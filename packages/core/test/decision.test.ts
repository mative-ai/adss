/**
 * The decision layer's parts: the held copies of a crossing track, the band an
 * obstacle that may stop occupies, the body-to-box separation, the references of B1 and B2/B3, the path and the gap
 * rule, the common decision cost on a rollout, the hysteresis with its lock and fallbacks, and the DecisionDriver on
 * a v1 scenario (same seed same fingerprint, at most four QPs per cycle, the minimum-risk maneuver when the solver
 * fails).
 * The milestone M5 itself is in m5.test.ts.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BRANCH_DEFAULTS,
  BrakeReference,
  DecisionDriver,
  DecisionSelector,
  defaultMpcSettings,
  MAX_CYCLE_QPS,
  defaultStepSolver,
  evaluateCandidate,
  EvadeReference,
  GRAVITY,
  laneReference as speedReference,
  NX,
  obstacleBand,
  parseScenario,
  pathObstacles,
  roadCorridor,
  RoadPath,
  runScenario,
  separation,
  STATE,
  stillLateralSpeed,
  SWITCH_CYCLES,
  VEHICLES,
  vehicleDiscs,
  type BranchGeometry,
  type BranchId,
  type CandidateEvaluation,
  type ControllerFactory,
  type DecisionContext,
  type DecisionReport,
  type MpcPlan,
  type ObstacleTrack,
  type Reference,
  type Scenario,
  type StepSolver,
} from '../src/index.ts';
import { DECISION_SCALES, DECISION_WEIGHTS } from '../src/mpc/selector.ts';
import { HELD_SUFFIX, heldSource, HOLD_MIN_LATERAL_SPEED, withHeldCopies } from '../src/mpc/obstacles.ts';

const car = VEHICLES.car;

function scenario(id: string): Scenario {
  return parseScenario(JSON.parse(readFileSync(new URL(`../../../scenarios/${id}.json`, import.meta.url), 'utf8')));
}

function track(overrides: Partial<ObstacleTrack>): ObstacleTrack {
  return { id: 'o', kind: 'static', tick: 0, s: 50, ey: -1.75, vs: 0, vey: 0, length: 1, width: 1, ...overrides };
}

/** A two-lane road 3.5 m each side of the reference line, the ego lane on the right. */
const lane = { center: -1.75, width: 3.5 };
const discs = vehicleDiscs(car);
const geometry: BranchGeometry = {
  params: car,
  corridor: {
    bounds(_s, out) {
      out.left = 3.5;
      out.right = -3.5;
    },
  },
  lane,
  discs,
  inflation: discs.radius + 0.3,
  obstacleMargin: 0.3,
  corridorMargin: 0.1,
  friction: { at: () => 1 },
};
const laneReference: Reference = {
  at(_s, out) {
    out.ey = lane.center;
    out.speed = 15;
  },
};

describe('held copies and the band of an obstacle that may stop', () => {
  it('adds a copy held at the reported e_y only to a track moving across the road', () => {
    const tracks = [track({ id: 'moose', vey: 3 }), track({ id: 'box', vey: HOLD_MIN_LATERAL_SPEED / 2 })];
    const out = withHeldCopies(tracks);
    expect(out.map((t) => t.id)).toEqual(['moose', `moose${HELD_SUFFIX}`, 'box']);
    expect(out[1]).toMatchObject({ ey: -1.75, vey: 0, vs: 0, s: 50 });
    expect(heldSource(`moose${HELD_SUFFIX}`)).toBe('moose');
    expect(heldSource('moose')).toBe('moose');
  });

  it('runs from the reported e_y to the constant-velocity e_y, a lateral speed under the noise floor aside', () => {
    const band = { lo: 0, hi: 0 };
    obstacleBand(track({ ey: -4, vey: 2 }), 1.5, band);
    expect(band).toEqual({ lo: -4, hi: -1 });
    obstacleBand(track({ ey: -4, vey: -2 }), 1, band);
    expect(band).toEqual({ lo: -6, hi: -4 });
    obstacleBand(track({ ey: -4, vey: 0.4 }), 2, band);
    expect(band).toEqual({ lo: -4, hi: -4 });
  });

  it("takes the noise floor from the scenario's sensor: 2.5 σ of its velocity noise", () => {
    expect(stillLateralSpeed(0.2)).toBeCloseTo(HOLD_MIN_LATERAL_SPEED, 12);
    expect(BRANCH_DEFAULTS.stillLateralSpeed).toBe(HOLD_MIN_LATERAL_SPEED);
    // A quieter sensor (σ 0.1 m/s) counts a 0.4 m/s crosser as moving, in the band and in the held copies.
    const band = { lo: 0, hi: 0 };
    obstacleBand(track({ ey: -4, vey: 0.4 }), 2, band, stillLateralSpeed(0.1));
    expect(band.lo).toBe(-4);
    expect(band.hi).toBeCloseTo(-3.2, 12);
    expect(withHeldCopies([track({ id: 'slow', vey: 0.4 })], stillLateralSpeed(0.1))).toHaveLength(2);
    expect(withHeldCopies([track({ id: 'slow', vey: 0.4 })])).toHaveLength(1);
  });
});

describe('separation of the body and a box', () => {
  it('is the gap along the road for aligned boxes, negative when they overlap', () => {
    expect(separation(10, 0, 1, 0, 2, 1, 0.5, 0.5)).toBeCloseTo(7.5, 12);
    expect(separation(0, 3, 1, 0, 2, 1, 0.5, 0.5)).toBeCloseTo(1.5, 12);
    expect(separation(1, 0, 1, 0, 2, 1, 0.5, 0.5)).toBeLessThan(0);
  });

  it('accounts for the body turned on the road', () => {
    const turned = separation(0, 3, Math.cos(0.5), Math.sin(0.5), 2, 1, 0.5, 0.5);
    expect(turned).toBeLessThan(separation(0, 3, 1, 0, 2, 1, 0.5, 0.5));
  });
});

describe('the references of the candidates', () => {
  it('B1 falls from v0 at s0 to 0 at the deceleration, within the base speed', () => {
    const brake = new BrakeReference(laneReference);
    brake.anchor(100, 14, 7);
    const out = { ey: 0, speed: 0 };
    brake.at(90, out);
    expect(out).toEqual({ ey: -1.75, speed: 14 });
    brake.at(107, out);
    expect(out.speed).toBeCloseTo(Math.sqrt(14 * 14 - 2 * 7 * 7), 12);
    brake.at(115, out);
    expect(out.speed).toBe(0);
    brake.anchor(100, 20, 7);
    brake.at(100, out);
    expect(out.speed).toBe(15);
  });

  it('B2 moves to its offset before the target, holds it alongside and returns to the lane', () => {
    const evade = new EvadeReference(laneReference);
    const analysis = pathObstacles(
      { s: 0, ey: -1.75, vx: 10 },
      [track({ s: 40, length: 1, width: 1 })],
      [0],
      2.4,
      geometry,
      BRANCH_DEFAULTS,
    );
    const target = analysis.target;
    expect(target).not.toBeNull();
    evade.anchor(target!, 2, 10, geometry, BRANCH_DEFAULTS);
    const out = { ey: 0, speed: 0 };
    const full = 40 - 0.5 - geometry.inflation - discs.offsets[0];
    evade.at(full - 10 * BRANCH_DEFAULTS.evadeRampTime - 1, out);
    expect(out.ey).toBe(-1.75);
    evade.at(full, out);
    expect(out.ey).toBe(2);
    evade.at(40, out);
    expect(out).toEqual({ ey: 2, speed: 10 });
    evade.at(200, out);
    expect(out.ey).toBe(-1.75);
  });
});

describe('the path and the gap rule', () => {
  it('finds the obstacle in the lane and a gap on its left only (the road edge is on the right)', () => {
    const analysis = pathObstacles(
      { s: 0, ey: -1.75, vx: 15 },
      [track({ s: 40, ey: -1.75, width: 1.8, length: 4.4 })],
      [0],
      2.4,
      geometry,
      BRANCH_DEFAULTS,
    );
    expect(analysis.target?.track.s).toBe(40);
    // The corridor's edge less its margin and half the body: 3.5 − 0.1 − 0.9.
    expect(analysis.left).toBeCloseTo(2.5, 12);
    expect(analysis.right).toBeNull();
  });

  it('leaves out an obstacle off the lane, one behind, and one beyond the range', () => {
    const tracks = [
      track({ id: 'curb', s: 40, ey: -4.25, width: 0.5, length: 0.5 }),
      track({ id: 'behind', s: -10 }),
      track({ id: 'far', s: 400 }),
    ];
    const analysis = pathObstacles({ s: 0, ey: -1.75, vx: 15 }, tracks, [0, 0, 0], 2.4, geometry, BRANCH_DEFAULTS);
    expect(analysis.obstacles).toEqual([]);
    expect(analysis.target).toBeNull();
  });

  it('counts a crossing obstacle in the path from the band it sweeps until the vehicle passes it', () => {
    const crossing = track({ id: 'walker', s: 30, ey: -4.5, vey: 1.4, width: 0.5, length: 0.5 });
    const analysis = pathObstacles({ s: 0, ey: -1.75, vx: 15 }, [crossing], [0], 2.4, geometry, BRANCH_DEFAULTS);
    expect(analysis.target?.track.id).toBe('walker');
  });

  it("leaves out a side whose grip is under gapGripShare of the lane's", () => {
    // The opposite lane (e_y > 0) at μ, the ego lane dry: the preview's mean of the two wheel tracks.
    const opposite = (mu: number): BranchGeometry => {
      const at = (ey: number) => (ey > 0 ? mu : 1);
      const friction = { at: (_s: number, ey = lane.center) => (at(ey + car.track / 2) + at(ey - car.track / 2)) / 2 };
      return { ...geometry, friction };
    };
    const car40 = [track({ s: 40, ey: -1.75, width: 1.8, length: 4.4 })];
    const x0 = { s: 0, ey: -1.75, vx: 15 };
    // On ice (μ 0.1) it is no way out; wet (0.7), it still is for an evasion planned on the lane's 1.
    expect(pathObstacles(x0, car40, [0], 2.4, opposite(0.1), BRANCH_DEFAULTS).left).toBeNull();
    expect(pathObstacles(x0, car40, [0], 2.4, opposite(0.7), BRANCH_DEFAULTS).left).toBeCloseTo(2.5, 12);
    expect(BRANCH_DEFAULTS.gapGripShare).toBe(0.5);
  });

  it('applies the grip rule on the right side too', () => {
    // The ego lane on the left (e_y 1.75), the right one (e_y < 0) at μ.
    const left = { center: 1.75, width: 3.5 };
    const right = (mu: number): BranchGeometry => {
      const at = (ey: number) => (ey < 0 ? mu : 1);
      const friction = { at: (_s: number, ey = left.center) => (at(ey + car.track / 2) + at(ey - car.track / 2)) / 2 };
      return { ...geometry, lane: left, friction };
    };
    const car40 = [track({ s: 40, ey: 1.75, width: 1.8, length: 4.4 })];
    const x0 = { s: 0, ey: 1.75, vx: 15 };
    expect(pathObstacles(x0, car40, [0], 2.4, right(0.1), BRANCH_DEFAULTS).right).toBeNull();
    // The corridor's edge plus its margin and half the body: −3.5 + 0.1 + 0.9.
    expect(pathObstacles(x0, car40, [0], 2.4, right(0.7), BRANCH_DEFAULTS).right).toBeCloseTo(-2.5, 12);
  });

  it("asks the preview at an evasion's e_y through the MPC (MpcController.frictionAt)", () => {
    const moose = scenario('moose');
    const road = new RoadPath(moose.road);
    const preview = { at: (_s: number, ey = moose.lane.center) => (ey > 0 ? 0.1 : 1) };
    const driver = new DecisionDriver(car, 1, road, roadCorridor(road), speedReference(moose.lane, 10), moose.lane, {
      friction: preview,
    });
    expect(driver.geometry.friction.at(60)).toBe(1);
    expect(driver.geometry.friction.at(60, 2)).toBe(0.1);
    expect(driver.controller('keep')?.frictionAt(60, 2)).toBe(0.1);
  });
});

/** A straight rollout at constant speed in the ego lane, (N+1)×NX. */
function cruise(speed: number, ey = lane.center): MpcPlan {
  const steps = defaultMpcSettings(car).steps;
  const trajectory = new Float64Array((steps.length + 1) * NX);
  let s = 0;
  for (let k = 0; k <= steps.length; k++) {
    if (k > 0) s += speed * (steps[k - 1] ?? 0);
    trajectory[k * NX + STATE.S] = s;
    trajectory[k * NX + STATE.EY] = ey;
    trajectory[k * NX + STATE.VX] = speed;
  }
  return {
    status: 'solved',
    iterations: 1,
    command: new Float64Array(2),
    inputs: new Float64Array(2 * steps.length),
    trajectory,
    slack: 0,
    obstacleRows: 0,
    terminalGap: undefined,
  };
}

function context(tracks: ObstacleTrack[]): DecisionContext {
  return {
    geometry,
    branch: BRANCH_DEFAULTS,
    steps: defaultMpcSettings(car).steps,
    tracks,
    ages: tracks.map(() => 0),
    referenceSpeed: 15,
    scales: DECISION_SCALES,
    weights: DECISION_WEIGHTS,
  };
}

describe('the common decision cost on a rollout', () => {
  it('costs nothing for a cruise at the reference speed on a free road', () => {
    const e = evaluateCandidate('keep', cruise(15), context([]));
    expect(e.feasible).toBe(true);
    expect(e.cost).toBe(0);
    expect(e.minClearance).toBeNull();
  });

  it('makes a rollout through an obstacle infeasible with its impact energy ½·m·v_rel²', () => {
    const e = evaluateCandidate('keep', cruise(15), context([track({ s: 20 })]));
    expect(e.feasible).toBe(false);
    expect(e.impactEnergy).toBeCloseTo(0.5 * car.mass * 15 * 15, 6);
    expect(e.contactTime).toBeGreaterThan(0);
    expect(e.minClearance).toBeLessThan(0);
  });

  it('flags a stop that cannot happen before an obstacle beyond the horizon', () => {
    // 36 m travelled in 2.4 s at 15 m/s, then 14.3 m to stop at 0.8·g: a box at 45 m is reached at about 9 m/s.
    const e = evaluateCandidate('keep', cruise(15), context([track({ s: 45 })]));
    expect(e.feasible).toBe(false);
    expect(e.contactTime).toBeGreaterThan(2.4);
    const decel = BRANCH_DEFAULTS.stopShare * GRAVITY;
    const front = 36 + car.length / 2 + (car.lf - car.lr) / 2;
    const gap = 45 - 0.5 - front;
    expect(e.impactEnergy).toBeCloseTo(0.5 * car.mass * (15 * 15 - 2 * decel * gap), 6);
  });

  it('weighs the lost progress and the opposite lane', () => {
    const slow = evaluateCandidate('brake', cruise(7.5), context([]));
    expect(slow.terms.progress).toBeCloseTo(DECISION_WEIGHTS.progress * 0.5, 12);
    const opposite = evaluateCandidate('left', cruise(15, 1.75), context([]));
    expect(opposite.terms.lane).toBeCloseTo(DECISION_WEIGHTS.lane, 12);
    expect(opposite.feasible).toBe(true);
  });
});

/** A candidate evaluation with the fields the selector reads. */
function ev(id: BranchId, cost: number | null, energy = 0, status: CandidateEvaluation['status'] = 'solved') {
  const terms = { clearance: 0, ttc: 0, comfort: 0, progress: 0, lane: 0, slack: 0 };
  return {
    id,
    status,
    feasible: cost !== null && status !== 'failed',
    cost: cost ?? 0,
    terms,
    impactEnergy: cost === null ? energy : 0,
    contactTime: cost === null ? 1 : null,
    minClearance: null,
    minTtc: null,
  } satisfies CandidateEvaluation;
}

describe('the hysteresis, the lock and the fallbacks', () => {
  it('switches only after a candidate beats the current one by 12 % for 2 cycles in a row', () => {
    const selector = new DecisionSelector();
    const almost = [ev('keep', 10), ev('brake', 8.9)];
    for (let i = 0; i < 5; i++) expect(selector.decide(almost, true).switched).toBe(false);
    const better = [ev('keep', 10), ev('brake', 8.7)];
    const first = selector.decide(better, true);
    expect(first).toMatchObject({ switched: false, reason: 'challenged', challenger: 'brake', challengeCycles: 1 });
    const second = selector.decide(better, true);
    expect(second).toMatchObject({ switched: true, chosen: 'brake', reason: 'switch' });
    expect(SWITCH_CYCLES).toBe(2);
  });

  it('hands a contact predicted for two cycles in a row to a candidate feasible now', () => {
    const selector = new DecisionSelector();
    expect(selector.decide([ev('keep', null, 5e4), ev('left', null, 9e4)], true).switched).toBe(false);
    const now = selector.decide([ev('keep', null, 5e4), ev('left', 30)], true);
    expect(now).toMatchObject({ switched: true, chosen: 'left' });
  });

  it('never takes an infeasible evasion on impact energy, while B1 takes over from B0 on a 12 % lower one', () => {
    const selector = new DecisionSelector();
    const chosen: BranchId[] = [];
    let switches = 0;
    for (let i = 0; i < 4; i++) {
      const d = selector.decide([ev('keep', null, 9e4), ev('brake', null, 3e4), ev('left', null, 1e4)], true);
      expect(d.fallback).toBe('noFeasible');
      chosen.push(d.chosen);
      if (d.switched) switches++;
    }
    expect(chosen).toEqual(['keep', 'brake', 'brake', 'brake']);
    expect(switches).toBe(1);
  });

  it('hands the lane to B1 without the 12 % margin when nothing is feasible and no evasion has a gap', () => {
    const lane = new DecisionSelector();
    expect(lane.decide([ev('keep', null, 9e4), ev('brake', null, 8.5e4)], true)).toMatchObject({
      chosen: 'keep',
      reason: 'noFeasible',
    });
    expect(lane.decide([ev('keep', null, 9e4), ev('brake', null, 8.5e4)], true)).toMatchObject({
      chosen: 'brake',
      switched: true,
      fallback: 'noFeasible',
    });
    // With an evasion in the running B0 is kept (the way out stays one switch), and B1 must lower the energy.
    const withEvasion = new DecisionSelector();
    const higher = new DecisionSelector();
    for (let i = 0; i < 4; i++) {
      const evasion = [ev('keep', null, 9e4), ev('brake', null, 8.5e4), ev('left', null, 9.5e4)];
      expect(withEvasion.decide(evasion, true).chosen).toBe('keep');
      expect(higher.decide([ev('keep', null, 9e4), ev('brake', null, 9.2e4)], true).chosen).toBe('keep');
    }
  });

  it('holds B1 against B0 until the event is over, then returns to the lane without counting a switch', () => {
    const selector = new DecisionSelector();
    selector.decide([ev('keep', 10), ev('brake', 1)], true);
    expect(selector.decide([ev('keep', 10), ev('brake', 1)], true).chosen).toBe('brake');
    for (let i = 0; i < 4; i++) expect(selector.decide([ev('keep', 0), ev('brake', 5)], true).chosen).toBe('brake');
    expect(selector.decide([ev('keep', 0), ev('brake', 5)], false)).toMatchObject({ chosen: 'brake', event: true });
    expect(selector.decide([ev('keep', 0), ev('brake', 5)], false)).toMatchObject({
      chosen: 'keep',
      event: false,
      switched: false,
      reason: 'clear',
    });
  });

  it('holds B1 against B0 even when B0 alone is feasible (the driver holds its brake)', () => {
    const selector = new DecisionSelector();
    selector.decide([ev('keep', 10), ev('brake', 1)], true);
    expect(selector.decide([ev('keep', 10), ev('brake', 1)], true).chosen).toBe('brake');
    for (let i = 0; i < 4; i++) {
      expect(selector.decide([ev('keep', 5), ev('brake', null, 9e4)], true)).toMatchObject({
        chosen: 'brake',
        switched: false,
      });
    }
  });

  it('keeps a locked evasion whatever the others cost', () => {
    const selector = new DecisionSelector();
    selector.decide([ev('keep', null, 5e4), ev('left', 30)], true);
    selector.decide([ev('keep', null, 5e4), ev('left', 30)], true);
    expect(selector.current).toBe('left');
    selector.setLock(true);
    for (let i = 0; i < 3; i++) {
      expect(selector.decide([ev('keep', 0), ev('brake', 0), ev('left', 500)], true)).toMatchObject({
        chosen: 'left',
        locked: true,
        reason: 'locked',
      });
    }
    selector.setLock(false);
    selector.decide([ev('keep', 0), ev('brake', 0), ev('left', 500)], true);
    expect(selector.decide([ev('keep', 0), ev('brake', 0), ev('left', 500)], true).chosen).toBe('keep');
  });

  it('flags the solver failure of the chosen candidate', () => {
    const selector = new DecisionSelector();
    expect(selector.decide([ev('keep', 0, 0, 'failed')], true)).toMatchObject({
      fallback: 'solverFailed',
      reason: 'solverFailed',
      chosen: 'keep',
    });
  });
});

describe('the DecisionDriver on moose, seed 1', () => {
  it('gives the same fingerprint twice, at most four QPs a cycle, and a readable decision', () => {
    const moose = scenario('moose');
    const run = () => {
      const qps: number[] = [];
      let count = 0;
      const log: DecisionReport[] = [];
      const counted = (): StepSolver => {
        const solver = defaultStepSolver();
        return { name: solver.name, solve: (ocp) => (count++, solver.solve(ocp)), reset: () => solver.reset() };
      };
      const factory: ControllerFactory = (c) =>
        new DecisionDriver(c.params, c.mu, c.road, c.corridor, c.reference, c.lane, {
          tracks: c.tracks,
          friction: c.friction,
          solver: counted,
          onDecision: (d) => {
            qps.push(count);
            count = 0;
            log.push(d);
          },
        });
      return { result: runScenario(moose, { seed: 1, ego: factory }), qps, log };
    };
    const a = run();
    const b = run();
    expect(a.result.fingerprint).toBe(b.result.fingerprint);
    expect(Math.max(...a.qps)).toBeLessThanOrEqual(4);
    expect(a.qps[0]).toBe(1);
    const event = a.log.find((d) => d.event);
    expect(event?.target).toBe('moose');
    expect(event?.candidates.map((c) => c.id)).toContain('brake');
    expect(a.log.some((d) => d.chosen === 'left')).toBe(true);
    expect(a.result.ego.metrics.collided).toBe(false);
  }, 60_000);

  it("holds every applied command within the MPC's rate rows, planning a switch again from the command in force", () => {
    const params = VEHICLES.car;
    const steerRate = params.steerRateMax * 0.05;
    const accelRate = defaultMpcSettings(params).accelRateMax * 0.05;
    let replanned = 0;
    // Seeds 10 and 26 switch to an evasion that was solved, not applied, in the previous cycle (measured 2026-11-04).
    for (const seed of [1, 10, 26]) {
      const log: DecisionReport[] = [];
      const qps: number[] = [];
      let count = 0;
      const counted = (): StepSolver => {
        const solver = defaultStepSolver();
        return { name: solver.name, solve: (ocp) => (count++, solver.solve(ocp)), reset: () => solver.reset() };
      };
      const factory: ControllerFactory = (c) =>
        new DecisionDriver(c.params, c.mu, c.road, c.corridor, c.reference, c.lane, {
          tracks: c.tracks,
          friction: c.friction,
          solver: counted,
          onDecision: (d) => {
            qps.push(count);
            count = 0;
            log.push(d);
          },
        });
      runScenario(scenario('moose'), { seed, ego: factory });
      let steer = 0;
      let accel = 0;
      for (const d of log) {
        expect(Math.abs(d.command.steer - steer)).toBeLessThanOrEqual(steerRate + 1e-12);
        expect(Math.abs(d.command.accel - accel)).toBeLessThanOrEqual(accelRate + 1e-12);
        steer = d.command.steer;
        accel = d.command.accel;
        if (d.replanned) replanned++;
      }
      expect(Math.max(...qps)).toBeLessThanOrEqual(MAX_CYCLE_QPS);
    }
    expect(replanned).toBeGreaterThan(0);
  }, 60_000);

  it('keeps B1 from easing off the brake while it predicts a contact (mu-split, seed 4)', () => {
    const log: DecisionReport[] = [];
    const factory: ControllerFactory = (c) =>
      new DecisionDriver(c.params, c.mu, c.road, c.corridor, c.reference, c.lane, {
        tracks: c.tracks,
        friction: c.friction,
        onDecision: (d) => log.push(d),
      });
    const result = runScenario(scenario('mu-split'), { seed: 4, ego: factory });
    let held = 0;
    for (let i = 1; i < log.length; i++) {
      const d = log[i]!;
      const b1 = d.candidates.find((c) => c.id === 'brake');
      if (d.chosen !== 'brake' || b1 === undefined || b1.feasible) continue;
      held++;
      expect(d.command.accel).toBeLessThanOrEqual(log[i - 1]!.command.accel);
    }
    expect(held).toBeGreaterThan(5);
    // Without the hold B1 eased off as the car yawed and hit the stopped car at 10.3 m/s (measured 2026-11-04).
    expect(result.ego.metrics.collided).toBe(false);
  }, 60_000);

  it('applies the minimum-risk maneuver, flagged, when every solver fails', () => {
    const failing = (): StepSolver => ({
      name: 'failing',
      solve: () => ({
        status: 'failed',
        iterations: 0,
        objective: Number.NaN,
        du: new Float64Array(0),
        slack: new Float64Array(0),
      }),
      reset: () => {},
    });
    const log: DecisionReport[] = [];
    const factory: ControllerFactory = (c) =>
      new DecisionDriver(c.params, c.mu, c.road, c.corridor, c.reference, c.lane, {
        tracks: c.tracks,
        friction: c.friction,
        solver: failing,
        onDecision: (d) => log.push(d),
      });
    const result = runScenario({ ...scenario('moose'), duration: 0.5 }, { seed: 1, ego: factory });
    expect(log.length).toBeGreaterThan(0);
    for (const d of log) {
      expect(d).toMatchObject({ fallback: 'solverFailed', reason: 'solverFailed' });
      expect(d.command.accel).toBeCloseTo(-GRAVITY, 12);
    }
    expect(result.ego.metrics.finalSpeed).toBeLessThan(alceSpeed());
  });
});

function alceSpeed(): number {
  return scenario('moose').speed.initial;
}
