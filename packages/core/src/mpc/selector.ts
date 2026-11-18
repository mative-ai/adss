/**
 * The common decision cost, the hysteresis, the point of no return and the fallbacks of the decision layer.
 * Candidates are compared on what their plans would do, never on raw QP
 * costs: each plan's nonlinear rollout (MpcPlan.trajectory, the prediction model from the planning state) is
 * measured against the same obstacles, the same reference speed and the same lane, whatever the candidate's own
 * references and rows.
 *
 * The obstacles are the tracks as the cycle read them, each predicted from its report: along the road at constant
 * velocity, across it over the band from its reported e_y to its constant-velocity e_y (it may stop at any time,
 * mpc/branches.ts obstacleBand). The vehicle is its body's rectangle, as for the run's collisions (sim/scenarioRun.ts);
 * the MPC's rows are written on the two discs that cover it (mpc/obstacles.ts), wider by design.
 *
 * Feasibility: a candidate is infeasible when its rollout touches an obstacle (the body overlaps a box at a stage), or
 * when at the horizon's end it could not stop before an obstacle still in its way, braking at min(stopShare·μ·g,
 * −accelMin) (the MPC's terminal row counts on the same). Its impact energy is ½·m·v_rel² at the first contact (the
 * relative velocity of the vehicle and the obstacle in road coordinates), or ½·m·(v_N² − 2·a·gap) beyond the horizon.
 * A candidate whose solver failed is not ranked.
 *
 * The cost of a feasible candidate, every term dimensionless and Bryson-scaled (the value at its scale costs 1),
 * then weighted (DecisionWeights):
 * - clearance: ((m − d_min)₊ / m)², d_min the smallest body-to-box separation over the rollout (separation), m the
 *   clearance scale;
 * - ttc: ((T − ttc_min)₊ / T)², ttc_min the smallest time to collision along the rollout (stages after the first),
 *   for the body laterally on a box ahead and closing;
 * - comfort: the time average of (a_x/A)² + (a_y/A)² + (j_x/J)² + (j_y/J)², a_y = vx·r, j the rates between stages;
 * - progress: the lost travel over the horizon against the reference speed, (v_ref·T − (s_N − s_0))₊ / (v_ref·T);
 * - lane: the time average of the share of the body's width in the opposite lane (right-hand traffic: left of the
 *   ego lane's left edge);
 * - slack: (σ_max / σ_scale)², the largest slack of the plan's QP.
 */
import type { QpStatus } from '../qp/problem.ts';
import type { ObstacleTrack } from '../sensors/views.ts';
import { GRAVITY, wheelbase, type VehicleParams } from '../vehicle/params.ts';
import { brakeDecel, obstacleBand, type BranchGeometry, type BranchId, type BranchSettings } from './branches.ts';
import { NX, STATE } from './model.ts';
import type { MpcPlan } from './mpc.ts';

const { S, EY, EPSI, VX, VY, R, AX } = STATE;

/** The scales of the cost's terms: the value that costs 1. */
export interface DecisionScales {
  /** Clearance below which the distance term grows, m. */
  readonly clearance: number;
  /** Time to collision below which the TTC term grows, s. */
  readonly ttc: number;
  /** Acceleration, longitudinal and lateral, m/s². */
  readonly accel: number;
  /** Jerk, m/s³. */
  readonly jerk: number;
  /** Largest slack of the QP. */
  readonly slack: number;
}

/** The weights of the cost's terms. */
export interface DecisionWeights {
  readonly clearance: number;
  readonly ttc: number;
  readonly comfort: number;
  readonly progress: number;
  readonly lane: number;
  readonly slack: number;
}

/**
 * The scales. The slack's is wide because the largest slack mixes units (m for the corridor and the obstacles, a share
 * for friction and the envelope): when B0 and B1 planned in the lane's corridor, which a μ-split stop leaves by some
 * 0.5 m, a scale of 0.1 made that slack alone send the stop of `mu-split` into the opposite lane.
 */
export const DECISION_SCALES: DecisionScales = { clearance: 1, ttc: 3, accel: 4, jerk: 10, slack: 0.5 };

/**
 * The weights: the opposite lane weighs most, so that braking in the lane wins wherever it is feasible (M5:
 * evade exactly where braking does not suffice); the clearance next, so that a near miss counts.
 */
export const DECISION_WEIGHTS: DecisionWeights = {
  clearance: 4,
  ttc: 1,
  comfort: 1,
  progress: 1,
  lane: 20,
  slack: 1,
};

/** The terms of a candidate's cost, weighted. */
export interface DecisionTerms {
  readonly clearance: number;
  readonly ttc: number;
  readonly comfort: number;
  readonly progress: number;
  readonly lane: number;
  readonly slack: number;
}

/** A candidate measured by the common decision cost. */
export interface CandidateEvaluation {
  readonly id: BranchId;
  readonly status: QpStatus;
  readonly feasible: boolean;
  /** Sum of the weighted terms (feasible or not: it is reported either way). */
  readonly cost: number;
  readonly terms: DecisionTerms;
  /** ½·m·v_rel² of the first predicted contact, J; 0 when feasible. */
  readonly impactEnergy: number;
  /** Time of the first predicted contact from the plan's start, s; null without one. */
  readonly contactTime: number | null;
  /** Smallest body-to-box separation over the rollout, m (negative in contact); null without obstacles. */
  readonly minClearance: number | null;
  /** Smallest time to collision along the rollout, s; null when never closing on a box ahead. */
  readonly minTtc: number | null;
}

/** What the cost needs besides the plan. */
export interface DecisionContext {
  readonly geometry: BranchGeometry;
  readonly branch: BranchSettings;
  /** The horizon's step durations, s. */
  readonly steps: readonly number[];
  /** The tracks the cycle read (without held copies), and each one's age at the plan's start, s. */
  readonly tracks: readonly ObstacleTrack[];
  readonly ages: readonly number[];
  /** The reference speed at the planning state, m/s. */
  readonly referenceSpeed: number;
  readonly scales: DecisionScales;
  readonly weights: DecisionWeights;
}

const bandOut = { lo: 0, hi: 0 };

/** Body corners for the lane term: x ahead of the center of gravity, y to the left, m. */
function corners(params: VehicleParams): [number, number][] {
  const overhang = (params.length - wheelbase(params)) / 2;
  const front = params.lf + overhang;
  const rear = -(params.lr + overhang);
  const half = params.width / 2;
  return [
    [front, half],
    [rear, half],
    [front, -half],
    [rear, -half],
  ];
}

/**
 * Separation of the body (half sizes hl × hw, heading (cos, sin) to the road) and an obstacle's box aligned with
 * the road (half sizes hs × hey), the body's center at (ds, dey) from the box's, m: the largest gap of the
 * separating-axis test over the four edge normals, negative when they overlap. A lower bound of the distance
 * between them (equal to it when the closest features face each other).
 */
export function separation(
  ds: number,
  dey: number,
  cos: number,
  sin: number,
  hl: number,
  hw: number,
  hs: number,
  hey: number,
): number {
  const c = Math.abs(cos);
  const s = Math.abs(sin);
  // The road's axes, then the body's.
  const gapS = Math.abs(ds) - (hs + hl * c + hw * s);
  const gapEy = Math.abs(dey) - (hey + hl * s + hw * c);
  const along = Math.abs(ds * cos + dey * sin) - (hl + hs * c + hey * s);
  const across = Math.abs(-ds * sin + dey * cos) - (hw + hs * s + hey * c);
  return Math.max(gapS, gapEy, along, across);
}

/** Measures one candidate's plan by the common decision cost. */
export function evaluateCandidate(id: BranchId, plan: MpcPlan, context: DecisionContext): CandidateEvaluation {
  const { geometry, steps, tracks, ages, scales, weights } = context;
  const { params, lane } = geometry;
  const x = plan.trajectory;
  const N = steps.length;
  const at = (k: number, i: number) => x[k * NX + i] ?? 0;
  let horizon = 0;
  for (const dt of steps) horizon += dt;

  const half = params.width / 2;
  const halfLength = params.length / 2;
  // The body's center lies (lf − lr)/2 ahead of the center of gravity (the overhangs split evenly).
  const bodyOffset = (params.lf - params.lr) / 2;
  let minClearance = Infinity;
  let minTtc = Infinity;
  let contactTime: number | null = null;
  let impactEnergy = 0;
  let t = 0;
  for (let k = 0; k <= N; k++) {
    if (k > 0) t += steps[k - 1] ?? 0;
    const epsi = at(k, EPSI);
    const cos = Math.cos(epsi);
    const sin = Math.sin(epsi);
    const bs = at(k, S) + bodyOffset * cos;
    const bey = at(k, EY) + bodyOffset * sin;
    const vs = at(k, VX) * cos - at(k, VY) * sin;
    const vey = at(k, VX) * sin + at(k, VY) * cos;
    // The body's extents along and across the road.
    const extentS = halfLength * Math.abs(cos) + half * Math.abs(sin);
    const extentEy = halfLength * Math.abs(sin) + half * Math.abs(cos);
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]!;
      const time = (ages[i] ?? 0) + t;
      const cs = track.s + track.vs * time;
      obstacleBand(track, time, bandOut, context.branch.stillLateralSpeed);
      const hs = track.length / 2;
      const hey = (bandOut.hi - bandOut.lo) / 2 + track.width / 2;
      const cey = (bandOut.lo + bandOut.hi) / 2;
      const distance = separation(bs - cs, bey - cey, cos, sin, halfLength, half, hs, hey);
      if (distance < minClearance) minClearance = distance;
      if (distance < 0 && contactTime === null) {
        contactTime = t;
        // The whole relative velocity: counting only its component along the contact's normal made a predicted graze
        // of an evasion that falls short cheap, and on `moose` at 14 to 17 m such evasions hit at 15 to 16 m/s where
        // braking hit at 11 to 13.
        const rs = vs - track.vs;
        const rey = vey - track.vey;
        impactEnergy = 0.5 * params.mass * (rs * rs + rey * rey);
      }
      // Time to collision: the body laterally on the box ahead, closing on it.
      if (k > 0 && Math.abs(bey - cey) < extentEy + hey && bs + extentS <= cs - hs) {
        const closing = vs - track.vs;
        const gap = cs - hs - (bs + extentS);
        if (closing > 0.1) minTtc = Math.min(minTtc, gap / closing);
      }
    }
  }

  // Beyond the horizon: can the end state stop before an obstacle still in its way?
  if (contactTime === null) {
    const epsi = at(N, EPSI);
    const cos = Math.cos(epsi);
    const sin = Math.sin(epsi);
    const s = at(N, S);
    const v = at(N, VX) * cos - at(N, VY) * sin;
    if (v > 0) {
      const a = brakeDecel(geometry, context.branch.stopShare, s);
      const stop = (v * v) / (2 * a);
      const bs = s + bodyOffset * cos;
      const bey = at(N, EY) + bodyOffset * sin;
      const front = bs + halfLength * Math.abs(cos) + half * Math.abs(sin);
      const extentEy = halfLength * Math.abs(sin) + half * Math.abs(cos);
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i]!;
        const time = (ages[i] ?? 0) + horizon + v / a;
        // An obstacle moving away is taken where it would stop braking now (the MPC's terminal row does the same).
        const cs =
          track.vs > 0
            ? track.s + (track.vs * track.vs) / (2 * Math.max(geometry.friction.at(track.s), 0.01) * GRAVITY)
            : track.s + track.vs * time;
        obstacleBand(track, time, bandOut, context.branch.stillLateralSpeed);
        const lo = bandOut.lo - track.width / 2 - extentEy;
        const hi = bandOut.hi + track.width / 2 + extentEy;
        if (bey <= lo || bey >= hi) continue;
        const gap = cs - track.length / 2 - front;
        if (gap < 0 || stop <= gap) continue;
        const left = v * v - 2 * a * gap;
        const energy = 0.5 * params.mass * left;
        if (contactTime === null || energy > impactEnergy) {
          contactTime = horizon + (v - Math.sqrt(left)) / a;
          impactEnergy = energy;
        }
      }
    }
  }

  // Comfort, progress and the opposite lane, time-averaged over the horizon.
  let comfort = 0;
  let laneShare = 0;
  const leftEdge = lane.center + lane.width / 2;
  const body = corners(params);
  for (let k = 1; k <= N; k++) {
    const dt = steps[k - 1] ?? 0;
    const ax = at(k, AX);
    const ay = at(k, VX) * at(k, R);
    const jx = (ax - at(k - 1, AX)) / dt;
    const jy = (ay - at(k - 1, VX) * at(k - 1, R)) / dt;
    comfort +=
      dt * ((ax / scales.accel) ** 2 + (ay / scales.accel) ** 2 + (jx / scales.jerk) ** 2 + (jy / scales.jerk) ** 2);
    const ey = at(k, EY);
    const epsi = at(k, EPSI);
    let reach = -Infinity;
    for (const [xc, yc] of body) reach = Math.max(reach, ey + xc * Math.sin(epsi) + yc * Math.cos(epsi));
    laneShare += dt * Math.min(Math.max((reach - leftEdge) / params.width, 0), 1);
  }
  comfort /= horizon;
  laneShare /= horizon;
  const planned = context.referenceSpeed * horizon;
  const progress = planned > 0 ? Math.max(planned - (at(N, S) - at(0, S)), 0) / planned : 0;
  const clearance =
    minClearance === Infinity ? 0 : (Math.max(scales.clearance - minClearance, 0) / scales.clearance) ** 2;
  const ttc = minTtc === Infinity ? 0 : (Math.max(scales.ttc - minTtc, 0) / scales.ttc) ** 2;
  const slack = (plan.slack / scales.slack) ** 2;

  const terms: DecisionTerms = {
    clearance: weights.clearance * clearance,
    ttc: weights.ttc * ttc,
    comfort: weights.comfort * comfort,
    progress: weights.progress * progress,
    lane: weights.lane * laneShare,
    slack: weights.slack * slack,
  };
  const cost = terms.clearance + terms.ttc + terms.comfort + terms.progress + terms.lane + terms.slack;
  return {
    id,
    status: plan.status,
    feasible: plan.status !== 'failed' && contactTime === null,
    cost,
    terms,
    impactEnergy,
    contactTime,
    minClearance: minClearance === Infinity ? null : minClearance,
    minTtc: minTtc === Infinity ? null : minTtc,
  };
}

/** A candidate beats another by at least this share of its cost (or of its impact energy, when neither is feasible). */
export const SWITCH_IMPROVEMENT = 0.12;
/** Cycles in a row a candidate must beat the current one before the switch. */
export const SWITCH_CYCLES = 2;

/**
 * Why the decision is what it is (a code for the interface's copy, which lives in the app):
 * - `cruise`: no obstacle in the path, the lane is kept;
 * - `hold`: the current maneuver is the best, or nothing beats it by the hysteresis;
 * - `challenged`: a candidate beats the current one, not yet for SWITCH_CYCLES cycles;
 * - `switch`: the current maneuver changed this cycle;
 * - `locked`: an evasion past its point of no return is kept whatever the others cost;
 * - `clear`: the event is over (no obstacle in the path), back to the lane;
 * - `noFeasible`: no candidate is feasible: the lane maneuver in force is kept, or B1 takes over from B0 on a lower
 *   impact energy, an evasion in force gives way to the lowest impact energy (with the same hysteresis);
 * - `solverFailed`: the chosen candidate's solver failed, the minimum-risk maneuver is applied.
 */
export type DecisionReason =
  'cruise' | 'hold' | 'challenged' | 'switch' | 'locked' | 'clear' | 'noFeasible' | 'solverFailed';

export type DecisionFallback = 'none' | 'noFeasible' | 'solverFailed';

/** The selector's verdict for one cycle. */
export interface Selection {
  /** The maneuver in force after this cycle. */
  readonly chosen: BranchId;
  /** Whether an event is under way (it outlasts the obstacle in the path by SWITCH_CYCLES − 1 quiet cycles). */
  readonly event: boolean;
  readonly switched: boolean;
  readonly locked: boolean;
  readonly fallback: DecisionFallback;
  readonly reason: DecisionReason;
  /** The candidate beating the current one and for how many cycles in a row (0 without one). */
  readonly challenger: BranchId | null;
  readonly challengeCycles: number;
}

/** Whether `a` beats `b` by the hysteresis' margin. A failed candidate never beats, and is beaten by any other. */
export function beats(a: CandidateEvaluation, b: CandidateEvaluation | undefined): boolean {
  if (a.status === 'failed') return false;
  if (b === undefined || b.status === 'failed') return true;
  if (a.feasible !== b.feasible) return a.feasible;
  if (a.feasible) return a.cost <= (1 - SWITCH_IMPROVEMENT) * b.cost;
  return a.impactEnergy <= (1 - SWITCH_IMPROVEMENT) * b.impactEnergy;
}

/** The best candidate: feasible ones by cost, else by impact energy; failed ones never; ties by B0–B3 order. */
export function bestCandidate(evaluations: readonly CandidateEvaluation[]): CandidateEvaluation | undefined {
  let best: CandidateEvaluation | undefined;
  for (const e of evaluations) {
    if (e.status === 'failed') continue;
    if (best === undefined) best = e;
    else if (e.feasible !== best.feasible) {
      if (e.feasible) best = e;
    } else if (e.feasible ? e.cost < best.cost : e.impactEnergy < best.impactEnergy) best = e;
  }
  return best;
}

/**
 * The hysteresis and the lock. The current maneuver changes only when a candidate has beaten it (beats) for
 * SWITCH_CYCLES cycles in a row, or at once when the candidate is feasible and the current one predicts a contact
 * that persists (it did in the previous cycle too) or that braking in the lane cannot avoid (B1 predicts one too), or
 * when the event is over (back to `keep`, not counted as a switch); an evasion marked past its point of no return by
 * the driver is kept until it releases the lock. On top of beats:
 * - B1 holds against B0 until the event is over, and against every candidate while it is feasible (while it predicts
 *   a contact, the driver keeps its brake from easing off: mpc/decisionDriver.ts);
 * - an evasion never replaces a feasible maneuver: it is the way out of a contact, not a cheaper ride;
 * - an infeasible candidate takes over on impact energy only as B1 from B0 (braking harder in the lane) or from a
 *   current evasion that predicts a contact; an infeasible evasion never does (on `moose` at 23 m an evasion chosen on
 *   its lower rollout energy hit the moose at 8.4 m/s, braking in the lane at 2.2 m/s);
 * - the fallback without a feasible candidate (the lowest impact energy wins) is taken without
 *   the 12 % margin when braking in the lane is all that is left: no candidate feasible and no evasion with a gap for
 *   SWITCH_CYCLES cycles in a row, B0 current, B1 lower in impact energy: B1 takes over. The energies of the two lane
 *   rollouts differ by a few percent, so the margin kept B0, which hit as fast as the single-maneuver MPC of tranche 1
 *   or up to 0.05 m/s faster in the forced case of M5 (c), where B1 hits slower; while an evasion has a gap, B0 is
 *   kept so that the way out of the contact stays one switch (B0 to B1 to the evasion made two switches in 9 of 100
 *   seeds of `moose`).
 */
export class DecisionSelector {
  private currentId: BranchId = 'keep';
  /** Cycles in a row each candidate has beaten the current one, by B0–B3 id. */
  private readonly streak = new Map<BranchId, number>();
  private lockedFlag = false;
  /** Cycles in a row with an event, and whether the current maneuver predicted a contact in the previous cycle. */
  private eventCycles = 0;
  private wasInfeasible = false;
  /** Cycles in a row without an obstacle in the path, while an event is under way. */
  private quietCycles = 0;
  /** Whether the previous cycle had neither a feasible candidate nor an evasion (only braking in the lane left). */
  private laneOnlyBefore = false;

  get current(): BranchId {
    return this.currentId;
  }

  get locked(): boolean {
    return this.lockedFlag;
  }

  reset(): void {
    this.currentId = 'keep';
    this.streak.clear();
    this.lockedFlag = false;
    this.eventCycles = 0;
    this.wasInfeasible = false;
    this.quietCycles = 0;
    this.laneOnlyBefore = false;
  }

  /** Locks or releases the current maneuver (the driver's point of no return); only an evasion is ever locked. */
  setLock(on: boolean): void {
    this.lockedFlag = on && (this.currentId === 'left' || this.currentId === 'right');
  }

  /**
   * One cycle's decision over the evaluated candidates (the current one among them). `inPath` is false when no
   * obstacle is in the path this cycle; the event under way ends after SWITCH_CYCLES such cycles in a row. Each
   * candidate keeps its own streak of cycles beating the current maneuver (a candidate not solved this cycle loses
   * it); among those with SWITCH_CYCLES or more, the best (bestCandidate) takes over.
   */
  decide(evaluations: readonly CandidateEvaluation[], inPath: boolean): Selection {
    const current = evaluations.find((e) => e.id === this.currentId);
    // An event ends after SWITCH_CYCLES cycles in a row without an obstacle in the path: one quiet cycle (a noisy
    // track just out of the path) neither ends it nor restarts it.
    if (inPath) this.quietCycles = 0;
    else if (this.eventCycles > 0) this.quietCycles++;
    if (!inPath && (this.eventCycles === 0 || this.quietCycles >= SWITCH_CYCLES)) this.eventCycles = 0;
    else this.eventCycles++;
    const event = this.eventCycles > 0;
    const infeasible = current !== undefined && current.status !== 'failed' && !current.feasible;
    // A contact predicted in two cycles in a row: one flipping for a cycle (a plan that braked a little less, a cold
    // first plan at the event's start) does not hand the vehicle to an evasion.
    const contact = infeasible && this.wasInfeasible;
    this.wasInfeasible = infeasible;
    let switched = false;
    let reason: DecisionReason;
    let challenger: CandidateEvaluation | undefined;
    if (!event && !this.lockedFlag) {
      reason = this.currentId === 'keep' ? 'cruise' : 'clear';
      this.currentId = 'keep';
      this.streak.clear();
      this.laneOnlyBefore = false;
    } else if (this.lockedFlag) {
      reason = 'locked';
      this.streak.clear();
      this.laneOnlyBefore = false;
    } else {
      const ready: CandidateEvaluation[] = [];
      const streaks = new Map<BranchId, number>();
      const brake = evaluations.find((e) => e.id === 'brake');
      // Braking in the lane, the hardest it can be (B1's rollout), predicts a contact too: only an evasion avoids it.
      const unavoidable = brake !== undefined && brake.status !== 'failed' && !brake.feasible;
      const evading = this.currentId === 'left' || this.currentId === 'right';
      for (const e of evaluations) {
        if (e.id === this.currentId || !beats(e, current)) continue;
        // B1 holds against B0 until the event is over: B0 brakes in the lane too, as its rows ask, and the two swapped
        // back and forth on their costs in the M5 sweeps (up to 5 switches in one event). Against every candidate it
        // holds while it is feasible: once stopped short of the moose on `moose` at 35 m, an evasion past it at walking
        // pace cost less than standing (the progress term) and took over.
        if (this.currentId === 'brake' && (e.id === 'keep' || current?.feasible === true)) continue;
        // An evasion never replaces a feasible maneuver: on `pedestrian` an evasion inside the lane (B3 passing a
        // pedestrian who had crossed) beat B0 on comfort and made a second switch.
        const evasion = e.id === 'left' || e.id === 'right';
        if (evasion && current !== undefined && current.status !== 'failed' && current.feasible) continue;
        // An infeasible candidate takes over only as B1 from B0, or from an infeasible evasion (then the lowest impact
        // energy wins). An infeasible evasion never takes over on impact energy: its rollout's energy was optimistic
        // in the closed loop (on `moose` with the left lane blocked, evasions chosen on it hit the moose up to 1.5 m/s
        // faster than braking alone, against M5).
        if (!e.feasible && !evading && e.id !== 'brake') continue;
        const n = (this.streak.get(e.id) ?? 0) + 1;
        streaks.set(e.id, n);
        // A feasible candidate replaces at once a current one whose contact persists, or that braking cannot avoid: an
        // evasion's window lasts a few cycles, and braking narrows it (on `moose` an evasion feasible in one cycle was
        // often no longer feasible in the next). A persisting contact needs two cycles of the event (B0's first plan
        // is cold and flips); B1's rollout brakes as hard as it can from the first cycle (mpc/branches.ts).
        const urgent = e.feasible && infeasible && (unavoidable || (contact && this.eventCycles >= SWITCH_CYCLES));
        if (n >= SWITCH_CYCLES || urgent) ready.push(e);
      }
      this.streak.clear();
      for (const [id, n] of streaks) this.streak.set(id, n);
      let next = bestCandidate(ready);
      // The fallback in the lane: nothing feasible and no evasion for SWITCH_CYCLES cycles in a row, the lowest impact
      // energy wins without the 12 % margin (see the class comment).
      const laneOnly =
        !evaluations.some((e) => e.feasible) && !evaluations.some((e) => e.id === 'left' || e.id === 'right');
      if (laneOnly && this.laneOnlyBefore && this.currentId === 'keep' && brake !== undefined) {
        if (brake.status !== 'failed' && current !== undefined && brake.impactEnergy < current.impactEnergy)
          next = brake;
      }
      this.laneOnlyBefore = laneOnly;
      if (next !== undefined) {
        this.currentId = next.id;
        this.wasInfeasible = !next.feasible;
        this.streak.clear();
        switched = true;
        reason = 'switch';
      } else {
        challenger = bestCandidate(evaluations.filter((e) => streaks.has(e.id)));
        reason = challenger === undefined ? 'hold' : 'challenged';
      }
    }
    const chosen = evaluations.find((e) => e.id === this.currentId);
    let fallback: DecisionFallback = 'none';
    if (chosen === undefined || chosen.status === 'failed') {
      fallback = 'solverFailed';
      reason = 'solverFailed';
    } else if (!evaluations.some((e) => e.feasible)) {
      fallback = 'noFeasible';
      if (reason === 'hold') reason = 'noFeasible';
    }
    return {
      chosen: this.currentId,
      event,
      switched,
      locked: this.lockedFlag,
      fallback,
      reason,
      challenger: challenger?.id ?? null,
      challengeCycles: challenger === undefined ? 0 : (this.streak.get(challenger.id) ?? 0),
    };
  }
}
