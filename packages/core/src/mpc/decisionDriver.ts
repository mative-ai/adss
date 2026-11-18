/**
 * The MPC with the decision layer as the driver of the plant. Every control
 * cycle (20 Hz) it observes the state in road coordinates and predicts it by the computation delay with the command
 * in force, as MpcDriver does; reads the tracks once; solves the candidate maneuvers (mpc/branches.ts), each an
 * MpcController with its own plan and solver, from that same state; measures each plan's rollout by the common
 * decision cost (mpc/selector.ts); and applies the first input of the maneuver the hysteresis keeps.
 *
 * - The evasions' MPC rows see each track moving across the road twice: as reported and held where it was reported
 *   (mpc/obstacles.ts withHeldCopies), so a crossing obstacle that may stop in the lane keeps its rows there. B0's
 *   rows see the tracks as reported (the single maneuver of tranche 1), B1 has no obstacle rows (mpc/branches.ts);
 *   the decision cost judges every candidate on the whole band an obstacle may sweep (mpc/selector.ts).
 * - Every candidate plans in the road's corridor, B0 as the single maneuver of tranche 1: a μ-split stop needs the
 *   room (on `mu-split` the single maneuver stops 1.28 m off the lane's center, its wheels off the ice). In the ego
 *   lane's corridor B0 hit the car there at 31 to 34 km/h on each of seeds 1 to 10, where the single maneuver stops
 *   in 4 and hits at most at 17 km/h; the M5 sweeps came out the same in either corridor. A B0 that swerves into the
 *   opposite lane pays the decision cost's lane term.
 * - A candidate solved in the previous cycle starts from its own plan (the RTI shift), one not solved then starts
 *   cold from the command in force (MpcController.reset). A candidate that was solved but not applied still takes its
 *   own first input as the command in force for its rate rows (MpcController keeps it private): see the integration
 *   notes of Phase 3 for the setter that would align it. Until then, at a switch to such a candidate whose first
 *   steering input breaks the MPC's steering rate row from the command in force, the candidate is planned again cold
 *   from the command in force (one more QP, while the cycle stays within MAX_CYCLE_QPS; `replanned` in the report),
 *   and the command applied is always held within the MPC's rate rows from the command in force (steerRateMax·period
 *   and accelRateMax·period). Without that a switch moved the command by up to 4 times the steering row in one cycle
 *   on `moose`, 6.3 m/s² and 0.22 rad on `mu-split` and `moose` before the lane maneuvers were held. Only clamping the
 *   command, without the new plan, left the evasion planning from a steering it had not applied, and 2 more of 100
 *   seeds of `moose` hit the moose at 16.4 m/s.
 * - While B1 is in force and its rollout predicts a contact, the brake command applied never eases off: the lower of
 *   the plan's and the one in force (the impact energy can only grow if it does). B1's plan, made without obstacle
 *   rows, gave up braking for the yaw on `mu-split` (−9 to 0 m/s² in 0.6 s) and hit the car at 10.3 m/s where B0
 *   stops; with the hold, 59 of 100 seeds hit there, against 60 for the single maneuver of tranche 1, at most at
 *   4.8 m/s like it (2.1 m/s on average over the 100 seeds, 2.2 for it), and none switches twice.
 * - Point of no return of an evasion: the vehicle can no longer stop before the target's inflated box, braking in its
 *   lane at min(stopShare·μ·g, −accelMin) from the planning state (v²/(2·a) ≥ the gap): aborting the evasion then
 *   ends in contact, finishing it does not. Past it the evasion is locked until the rear disc has left the box, or the
 *   target is no longer tracked.
 * - Fallbacks: without a feasible candidate the current lane maneuver is kept or B1 takes over from B0 on a lower
 *   impact energy (without the 12 % margin when no evasion has a gap either), and an infeasible evasion gives way to
 *   the candidate with the lowest impact energy (reason `noFeasible`; the selector's rules); when the chosen
 *   candidate's solver failed, the minimum-risk maneuver is applied for the cycle: −μ(s)·g (the ABS holds the wheels
 *   at their peak), steering by a Stanley law to the lane's center with the road's curvature as feed-forward (reason
 *   `solverFailed`). It is an emergency command, not bound by the MPC's rate rows.
 *
 * `lastDecision` holds the cycle's verdict for the interface and the worker protocol's future `decision` message:
 * codes and numbers only, the copy lives in the app.
 */
import { wrapAngle } from '../math/angle.ts';
import type { QpStatus } from '../qp/problem.ts';
import type { Projection, RoadPath, RoadPoint } from '../road/path.ts';
import type { FrictionPreview, LaneGeometry, ObstacleTrack, TrackSource } from '../sensors/views.ts';
import type { Controller } from '../sim/closedLoop.ts';
import { TICK_HZ } from '../sim/clock.ts';
import type { DriverCommand } from '../vehicle/actuators.ts';
import { GRAVITY, wheelbase, type VehicleParams } from '../vehicle/params.ts';
import { CHASSIS } from '../vehicle/plant.ts';
import type { Vehicle } from '../vehicle/vehicle.ts';
import {
  BRANCH_DEFAULTS,
  BRANCH_IDS,
  BrakeReference,
  brakeDecel,
  EvadeReference,
  pathObstacles,
  type BranchGeometry,
  type BranchId,
  type BranchSettings,
  type PathAnalysis,
  type PathObstacle,
} from './branches.ts';
import { NU, NX, STATE } from './model.ts';
import {
  defaultMpcSettings,
  defaultStepSolver,
  MPC_CONSTRAINT_DEFAULTS,
  MpcController,
  type Corridor,
  type MpcConstraintSettings,
  type MpcPlan,
  type MpcSettings,
  type Reference,
} from './mpc.ts';
import { heldSource, withHeldCopies } from './obstacles.ts';
import {
  DECISION_SCALES,
  DECISION_WEIGHTS,
  DecisionSelector,
  evaluateCandidate,
  type CandidateEvaluation,
  type DecisionContext,
  type DecisionFallback,
  type DecisionReason,
  type DecisionScales,
  type DecisionTerms,
  type DecisionWeights,
} from './selector.ts';
import type { StepSolver } from './stepSolver.ts';

/** One candidate in a decision report. */
export interface CandidateReport {
  readonly id: BranchId;
  readonly status: QpStatus;
  readonly iterations: number;
  readonly feasible: boolean;
  readonly cost: number;
  readonly terms: DecisionTerms;
  /** J; 0 when feasible. */
  readonly impactEnergy: number;
  readonly contactTime: number | null;
  readonly minClearance: number | null;
  readonly minTtc: number | null;
  /** For B2 and B3: the e_y the evasion passes the target at, m. */
  readonly offset: number | null;
}

/** The decision of one control cycle. */
export interface DecisionReport {
  /** The control tick (the plan starts delayTicks later). */
  readonly tick: number;
  /** The maneuver in force. */
  readonly chosen: BranchId;
  /** The candidates solved this cycle, in B0–B3 order. */
  readonly candidates: readonly CandidateReport[];
  readonly switched: boolean;
  readonly locked: boolean;
  readonly fallback: DecisionFallback;
  readonly reason: DecisionReason;
  /** Whether an event is under way (an obstacle in the path, or one in the last SWITCH_CYCLES − 1 cycles). */
  readonly event: boolean;
  /** The obstacle B2 and B3 pass (the nearest in the path), by its track id. */
  readonly target: string | null;
  readonly challenger: BranchId | null;
  readonly challengeCycles: number;
  /**
   * The chosen candidate was planned again from the command in force before its first input was applied: it was solved
   * in the previous cycle without being applied (a switch to it), so its plan had started from its own command.
   */
  readonly replanned: boolean;
  /** The command applied: the chosen plan's first input, or the minimum-risk maneuver's. */
  readonly command: { readonly steer: number; readonly accel: number };
}

export interface DecisionDriverOptions {
  /** Control period, ticks: 50 at 1 kHz is 20 Hz. */
  readonly periodTicks?: number;
  /** Computation delay, ticks (configuration, not a measured time). */
  readonly delayTicks?: number;
  readonly settings?: MpcSettings;
  readonly constraints?: Partial<MpcConstraintSettings>;
  /** A step solver for each candidate, one instance each; the MPC's default when absent. */
  readonly solver?: (branch: BranchId) => StepSolver;
  readonly friction?: FrictionPreview;
  readonly tracks?: TrackSource;
  /** MpcOptions.standstill and roadDemand, on by default as in the scenario runs. */
  readonly standstill?: boolean;
  readonly roadDemand?: boolean;
  /** The candidates allowed, `keep` always among them (['keep', 'brake'] is braking in the lane alone). */
  readonly maneuvers?: readonly BranchId[];
  /** Held copies of the crossing tracks in the evasions' MPC rows (withHeldCopies); on by default. */
  readonly hold?: boolean;
  readonly branch?: Partial<BranchSettings>;
  readonly scales?: Partial<DecisionScales>;
  readonly weights?: Partial<DecisionWeights>;
  /** Called with every cycle's report (the CLI's summary, the tests). */
  readonly onDecision?: (report: DecisionReport) => void;
}

/** A track source the driver fills once per cycle, so every candidate reads the same tracks. */
class CycleTracks implements TrackSource {
  current: readonly ObstacleTrack[] = [];
  tracks(): readonly ObstacleTrack[] {
    return this.current;
  }
}

interface Branch {
  readonly id: BranchId;
  readonly mpc: MpcController;
  readonly brake: BrakeReference | null;
  readonly evade: EvadeReference | null;
  solved: boolean;
  /** Solved this cycle from its own previous plan (the RTI shift), not from the command in force. */
  warm: boolean;
  plan: MpcPlan | undefined;
}

/** The most QPs one control cycle solves, the replanning of a switch included (Phase 3: at most 4 candidates). */
export const MAX_CYCLE_QPS = 4;

/** Stanley gain of the minimum-risk maneuver's steering, 1/s, and its softening speed, m/s. */
const SAFE_STANLEY_GAIN = 1;
const SAFE_STANLEY_SOFTENING = 1;

export class DecisionDriver implements Controller {
  readonly periodTicks: number;
  readonly delayTicks: number;
  /** The last cycle's decision. */
  lastDecision: DecisionReport | undefined;
  readonly selector = new DecisionSelector();
  readonly geometry: BranchGeometry;
  readonly branchSettings: BranchSettings;
  private readonly branches: Branch[];
  private readonly road: RoadPath;
  private readonly reference: Reference;
  private readonly params: VehicleParams;
  private readonly source: TrackSource | undefined;
  /** The tracks as reported (B0), and with the held copies (the evasions), filled once per cycle. */
  private readonly reported = new CycleTracks();
  private readonly held = new CycleTracks();
  /** The tracks in the path in the previous cycle (pathObstacles' `sticky`). */
  private readonly inPath = new Set<string>();
  private readonly ages: number[] = [];
  private readonly hold: boolean;
  private readonly horizon: number;
  private readonly steps: readonly number[];
  private readonly accelRate: number;
  private readonly scales: DecisionScales;
  private readonly weights: DecisionWeights;
  private readonly onDecision: ((report: DecisionReport) => void) | undefined;
  private readonly projection: Projection = { s: 0, ey: 0, heading: 0, curvature: 0, index: -1 };
  private readonly point: RoadPoint = { x: 0, y: 0, heading: 0, curvature: 0 };
  private readonly ref = { ey: 0, speed: 0 };
  private readonly state = new Float64Array(NX);
  private readonly predicted = new Float64Array(NX);
  private readonly inForce = new Float64Array(NU);
  /** The candidate whose first input was applied unchanged in the last cycle (its own command in force is right). */
  private appliedId: BranchId | null = null;
  /** The evaded target's track id while an evasion is current. */
  private lockTarget: string | null = null;

  constructor(
    params: VehicleParams,
    mu: number,
    road: RoadPath,
    corridor: Corridor,
    reference: Reference,
    lane: LaneGeometry,
    options: DecisionDriverOptions = {},
  ) {
    this.periodTicks = options.periodTicks ?? 50;
    this.delayTicks = options.delayTicks ?? 50;
    this.params = params;
    this.road = road;
    this.reference = reference;
    this.source = options.tracks;
    this.hold = options.hold ?? true;
    this.onDecision = options.onDecision;
    this.branchSettings = { ...BRANCH_DEFAULTS, ...options.branch };
    this.scales = { ...DECISION_SCALES, ...options.scales };
    this.weights = { ...DECISION_WEIGHTS, ...options.weights };
    const settings = options.settings ?? defaultMpcSettings(params);
    this.steps = settings.steps;
    this.accelRate = settings.accelRateMax;
    let horizon = 0;
    for (const dt of settings.steps) horizon += dt;
    this.horizon = horizon;
    const brakeSettings: MpcSettings = {
      ...settings,
      scales: { ...settings.scales, speed: this.branchSettings.brakeSpeedScale },
    };
    const evadeSettings: MpcSettings = {
      ...settings,
      scales: { ...settings.scales, ...this.branchSettings.evadeScales },
    };
    const allowed = new Set<BranchId>(options.maneuvers ?? BRANCH_IDS);
    allowed.add('keep');
    const constraints = { ...MPC_CONSTRAINT_DEFAULTS, ...options.constraints };
    // Every candidate plans in the road's corridor; B0 sees the tracks as reported, the evasions with their held
    // copies, B1 none (see the module comment).
    this.branches = BRANCH_IDS.filter((id) => allowed.has(id)).map((id) => {
      const brake = id === 'brake' ? new BrakeReference(reference) : null;
      const evade = id === 'left' || id === 'right' ? new EvadeReference(reference) : null;
      const mpc = new MpcController(
        params,
        mu,
        road,
        corridor,
        brake ?? evade ?? reference,
        id === 'brake' ? brakeSettings : evade ? evadeSettings : settings,
        options.solver ? options.solver(id) : defaultStepSolver(),
        {
          ...(options.friction && { friction: options.friction }),
          ...(options.tracks && id !== 'brake' && { tracks: id === 'keep' || !this.hold ? this.reported : this.held }),
          side: 'stop',
          standstill: options.standstill ?? true,
          roadDemand: options.roadDemand ?? true,
          constraints,
        },
      );
      return { id, mpc, brake, evade, solved: false, warm: false, plan: undefined };
    });
    const first = this.branches[0]!.mpc;
    this.geometry = {
      params,
      corridor,
      lane,
      discs: first.discs,
      inflation: first.discs.radius + constraints.obstacleMargin,
      obstacleMargin: constraints.obstacleMargin,
      corridorMargin: settings.corridorMargin,
      friction: { at: (s, ey) => first.frictionAt(s, ey) },
    };
  }

  /** The candidates' controllers, by id (for the tests). */
  controller(id: BranchId): MpcController | undefined {
    return this.branches.find((b) => b.id === id)?.mpc;
  }

  /** The last plan of a candidate (solved in the last cycle or earlier). */
  plan(id: BranchId): MpcPlan | undefined {
    return this.branches.find((b) => b.id === id)?.plan;
  }

  reset(): void {
    this.projection.index = -1;
    this.inForce.fill(0);
    for (const b of this.branches) {
      b.mpc.reset();
      b.solved = false;
      b.warm = false;
      b.plan = undefined;
    }
    this.appliedId = null;
    this.selector.reset();
    this.inPath.clear();
    this.lockTarget = null;
    this.lastDecision = undefined;
  }

  /** The vehicle's state in the prediction model's coordinates (as MpcDriver.observe). */
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
    const first = this.branches[0]!.mpc;
    this.observe(vehicle, this.state);
    const x0 = this.predicted;
    if (this.delayTicks > 0) {
      const s = this.state[STATE.S] ?? 0;
      const kappa = this.road.pointAt(s, this.point).curvature;
      first.model.discretize(this.state, this.inForce, kappa, first.frictionAt(s), this.delayTicks / TICK_HZ, x0);
    } else {
      x0.set(this.state);
    }
    const startTick = tick + this.delayTicks;
    const tracks = this.source ? this.source.tracks() : [];
    const ages = this.ages;
    ages.length = tracks.length;
    for (let i = 0; i < tracks.length; i++) ages[i] = (startTick - tracks[i]!.tick) / TICK_HZ;
    this.reported.current = tracks;
    this.held.current = this.hold ? withHeldCopies(tracks, this.branchSettings.stillLateralSpeed) : tracks;
    const s0 = x0[STATE.S] ?? 0;
    const v0 = Math.max(x0[STATE.VX] ?? 0, 0);
    this.reference.at(s0, this.ref);
    const analysis = pathObstacles(
      { s: s0, ey: x0[STATE.EY] ?? 0, vx: v0, vRange: this.ref.speed },
      tracks,
      ages,
      this.horizon,
      this.geometry,
      this.branchSettings,
      this.inPath,
    );
    this.inPath.clear();
    for (const o of analysis.obstacles) this.inPath.add(o.track.id);
    const event = analysis.obstacles.length > 0;
    this.updateLock(analysis, v0, s0);

    const current = this.selector.current;
    const evaluations: CandidateEvaluation[] = [];
    const reports: CandidateReport[] = [];
    const context: DecisionContext = {
      geometry: this.geometry,
      branch: this.branchSettings,
      steps: this.steps,
      tracks,
      ages,
      referenceSpeed: this.ref.speed,
      scales: this.scales,
      weights: this.weights,
    };
    let qps = 0;
    for (const branch of this.branches) {
      const offset = this.configure(branch, analysis, event, current, s0, v0);
      branch.warm = false;
      if (offset === undefined) {
        branch.solved = false;
        continue;
      }
      if (branch.solved) branch.warm = true;
      else branch.mpc.reset(this.inForce);
      const plan = branch.mpc.step(x0, startTick);
      qps++;
      branch.plan = plan;
      branch.solved = true;
      const evaluation = evaluateCandidate(branch.id, plan, context);
      evaluations.push(evaluation);
      reports.push({
        id: branch.id,
        status: evaluation.status,
        iterations: plan.iterations,
        feasible: evaluation.feasible,
        cost: evaluation.cost,
        terms: evaluation.terms,
        impactEnergy: evaluation.impactEnergy,
        contactTime: evaluation.contactTime,
        minClearance: evaluation.minClearance,
        minTtc: evaluation.minTtc,
        offset,
      });
    }

    const selection = this.selector.decide(evaluations, event);
    if (selection.switched) {
      this.lockTarget =
        selection.chosen === 'left' || selection.chosen === 'right' ? (analysis.target?.track.id ?? null) : null;
      this.updateLock(analysis, v0, s0);
    } else if (selection.chosen === 'keep' || selection.chosen === 'brake') {
      this.lockTarget = null;
    }
    const chosen = this.branches.find((b) => b.id === selection.chosen);
    let replanned = false;
    if (selection.fallback === 'solverFailed' || chosen?.plan === undefined) {
      this.minimumRisk(x0, out);
      this.appliedId = null;
    } else {
      // The MPC's rate rows from the command in force: they hold for a plan made from it. A warm candidate that was not
      // applied planned from its own command as the one in force (see the module comment): when its first input
      // breaks them, it is planned again from the command in force, while the cycle's QPs stay within MAX_CYCLE_QPS.
      const dt = this.periodTicks / TICK_HZ;
      const steer = this.inForce[0] ?? 0;
      const accel = this.inForce[1] ?? 0;
      const steerRate = this.params.steerRateMax * dt;
      const accelRate = this.accelRate * dt;
      const stale = chosen.warm && chosen.id !== this.appliedId;
      if (stale && qps < MAX_CYCLE_QPS && Math.abs((chosen.plan.command[0] ?? 0) - steer) > steerRate) {
        chosen.mpc.reset(this.inForce);
        const plan = chosen.mpc.step(x0, startTick);
        if (plan.status !== 'failed') {
          chosen.plan = plan;
          replanned = true;
        }
      }
      const plan = chosen.plan!;
      out.steer = Math.min(steer + steerRate, Math.max(steer - steerRate, plan.command[0] ?? 0));
      out.accel = Math.min(accel + accelRate, Math.max(accel - accelRate, plan.command[1] ?? 0));
      // B1 in force with a contact predicted: the brake does not ease off (see the module comment).
      const brake = evaluations.find((e) => e.id === 'brake');
      if (chosen.id === 'brake' && brake !== undefined && !brake.feasible) out.accel = Math.min(out.accel, accel);
      this.appliedId = chosen.id;
    }
    this.inForce[0] = out.steer;
    this.inForce[1] = out.accel;
    const report: DecisionReport = {
      tick,
      chosen: selection.chosen,
      candidates: reports,
      switched: selection.switched,
      locked: this.selector.locked,
      fallback: selection.fallback,
      reason: selection.reason,
      event: selection.event,
      target: analysis.target?.track.id ?? null,
      challenger: selection.challenger,
      challengeCycles: selection.challengeCycles,
      replanned,
      command: { steer: out.steer, accel: out.accel },
    };
    this.lastDecision = report;
    this.onDecision?.(report);
  }

  /**
   * Sets a candidate's references and sides for the cycle; returns undefined when it is not solved this cycle, else
   * the evasion's offset (null for B0 and B1).
   */
  private configure(
    branch: Branch,
    analysis: PathAnalysis,
    event: boolean,
    current: BranchId,
    s0: number,
    v0: number,
  ): number | null | undefined {
    const mpc = branch.mpc;
    switch (branch.id) {
      case 'keep':
        return null;
      case 'brake':
        if (!event && current !== 'brake') return undefined;
        branch.brake?.anchor(s0, v0, -this.params.accelMin);
        return null;
      case 'left':
      case 'right': {
        const offset = branch.id === 'left' ? analysis.left : analysis.right;
        const target = analysis.target;
        const evade = branch.evade!;
        if (target !== null && offset !== null) {
          evade.anchor(target, offset, v0, this.geometry, this.branchSettings);
          this.setSides(mpc, target, branch.id);
          return offset;
        }
        // The current evasion goes on without a gap or past its target, on the last anchor.
        if (current !== branch.id || !branch.solved) return undefined;
        if (target !== null) this.setSides(mpc, target, branch.id);
        else mpc.sideById.clear();
        return evade.target;
      }
    }
  }

  /** The target (both its copies) on the evasion's side, every other obstacle 'stop'. */
  private setSides(mpc: MpcController, target: PathObstacle, side: 'left' | 'right'): void {
    mpc.sideById.clear();
    for (const track of this.held.current) {
      if (heldSource(track.id) === target.track.id) mpc.sideById.set(track.id, side);
    }
  }

  /**
   * The point of no return of the current evasion: locked while the vehicle could not stop before the target's
   * inflated box braking in its lane at the stopShare deceleration; released once the box is passed or the target lost.
   */
  private updateLock(analysis: PathAnalysis, v0: number, s0: number): void {
    const current = this.selector.current;
    if ((current !== 'left' && current !== 'right') || this.lockTarget === null) {
      this.selector.setLock(false);
      return;
    }
    const target = analysis.obstacles.find((o) => o.track.id === this.lockTarget);
    if (target === undefined) {
      this.selector.setLock(false);
      return;
    }
    const stop = (v0 * v0) / (2 * brakeDecel(this.geometry, this.branchSettings.stopShare, s0));
    if (this.selector.locked || stop >= target.gap) this.selector.setLock(true);
  }

  /**
   * The minimum-risk maneuver: brake at −μ(s)·g (the plant's ABS holds the wheels near their peak) and keep the lane
   * with a Stanley law on the planning state, the road's curvature as feed-forward.
   */
  private minimumRisk(x0: Float64Array, out: DriverCommand): void {
    const p = this.params;
    const s = x0[STATE.S] ?? 0;
    this.reference.at(s, this.ref);
    const kappa = this.road.pointAt(s, this.point).curvature;
    const v = Math.max(x0[STATE.VX] ?? 0, 0);
    const error = (x0[STATE.EY] ?? 0) - this.ref.ey;
    const steer =
      wheelbase(p) * kappa -
      (x0[STATE.EPSI] ?? 0) -
      Math.atan((SAFE_STANLEY_GAIN * error) / (v + SAFE_STANLEY_SOFTENING));
    out.steer = Math.min(p.steerMax, Math.max(-p.steerMax, steer));
    out.accel = Math.max(p.accelMin, -this.branches[0]!.mpc.frictionAt(s) * GRAVITY);
  }
}

/**
 * The maneuver switches of a run per encounter, by the obstacle's track id: each switch counts for the target in the
 * path at that cycle, or for the last one before it. An encounter spans the whole run, so an event that ends and
 * starts again on the same obstacle stays one encounter: the return to B0 at its end (`clear`) is not a switch, the
 * next switch out of B0 counts in the same encounter. M5's criterion is at most one per encounter.
 */
export function encounterSwitches(reports: readonly DecisionReport[]): Map<string, number> {
  const counts = new Map<string, number>();
  let target: string | null = null;
  for (const report of reports) {
    if (report.target !== null) target = report.target;
    if (report.switched && target !== null) counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  return counts;
}

/** The changes of the maneuver in force over a run, `clear` returns to B0 included, the last one aside. */
export function maneuverChanges(reports: readonly DecisionReport[]): number {
  let changes = 0;
  let previous: BranchId = 'keep';
  for (const report of reports) {
    if (report.chosen !== previous) changes++;
    previous = report.chosen;
  }
  return previous === 'keep' && changes > 0 ? changes - 1 : changes;
}
