/**
 * One candidate on the corpus. A first pass warms the JIT up and is discarded; then each timed pass runs the
 * whole corpus with fresh solvers, one per run and stream (the solver a QP went to when it was recorded), so the
 * warm starts follow the same sequence in every pass and a stream's QPs reach the solver they were recorded with;
 * a stream's solver is reset before every QP the live run reset it before (bench/recording.ts), so a candidate
 * starts cold wherever the recorded run did. A QP's time is its median across the timed passes, the reset left
 * out. The plan of each QP is compared with the exact solution of the same QP, and every pass must return the same
 * solutions to the bit: status, iterations, objective, inputs and slacks.
 */
import type { StepSolution, StepSolver } from '@mpc-simulator/core';

import type { Candidate } from './candidate.ts';
import type { Corpus, CorpusSource } from './corpus.ts';
import { median, summarize, type Summary } from './stats.ts';

/** First-command errors above these are counted as off: about 0.06° of steering and 0.01 m/s². */
export const STEER_TOLERANCE = 1e-3;
export const ACCEL_TOLERANCE = 1e-2;

export interface Measure extends Summaries {
  readonly name: string;
  readonly note: string;
  /** Every timed pass returned the same solutions (status, iterations, objective, du, slack), bit for bit. */
  readonly deterministic: boolean;
  /** The same summaries over each source's QPs, when the corpus has more than one. */
  readonly bySource?: Partial<Record<CorpusSource, Summaries>>;
}

export interface Summaries {
  readonly qps: number;
  /** The step solver (the QP in its form and its solve), ms per QP. */
  readonly timeMs: Summary;
  readonly iterations: Summary;
  /** Share of QPs stopped by the iteration cap. */
  readonly capped: number;
  /** QPs with no usable plan (status failed or infeasible, or a non-finite input). */
  readonly failed: number;
  /** |δ_cmd − δ_cmd*| of the first input, rad, over the usable QPs. */
  readonly steerError: Summary;
  /** |a_cmd − a_cmd*| of the first input, m/s², over the usable QPs. */
  readonly accelError: Summary;
  /**
   * The largest error over the whole plan, steering in rad and acceleration in m/s², over the usable QPs: the
   * decision layer of Phase 3 compares maneuvers on the rollout of the whole plan, not of its first input.
   */
  readonly planSteerError: Summary;
  readonly planAccelError: Summary;
  /** Share of QPs whose first command is off by more than the tolerances, or unusable. */
  readonly off: number;
  /** (J − J*)/max(1, |J*|) over the usable QPs. */
  readonly objectiveGap: Summary;
}

function usable(solution: StepSolution): boolean {
  const ok = solution.status === 'solved' || solution.status === 'maxIterations';
  return ok && solution.du.every(Number.isFinite);
}

const sameArray = (a: Float64Array, b: Float64Array) => a.length === b.length && a.every((v, j) => Object.is(v, b[j]));

/** The same solution to the bit: status, iterations, objective, inputs and slacks. */
export function same(a: StepSolution, b: StepSolution | undefined): boolean {
  return (
    b !== undefined &&
    a.status === b.status &&
    a.iterations === b.iterations &&
    Object.is(a.objective, b.objective) &&
    sameArray(a.du, b.du) &&
    sameArray(a.slack, b.slack)
  );
}

function pass(candidate: Candidate, corpus: Corpus, times?: number[][]): StepSolution[] {
  const solvers = new Map<string, StepSolver>();
  const out: StepSolution[] = [];
  corpus.steps.forEach((step, i) => {
    const key = `${step.run}:${step.stream}`;
    let solver = solvers.get(key);
    if (!solver) {
      solver = candidate.create();
      solvers.set(key, solver);
    }
    if (step.reset) solver.reset();
    const start = performance.now();
    out.push(solver.solve(step.ocp));
    times?.[i]?.push(performance.now() - start);
  });
  return out;
}

/** What one QP gave: its time, iterations and errors against the exact solution. */
interface StepResult {
  readonly timeMs: number;
  readonly iterations: number;
  readonly capped: boolean;
  /** Errors and objective gap, absent when the plan is not usable. */
  readonly errors?: { steer: number; accel: number; planSteer: number; planAccel: number; gap: number };
}

function stepResult(s: StepSolution, exact: StepSolution | undefined, timeMs: number): StepResult {
  const base = { timeMs, iterations: s.iterations, capped: s.status === 'maxIterations' };
  if (!usable(s) || !exact) return base;
  let planSteer = 0;
  let planAccel = 0;
  for (let k = 0; k < s.du.length; k += 2) {
    planSteer = Math.max(planSteer, Math.abs((s.du[k] ?? 0) - (exact.du[k] ?? 0)));
    planAccel = Math.max(planAccel, Math.abs((s.du[k + 1] ?? 0) - (exact.du[k + 1] ?? 0)));
  }
  return {
    ...base,
    errors: {
      steer: Math.abs((s.du[0] ?? 0) - (exact.du[0] ?? 0)),
      accel: Math.abs((s.du[1] ?? 0) - (exact.du[1] ?? 0)),
      planSteer,
      planAccel,
      gap: (s.objective - exact.objective) / Math.max(1, Math.abs(exact.objective)),
    },
  };
}

function summaries(results: readonly StepResult[]): Summaries {
  const errors = results.flatMap((r) => (r.errors ? [r.errors] : []));
  const n = results.length;
  const failed = n - errors.length;
  const outside = errors.filter((e) => e.steer > STEER_TOLERANCE || e.accel > ACCEL_TOLERANCE).length;
  return {
    qps: n,
    timeMs: summarize(results.map((r) => r.timeMs)),
    iterations: summarize(results.map((r) => r.iterations)),
    capped: results.filter((r) => r.capped).length / n,
    failed,
    steerError: summarize(errors.map((e) => e.steer)),
    accelError: summarize(errors.map((e) => e.accel)),
    planSteerError: summarize(errors.map((e) => e.planSteer)),
    planAccelError: summarize(errors.map((e) => e.planAccel)),
    off: (failed + outside) / n,
    objectiveGap: summarize(errors.map((e) => e.gap)),
  };
}

export function measure(candidate: Candidate, corpus: Corpus, passes: number): Measure {
  const steps = corpus.steps;
  pass(candidate, corpus);
  const times = steps.map(() => [] as number[]);
  const results: StepSolution[][] = [];
  for (let p = 0; p < passes; p++) results.push(pass(candidate, corpus, times));
  const first = results[0] ?? [];
  const deterministic = results.every((r) => r.length === first.length && r.every((s, i) => same(s, first[i])));
  const perStep = first.map((s, i) => stepResult(s, steps[i]?.exact, median(times[i] ?? [])));
  const sources = [...new Set(corpus.runs.map((r) => r.source))];
  const bySource: Partial<Record<CorpusSource, Summaries>> = {};
  if (sources.length > 1) {
    for (const source of sources) {
      bySource[source] = summaries(perStep.filter((_, i) => corpus.runs[steps[i]?.run ?? -1]?.source === source));
    }
  }
  return {
    name: candidate.name,
    note: candidate.note,
    ...summaries(perStep),
    deterministic,
    ...(sources.length > 1 ? { bySource } : {}),
  };
}
