/**
 * The ISO 3888-2 double lane change (the moose test) of milestone M3 (Phase 2) and of the solver
 * benchmark. Layout for a vehicle W m wide: lane 1 of 12 m, width 1.1·W + 0.25; a gap of 13.5 m; lane 3 of 11 m,
 * width W + 1, its right edge 1 m left of lane 1's left edge; a gap of 12.5 m; lane 5 of 12 m, width
 * 1.3·W + 0.25 (at least 3 m), sharing lane 1's right edge. The course lies on a straight road along the x axis
 * from the origin, so s = x and e_y = y, positive to the left.
 */
import type { Corridor, Reference } from '../mpc/mpc.ts';
import { wheelbase, type VehicleParams } from '../vehicle/params.ts';
import { CHASSIS } from '../vehicle/plant.ts';
import type { Vehicle } from '../vehicle/vehicle.ts';

export interface Lane {
  readonly from: number;
  readonly to: number;
  readonly right: number;
  readonly left: number;
}

export interface LaneChangeCourse {
  readonly lanes: readonly Lane[];
  /** Arc length at which the run ends, past the exit lane, m. */
  readonly end: number;
  /** Lanes where there are cones, the road edges elsewhere (6 m left, 3 m right). */
  readonly corridor: Corridor;
  /** The center of the lane being driven or of the next one, at the entry speed. */
  readonly reference: Reference;
  /** How far the body's farthest corner is outside the lane it is in, m: 0 inside a lane or between lanes. */
  outside(vehicle: Vehicle): number;
}

const ROAD_LEFT = 6;
const ROAD_RIGHT = -3;

export function isoLaneChange(params: VehicleParams, speed: number, start = 50): LaneChangeCourse {
  const W = params.width;
  const w1 = 1.1 * W + 0.25;
  const w3 = W + 1;
  const w5 = Math.max(1.3 * W + 0.25, 3);
  const lanes: Lane[] = [
    { from: start, to: start + 12, right: -w1 / 2, left: w1 / 2 },
    { from: start + 25.5, to: start + 36.5, right: w1 / 2 + 1, left: w1 / 2 + 1 + w3 },
    { from: start + 49, to: start + 61, right: -w1 / 2, left: -w1 / 2 + w5 },
  ];
  const laneAt = (s: number) => lanes.find((l) => s >= l.from && s <= l.to);
  const overhang = (params.length - wheelbase(params)) / 2;
  const corners = [
    [params.lf + overhang, W / 2],
    [params.lf + overhang, -W / 2],
    [-(params.lr + overhang), W / 2],
    [-(params.lr + overhang), -W / 2],
  ] as const;

  return {
    lanes,
    end: start + 75,
    corridor: {
      bounds(s, out) {
        const lane = laneAt(s);
        out.left = lane ? lane.left : ROAD_LEFT;
        out.right = lane ? lane.right : ROAD_RIGHT;
      },
    },
    reference: {
      at(s, out) {
        const lane = lanes.find((l) => s <= l.to) ?? lanes[lanes.length - 1];
        out.ey = lane ? (lane.left + lane.right) / 2 : 0;
        out.speed = speed;
      },
    },
    outside(vehicle) {
      const c = vehicle.plant.chassis;
      const x = c[CHASSIS.X] ?? 0;
      const y = c[CHASSIS.Y] ?? 0;
      const psi = c[CHASSIS.PSI] ?? 0;
      let worst = 0;
      for (const [cx, cy] of corners) {
        const s = x + cx * Math.cos(psi) - cy * Math.sin(psi);
        const ey = y + cx * Math.sin(psi) + cy * Math.cos(psi);
        const lane = laneAt(s);
        if (lane) worst = Math.max(worst, ey - lane.left, lane.right - ey);
      }
      return worst;
    },
  };
}
