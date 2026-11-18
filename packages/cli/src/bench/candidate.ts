/** A step solver the benchmark measures: a form of the step's QP and the solver that takes it. */
import type { StepSolver } from '@mpc-simulator/core';

export interface Candidate {
  readonly name: string;
  /** What it is, in a few words, for the report. */
  readonly note: string;
  /** A fresh solver, with nothing kept from a previous run. */
  create(): StepSolver;
}
