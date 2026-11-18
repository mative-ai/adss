/**
 * Milestone M5 (Phase 3) with the decision layer driving the ego
 * (mpc/decisionDriver.ts):
 * (a) on `moose` at 60 km/h on dry asphalt, seed 1: braking in the lane alone (the decision layer restricted to B0 and
 *     B1) avoids the moose from D* on, D* the smallest trigger distance of the sweep from which every larger one avoids
 *     it. The decision layer never collides where braking alone does not (D ≥ D*), brakes without evading for
 *     D ≥ D* + δ and evades without collision for EVADE_MIN ≤ D ≤ D* − δ, δ = 2 m. Below EVADE_MIN not even an evasion
 *     forced from the first cycle it is solved clears the moose (at 18 m it hits at 16.9 m/s, measured on 2026-11-04),
 *     so nothing is asked there. The sweep is one seed: over 100 seeds of the sensor's noise at the scenario's own
 *     20 m, 12 runs still hit the moose by braking or a late evasion (the Phase 3 report, not a criterion here);
 * (b) over 100 seeds of the sensor's noise, on `moose`, `pedestrian` and `mu-split` (the v1 scenarios with an obstacle), at
 *     most one maneuver switch per encounter with an obstacle (encounterSwitches: an event that ends and starts again
 *     on the same obstacle stays one encounter), and at most one change of the maneuver in force over the run, the
 *     returns to B0 at an event's end included but the final one (maneuverChanges);
 * (c) a forced case without a feasible maneuver: the moose at 14, 17 and 20 m with the left lane blocked by a stopped
 *     car beside it (at most 2 critical obstacles), seeds 1 to 3: the impact speed is not above braking alone's, both
 *     the decision layer's own (B0 and B1) and the single-maneuver MPC of tranche 1 braking in its lane ('stop'). No
 *     evasion is ever solved there, so the first comparison is with itself; the second is the informative one.
 * Then a guard on `mu-split`, the regression this layer had (it hit the stopped car at 31 to 34 km/h on every seed 1
 * to 10, B0 then planned in its lane's corridor): no evasion onto the iced opposite lane, and no harder hit than the
 * single-maneuver MPC over seeds 1 to 10.
 * (b) takes a few minutes in Node: its own describe, with an explicit timeout.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DecisionDriver,
  encounterSwitches,
  maneuverChanges,
  MpcDriver,
  overrideScenario,
  parseScenario,
  runScenario,
  type BranchId,
  type ControllerFactory,
  type DecisionReport,
  type Scenario,
} from '../src/index.ts';

const json = (id: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../scenarios/${id}.json`, import.meta.url), 'utf8')) as unknown;
const moose = parseScenario(json('moose'));

/** The sweep of trigger distances, m, and the margin around D*. */
const SWEEP = Array.from({ length: 21 }, (_, i) => 16 + i);
const DELTA = 2;
const EVADE_MIN = 19;

interface Run {
  readonly collided: boolean;
  readonly impactSpeed: number | null;
  readonly evaded: boolean;
  readonly log: readonly DecisionReport[];
}

function run(s: Scenario, seed: number, maneuvers?: readonly BranchId[]): Run {
  const log: DecisionReport[] = [];
  const ego: ControllerFactory = (c) =>
    new DecisionDriver(c.params, c.mu, c.road, c.corridor, c.reference, c.lane, {
      tracks: c.tracks,
      friction: c.friction,
      ...(maneuvers && { maneuvers }),
      onDecision: (d) => log.push(d),
    });
  const result = runScenario(s, { seed, ego });
  const m = result.ego.metrics;
  return {
    collided: m.collided,
    impactSpeed: m.impactSpeed,
    evaded: log.some((d) => d.chosen === 'left' || d.chosen === 'right'),
    log,
  };
}

/** The single-maneuver MPC of tranche 1 braking in its lane, as in m4.test.ts. */
function stopImpact(s: Scenario, seed: number): number | null {
  const ego: ControllerFactory = (c) =>
    new MpcDriver(c.params, c.mu, c.road, c.corridor, c.reference, {
      tracks: c.tracks,
      friction: c.friction,
      standstill: true,
      roadDemand: true,
      side: 'stop',
    });
  return runScenario(s, { seed, ego }).ego.metrics.impactSpeed;
}

const atDistance = (d: number) => overrideScenario(moose, { triggerDistance: { moose: d } });

describe('M5 (a): the decision layer evades exactly where braking does not suffice', () => {
  it('on moose at 60 km/h dry, sweeping the moose trigger distance', () => {
    expect(moose.speed.initial * 3.6).toBeCloseTo(60, 6);
    expect(moose.surface.base).toBe('dry');
    const braking = SWEEP.map((d) => ({ d, avoided: !run(atDistance(d), 1, ['keep', 'brake']).collided }));
    let dStar = Infinity;
    for (let i = braking.length - 1; i >= 0 && braking[i]!.avoided; i--) dStar = braking[i]!.d;
    // Braking alone fails at the low end and succeeds at the high end of the sweep.
    expect(braking[0]!.avoided).toBe(false);
    expect(Number.isFinite(dStar)).toBe(true);
    expect(dStar - DELTA).toBeGreaterThanOrEqual(EVADE_MIN);

    for (const d of SWEEP) {
      if (d < EVADE_MIN) continue;
      const r = run(atDistance(d), 1);
      // Never a collision where braking alone avoids the moose, the δ band included.
      if (d >= dStar || d <= dStar - DELTA) expect({ d, collided: r.collided }).toEqual({ d, collided: false });
      if (d <= dStar - DELTA || d >= dStar + DELTA) {
        expect({ d, evaded: r.evaded }).toEqual({ d, evaded: d <= dStar - DELTA });
      }
    }
  }, 300_000);
});

describe('M5 (b): at most one maneuver switch per encounter over 100 noisy seeds', () => {
  for (const id of ['moose', 'pedestrian', 'mu-split']) {
    it(`on ${id}`, () => {
      const scenario = parseScenario(json(id));
      const bad: { seed: number; perEncounter: number; changes: number }[] = [];
      for (let seed = 1; seed <= 100; seed++) {
        const log = run(scenario, seed).log;
        const perEncounter = Math.max(0, ...encounterSwitches(log).values());
        const changes = maneuverChanges(log);
        if (perEncounter > 1 || changes > 1) bad.push({ seed, perEncounter, changes });
      }
      expect(bad).toEqual([]);
    }, 600_000);
  }
});

describe('M5 (c): without a feasible maneuver, impact speed not above braking alone', () => {
  it('with the moose too close and the left lane blocked by a stopped car', () => {
    for (const seed of [1, 2, 3]) {
      for (const d of [14, 17, 20]) {
        const raw = json('moose') as { obstacles: unknown[] };
        raw.obstacles.push({
          id: 'blocking-car',
          kind: 'static',
          length: 4.4,
          width: 1.8,
          start: { s: 72, ey: 1.75 },
          velocity: { s: 0, ey: 0 },
          visibility: 'always',
        });
        const forced = overrideScenario(parseScenario(raw), { triggerDistance: { moose: d } });
        expect(forced.obstacles).toHaveLength(2);
        const decision = run(forced, seed);
        const braking = run(forced, seed, ['keep', 'brake']);
        const stop = stopImpact(forced, seed);
        // Forced: no candidate is ever feasible once the moose is in the path.
        expect(decision.log.filter((r) => r.event).every((r) => r.candidates.every((c) => !c.feasible))).toBe(true);
        expect(braking.collided).toBe(true);
        expect(stop).not.toBeNull();
        const impact = decision.impactSpeed ?? 0;
        expect({ seed, d, impact: impact <= (braking.impactSpeed ?? 0) }).toEqual({ seed, d, impact: true });
        expect({ seed, d, impact: impact <= (stop ?? 0) }).toEqual({ seed, d, impact: true });
      }
    }
  }, 300_000);
});

/** How far the decision layer's B0 may stray from the single maneuver on one seed, m/s (its applied command is held
 * within the rate rows from the command in force, MpcDriver's is not). */
const SINGLE_MANEUVER_TOLERANCE = 0.1;

describe('mu-split: no evasion onto the ice, no harder hit than braking in the lane', () => {
  it('over seeds 1 to 10, against the single-maneuver MPC of tranche 1', () => {
    const muSplit = parseScenario(json('mu-split'));
    const decision: number[] = [];
    const stop: number[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      const r = run(muSplit, seed);
      // The opposite lane is ice under a lane of μ 0.55: no gap has the grip (BranchSettings.gapGripShare).
      expect({
        seed,
        evasion: r.log.some((d) => d.candidates.some((c) => c.id === 'left' || c.id === 'right')),
      }).toEqual({ seed, evasion: false });
      decision.push(r.impactSpeed ?? 0);
      stop.push(stopImpact(muSplit, seed) ?? 0);
    }
    const mean = (v: readonly number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    expect(Math.max(...decision)).toBeLessThanOrEqual(Math.max(...stop) + SINGLE_MANEUVER_TOLERANCE);
    expect(mean(decision)).toBeLessThanOrEqual(mean(stop) + SINGLE_MANEUVER_TOLERANCE);
  }, 300_000);
});
