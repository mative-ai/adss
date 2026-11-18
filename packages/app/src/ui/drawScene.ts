/**
 * The top view (Phase 4) drawn on a Canvas 2D: the road and its surfaces, the lane, the obstacles, the
 * plans of the candidate maneuvers (the chosen one in green) and the vehicles, around the ego with the road running up
 * the screen. The same drawing serves the main view and, framed wider and with marks that keep a least size, the
 * mini-map over the 3D scene. It only draws what a frame holds; it computes no physics. Everything is drawn in meters
 * under one transform (world to screen), so a line width is `px / scale`. Colors never carry the meaning alone: the
 * chosen plan is solid and thick, the others thin and dashed; the ghost is outlined, the ego filled; a detected obstacle
 * has a solid ring, an undetected one a dashed ring; a slippery zone is hatched.
 */
import { ROAD_SAMPLE_STEP, type SceneInfo } from '@mpc-simulator/worker';

import type { FrameView, VehicleView } from '../sim/frame.ts';
import type { RoadGeometry } from './roadGeometry.ts';

/** How a top view frames the road. */
export interface TopViewOptions {
  /** Meters of road the view spans, from the bottom edge to the top one. */
  readonly span: number;
  /** Where the ego sits, as a share of the height from the top: most of the view is the road ahead. */
  readonly egoAt: number;
  /** A small view: the vehicles and the obstacles keep a least size on screen, and the lines are thinner. */
  readonly compact: boolean;
}

/** The view on its own. */
export const MAIN_VIEW: TopViewOptions = { span: 48, egoAt: 0.75, compact: false };
/** The mini-map over the 3D scene: more than twice the road, to see what the camera does not. */
export const MINI_VIEW: TopViewOptions = { span: 110, egoAt: 0.72, compact: true };

export interface Palette {
  background: string;
  road: string;
  line: string;
  zone: string;
  hatch: string;
  obstacle: string;
  plan: string;
  chosen: string;
  chosenEdge: string;
  ego: string;
  egoEdge: string;
  ghost: string;
}

export const LIGHT: Palette = {
  background: '#e3e7dd',
  road: '#8c9584',
  line: 'rgba(247, 248, 244, 0.92)',
  zone: 'rgba(247, 248, 244, 0.5)',
  hatch: 'rgba(247, 248, 244, 0.95)',
  obstacle: '#141812',
  plan: 'rgba(20, 24, 18, 0.6)',
  chosen: '#4db936',
  chosenEdge: '#0d230b',
  ego: '#4db936',
  egoEdge: '#0d230b',
  ghost: '#f7f8f4',
};

export const DARK: Palette = {
  background: '#090c08',
  road: '#33402f',
  line: 'rgba(255, 255, 255, 0.72)',
  zone: 'rgba(255, 255, 255, 0.2)',
  hatch: 'rgba(255, 255, 255, 0.7)',
  obstacle: '#f7f8f4',
  plan: 'rgba(255, 255, 255, 0.6)',
  chosen: '#70c75e',
  chosenEdge: '#090c08',
  ego: '#4db936',
  egoEdge: '#0d230b',
  ghost: '#d0d6c8',
};

/** World to screen: x' = a·x + c·y + e, y' = b·x + d·y + f (CSS pixels), and the pixels per meter. */
export interface ViewMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  scale: number;
}

/**
 * The view around (x, y) with the direction `heading` going up the screen and its left going left. The world has y up
 * and the screen y down, so the matrix reverses orientation, as it must.
 */
export function viewMatrix(
  width: number,
  height: number,
  x: number,
  y: number,
  heading: number,
  view: TopViewOptions = MAIN_VIEW,
): ViewMatrix {
  const scale = height / view.span;
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  const a = scale * sin;
  const b = -scale * cos;
  const c = -scale * cos;
  const d = -scale * sin;
  const cx = width / 2;
  const cy = height * view.egoAt;
  return { a, b, c, d, e: cx - a * x - c * y, f: cy - b * x - d * y, scale };
}

const P = { x: 0, y: 0 };

/** A strip of road from `s0` to `s1` and from `e0` to `e1` (e_y, left positive), as a path. */
function strip(
  ctx: CanvasRenderingContext2D,
  road: RoadGeometry,
  s0: number,
  s1: number,
  e0: number,
  e1: number,
): void {
  const step = ROAD_SAMPLE_STEP;
  const from = Math.max(0, s0);
  const to = Math.min(road.length, s1);
  ctx.beginPath();
  road.pointAt(from, e1, P);
  ctx.moveTo(P.x, P.y);
  for (let s = Math.ceil(from / step) * step; s < to; s += step) {
    road.pointAt(s, e1, P);
    ctx.lineTo(P.x, P.y);
  }
  road.pointAt(to, e1, P);
  ctx.lineTo(P.x, P.y);
  road.pointAt(to, e0, P);
  ctx.lineTo(P.x, P.y);
  for (let s = Math.floor(to / step) * step; s > from; s -= step) {
    road.pointAt(s, e0, P);
    ctx.lineTo(P.x, P.y);
  }
  road.pointAt(from, e0, P);
  ctx.lineTo(P.x, P.y);
  ctx.closePath();
}

/** A line along the road at `ey`, from `s0` to `s1`, added to the current path. */
function along(ctx: CanvasRenderingContext2D, road: RoadGeometry, s0: number, s1: number, ey: number): void {
  const step = ROAD_SAMPLE_STEP;
  const from = Math.max(0, s0);
  const to = Math.min(road.length, s1);
  road.pointAt(from, ey, P);
  ctx.moveTo(P.x, P.y);
  for (let s = Math.ceil(from / step) * step; s < to; s += step) {
    road.pointAt(s, ey, P);
    ctx.lineTo(P.x, P.y);
  }
  road.pointAt(to, ey, P);
  ctx.lineTo(P.x, P.y);
}

/**
 * The vehicle's body as the current path, at its pose: the core's contact test puts it `bodyOffset` ahead of x, y.
 * `grow` enlarges it about its center, for a view where its true size would be a few pixels.
 */
function body(ctx: CanvasRenderingContext2D, v: VehicleView, scene: SceneInfo, grow: number): void {
  const { bodyOffset } = scene.vehicle;
  const length = scene.vehicle.length * grow;
  const width = scene.vehicle.width * grow;
  ctx.translate(v.x + bodyOffset * Math.cos(v.psi), v.y + bodyOffset * Math.sin(v.psi));
  ctx.rotate(v.psi);
  ctx.beginPath();
  ctx.rect(-length / 2, -width / 2, length, width);
}

/** Draws one frame of the top view into `ctx`, `width` by `height` CSS pixels at `dpr` device pixels each. */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  road: RoadGeometry,
  scene: SceneInfo,
  frame: FrameView,
  width: number,
  height: number,
  dpr: number,
  palette: Palette,
  view: TopViewOptions = MAIN_VIEW,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, width, height);

  const ego = frame.ego;
  const m = viewMatrix(width, height, ego.x, ego.y, road.headingAt(ego.s), view);
  const px = 1 / m.scale;
  // In a compact view the lines are thinner, and a mark is never smaller than so many pixels.
  const thin = view.compact ? 0.7 : 1;
  const least = (meters: number, pixels: number) => (view.compact ? Math.max(meters, pixels * px) : meters);
  ctx.setTransform(dpr * m.a, dpr * m.b, dpr * m.c, dpr * m.d, dpr * m.e, dpr * m.f);

  // The stretch of road in view, with a margin for the rotation: the ego sits `egoAt` of the way down the view.
  const s0 = ego.s - view.span * (1 - view.egoAt) - 12;
  const s1 = ego.s + view.span * view.egoAt + 12;
  const left = scene.width.left;
  const right = -scene.width.right;

  ctx.fillStyle = palette.road;
  strip(ctx, road, s0, s1, right, left);
  ctx.fill();

  for (const zone of scene.surface.zones) {
    if (zone.to < s0 || zone.from > s1) continue;
    const e0 = zone.side === 'left' ? 0 : right;
    const e1 = zone.side === 'right' ? 0 : left;
    const a = Math.max(zone.from, s0);
    const b = Math.min(zone.to, s1);
    ctx.save();
    ctx.fillStyle = palette.zone;
    strip(ctx, road, a, b, e0, e1);
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = palette.hatch;
    ctx.lineWidth = 2 * px * thin;
    ctx.beginPath();
    const slant = e1 - e0;
    const spacing = least(1.6, 5);
    for (let s = Math.floor(a) - slant; s < b; s += spacing) {
      road.pointAt(s, e0, P);
      ctx.moveTo(P.x, P.y);
      road.pointAt(s + slant, e1, P);
      ctx.lineTo(P.x, P.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // The road's edges, and the ego lane's two lines (dashed).
  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 2.5 * px * thin;
  ctx.setLineDash([]);
  ctx.beginPath();
  along(ctx, road, s0, s1, left);
  along(ctx, road, s0, s1, right);
  ctx.stroke();
  ctx.lineWidth = 1.5 * px * thin;
  ctx.setLineDash([6 * px, 8 * px]);
  ctx.beginPath();
  along(ctx, road, s0, s1, scene.lane.center + scene.lane.width / 2);
  along(ctx, road, s0, s1, scene.lane.center - scene.lane.width / 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // The candidate plans: the others thin and dashed, the chosen one thick and solid with an outline.
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const trace = (points: Float64Array) => {
    ctx.beginPath();
    ctx.moveTo(points[0] ?? 0, points[1] ?? 0);
    for (let k = 2; k < points.length; k += 2) ctx.lineTo(points[k] ?? 0, points[k + 1] ?? 0);
  };
  ctx.strokeStyle = palette.plan;
  ctx.lineWidth = 1.5 * px * thin;
  ctx.setLineDash([5 * px, 5 * px]);
  for (const plan of frame.plans) {
    if (!plan.solved || plan.chosen) continue;
    trace(plan.points);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const plan of frame.plans) {
    if (!plan.solved || !plan.chosen) continue;
    trace(plan.points);
    ctx.strokeStyle = palette.chosenEdge;
    ctx.lineWidth = 7 * px * thin;
    ctx.stroke();
    ctx.strokeStyle = palette.chosen;
    ctx.lineWidth = 4 * px * thin;
    ctx.stroke();
  }

  // The obstacles, true to size, with a ring that is solid when the sensor tracks them and dashed when it does not.
  frame.obstacles.forEach((o, i) => {
    const spec = scene.obstacles[i];
    if (!spec) return;
    const length = least(spec.length, 4);
    const breadth = least(spec.width, 4);
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.rotate(o.heading);
    ctx.fillStyle = palette.obstacle;
    ctx.fillRect(-length / 2, -breadth / 2, length, breadth);
    ctx.restore();
    ctx.strokeStyle = o.detected ? palette.chosen : palette.obstacle;
    ctx.lineWidth = 2 * px * thin;
    ctx.setLineDash(o.detected ? [] : [4 * px, 4 * px]);
    ctx.beginPath();
    ctx.arc(o.x, o.y, least(Math.max(1.3, Math.hypot(spec.length, spec.width) / 2 + 0.5), 6), 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);
  });

  // The ghost outlined, the ego filled and over it.
  const grow = least(scene.vehicle.length, 12) / scene.vehicle.length;
  if (frame.hasGhost) {
    ctx.save();
    body(ctx, frame.ghost, scene, grow);
    ctx.fillStyle = 'rgba(247, 248, 244, 0.18)';
    ctx.fill();
    ctx.strokeStyle = palette.ghost;
    ctx.lineWidth = 2 * px * thin;
    ctx.setLineDash([5 * px * thin, 3 * px * thin]);
    ctx.stroke();
    ctx.restore();
  }
  ctx.save();
  body(ctx, ego, scene, grow);
  ctx.fillStyle = palette.ego;
  ctx.fill();
  ctx.strokeStyle = palette.egoEdge;
  ctx.lineWidth = 2 * px * thin;
  ctx.stroke();
  if (!view.compact) {
    // The windscreen, to see which way it points.
    ctx.beginPath();
    ctx.moveTo(scene.vehicle.length / 2 - 1.1, -scene.vehicle.width / 2 + 0.2);
    ctx.lineTo(scene.vehicle.length / 2 - 1.1, scene.vehicle.width / 2 - 0.2);
    ctx.stroke();
  }
  ctx.restore();
}
