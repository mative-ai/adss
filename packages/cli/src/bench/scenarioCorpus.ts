/**
 * The scenario part of the solver benchmark's corpus (Phase 3, the go/no-go benchmark): the step QPs
 * the MPC solves in the four v1 scenarios, with the obstacle tracks of its own sensor, the friction preview, the
 * standstill rows and the road's demand on curves, as in packages/core/test/m4.test.ts. Each case is a scenario
 * file, a seed, a speed or trigger override and the maneuver the ego drives; the runs are seeded, so the corpus is
 * rebuilt from this list and every run records the same QPs.
 *
 * The ego is built by a RecordedController: any controller, given a factory of step solvers (one per QP stream,
 * since a solver keeps state between steps): the single-maneuver MpcDriver, or the decision layer of Phase 3, which
 * solves up to 4 candidate maneuvers per step, each with its own solver (DecisionDriver's `solver` option is a factory
 * per branch). Its QPs come in up to 4 streams per run, which measure.ts keeps apart, and the cold start of every
 * candidate it did not choose is recorded as a reset of that stream (bench/recording.ts) and replayed.
 */
import { readFileSync } from 'node:fs';

import {
  DecisionDriver,
  MpcDriver,
  overrideScenario,
  parseScenario,
  runScenario,
  type Controller,
  type ControllerContext,
  type ObstacleSide,
  type RunMetrics,
  type Scenario,
  type ScenarioOverrides,
  type StepSolver,
} from '@mpc-simulator/core';

import { recordingSolver, type SolverCall } from './recording.ts';

/** Builds the ego for a scenario run; each call to `solver` gives a new step solver, its own QP stream. */
export type RecordedController = (context: ControllerContext, solver: () => StepSolver) => Controller;

/** The MPC with one maneuver: what the scenario lets it know and the obstacles taken on `side`. */
export function singleManeuver(side: ObstacleSide): RecordedController {
  return (c, solver) =>
    new MpcDriver(c.params, c.mu, c.road, c.corridor, c.reference, {
      solver: solver(),
      tracks: c.tracks,
      friction: c.friction,
      standstill: true,
      roadDemand: true,
      side,
    });
}

/** The MPC with the decision layer, as `npm run sim` drives the ego: one solver per candidate maneuver. */
export const decisionLayer: RecordedController = (c, solver) =>
  new DecisionDriver(c.params, c.mu, c.road, c.corridor, c.reference, c.lane, {
    solver: () => solver(),
    tracks: c.tracks,
    friction: c.friction,
  });

export type ScenarioId = 'pedestrian' | 'moose' | 'ice' | 'mu-split';

export interface ScenarioCase {
  readonly name: string;
  readonly scenario: ScenarioId;
  readonly seed: number;
  readonly overrides: ScenarioOverrides;
  /** What drives the ego, for the report. */
  readonly controller: string;
  readonly ego: RecordedController;
}

const MANEUVERS: Readonly<Record<string, RecordedController>> = {
  stop: singleManeuver('stop'),
  left: singleManeuver('left'),
  decision: decisionLayer,
};

function scenarioCase(
  scenario: ScenarioId,
  seed: number,
  controller: keyof typeof MANEUVERS,
  overrides: { speedKmh?: number; trigger?: [id: string, distance: number] } = {},
): ScenarioCase {
  const parts: string[] = [scenario];
  if (overrides.speedKmh !== undefined) parts.push(String(overrides.speedKmh));
  if (overrides.trigger) parts.push(`t${overrides.trigger[1]}`);
  parts.push(controller, `s${seed}`);
  const ego = MANEUVERS[controller];
  if (!ego) throw new RangeError(`Unknown controller ${controller}`);
  return {
    name: parts.join('-'),
    scenario,
    seed,
    overrides: {
      ...(overrides.speedKmh !== undefined ? { speedKmh: overrides.speedKmh } : {}),
      ...(overrides.trigger ? { triggerDistance: { [overrides.trigger[0]]: overrides.trigger[1] } } : {}),
    },
    controller,
    ego,
  };
}

function sweep(
  scenario: ScenarioId,
  speeds: readonly number[],
  controllers: readonly (keyof typeof MANEUVERS)[],
  seeds: readonly number[],
): ScenarioCase[] {
  return speeds.flatMap((speedKmh) =>
    controllers.flatMap((controller) => seeds.map((seed) => scenarioCase(scenario, seed, controller, { speedKmh }))),
  );
}

/**
 * The scenario runs of the corpus. Braking in the lane ('stop') everywhere, and the pass on the left where the
 * opposite lane is free (pedestrian, moose), so the corpus has obstacle QPs of both kinds; speeds around each file's
 * own, two seeds (the noise of the object sensor) where there are obstacles, and on pedestrian and moose a later trigger,
 * which M5 sweeps. Then the decision layer, as the product runs it, at each file's own speed with two seeds, and on
 * moose at the 24 m where braking starts to suffice (M5): its candidates, evasions included, and its switches. On
 * ice it solves B0 alone, the 'stop' runs' QPs.
 */
export const SCENARIO_CASES: readonly ScenarioCase[] = [
  ...sweep('pedestrian', [40, 50, 60], ['stop', 'left'], [1, 2]),
  scenarioCase('pedestrian', 1, 'stop', { trigger: ['pedestrian', 25] }),
  scenarioCase('pedestrian', 1, 'left', { trigger: ['pedestrian', 25] }),
  ...sweep('moose', [50, 60, 70], ['stop', 'left'], [1, 2]),
  scenarioCase('moose', 1, 'stop', { trigger: ['moose', 30] }),
  scenarioCase('moose', 1, 'left', { trigger: ['moose', 30] }),
  // No obstacle, so no sensor noise: a second seed would repeat the first run to the bit. Speeds vary instead.
  ...sweep('ice', [60, 65, 70, 75, 80], ['stop'], [1]),
  ...sweep('mu-split', [70, 80, 90], ['stop'], [1, 2]),
  ...sweep('pedestrian', [50], ['decision'], [1, 2]),
  ...sweep('moose', [60], ['decision'], [1, 2]),
  scenarioCase('moose', 1, 'decision', { trigger: ['moose', 24] }),
  ...sweep('mu-split', [80], ['decision'], [1, 2]),
];

const parsed = new Map<ScenarioId, Scenario>();

/** The scenario file, validated; read once. */
export function loadScenario(id: ScenarioId): Scenario {
  let scenario = parsed.get(id);
  if (!scenario) {
    const file = new URL(`../../../../scenarios/${id}.json`, import.meta.url);
    scenario = parseScenario(JSON.parse(readFileSync(file, 'utf8')));
    parsed.set(id, scenario);
  }
  return scenario;
}

export interface ScenarioDrive {
  readonly run: ScenarioCase;
  readonly metrics: RunMetrics;
  readonly end: 'duration' | 'collision' | 'roadEnd';
  /** The run's fingerprint (ego only: no ghost here). */
  readonly fingerprint: string;
  /** Whole controller step (every maneuver it solves), ms. */
  readonly stepMs: number[];
  /** Each step-solver call, ms. */
  readonly solveMs: number[];
}

/**
 * Runs the case with `makeSolver` behind every step solver the ego asks for; `onCall` sees each call, resets
 * included (bench/recording.ts). Time is measured here, in the CLI, around the solver and the controller step, and
 * never enters the run.
 */
export function driveScenario(
  run: ScenarioCase,
  makeSolver: () => StepSolver,
  onCall?: (call: SolverCall) => void,
): ScenarioDrive {
  const scenario = overrideScenario(loadScenario(run.scenario), run.overrides);
  const stepMs: number[] = [];
  const solveMs: number[] = [];
  let streams = 0;
  const solver = (): StepSolver =>
    recordingSolver(makeSolver(), streams++, (call) => {
      solveMs.push(call.ms);
      onCall?.(call);
    });
  const ego = (context: ControllerContext): Controller => {
    const controller = run.ego(context, solver);
    return {
      periodTicks: controller.periodTicks,
      delayTicks: controller.delayTicks,
      compute(tick, vehicle, out) {
        const start = performance.now();
        controller.compute(tick, vehicle, out);
        stepMs.push(performance.now() - start);
      },
    };
  };
  const result = runScenario(scenario, { seed: run.seed, ego });
  return {
    run,
    metrics: result.ego.metrics,
    end: result.ego.end,
    fingerprint: result.fingerprint,
    stepMs,
    solveMs,
  };
}
