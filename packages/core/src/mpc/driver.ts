/**
 * The MPC as the driver of the plant. At each control tick it reads the state in road coordinates (exact
 * for now: the sensor models come with v1.1), predicts it forward by the computation delay with the command
 * still in force, plans from there, and returns the plan's first input, which takes effect after the delay.
 * The obstacle tracks are read at the same tick; the MPC predicts each from its own tick (ObstacleTrack.tick, the
 * sensor's latency included) to the plan's start, the control tick plus the delay.
 */
import { wrapAngle } from '../math/angle.ts';
import type { Projection, RoadPath, RoadPoint } from '../road/path.ts';
import type { Controller } from '../sim/closedLoop.ts';
import { TICK_HZ } from '../sim/clock.ts';
import type { FrictionPreview, TrackSource } from '../sensors/views.ts';
import type { DriverCommand } from '../vehicle/actuators.ts';
import type { VehicleParams } from '../vehicle/params.ts';
import { CHASSIS } from '../vehicle/plant.ts';
import type { Vehicle } from '../vehicle/vehicle.ts';
import {
  MpcController,
  type Corridor,
  type MpcConstraintSettings,
  type MpcPlan,
  type MpcSettings,
  type ObstacleSide,
  type Reference,
} from './mpc.ts';
import { NU, NX, STATE } from './model.ts';
import type { StepSolver } from './stepSolver.ts';

export interface MpcDriverOptions {
  /** Control period, ticks: 50 at 1 kHz is 20 Hz. */
  readonly periodTicks?: number;
  /** Computation delay, ticks (configuration, not a measured time). */
  readonly delayTicks?: number;
  readonly settings?: MpcSettings;
  /** Form of the step's QP and its solver; the MPC's default when absent. */
  readonly solver?: StepSolver;
  /** The μ the MPC expects along the road; the constructor's μ everywhere when absent. */
  readonly friction?: FrictionPreview;
  /** The obstacle tracks; no obstacle constraints when absent. */
  readonly tracks?: TrackSource;
  /** How the plan treats the obstacles at the start; `mpc.side` changes it per step. */
  readonly side?: ObstacleSide;
  /** Turns the terminal braking constraint off (for comparisons); on by default. */
  readonly terminal?: boolean;
  /** Handles low speed and standstill (MpcOptions.standstill); off by default. */
  readonly standstill?: boolean;
  /** Writes the g-g limit on the road's demand on curves (MpcOptions.roadDemand); off by default. */
  readonly roadDemand?: boolean;
  readonly constraints?: Partial<MpcConstraintSettings>;
}

export class MpcDriver implements Controller {
  readonly periodTicks: number;
  readonly delayTicks: number;
  readonly mpc: MpcController;
  /** The last plan, for the UI and the tests. */
  lastPlan: MpcPlan | undefined;
  private readonly road: RoadPath;
  private readonly projection: Projection = { s: 0, ey: 0, heading: 0, curvature: 0, index: -1 };
  private readonly point: RoadPoint = { x: 0, y: 0, heading: 0, curvature: 0 };
  private readonly state = new Float64Array(NX);
  private readonly predicted = new Float64Array(NX);
  private readonly inForce = new Float64Array(NU);

  constructor(
    params: VehicleParams,
    mu: number,
    road: RoadPath,
    corridor: Corridor,
    reference: Reference,
    options: MpcDriverOptions = {},
  ) {
    this.periodTicks = options.periodTicks ?? 50;
    this.delayTicks = options.delayTicks ?? 50;
    this.road = road;
    this.mpc = new MpcController(params, mu, road, corridor, reference, options.settings, options.solver, {
      ...(options.friction && { friction: options.friction }),
      ...(options.tracks && { tracks: options.tracks }),
      ...(options.side && { side: options.side }),
      ...(options.terminal !== undefined && { terminal: options.terminal }),
      ...(options.standstill !== undefined && { standstill: options.standstill }),
      ...(options.roadDemand !== undefined && { roadDemand: options.roadDemand }),
      ...(options.constraints && { constraints: options.constraints }),
    });
  }

  reset(): void {
    this.projection.index = -1;
    this.inForce.fill(0);
    this.mpc.reset();
    this.lastPlan = undefined;
  }

  /** The vehicle's state in the prediction model's coordinates. */
  observe(vehicle: Vehicle, out: Float64Array): Float64Array {
    const c = vehicle.plant.chassis;
    const p = this.road.project(c[CHASSIS.X] ?? 0, c[CHASSIS.Y] ?? 0, this.projection.index, this.projection);
    const act = vehicle.actuators;
    out[STATE.S] = p.s;
    out[STATE.EY] = p.ey;
    out[STATE.EPSI] = wrapAngle((c[CHASSIS.PSI] ?? 0) - p.heading);
    out[STATE.VX] = c[CHASSIS.VX] ?? 0;
    out[STATE.VY] = c[CHASSIS.VY] ?? 0;
    out[STATE.R] = c[CHASSIS.R] ?? 0;
    out[STATE.DELTA] = act.steer;
    out[STATE.AX] = (act.driveForce - act.brakeForce) / vehicle.params.mass;
    return out;
  }

  compute(tick: number, vehicle: Vehicle, out: DriverCommand): void {
    this.observe(vehicle, this.state);
    if (this.delayTicks > 0) {
      const s = this.state[STATE.S] ?? 0;
      const kappa = this.road.pointAt(s, this.point).curvature;
      const mu = this.mpc.frictionAt(s);
      this.mpc.model.discretize(this.state, this.inForce, kappa, mu, this.delayTicks / TICK_HZ, this.predicted);
    } else {
      this.predicted.set(this.state);
    }
    const plan = this.mpc.step(this.predicted, tick + this.delayTicks);
    this.lastPlan = plan;
    this.inForce.set(plan.command);
    out.steer = plan.command[0] ?? 0;
    out.accel = plan.command[1] ?? 0;
  }
}
