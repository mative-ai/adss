/**
 * The go/no-go benchmark (the end of M5), run in a Chrome worker: the app's
 * bench.html starts goNoGoWorker.ts, which runs this on the v1 scenarios and posts the report. The ego is the decision
 * layer as `npm run sim` drives it: N = 20, up to four candidate maneuvers per control cycle, each solved by
 * the fast Goldfarb–Idnani. Each case is driven three times in closed loop from the same scenario and seed:
 * - timed, with the fast solver alone: a full step is the decision driver's control step (observe, predict, every
 *   candidate's QP and rollout, the decision), timed around compute(); GO needs p95 ≤ 20 ms and p99 ≤ 35 ms over every
 *   step of every case, after one untimed case that warms the JIT up; and the iteration cap may stop at most 0.5 % of
 *   the QPs;
 * - with a twin: a second decision driver with the exact reference (Goldfarb–Idnani on the condensed QP) fed the same
 *   vehicle every cycle, its commands discarded. GO needs the maneuver in force to be the twin's in at least 99.5 % of
 *   the cycles: the reference's choice at the same state, which is what the criterion asks of a solver;
 * - with the exact solver alone, for information: its choices against the timed run's, cycle by cycle (a run that ends
 *   before the other counts the cycles it lacks as different). Near the limit of grip two closed loops part after the
 *   first bit of difference, and later choices differ for that, not for the solver: on `mu-split` 22 of 4056 cycles in
 *   Chrome on 2026-11-04, every other case equal.
 * Time is read here, around the controller, never in the core, and changes no result: the timed and the twin runs give
 * the same fingerprint (`twinNeutral`).
 */
import {
  CondensedStepSolver,
  DecisionDriver,
  defaultStepSolver,
  GoldfarbIdnaniSolver,
  overrideScenario,
  runScenario,
  stillLateralSpeed,
  type BranchId,
  type Controller,
  type ControllerFactory,
  type DriverCommand,
  type Scenario,
  type ScenarioOverrides,
  type StepSolver,
} from '@mpc-simulator/core';

export type GoNoGoScenarioId = 'pedestrian' | 'moose' | 'ice' | 'mu-split';

export interface GoNoGoCase {
  readonly name: string;
  readonly scenario: GoNoGoScenarioId;
  readonly seed: number;
  readonly overrides: ScenarioOverrides;
}

/** The thresholds: GO when every one holds. */
export const GO_NO_GO_CRITERIA = {
  /** Full step, ms. */
  stepP95: 20,
  stepP99: 35,
  /** Largest share of the fast solver's QPs the iteration cap may stop. */
  capped: 0.005,
  /** Smallest share of the control cycles whose maneuver in force is the reference's at the same state. */
  agreement: 0.995,
} as const;

function sweep(scenario: GoNoGoScenarioId, speeds: readonly number[], seeds: readonly number[]): GoNoGoCase[] {
  return speeds.flatMap((speedKmh) =>
    seeds.map((seed) => ({ name: `${scenario}-${speedKmh}-s${seed}`, scenario, seed, overrides: { speedKmh } })),
  );
}

function triggered(scenario: GoNoGoScenarioId, obstacle: string, distance: number, seed: number): GoNoGoCase {
  const overrides = { triggerDistance: { [obstacle]: distance } };
  return { name: `${scenario}-t${distance}-s${seed}`, scenario, seed, overrides };
}

/**
 * The cases: speeds around each file's own and two seeds of the sensor's noise where there is an obstacle; on pedestrian a
 * later pedestrian, on moose the moose where braking starts to suffice (D* = 24 m, M5) and later; ice has no
 * obstacle, hence no noise, and one seed per speed. 6455 QPs of the fast solver (2026-11-04).
 */
export const GO_NO_GO_CASES: readonly GoNoGoCase[] = [
  ...sweep('pedestrian', [40, 50, 60], [1, 2]),
  triggered('pedestrian', 'pedestrian', 25, 1),
  ...sweep('moose', [50, 60, 70], [1, 2]),
  triggered('moose', 'moose', 24, 1),
  triggered('moose', 'moose', 30, 1),
  ...sweep('ice', [60, 70, 80], [1]),
  ...sweep('mu-split', [70, 80, 90], [1, 2]),
];

/** The exact reference: Goldfarb–Idnani on the condensed QP, cold. */
export function exactStepSolver(): StepSolver {
  return new CondensedStepSolver('gi-condensed', new GoldfarbIdnaniSolver());
}

/** Nearest-rank order statistics, ms (as the CLI's bench/stats.ts). */
export interface StepSummary {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

function summarize(values: readonly number[]): StepSummary {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? Number.NaN };
}

/** What one closed-loop run gave. */
interface Drive {
  /** The maneuver in force at every control cycle, and the twin's (empty without one). */
  readonly chosen: readonly BranchId[];
  readonly twin: readonly BranchId[];
  readonly fingerprint: string;
  /** Every full step, ms (empty when untimed). */
  readonly stepMs: readonly number[];
  /** The driving solver's QPs, and those the iteration cap stopped. */
  readonly qps: number;
  readonly capped: number;
  readonly collided: boolean;
}

interface DriveOptions {
  readonly timed?: boolean;
  /** The twin's solver: a second decision driver fed the same vehicle, its commands discarded. */
  readonly twin?: () => StepSolver;
}

function drive(scenario: Scenario, seed: number, makeSolver: () => StepSolver, options: DriveOptions = {}): Drive {
  const chosen: BranchId[] = [];
  const twinChosen: BranchId[] = [];
  const stepMs: number[] = [];
  let qps = 0;
  let capped = 0;
  const counted = (): StepSolver => {
    const inner = makeSolver();
    return {
      name: inner.name,
      solve(ocp) {
        const solution = inner.solve(ocp);
        qps++;
        if (solution.status === 'maxIterations') capped++;
        return solution;
      },
      reset: () => inner.reset(),
    };
  };
  const ego: ControllerFactory = (c) => {
    const decisionDriver = (solver: () => StepSolver, log: BranchId[]) =>
      new DecisionDriver(c.params, c.mu, c.road, c.corridor, c.reference, c.lane, {
        solver,
        tracks: c.tracks,
        friction: c.friction,
        branch: { stillLateralSpeed: stillLateralSpeed(scenario.sensor.noise.velocity) },
        onDecision: (d) => log.push(d.chosen),
      });
    const driver = decisionDriver(() => counted(), chosen);
    const twin = options.twin ? decisionDriver(options.twin, twinChosen) : undefined;
    if (!options.timed && twin === undefined) return driver;
    const discarded: DriverCommand = { steer: 0, accel: 0 };
    const step: Controller = {
      periodTicks: driver.periodTicks,
      delayTicks: driver.delayTicks,
      compute(tick, vehicle, out) {
        if (options.timed) {
          const start = performance.now();
          driver.compute(tick, vehicle, out);
          stepMs.push(performance.now() - start);
        } else {
          driver.compute(tick, vehicle, out);
        }
        twin?.compute(tick, vehicle, discarded);
      },
    };
    return step;
  };
  const result = runScenario(scenario, { seed, ego });
  const collided = result.ego.metrics.collided;
  return { chosen, twin: twinChosen, fingerprint: result.fingerprint, stepMs, qps, capped, collided };
}

/** Cycles whose maneuvers agree, over the longer of the two sequences. */
function agreeing(a: readonly BranchId[], b: readonly BranchId[]): { cycles: number; agreeing: number } {
  const cycles = Math.max(a.length, b.length);
  let same = 0;
  for (let i = 0; i < cycles; i++) if (a[i] !== undefined && a[i] === b[i]) same++;
  return { cycles, agreeing: same };
}

export interface GoNoGoCaseReport {
  readonly name: string;
  readonly qps: number;
  readonly capped: number;
  /** Control cycles, and those whose maneuver in force is the twin's: the reference's at the same state. */
  readonly cycles: number;
  readonly agreeing: number;
  /** The same against the exact solver's own closed loop (information, not a criterion). */
  readonly closedLoopCycles: number;
  readonly closedLoopAgreeing: number;
  readonly step: StepSummary;
  /** The timed run's fingerprint; whether the twin run gave the same; the exact closed loop's. */
  readonly fingerprint: string;
  readonly twinNeutral: boolean;
  readonly referenceFingerprint: string;
  readonly collided: boolean;
  readonly referenceCollided: boolean;
}

export interface GoNoGoChecks {
  readonly stepP95: boolean;
  readonly stepP99: boolean;
  readonly capped: boolean;
  readonly agreement: boolean;
}

export interface GoNoGoReport {
  readonly cases: readonly GoNoGoCaseReport[];
  /** The fast solver's QPs and full steps over every case. */
  readonly qps: number;
  readonly steps: number;
  readonly step: StepSummary;
  readonly cappedShare: number;
  /** The criterion's agreement (same state), and the closed loops' (information). */
  readonly agreement: number;
  readonly closedLoopAgreement: number;
  readonly checks: GoNoGoChecks;
  readonly go: boolean;
}

/** Messages of the go/no-go worker (goNoGoWorker.ts) to the page. */
export type GoNoGoMessage =
  | { readonly type: 'case'; readonly report: GoNoGoCaseReport; readonly done: number; readonly total: number }
  | {
      readonly type: 'report';
      readonly report: GoNoGoReport;
      readonly environment: { readonly userAgent: string; readonly hardwareConcurrency: number };
    }
  | { readonly type: 'error'; readonly message: string };

export interface GoNoGoOptions {
  readonly cases?: readonly GoNoGoCase[];
  /** Called as each case ends. */
  readonly onCase?: (report: GoNoGoCaseReport, done: number, total: number) => void;
}

/** Runs the cases (GO_NO_GO_CASES by default) on the parsed v1 scenarios and checks the criteria. */
export function runGoNoGo(
  scenarios: Readonly<Record<GoNoGoScenarioId, Scenario>>,
  options: GoNoGoOptions = {},
): GoNoGoReport {
  const list = options.cases ?? GO_NO_GO_CASES;
  const build = (c: GoNoGoCase) => overrideScenario(scenarios[c.scenario], c.overrides);
  const first = list[0];
  if (first !== undefined) drive(build(first), first.seed, defaultStepSolver);
  const cases: GoNoGoCaseReport[] = [];
  const steps: number[] = [];
  for (const c of list) {
    const scenario = build(c);
    const timed = drive(scenario, c.seed, defaultStepSolver, { timed: true });
    const twinned = drive(scenario, c.seed, defaultStepSolver, { twin: exactStepSolver });
    const exact = drive(scenario, c.seed, exactStepSolver);
    const same = agreeing(twinned.chosen, twinned.twin);
    const closed = agreeing(timed.chosen, exact.chosen);
    for (const ms of timed.stepMs) steps.push(ms);
    const report: GoNoGoCaseReport = {
      name: c.name,
      qps: timed.qps,
      capped: timed.capped,
      cycles: same.cycles,
      agreeing: same.agreeing,
      closedLoopCycles: closed.cycles,
      closedLoopAgreeing: closed.agreeing,
      step: summarize(timed.stepMs),
      fingerprint: timed.fingerprint,
      twinNeutral: twinned.fingerprint === timed.fingerprint,
      referenceFingerprint: exact.fingerprint,
      collided: timed.collided,
      referenceCollided: exact.collided,
    };
    cases.push(report);
    options.onCase?.(report, cases.length, list.length);
  }
  const total = (pick: (r: GoNoGoCaseReport) => number) => cases.reduce((sum, r) => sum + pick(r), 0);
  const qps = total((r) => r.qps);
  const share = (part: number, whole: number) => (whole > 0 ? part / whole : 1);
  const step = summarize(steps);
  const cappedShare = qps > 0 ? total((r) => r.capped) / qps : 0;
  const agreement = share(
    total((r) => r.agreeing),
    total((r) => r.cycles),
  );
  const closedLoopAgreement = share(
    total((r) => r.closedLoopAgreeing),
    total((r) => r.closedLoopCycles),
  );
  const checks: GoNoGoChecks = {
    stepP95: step.p95 <= GO_NO_GO_CRITERIA.stepP95,
    stepP99: step.p99 <= GO_NO_GO_CRITERIA.stepP99,
    capped: cappedShare <= GO_NO_GO_CRITERIA.capped,
    agreement: agreement >= GO_NO_GO_CRITERIA.agreement,
  };
  return {
    cases,
    qps,
    steps: steps.length,
    step,
    cappedShare,
    agreement,
    closedLoopAgreement,
    checks,
    go: checks.stepP95 && checks.stepP99 && checks.capped && checks.agreement,
  };
}
