/**
 * Road reference line built from straight, arc and clothoid segments, sampled every 0.25 m. A world position
 * projects onto it in Frenet coordinates: s along the line, e_y to its left. The corridor is the drivable
 * width on each side of the line, constant along the road in v1.
 */
export type Segment =
  | { readonly kind: 'straight'; readonly length: number }
  | { readonly kind: 'arc'; readonly length: number; readonly curvature: number }
  | {
      readonly kind: 'clothoid';
      readonly length: number;
      readonly curvatureStart: number;
      readonly curvatureEnd: number;
    };

export interface RoadSpec {
  readonly start?: { readonly x: number; readonly y: number; readonly heading: number };
  readonly segments: readonly Segment[];
  /** Drivable width to the left and to the right of the reference line, m. */
  readonly width: { readonly left: number; readonly right: number };
}

export interface RoadPoint {
  x: number;
  y: number;
  /** Cumulative heading along the line, not wrapped to (−π, π]. */
  heading: number;
  curvature: number;
}

export interface Projection {
  s: number;
  /** Signed distance from the line, positive to the left. */
  ey: number;
  heading: number;
  curvature: number;
  /** Sample index near the projection: pass it back as the hint of the next query. */
  index: number;
}

export const SAMPLE_STEP = 0.25;
/** Simpson sub-intervals per sample step when integrating the position. */
const SUBSTEPS = 8;
/** Beyond the corridor by more than this, a hinted search starts again from scratch. */
const FAR_MARGIN = 10;

function curvatureOf(segment: Segment, u: number): number {
  switch (segment.kind) {
    case 'straight':
      return 0;
    case 'arc':
      return segment.curvature;
    case 'clothoid':
      return segment.curvatureStart + ((segment.curvatureEnd - segment.curvatureStart) * u) / segment.length;
  }
}

/** Heading change over the first u metres of the segment. */
function turnOf(segment: Segment, u: number): number {
  switch (segment.kind) {
    case 'straight':
      return 0;
    case 'arc':
      return segment.curvature * u;
    case 'clothoid':
      return (
        segment.curvatureStart * u + ((segment.curvatureEnd - segment.curvatureStart) * u * u) / (2 * segment.length)
      );
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class RoadPath {
  readonly length: number;
  readonly width: { readonly left: number; readonly right: number };
  private readonly count: number;
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  private readonly headings: Float64Array;
  private readonly curvatures: Float64Array;
  private readonly segments: readonly Segment[];
  private readonly segmentStart: Float64Array;
  private readonly segmentHeading: Float64Array;
  private readonly farDistance2: number;
  private readonly scratch: RoadPoint = { x: 0, y: 0, heading: 0, curvature: 0 };

  constructor(spec: RoadSpec) {
    if (spec.segments.length === 0) throw new RangeError('A road needs at least one segment');
    for (const segment of spec.segments) {
      if (!(segment.length > 0)) throw new RangeError(`Segment length must be positive: ${segment.length}`);
    }
    this.segments = spec.segments;
    this.width = spec.width;
    const far = Math.max(spec.width.left, spec.width.right) + FAR_MARGIN;
    this.farDistance2 = far * far;
    const start = spec.start ?? { x: 0, y: 0, heading: 0 };

    this.segmentStart = new Float64Array(spec.segments.length);
    this.segmentHeading = new Float64Array(spec.segments.length);
    let s = 0;
    let heading = start.heading;
    spec.segments.forEach((segment, i) => {
      this.segmentStart[i] = s;
      this.segmentHeading[i] = heading;
      s += segment.length;
      heading += turnOf(segment, segment.length);
    });
    this.length = s;

    this.count = Math.ceil(this.length / SAMPLE_STEP) + 1;
    this.xs = new Float64Array(this.count);
    this.ys = new Float64Array(this.count);
    this.headings = new Float64Array(this.count);
    this.curvatures = new Float64Array(this.count);
    let x = start.x;
    let y = start.y;
    for (let k = 0; k < this.count; k++) {
      const sk = this.sampleS(k);
      if (k > 0) {
        // Simpson's rule on the heading over [s(k−1), s(k)].
        const s0 = this.sampleS(k - 1);
        const h = (sk - s0) / SUBSTEPS;
        let cx = 0;
        let cy = 0;
        for (let j = 0; j <= SUBSTEPS; j++) {
          const weight = j === 0 || j === SUBSTEPS ? 1 : j % 2 === 1 ? 4 : 2;
          const theta = this.headingAt(s0 + j * h);
          cx += weight * Math.cos(theta);
          cy += weight * Math.sin(theta);
        }
        x += (h / 3) * cx;
        y += (h / 3) * cy;
      }
      this.xs[k] = x;
      this.ys[k] = y;
      this.headings[k] = this.headingAt(sk);
      this.curvatures[k] = this.curvatureAt(sk);
    }
  }

  /** Point on the line at arc length s, clamped to the road's ends. */
  pointAt(s: number, out: RoadPoint): RoadPoint {
    const clamped = s < 0 ? 0 : s > this.length ? this.length : s;
    const k = Math.min(Math.floor(clamped / SAMPLE_STEP), this.count - 2);
    const s0 = this.sampleS(k);
    const t = (clamped - s0) / (this.sampleS(k + 1) - s0);
    out.x = lerp(this.xs[k] ?? 0, this.xs[k + 1] ?? 0, t);
    out.y = lerp(this.ys[k] ?? 0, this.ys[k + 1] ?? 0, t);
    out.heading = lerp(this.headings[k] ?? 0, this.headings[k + 1] ?? 0, t);
    out.curvature = lerp(this.curvatures[k] ?? 0, this.curvatures[k + 1] ?? 0, t);
    return out;
  }

  /** Whether a lateral offset is beyond the corridor by more than the restart margin. */
  isFar(ey: number): boolean {
    return ey * ey > this.farDistance2;
  }

  /**
   * Frenet coordinates of (x, y). With a valid `hint` (the index of the previous projection) the search is
   * local, which is what a moving vehicle needs; with −1 it scans the whole line once.
   * A stale hint, or a road that comes back near itself (a hairpin), can leave the local search on the wrong
   * branch: when the result is far from the road it starts again from the nearest sample of all, unless
   * `restartWhenFar` is false because the previous point was already far (a vehicle off the road).
   */
  project(x: number, y: number, hint: number, out: Projection, restartWhenFar = true): Projection {
    const hinted = hint >= 0 && hint < this.count;
    let i = this.descend(hinted ? hint : this.nearestSample(x, y), x, y);
    if (hinted && restartWhenFar && this.distance2(i, x, y) > this.farDistance2) {
      i = this.descend(this.nearestSample(x, y), x, y);
    }

    // The foot of the perpendicular lies on the segment after the nearest sample, or on the one before it.
    let a = i;
    let t = this.footParameter(i, x, y);
    if ((t <= 0 && i > 0) || i + 1 >= this.count) {
      a = i - 1;
      t = this.footParameter(a, x, y);
    }
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    let s = lerp(this.sampleS(a), this.sampleS(a + 1), t);

    // The perpendicular to a chord is not the perpendicular to the curve: away from the line that costs about
    // a centimetre. Newton steps on the interpolated tangent, in the Frenet metric, remove it.
    const p = this.scratch;
    for (let iteration = 0; iteration < 2; iteration++) {
      this.pointAt(s, p);
      const dx = x - p.x;
      const dy = y - p.y;
      const cos = Math.cos(p.heading);
      const sin = Math.sin(p.heading);
      const metric = 1 - p.curvature * (-dx * sin + dy * cos);
      s += (dx * cos + dy * sin) / (metric > 0.1 ? metric : 1);
      s = s < 0 ? 0 : s > this.length ? this.length : s;
    }
    this.pointAt(s, p);
    out.s = s;
    out.ey = -(x - p.x) * Math.sin(p.heading) + (y - p.y) * Math.cos(p.heading);
    out.heading = p.heading;
    out.curvature = p.curvature;
    out.index = i;
    return out;
  }

  /** From sample `start`, walks to the nearest sample around it. */
  private descend(start: number, x: number, y: number): number {
    let i = start;
    let best = this.distance2(i, x, y);
    while (i + 1 < this.count) {
      const d = this.distance2(i + 1, x, y);
      if (d >= best) break;
      best = d;
      i++;
    }
    while (i > 0) {
      const d = this.distance2(i - 1, x, y);
      if (d >= best) break;
      best = d;
      i--;
    }
    return i;
  }

  private sampleS(k: number): number {
    return Math.min(k * SAMPLE_STEP, this.length);
  }

  private segmentIndex(s: number): number {
    let i = this.segments.length - 1;
    while (i > 0 && s < (this.segmentStart[i] ?? 0)) i--;
    return i;
  }

  private headingAt(s: number): number {
    const i = this.segmentIndex(s);
    const segment = this.segments[i] as Segment;
    return (this.segmentHeading[i] ?? 0) + turnOf(segment, s - (this.segmentStart[i] ?? 0));
  }

  private curvatureAt(s: number): number {
    const i = this.segmentIndex(s);
    return curvatureOf(this.segments[i] as Segment, s - (this.segmentStart[i] ?? 0));
  }

  private distance2(k: number, x: number, y: number): number {
    const dx = x - (this.xs[k] ?? 0);
    const dy = y - (this.ys[k] ?? 0);
    return dx * dx + dy * dy;
  }

  /** Parameter of the foot of the perpendicular on the segment from sample k to k + 1 (unclamped). */
  private footParameter(k: number, x: number, y: number): number {
    const ax = this.xs[k] ?? 0;
    const ay = this.ys[k] ?? 0;
    const dx = (this.xs[k + 1] ?? 0) - ax;
    const dy = (this.ys[k + 1] ?? 0) - ay;
    const len2 = dx * dx + dy * dy;
    return len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
  }

  private nearestSample(x: number, y: number): number {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < this.count; k++) {
      const d = this.distance2(k, x, y);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  }
}
