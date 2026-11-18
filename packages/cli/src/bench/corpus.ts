/**
 * The solver benchmark's QP corpus (Phase 3, the go/no-go benchmark): the step QPs the MPC
 * solves, each with its exact solution, Goldfarb–Idnani on the condensed form, cold. Two sources:
 * - moose: ISO 3888-2 runs driven by the exact solver, across entry speeds and surfaces (no noise, no obstacles);
 * - scenarios: the v1 scenario runs of bench/scenarioCorpus.ts, with obstacle tracks and the friction preview.
 * Every run is deterministic, so the corpus is rebuilt from these lists, with no file to keep in sync, and its
 * fingerprint (every QP and exact solution, bit for bit) says which corpus a benchmark measured.
 */
import {
  CHASSIS,
  CondensedStepSolver,
  Fingerprint,
  GoldfarbIdnaniSolver,
  KEY_STAGE,
  isoLaneChange,
  MpcDriver,
  RoadPath,
  ROW_KIND,
  runClosedLoop,
  ticksFor,
  uniformSurface,
  Vehicle,
  VEHICLES,
  type OcpQp,
  type StepSolution,
  type StepSolver,
  type SurfaceId,
} from '@mpc-simulator/core';

import { recordingSolver } from './recording.ts';
import { driveScenario, SCENARIO_CASES, type ScenarioCase, type ScenarioDrive } from './scenarioCorpus.ts';

export interface CourseRun {
  readonly name: string;
  readonly speedKmh: number;
  readonly surface: SurfaceId;
  /** Friction coefficient the MPC believes in: the surface's own. */
  readonly mu: number;
}

const run = (speedKmh: number, surface: SurfaceId, mu: number): CourseRun => ({
  name: `moose-${speedKmh}-${surface}`,
  speedKmh,
  surface,
  mu,
});

/** Milestone M3: 60 km/h on dry asphalt. */
export const M3_RUN = run(60, 'dry', 1);

export const CORPUS_RUNS: readonly CourseRun[] = [
  run(50, 'dry', 1),
  M3_RUN,
  run(70, 'dry', 1),
  run(80, 'dry', 1),
  run(40, 'wet', 0.7),
  run(50, 'wet', 0.7),
  run(60, 'wet', 0.7),
  run(30, 'snow', 0.3),
  run(40, 'snow', 0.3),
];

/** The exact reference: Goldfarb–Idnani on the condensed form, cold. */
export function exactSolver(): StepSolver {
  return new CondensedStepSolver('gi-condensed', new GoldfarbIdnaniSolver());
}

export interface Drive {
  readonly run: CourseRun;
  /** How far the body went outside the cones, at worst, m. */
  readonly worstOutside: number;
  /** Whole MPC step (state prediction, rollout, linearization, QP, solve, final rollout), ms. */
  readonly stepMs: number[];
  /** The step solver alone (the QP in its form and its solve), ms. */
  readonly solveMs: number[];
  readonly ocps: OcpQp[];
  readonly solutions: StepSolution[];
  /** Per QP: the solver was reset since the previous QP (bench/recording.ts). */
  readonly resets: boolean[];
}

/** Drives the car through the course with `solver` as the MPC's step solver. */
export function drive(course: CourseRun, solver: StepSolver): Drive {
  const car = VEHICLES.car;
  const speed = course.speedKmh / 3.6;
  const lane = isoLaneChange(car, speed);
  const road = new RoadPath({ segments: [{ kind: 'straight', length: 400 }], width: { left: 6, right: 3 } });
  const vehicle = new Vehicle(car, uniformSurface(course.surface));
  vehicle.reset(0, 0, 0, speed);
  const ocps: OcpQp[] = [];
  const solutions: StepSolution[] = [];
  const resets: boolean[] = [];
  const solveMs: number[] = [];
  const timed = recordingSolver(solver, 0, (call) => {
    solveMs.push(call.ms);
    ocps.push(call.ocp);
    solutions.push(call.solution);
    resets.push(call.reset);
  });
  const driver = new MpcDriver(car, course.mu, road, lane.corridor, lane.reference, { solver: timed });
  const stepMs: number[] = [];
  let worstOutside = 0;
  runClosedLoop(
    vehicle,
    {
      periodTicks: driver.periodTicks,
      delayTicks: driver.delayTicks,
      compute(tick, v, out) {
        const start = performance.now();
        driver.compute(tick, v, out);
        stepMs.push(performance.now() - start);
      },
    },
    {
      ticks: ticksFor(20),
      until: (_tick, v) => (v.plant.chassis[CHASSIS.X] ?? 0) > lane.end,
      onTick: (_tick, v) => {
        worstOutside = Math.max(worstOutside, lane.outside(v));
      },
    },
  );
  return { run: course, worstOutside, stepMs, solveMs, ocps, solutions, resets };
}

export type CorpusSource = 'moose' | 'scenarios';
export type CorpusChoice = CorpusSource | 'all';

export interface CorpusRun {
  readonly name: string;
  readonly source: CorpusSource;
  readonly qps: number;
  /** QPs with at least one obstacle row. */
  readonly obstacleQps: number;
  /** QPs whose stream's solver was reset before them. */
  readonly resets: number;
}

export interface CorpusStep {
  /** Index of the run in the corpus. */
  readonly run: number;
  /** The solver of the run the QP went to, in creation order: 0 for one maneuver, up to 3 with the decision layer. */
  readonly stream: number;
  /** The stream's solver was reset since its previous QP: the replay resets it before this QP too. */
  readonly reset: boolean;
  readonly ocp: OcpQp;
  readonly exact: StepSolution;
}

export interface Corpus {
  readonly choice: CorpusChoice;
  readonly runs: readonly CorpusRun[];
  readonly steps: readonly CorpusStep[];
  /** The moose drives and the scenario drives with the exact solver, for the closed-loop comparison. */
  readonly moose: readonly Drive[];
  readonly scenarios: readonly ScenarioDrive[];
  /** 16 hex digits over the run names and every step's stream, reset, QP and exact solution. */
  readonly fingerprint: string;
  /** Distinct QPs (QP and exact solution, bit for bit): the steps that are not a repeat of an earlier one. */
  readonly uniqueQps: number;
  /** Groups of runs that recorded the same steps to the bit (a variant that changes nothing), by name. */
  readonly duplicateRuns: readonly (readonly string[])[];
}

/** Number of obstacle rows of a QP. */
export function obstacleRows(ocp: OcpQp): number {
  let count = 0;
  for (const key of ocp.rowKeys) if (Math.floor(key / (KEY_STAGE * KEY_STAGE)) === ROW_KIND.OBSTACLE) count++;
  return count;
}

const numbers = (values: readonly number[]) => Float64Array.from(values);

function addText(print: Fingerprint, text: string): void {
  print.addNumber(text.length);
  for (let i = 0; i < text.length; i++) print.addNumber(text.charCodeAt(i));
}

function addQp(print: Fingerprint, ocp: OcpQp, exact: StepSolution): void {
  print.add(numbers([ocp.horizon, ocp.nx, ocp.nu, ocp.slacks, ocp.rowKeys.length]));
  print.add(ocp.a).add(ocp.b);
  print.add(numbers(ocp.slackStage));
  print.add(numbers(ocp.costRow)).add(numbers(ocp.costCol)).add(numbers(ocp.costValue)).add(numbers(ocp.linear));
  print.add(numbers(ocp.rowStart)).add(numbers(ocp.rowIndex)).add(numbers(ocp.rowValue));
  print.add(numbers(ocp.lower)).add(numbers(ocp.upper)).add(numbers(ocp.rowKeys));
  addText(print, exact.status);
  print
    .add(numbers([exact.iterations, exact.objective]))
    .add(exact.du)
    .add(exact.slack);
}

/** Fingerprint of a corpus: its runs in order, and each step's run, stream, reset, QP and exact solution. */
export function corpusFingerprint(runs: readonly CorpusRun[], steps: readonly CorpusStep[]): string {
  const print = new Fingerprint();
  print.addNumber(runs.length);
  for (const r of runs) addText(print, `${r.source}:${r.name}`);
  print.addNumber(steps.length);
  for (const { run, stream, reset, ocp, exact } of steps) {
    print.add(numbers([run, stream, reset ? 1 : 0]));
    addQp(print, ocp, exact);
  }
  return print.digest();
}

/** The distinct QPs of a corpus and the runs that repeat another run's steps exactly. */
export function corpusRepeats(
  runs: readonly CorpusRun[],
  steps: readonly CorpusStep[],
): { uniqueQps: number; duplicateRuns: string[][] } {
  const qps = new Set<string>();
  const runPrints = runs.map(() => new Fingerprint());
  for (const { run, stream, reset, ocp, exact } of steps) {
    const qp = new Fingerprint();
    addQp(qp, ocp, exact);
    qps.add(qp.digest());
    const print = runPrints[run];
    if (print) {
      print.add(numbers([stream, reset ? 1 : 0]));
      addQp(print, ocp, exact);
    }
  }
  const groups = new Map<string, string[]>();
  runPrints.forEach((print, i) => {
    const digest = print.digest();
    groups.set(digest, [...(groups.get(digest) ?? []), runs[i]?.name ?? '?']);
  });
  return { uniqueQps: qps.size, duplicateRuns: [...groups.values()].filter((names) => names.length > 1) };
}

export interface CorpusSelection {
  readonly choice: CorpusChoice;
  /** Run names to keep (moose and scenario names alike); every run of the chosen sources when absent. */
  readonly names?: readonly string[];
}

/** The runs a selection keeps, before recording them. */
export function selectRuns(selection: CorpusSelection): { moose: CourseRun[]; scenarios: ScenarioCase[] } {
  const keep = (name: string) => !selection.names || selection.names.includes(name);
  const moose = selection.choice === 'scenarios' ? [] : CORPUS_RUNS.filter((r) => keep(r.name));
  const scenarios = selection.choice === 'moose' ? [] : SCENARIO_CASES.filter((c) => keep(c.name));
  return { moose, scenarios };
}

export function recordCorpus(selection: CorpusSelection): Corpus {
  const chosen = selectRuns(selection);
  const runs: CorpusRun[] = [];
  const steps: CorpusStep[] = [];
  const moose = chosen.moose.map((course) => {
    const d = drive(course, exactSolver());
    const run = runs.length;
    d.ocps.forEach((ocp, i) =>
      steps.push({ run, stream: 0, reset: d.resets[i] ?? false, ocp, exact: d.solutions[i] as StepSolution }),
    );
    const obstacleQps = d.ocps.filter((ocp) => obstacleRows(ocp) > 0).length;
    const resets = d.resets.filter(Boolean).length;
    runs.push({ name: course.name, source: 'moose', qps: d.ocps.length, obstacleQps, resets });
    return d;
  });
  const scenarios = chosen.scenarios.map((c) => {
    const run = runs.length;
    let qps = 0;
    let obstacleQps = 0;
    let resets = 0;
    const d = driveScenario(c, exactSolver, ({ stream, reset, ocp, solution }) => {
      steps.push({ run, stream, reset, ocp, exact: solution });
      qps++;
      if (obstacleRows(ocp) > 0) obstacleQps++;
      if (reset) resets++;
    });
    runs.push({ name: c.name, source: 'scenarios', qps, obstacleQps, resets });
    return d;
  });
  return {
    choice: selection.choice,
    runs,
    steps,
    moose,
    scenarios,
    fingerprint: corpusFingerprint(runs, steps),
    ...corpusRepeats(runs, steps),
  };
}
