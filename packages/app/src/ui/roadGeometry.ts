/**
 * The road's line as the scene sampled it (SceneInfo.road, one point every ROAD_SAMPLE_STEP m), read back between its
 * samples: the heading at a distance along the road and the world point beside the line. The top view, the mini-map and
 * the 3D scene all draw the road from here; nothing is computed that the worker did not send.
 */
import { ROAD_SAMPLE, ROAD_SAMPLE_STEP, type SceneInfo } from '@mpc-simulator/worker';

export class RoadGeometry {
  private readonly samples: Float64Array;
  readonly count: number;

  constructor(scene: Pick<SceneInfo, 'road'>) {
    this.samples = scene.road;
    this.count = Math.floor(scene.road.length / ROAD_SAMPLE);
  }

  /** The road's length, m. */
  get length(): number {
    return (this.count - 1) * ROAD_SAMPLE_STEP;
  }

  private index(s: number): number {
    return Math.min(Math.max(Math.floor(s / ROAD_SAMPLE_STEP), 0), this.count - 2);
  }

  private at(i: number, field: number): number {
    return this.samples[i * ROAD_SAMPLE + field] ?? 0;
  }

  /** The road's heading at `s`, rad. */
  headingAt(s: number): number {
    const i = this.index(s);
    const t = Math.min(Math.max(s / ROAD_SAMPLE_STEP - i, 0), 1);
    return this.at(i, 3) + (this.at(i + 1, 3) - this.at(i, 3)) * t;
  }

  /** The world point at `s` along the road and `ey` to its left, in `out`. */
  pointAt(s: number, ey: number, out: { x: number; y: number }): void {
    const i = this.index(s);
    const t = Math.min(Math.max(s / ROAD_SAMPLE_STEP - i, 0), 1);
    const x = this.at(i, 1) + (this.at(i + 1, 1) - this.at(i, 1)) * t;
    const y = this.at(i, 2) + (this.at(i + 1, 2) - this.at(i, 2)) * t;
    const h = this.headingAt(s);
    out.x = x - Math.sin(h) * ey;
    out.y = y + Math.cos(h) * ey;
  }
}
