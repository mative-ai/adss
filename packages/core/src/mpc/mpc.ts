/**
 * RTI-MPC with one maneuver; Phase 3 adds the parallel maneuvers on top of it. Every control step:
 * 1. shifts the previous input plan by one step and rolls it out with the prediction model from the current
 *    state, linearizing along that rollout (the RTI: one linearization per step);
 * 2. writes the step's QP over the stage variables (mpc/ocpQp.ts): Bryson-scaled costs on tracking, effort and
 *    rates, weighted by each stage's duration; hard input bounds and rates; soft corridor (the four body
 *    corners), friction ellipse (three facets) and stability envelope (rear slip angle, yaw rate), with L1 + L2
 *    slack; and, when the options ask for them, the road's own g-g demand vx²·|κ| on a curve, vx ≥ 0, the
 *    obstacles' half-planes (mpc/obstacles.ts) and the terminal braking feasibility;
 * 3. hands it to the step solver, which condenses and solves it, and keeps the plan for the next step.
 *
 * Friction is per stage: an optional FrictionPreview gives the μ each stage expects at its nominal arc length, in
 * the model, the friction ellipse and the envelope; without one every stage takes the constructor's μ.
 *
 * Every soft row group has its own slacks, each with a diagonal quadratic and a positive linear cost and used only
 * with coefficient ±1, so the fast solver's slack elimination still applies. A slack of the new groups
 * exists only when one of its rows does. Without obstacles, preview, the standstill option and the roadDemand
 * option, the QP is the same to the bit as before these constraints (the solver corpus and M3 are such runs).
 */
import type { RoadPath, RoadPoint } from '../road/path.ts';
import type { QpStatus } from '../qp/problem.ts';
import type { FrictionPreview, ObstacleTrack, TrackSource } from '../sensors/views.ts';
import { TICK_HZ } from '../sim/clock.ts';
import { GRAVITY, rolloverAccel, wheelbase, type VehicleParams } from '../vehicle/params.ts';
import { NU, NX, PredictionModel, STATE } from './model.ts';
import {
  brakingRoom,
  obstacleHalfPlane,
  predictTrack,
  vehicleDiscs,
  type DiscView,
  type HalfPlane,
  type ObstacleSide,
  type VehicleDiscs,
} from './obstacles.ts';
import { OcpQp, ROW_KIND, rowKey } from './ocpQp.ts';
import { GiStepSolver, type StepSolver } from './stepSolver.ts';

export {
  brakingRoom,
  obstacleHalfPlane,
  predictTrack,
  vehicleDiscs,
  type DiscView,
  type HalfPlane,
  type ObstacleSide,
  type VehicleDiscs,
} from './obstacles.ts';

const { S, EY, EPSI, VX, VY, R, AX } = STATE;

/** Lateral bounds of the drivable area at arc length s, positive to the left. */
export interface Corridor {
  bounds(s: number, out: { left: number; right: number }): void;
}

/** What the vehicle should do at arc length s: lateral offset and speed. */
export interface Reference {
  at(s: number, out: { ey: number; speed: number }): void;
}

export interface MpcSettings {
  /** Durations of the horizon's steps, s. */
  readonly steps: readonly number[];
  /** Bryson scales: the deviation that costs as much as one second of it at the scale. */
  readonly scales: {
    readonly ey: number;
    readonly epsi: number;
    readonly speed: number;
    readonly steer: number;
    readonly accel: number;
    readonly steerRate: number;
    readonly jerk: number;
  };
  /** Multiplier of the state costs at the last step. */
  readonly terminalWeight: number;
  readonly slackLinear: number;
  readonly slackQuadratic: number;
  /** Hard limit on the longitudinal command rate, m/s³. */
  readonly accelRateMax: number;
  /** Margin kept from the corridor edges, m. */
  readonly corridorMargin: number;
}

/** Settings of the constraints added in Phase 3: obstacles, standstill, terminal braking, the road's g-g demand. */
export interface MpcConstraintSettings {
  /** Clearance kept between a vehicle disc and an obstacle's box, on top of the disc's radius, m. */
  readonly obstacleMargin: number;
  /**
   * Screening: an obstacle row joins the QP when the nominal plan's clearance is under this, plus how far one QP
   * can move the stage (MpcController.addObstacles), m.
   */
  readonly obstacleScreen: number;
  /**
   * Screening: a vx ≥ 0 row joins the QP at a stage where the hardest braking from the plan's start could bring
   * the speed under this, m/s.
   */
  readonly standstillScreen: number;
  /**
   * Share of μ·g the terminal braking constraint counts on (ABS slip around the peak, load transfer, the brake
   * lag): its deceleration is min(η·μ(s)·g, −accelMin).
   */
  readonly brakeEfficiency: number;
  /** Farthest the terminal constraint looks beyond the front disc at the horizon end, m. */
  readonly terminalRange: number;
  /** Integration step of the braking room along the friction preview, m. */
  readonly terminalStep: number;
  /**
   * Share of the stage's lateral limit that following the road's curvature may take, vx²·|κ| ≤ share·A_y: the
   * rest is left for corrections and for braking.
   */
  readonly pathFrictionShare: number;
}

export const MPC_CONSTRAINT_DEFAULTS: MpcConstraintSettings = {
  pathFrictionShare: 0.8,
  obstacleMargin: 0.3,
  obstacleScreen: 8,
  standstillScreen: 3,
  brakeEfficiency: 0.8,
  terminalRange: 200,
  terminalStep: 1,
};

/** The MPC's inputs beyond the road, corridor and reference; each one is optional. */
export interface MpcOptions {
  /** The μ each stage expects at its nominal arc length; the constructor's μ everywhere when absent. */
  readonly friction?: FrictionPreview;
  /** The obstacles, read once per step; no obstacle rows when absent. */
  readonly tracks?: TrackSource;
  /** How the plan treats the obstacles at the start ('avoid' by default); settable per step on the controller. */
  readonly side?: ObstacleSide;
  /** Turns the terminal braking constraint off (for comparisons); on by default. */
  readonly terminal?: boolean;
  /**
   * Handles low speed and standstill: the prediction model blends into the kinematic model below 3 m/s, as the
   * plant does, and vx ≥ 0 is written at the low-speed stages. Off by default only so that the solver corpus and
   * M3 stay the same QPs (at the limit, a few of their plans brake to a standstill inside the horizon); the
   * scenario runs turn it on.
   */
  readonly standstill?: boolean;
  /**
   * Writes the g-g limit on the road's demand, vx²·|κ| ≤ pathFrictionShare·A_y, at the stages on a curve: it lets
   * the plan brake before a curve, or an ice patch on it, that it could not follow. Off by default so that the MPC
   * without options stays the Phase 2 one; the scenario runs turn it on.
   */
  readonly roadDemand?: boolean;
  readonly constraints?: Partial<MpcConstraintSettings>;
}

/** The plan's grid: six steps of 50 ms, then 150 ms (200 ms for the truck), 20 in all. */
export function defaultSteps(params: VehicleParams): number[] {
  const tail = params.id === 'truck' ? 0.2 : 0.15;
  return [...Array.from({ length: 6 }, () => 0.05), ...Array.from({ length: 14 }, () => tail)];
}

export function defaultMpcSettings(params: VehicleParams): MpcSettings {
  return {
    steps: defaultSteps(params),
    scales: { ey: 0.3, epsi: 0.05, speed: 1, steer: 0.3, accel: 3, steerRate: 0.3, jerk: 5 },
    terminalWeight: 5,
    slackLinear: 1e4,
    slackQuadratic: 1e2,
    accelRateMax: 40,
    corridorMargin: 0.1,
  };
}

/**
 * The MPC's step solver: the fast Goldfarb–Idnani on the condensed QP, cold. It is exact up to
 * rounding, so the plan does not depend on a tolerance.
 */
export function defaultStepSolver(): StepSolver {
  return new GiStepSolver('gi-fast');
}

export interface MpcPlan {
  readonly status: QpStatus;
  readonly iterations: number;
  /** First input of the plan: [δ_cmd, a_cmd]. */
  readonly command: Float64Array;
  /** Planned inputs, N×NU. */
  readonly inputs: Float64Array;
  /** Nonlinear rollout of the plan, (N+1)×NX, starting at the planning state. */
  readonly trajectory: Float64Array;
  /** Largest slack used: 0 when every soft constraint holds. */
  readonly slack: number;
  /** Obstacle half-planes in the step's QP, after screening. */
  readonly obstacleRows: number;
  /**
   * Nominal value of the terminal braking constraint, m (positive: the nominal plan could not stop in time),
   * when an obstacle in the path gave one.
   */
  readonly terminalGap: number | undefined;
}

/** Number of body corners checked against the corridor. */
const CORNERS = 4;
/** Friction-ellipse facets per stage, around the predicted acceleration direction. */
const FACETS = [-Math.PI / 8, 0, Math.PI / 8];
/** Steps sharing one envelope slack. */
const ENVELOPE_BLOCK = 4;
/**
 * Constraint screening: a soft row joins the QP only when the nominal plan is already near it, within this
 * distance of a corridor edge (m) or at this share of a friction or envelope limit. The next RTI step brings
 * a row back as soon as the plan moves toward it.
 */
const SCREEN_CORRIDOR = 1.5;
const SCREEN_SHARE = 0.6;
/** Lowest friction coefficient the plan takes from a preview: keeps every limit and deceleration finite. */
const MU_FLOOR = 0.01;
/**
 * How far below zero the QP's linearization may plan vx, m/s. The rollouts hold at rest by themselves; the vx ≥ 0
 * row only keeps the step's solution from planning through zero. At exactly 0 it would sit on the hold's kink
 * as the plan comes to rest, where both solvers stop on it with a violation of order 1e-6.
 */
const STANDSTILL_FLOOR = 0.01;

export class MpcController {
  readonly params: VehicleParams;
  readonly model: PredictionModel;
  readonly settings: MpcSettings;
  readonly horizon: number;
  readonly solver: StepSolver;
  /** The last step's QP, for the benchmark and the tests. */
  lastOcp: OcpQp | undefined;
  readonly constraints: MpcConstraintSettings;
  /** The two discs that cover the body, for the obstacle constraints. */
  readonly discs: VehicleDiscs;
  /** How the plan treats the obstacles: the decision layer sets it before each step. */
  side: ObstacleSide;
  /** Per-obstacle overrides of `side`, by track id. */
  readonly sideById = new Map<string, ObstacleSide>();
  /** Whether the terminal braking constraint is written (it needs obstacles). */
  terminal: boolean;
  /** Whether the g-g limit on the road's demand is written. */
  roadDemand: boolean;
  private readonly friction: FrictionPreview | undefined;
  private readonly trackSource: TrackSource | undefined;
  private readonly road: RoadPath;
  private readonly corridor: Corridor;
  private readonly reference: Reference;
  private readonly cornerX: Float64Array;
  private readonly cornerY: Float64Array;
  // Plan state.
  private readonly plan: Float64Array;
  private readonly lastApplied = new Float64Array(NU);
  private hasPlan = false;
  // Work storage.
  private readonly nominalU: Float64Array;
  private readonly nominalX: Float64Array;
  private readonly point: RoadPoint = { x: 0, y: 0, heading: 0, curvature: 0 };
  private readonly bounds = { left: 0, right: 0 };
  private readonly ref = { ey: 0, speed: 0 };
  private readonly center = { s: 0, ey: 0 };
  private readonly later = { s: 0, ey: 0 };
  private readonly halfPlane: HalfPlane = { ns: 0, ney: 0, clearance: 0 };
  // Per step: the tracks read once and the age of each at the plan's start, s, and what the step reports.
  private stepTracks: readonly ObstacleTrack[] = [];
  private trackAges: number[] = [];
  private obstacleRows = 0;
  private terminalGap: number | undefined;

  constructor(
    params: VehicleParams,
    mu: number,
    road: RoadPath,
    corridor: Corridor,
    reference: Reference,
    settings: MpcSettings = defaultMpcSettings(params),
    solver: StepSolver = defaultStepSolver(),
    options: MpcOptions = {},
  ) {
    this.params = params;
    this.model = new PredictionModel(params, mu);
    this.standstill = options.standstill ?? false;
    this.friction = options.friction;
    this.trackSource = options.tracks;
    this.side = options.side ?? 'avoid';
    this.terminal = options.terminal ?? true;
    this.roadDemand = options.roadDemand ?? false;
    this.constraints = { ...MPC_CONSTRAINT_DEFAULTS, ...options.constraints };
    this.discs = vehicleDiscs(params);
    this.settings = settings;
    this.horizon = settings.steps.length;
    this.solver = solver;
    this.road = road;
    this.corridor = corridor;
    this.reference = reference;
    const overhang = (params.length - wheelbase(params)) / 2;
    const front = params.lf + overhang;
    const rear = -(params.lr + overhang);
    const half = params.width / 2;
    this.cornerX = Float64Array.of(front, rear, front, rear);
    this.cornerY = Float64Array.of(half, half, -half, -half);
    const N = this.horizon;
    this.plan = new Float64Array(N * NU);
    this.nominalU = new Float64Array(N * NU);
    this.nominalX = new Float64Array((N + 1) * NX);
  }

  /**
   * Whether the plan handles low speed and standstill: the prediction model blends into the kinematic model below
   * 3 m/s (PredictionModel.lowSpeedBlend) and holds at rest instead of reversing (PredictionModel.standstillHold),
   * in the linearization rollout and in the plan's trajectory alike, and vx ≥ 0 is written at the low-speed stages.
   */
  get standstill(): boolean {
    return this.model.lowSpeedBlend;
  }

  set standstill(on: boolean) {
    this.model.lowSpeedBlend = on;
    this.model.standstillHold = on;
  }

  /** Forgets the plan; `applied` is the command in force now. */
  reset(applied: Float64Array = new Float64Array(NU)): void {
    this.hasPlan = false;
    this.plan.fill(0);
    this.lastApplied.set(applied);
    this.solver.reset();
    this.lastOcp = undefined;
  }

  /**
   * The friction coefficient the plan expects at arc length s: the preview's, or the constructor's μ; never below
   * MU_FLOOR (a preview of 0, below or NaN would put infinities in the QP's limits). The plan's rows take it on the
   * ego lane (e_y absent); the decision layer asks it at an evasion's e_y (FrictionPreview).
   */
  frictionAt(s: number, ey?: number): number {
    const mu = this.friction ? this.friction.at(s, ey) : this.model.mu;
    return mu > MU_FLOOR ? mu : MU_FLOOR;
  }

  /**
   * Plans from x0 (the state when the plan's first input takes effect) and keeps the plan. `startTick` is the tick
   * of x0: each track is (startTick − track.tick)/TICK_HZ old at the plan's start and is predicted at constant
   * velocity from its own tick. Without it, every track is taken as reported at the plan's start. Throws when a
   * track's age is not finite (ObstacleTrack.tick missing or not a number, or a non-finite startTick).
   */
  step(x0: Float64Array, startTick?: number): MpcPlan {
    const N = this.horizon;
    const ocp = new OcpQp(N, NX, NU);
    this.stepTracks = this.trackSource ? this.trackSource.tracks() : [];
    this.trackAges = this.stepTracks.map((track) => {
      const age = startTick === undefined ? 0 : (startTick - track.tick) / TICK_HZ;
      // A contract violation (a track without its tick, a NaN start tick): its NaN bounds would read as satisfied.
      if (!Number.isFinite(age)) {
        throw new Error(
          `MpcController.step: track '${track.id}' has no finite age (tick ${track.tick}, start tick ${startTick})`,
        );
      }
      return age;
    });
    this.obstacleRows = 0;
    this.terminalGap = undefined;
    this.shift();
    this.rollout(x0, this.nominalU, this.nominalX, ocp);
    this.buildOcp(ocp);
    this.lastOcp = ocp;
    const solution = this.solver.solve(ocp);
    const ok = solution.status === 'solved' || solution.status === 'maxIterations';
    const usable = ok && solution.du.every(Number.isFinite);
    if (usable) {
      for (let i = 0; i < N * NU; i++) this.plan[i] = (this.nominalU[i] ?? 0) + (solution.du[i] ?? 0);
    } else {
      this.plan.set(this.nominalU);
      this.solver.reset();
    }
    this.clampPlan();
    this.hasPlan = true;
    this.lastApplied.set(this.plan.subarray(0, NU));

    const trajectory = new Float64Array((N + 1) * NX);
    this.rollout(x0, this.plan, trajectory);
    let slack = 0;
    if (usable) for (const value of solution.slack) slack = Math.max(slack, value);
    return {
      status: usable ? solution.status : 'failed',
      iterations: solution.iterations,
      command: this.plan.slice(0, NU),
      inputs: this.plan.slice(),
      trajectory,
      slack,
      obstacleRows: this.obstacleRows,
      terminalGap: this.terminalGap,
    };
  }

  /** Nominal inputs: the previous plan advanced by one step, its last input repeated. */
  private shift(): void {
    const N = this.horizon;
    if (!this.hasPlan) {
      for (let k = 0; k < N; k++) this.nominalU.set(this.lastApplied, k * NU);
      return;
    }
    this.nominalU.set(this.plan.subarray(NU));
    this.nominalU.set(this.plan.subarray((N - 1) * NU), (N - 1) * NU);
  }

  /** Rolls the inputs out from x0; with `ocp`, also stores the linearization A_k, B_k in it. */
  private rollout(x0: Float64Array, inputs: Float64Array, out: Float64Array, ocp?: OcpQp): void {
    const N = this.horizon;
    out.set(x0, 0);
    const x = new Float64Array(NX);
    const next = new Float64Array(NX);
    for (let k = 0; k < N; k++) {
      x.set(out.subarray(k * NX, (k + 1) * NX));
      const kappa = this.road.pointAt(x[S] ?? 0, this.point).curvature;
      const mu = this.frictionAt(x[S] ?? 0);
      const u = inputs.subarray(k * NU, (k + 1) * NU);
      if (ocp) {
        this.model.discretize(
          x,
          u,
          kappa,
          mu,
          this.settings.steps[k] ?? 0,
          next,
          ocp.a.subarray(k * NX * NX, (k + 1) * NX * NX),
          ocp.b.subarray(k * NX * NU, (k + 1) * NX * NU),
        );
      } else {
        this.model.discretize(x, u, kappa, mu, this.settings.steps[k] ?? 0, next);
      }
      out.set(next, (k + 1) * NX);
    }
  }

  /** Writes the step's costs and rows over the stage variables of `ocp`. */
  private buildOcp(ocp: OcpQp): void {
    const N = this.horizon;
    const p = this.params;
    const st = this.settings;
    const sc = st.scales;
    const x = (k: number, state: number) => this.nominalX[(k + 1) * NX + state] ?? 0;
    const ubar = (k: number, i: number) => this.nominalU[k * NU + i] ?? 0;
    const at = (k: number, state: number) => ocp.state(k, state);

    // Slacks: one per stage for the corridor, one per block of stages for the envelope.
    const corridorSlack = Array.from({ length: N }, (_, k) => ocp.addSlack(k));
    const envelopeSlack = Array.from({ length: Math.ceil(N / ENVELOPE_BLOCK) }, (_, b) =>
      ocp.addSlack(Math.min(N - 1, (b + 1) * ENVELOPE_BLOCK - 1)),
    );
    const envelope = (k: number) => envelopeSlack[Math.floor(k / ENVELOPE_BLOCK)] ?? 0;

    for (let k = 0; k < N; k++) {
      const dt = st.steps[k] ?? 0;
      const w = dt * (k === N - 1 ? st.terminalWeight : 1);
      this.reference.at(x(k, S), this.ref);
      ocp.addSquare([at(k, EY)], [1], x(k, EY) - this.ref.ey, w / (sc.ey * sc.ey));
      ocp.addSquare([at(k, EPSI)], [1], x(k, EPSI), w / (sc.epsi * sc.epsi));
      ocp.addSquare([at(k, VX)], [1], x(k, VX) - this.ref.speed, w / (sc.speed * sc.speed));

      // Effort and rates on the inputs themselves.
      const effort = [sc.steer, sc.accel];
      const rate = [sc.steerRate, sc.jerk];
      for (let i = 0; i < NU; i++) {
        const we = dt / ((effort[i] ?? 1) * (effort[i] ?? 1));
        ocp.addSquare([ocp.input(k, i)], [1], ubar(k, i), we);
        const wr = dt / ((rate[i] ?? 1) * (rate[i] ?? 1) * dt * dt);
        const previous = k === 0 ? (this.lastApplied[i] ?? 0) : ubar(k - 1, i);
        const v = ubar(k, i) - previous;
        if (k === 0) ocp.addSquare([ocp.input(k, i)], [1], v, wr);
        else ocp.addSquare([ocp.input(k, i), ocp.input(k - 1, i)], [1, -1], v, wr);
      }
    }
    for (let j = 0; j < ocp.slacks; j++) {
      ocp.addQuadratic(ocp.slack(j), ocp.slack(j), 2 * st.slackQuadratic);
      ocp.addLinear(ocp.slack(j), st.slackLinear);
    }

    // Hard input bounds and rates.
    const lower = [-p.steerMax, p.accelMin];
    const upper = [p.steerMax, p.accelMax];
    const rateMax = [p.steerRateMax, st.accelRateMax];
    for (let k = 0; k < N; k++) {
      const dt = st.steps[k] ?? 0;
      for (let i = 0; i < NU; i++) {
        const input = ocp.input(k, i);
        const bound = rowKey(ROW_KIND.BOUND, k, i);
        ocp.addRow([input], [1], (lower[i] ?? 0) - ubar(k, i), (upper[i] ?? 0) - ubar(k, i), bound);
        const previous = k === 0 ? (this.lastApplied[i] ?? 0) : ubar(k - 1, i);
        const limit = (rateMax[i] ?? 0) * dt;
        const v = ubar(k, i) - previous;
        const rate = rowKey(ROW_KIND.RATE, k, i);
        if (k === 0) ocp.addRow([input], [1], -limit - v, limit - v, rate);
        else ocp.addRow([input, ocp.input(k - 1, i)], [1, -1], -limit - v, limit - v, rate);
      }
    }

    // Soft corridor on the four body corners: e_c = e_y + x_c·sin e_ψ + y_c·cos e_ψ, linearized in e_ψ.
    for (let k = 0; k < N; k++) {
      const ey = x(k, EY);
      const epsi = x(k, EPSI);
      const cos = Math.cos(epsi);
      const sin = Math.sin(epsi);
      for (let c = 0; c < CORNERS; c++) {
        const xc = this.cornerX[c] ?? 0;
        const yc = this.cornerY[c] ?? 0;
        const value = ey + xc * sin + yc * cos;
        const slope = xc * cos - yc * sin;
        this.corridor.bounds(x(k, S) + xc * cos - yc * sin, this.bounds);
        const index = [at(k, EY), at(k, EPSI), corridorSlack[k] ?? 0];
        const key = rowKey(ROW_KIND.CORRIDOR, k, c);
        if (yc > 0) {
          const room = this.bounds.left - st.corridorMargin - value;
          if (room > SCREEN_CORRIDOR) continue;
          ocp.addRow(index, [1, slope, -1], -Infinity, room, key);
        } else {
          const room = this.bounds.right + st.corridorMargin - value;
          if (room < -SCREEN_CORRIDOR) continue;
          ocp.addRow(index, [1, slope, 1], room, Infinity, key);
        }
      }
    }

    // Soft friction ellipse: (a_x/A_x)·cos θ + (a_y/A_y)·sin θ ≤ 1 on facets around the predicted direction,
    // with a_y ≈ vx·r linearized. A_y is also bounded by the rollover limit. μ is the stage's.
    const muAt = (k: number) => this.frictionAt(x(k, S));
    for (let k = 0; k < N; k++) {
      const mu = muAt(k);
      const axLimit = mu * GRAVITY;
      const ayLimit = Math.min(mu * GRAVITY, rolloverAccel(p));
      const vx = x(k, VX);
      const r = x(k, R);
      const ax = x(k, AX);
      const ay = vx * r;
      if (Math.hypot(ax / axLimit, ay / ayLimit) < SCREEN_SHARE) continue;
      const heading = Math.atan2(ay / ayLimit, ax / axLimit);
      FACETS.forEach((offset, f) => {
        const th = heading + offset;
        const cx = Math.cos(th) / axLimit;
        const cy = Math.sin(th) / ayLimit;
        ocp.addRow(
          [at(k, AX), at(k, VX), at(k, R), envelope(k)],
          [cx, cy * r, cy * vx, -1],
          -Infinity,
          1 - (cx * ax + cy * ay),
          rowKey(ROW_KIND.FRICTION, k, f),
        );
      });
    }

    // Soft stability envelope, normalized by its limits: |α_r| ≤ α_lim, |r| ≤ μ·g/vx, on the stage's μ.
    for (let k = 0; k < N; k++) {
      const mu = muAt(k);
      const alphaLimit = this.model.rearSlipLimit(mu);
      const vx = Math.max(x(k, VX), 1);
      const vy = x(k, VY);
      const r = x(k, R);
      const nr = vy - p.lr * r;
      const alpha = Math.atan(nr / vx);
      const den = vx * vx + nr * nr;
      const dVy = vx / den;
      const dR = (-p.lr * vx) / den;
      const dVx = x(k, VX) > 1 ? -nr / den : 0;
      const yawLimit = (mu * GRAVITY) / vx;
      const limits = [
        {
          kind: ROW_KIND.SLIP,
          index: [at(k, VY), at(k, R), at(k, VX)],
          coeff: [dVy / alphaLimit, dR / alphaLimit, dVx / alphaLimit],
          value: alpha / alphaLimit,
        },
        { kind: ROW_KIND.YAW, index: [at(k, R)], coeff: [1 / yawLimit], value: r / yawLimit },
      ];
      for (const { kind, index, coeff, value } of limits) {
        if (Math.abs(value) < SCREEN_SHARE) continue;
        const slack = envelope(k);
        ocp.addRow([...index, slack], [...coeff, -1], -Infinity, 1 - value, rowKey(kind, k, 0));
        ocp.addRow([...index, slack], [...coeff, 1], -1 - value, Infinity, rowKey(kind, k, 1));
      }
    }

    // Soft g-g limit on the road's demand (the roadDemand option): following the road takes a lateral acceleration
    // vx²·|κ|, within a share of the stage's limit. Once the model's tires saturate (ice ahead), the plan's own
    // a_y = vx·r stays within μ·g whatever the speed and the rows above cannot ask for braking; this one can,
    // before the stage is reached: vx ≤ v_lim = √(share·A_y/|κ|), normalized by v_lim, on the envelope slack.
    // None on a straight road.
    for (let k = 0; k < N && this.roadDemand; k++) {
      const kappa = Math.abs(this.road.pointAt(x(k, S), this.point).curvature);
      if (kappa < 1e-9) continue;
      const mu = muAt(k);
      const limit = Math.sqrt((this.constraints.pathFrictionShare * Math.min(mu * GRAVITY, rolloverAccel(p))) / kappa);
      const ratio = x(k, VX) / limit;
      if (ratio * ratio < SCREEN_SHARE) continue;
      ocp.addRow(
        [at(k, VX), envelope(k)],
        [1 / limit, -1],
        -Infinity,
        1 - ratio,
        rowKey(ROW_KIND.FRICTION, k, FACETS.length),
      );
    }

    const firstNew = ocp.slacks;
    if (this.standstill) this.addStandstill(ocp);
    this.addObstacles(ocp);
    if (this.terminal) this.addTerminal(ocp);

    // Slack variables are non-negative.
    for (let j = 0; j < ocp.slacks; j++) {
      const index = j < firstNew ? (j < N ? 0 : 1) : j;
      ocp.addRow([ocp.slack(j)], [1], 0, Infinity, rowKey(ROW_KIND.SLACK, ocp.slackStage[j] ?? 0, index));
    }
  }

  /** A slack of the groups below, with its L1 + L2 cost: created only when one of its rows exists. */
  private newSlack(ocp: OcpQp, stage: number): number {
    const v = ocp.addSlack(stage);
    ocp.addQuadratic(v, v, 2 * this.settings.slackQuadratic);
    ocp.addLinear(v, this.settings.slackLinear);
    return v;
  }

  /** Nominal value of a state at stage k: x_{k+1}, the state after step k. */
  private nominal(k: number, state: number): number {
    return this.nominalX[(k + 1) * NX + state] ?? 0;
  }

  /**
   * vx ≥ −STANDSTILL_FLOOR, soft (one slack for the horizon). The nonlinear rollouts hold at rest
   * (PredictionModel.standstillHold), but the QP's linearization of a stage that is still moving does not: without
   * this row its solution could plan through zero, and the next rollout would hold at an unplanned place. A stage
   * the nominal plan holds at rest takes none (its vx does not move in the QP). Screened on what one QP step can
   * reach, not on the nominal speed alone (the first plan's nominal is a constant cruise): a stage takes the row when
   * the hardest braking command from the plan's start, through the acceleration lag τ, could bring its speed under
   * the screen,
   *   v_min(t) = vx_0 + a_min·t + (a_x,0 − a_min)·τ·(1 − e^(−t/τ)),
   * the lowest speed of the linearized model whatever the plan (its rate limits and the r·vy coupling aside).
   */
  private addStandstill(ocp: OcpQp): void {
    const N = this.horizon;
    const aMin = this.params.accelMin;
    const lag = this.model.accelLag;
    const v0 = this.nominalX[VX] ?? 0;
    const a0 = this.nominalX[AX] ?? 0;
    let slack = -1;
    let t = 0;
    for (let k = 0; k < N; k++) {
      t += this.settings.steps[k] ?? 0;
      const lowest = v0 + aMin * t + (a0 - aMin) * lag * (1 - Math.exp(-t / lag));
      if (lowest >= this.constraints.standstillScreen) continue;
      if (this.heldAt(ocp, k)) continue;
      const vx = this.nominal(k, VX);
      if (slack < 0) slack = this.newSlack(ocp, N - 1);
      ocp.addRow(
        [ocp.state(k, VX), slack],
        [1, 1],
        -vx - STANDSTILL_FLOOR,
        Infinity,
        rowKey(ROW_KIND.STANDSTILL, k, 0),
      );
    }
  }

  /** Whether the nominal plan is held at rest after step k: no state or input of the QP moves its vx. */
  private heldAt(ocp: OcpQp, k: number): boolean {
    if (this.nominal(k, VX) !== 0) return false;
    const a = ocp.a.subarray((k * NX + VX) * NX, (k * NX + VX + 1) * NX);
    const b = ocp.b.subarray((k * NX + VX) * NU, (k * NX + VX + 1) * NU);
    return a.every((v) => v === 0) && b.every((v) => v === 0);
  }

  /**
   * The obstacles' half-planes (mpc/obstacles.ts): each track predicted at constant velocity from its own tick to
   * each stage's time, both discs of the body against its box inflated by the disc radius and the margin,
   * linearized at the nominal plan in s, e_y and e_ψ; soft, one slack per track and block of ENVELOPE_BLOCK
   * stages. Screened by the nominal clearance, widened by how far one QP can move the stage: ½·a_reach·t², with
   * a_reach the larger of the command's range (accelMax − accelMin) and g, t the stage's time from the plan's start.
   * The side's windows are widened by the same reach, with the box's tangent half-plane in the widening
   * (obstacleHalfPlane).
   */
  private addObstacles(ocp: OcpQp): void {
    const tracks = this.stepTracks;
    if (tracks.length === 0) return;
    const N = this.horizon;
    const p = this.params;
    const cs = this.constraints;
    const { offsets, radius } = this.discs;
    const inflation = radius + cs.obstacleMargin;
    const reach = 0.5 * Math.max(p.accelMax - p.accelMin, GRAVITY);
    const blocks = Math.ceil(N / ENVELOPE_BLOCK);
    const slacks = new Array<number>(tracks.length * blocks).fill(-1);
    const ages = this.trackAges;
    // Which discs are already ahead of each obstacle's center at the plan's start.
    const s0 = this.nominalX[S] ?? 0;
    const cos0 = Math.cos(this.nominalX[EPSI] ?? 0);
    const ahead = tracks.map((track, i) => {
      predictTrack(track, ages[i] ?? 0, this.center);
      return offsets.map((o) => s0 + o * cos0 > this.center.s);
    });
    const hp = this.halfPlane;
    let t = 0;
    for (let k = 0; k < N; k++) {
      const dt = this.settings.steps[k] ?? 0;
      t += dt;
      const move = reach * t * t;
      const screen = cs.obstacleScreen + move;
      const s = this.nominal(k, S);
      const ey = this.nominal(k, EY);
      const epsi = this.nominal(k, EPSI);
      const cos = Math.cos(epsi);
      const sin = Math.sin(epsi);
      // Half the stage's travel: 'left' and 'right' reach that much beyond the box, so no stage steps over it.
      const travel = 0.5 * Math.abs(this.nominal(k, VX)) * dt;
      const block = Math.floor(k / ENVELOPE_BLOCK);
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i]!;
        const side = this.sideById.get(track.id) ?? this.side;
        predictTrack(track, (ages[i] ?? 0) + t, this.center);
        for (let d = 0; d < offsets.length; d++) {
          const o = offsets[d]!;
          const view: DiscView = {
            ds: s + o * cos - this.center.s,
            dey: ey + o * sin - this.center.ey,
            hs: track.length / 2,
            hey: track.width / 2,
            inflation,
            buffer: side === 'stop' ? 0 : travel,
            reach: move,
            ahead: ahead[i]![d]!,
          };
          if (!obstacleHalfPlane(side, view, hp) || hp.clearance >= screen) continue;
          const slot = i * blocks + block;
          if (slacks[slot]! < 0) slacks[slot] = this.newSlack(ocp, Math.min(N - 1, (block + 1) * ENVELOPE_BLOCK - 1));
          // δ(n·p_d) = n_s·(δs − o·sin e_ψ·δe_ψ) + n_ey·(δe_y + o·cos e_ψ·δe_ψ).
          const index: number[] = [];
          const coeff: number[] = [];
          if (hp.ns !== 0) {
            index.push(ocp.state(k, S));
            coeff.push(hp.ns);
          }
          if (hp.ney !== 0) {
            index.push(ocp.state(k, EY));
            coeff.push(hp.ney);
          }
          index.push(ocp.state(k, EPSI), slacks[slot]!);
          coeff.push(o * (hp.ney * cos - hp.ns * sin), 1);
          ocp.addRow(index, coeff, -hp.clearance, Infinity, rowKey(ROW_KIND.OBSTACLE, k, 2 * i + d));
          this.obstacleRows++;
        }
      }
    }
  }

  /**
   * Terminal braking feasibility: on ice the stopping distance is longer than the horizon. At the last
   * stage the speed must allow stopping before the nearest obstacle in the path beyond the horizon end, at the
   * deceleration a(s) = min(η·μ(s)·g, −accelMin) along the friction preview. In metres,
   *   g(v, s) = v²/(2·a(s̄)) − ∫_s^{s_stop} a / a(s̄) ≤ 0, linearized: (v̄/a(s̄))·δv_N + δs_N − σ ≤ −g(v̄, s̄),
   * soft with one slack σ. An obstacle is in the path when:
   * - its side is 'avoid' or 'stop' (a pass on a side commits to going by it: the decision layer judges that);
   * - it is ahead of the front disc within terminalRange: at the horizon end for one coming closer, at the plan's
   *   start for one moving away (its constant-velocity place at the horizon end is not where it may be then);
   * - the band it may be in across the road, widened by its half width, the disc radius and the margin, covers the
   *   vehicle's e_y at the horizon end: for one coming closer, the band it sweeps from the horizon end until the
   *   vehicle could stop (v̄/a); for one moving away, from its e_y at the plan's start to its e_y where it would
   *   stop braking now (its lateral speed shed over the same stop), the place its stop point assumes.
   * The stop point is where the front disc would touch the inflated box. An obstacle moving away may brake at any
   * time: it is taken where it would stop braking now, at the full μ·g of the road where it is, from its reported
   * state (the earliest it can stop, whatever its age). One coming closer is taken where it will be when the
   * vehicle could stop. The tightest obstacle gives the row.
   */
  private addTerminal(ocp: OcpQp): void {
    const tracks = this.stepTracks;
    if (tracks.length === 0) return;
    const N = this.horizon;
    const k = N - 1;
    const cs = this.constraints;
    const v = this.nominal(k, VX);
    if (!(v > 0)) return;
    const s = this.nominal(k, S);
    const ey = this.nominal(k, EY);
    const offset = this.discs.offsets[0];
    const front = s + offset * Math.cos(this.nominal(k, EPSI));
    const front0 = (this.nominalX[S] ?? 0) + offset * Math.cos(this.nominalX[EPSI] ?? 0);
    const inflation = this.discs.radius + cs.obstacleMargin;
    const maxDecel = -this.params.accelMin;
    // frictionAt never goes below MU_FLOOR, so a(s) > 0 and every term below stays finite.
    const decel = (at: number) => Math.min(cs.brakeEfficiency * this.frictionAt(at) * GRAVITY, maxDecel);
    const a = decel(s);
    const stopTime = v / a;
    let horizon = 0;
    for (const dt of this.settings.steps) horizon += dt;
    let gap = -Infinity;
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]!;
      const side = this.sideById.get(track.id) ?? this.side;
      if (side !== 'avoid' && side !== 'stop') continue;
      const age = this.trackAges[i] ?? 0;
      let at: number;
      let lo: number;
      let hi: number;
      if (track.vs > 0) {
        // Its stop point if it brakes now, and its e_y there (the lateral speed shed over the same stop), with
        // its e_y at the plan's start: the band it may be in when the vehicle reaches it.
        const brake = this.frictionAt(track.s) * GRAVITY;
        at = track.s + (track.vs * track.vs) / (2 * brake);
        const stopEy = track.ey + (track.vey * track.vs) / (2 * brake);
        predictTrack(track, age, this.later);
        lo = Math.min(this.later.ey, stopEy);
        hi = Math.max(this.later.ey, stopEy);
        if (this.later.s <= front0 || at - front > cs.terminalRange) continue;
      } else {
        const end = age + horizon;
        predictTrack(track, end, this.center);
        predictTrack(track, end + stopTime, this.later);
        lo = Math.min(this.center.ey, this.later.ey);
        hi = Math.max(this.center.ey, this.later.ey);
        if (this.center.s <= front || this.center.s - front > cs.terminalRange) continue;
        at = this.later.s;
      }
      const reach = track.width / 2 + inflation;
      if (ey < lo - reach || ey > hi + reach) continue;
      const stopAt = at - track.length / 2 - inflation;
      const room = brakingRoom(decel, s, s + (stopAt - front), cs.terminalStep);
      gap = Math.max(gap, (v * v) / (2 * a) - room / a);
    }
    if (gap === -Infinity) return;
    this.terminalGap = gap;
    const slack = this.newSlack(ocp, k);
    const key = rowKey(ROW_KIND.TERMINAL, k, 0);
    ocp.addRow([ocp.state(k, VX), ocp.state(k, S), slack], [v / a, 1, -1], -Infinity, -gap, key);
  }

  /** Keeps the plan inside the hard input bounds, whatever the solver returned. */
  private clampPlan(): void {
    const p = this.params;
    for (let k = 0; k < this.horizon; k++) {
      const steer = this.plan[k * NU] ?? 0;
      const accel = this.plan[k * NU + 1] ?? 0;
      this.plan[k * NU] = Math.min(p.steerMax, Math.max(-p.steerMax, steer));
      this.plan[k * NU + 1] = Math.min(p.accelMax, Math.max(p.accelMin, accel));
    }
  }
}
