/**
 * The recording step solver of the benchmark's corpus: it forwards every call to a real solver and reports each QP
 * with its solution, its time and whether the solver was reset since the previous QP of the same stream. A reset is
 * part of the sequence a stream's solver sees (MpcController.step resets its solver after an unusable solution, the
 * decision layer cold-starts every candidate it did not choose), so the corpus records it and measure.ts replays it
 * before the QP that followed it; without it, a replayed candidate would warm-start where the live run started cold.
 */
import type { OcpQp, StepSolution, StepSolver } from '@mpc-simulator/core';

/** One step-solver call: its stream (the solver it went to, in creation order), QP and solution. */
export interface SolverCall {
  readonly stream: number;
  /** The stream's solver was reset at least once since its previous QP (or since it was created). */
  readonly reset: boolean;
  readonly ocp: OcpQp;
  readonly solution: StepSolution;
  /** The solve alone, ms: measured in the CLI, it never enters the run. */
  readonly ms: number;
}

/** Wraps `inner` as stream `stream`; `onCall` sees every solve. */
export function recordingSolver(inner: StepSolver, stream: number, onCall: (call: SolverCall) => void): StepSolver {
  let reset = false;
  return {
    name: inner.name,
    solve(ocp) {
      const start = performance.now();
      const solution = inner.solve(ocp);
      const ms = performance.now() - start;
      onCall({ stream, reset, ocp, solution, ms });
      reset = false;
      return solution;
    },
    reset() {
      reset = true;
      inner.reset();
    },
  };
}
