/**
 * A form of the step's QP and the solver that takes it: the part of the MPC with more than one candidate,
 * behind one interface so that the MPC, the tests and the benchmark can swap it.
 */
import { GoldfarbIdnaniFastSolver, type GoldfarbIdnaniFastSettings } from '../qp/goldfarbIdnaniFast.ts';
import type { QpSolver, QpStatus } from '../qp/problem.ts';
import { Condenser } from './lowering.ts';
import type { OcpQp } from './ocpQp.ts';
import { RowCondenser } from './rowCondenser.ts';

export interface StepSolution {
  readonly status: QpStatus;
  readonly iterations: number;
  /** Input deviations δU, N×NU. */
  readonly du: Float64Array;
  /** Slack values, in the OcpQp's order. */
  readonly slack: Float64Array;
  /** Objective of the QP, the same in every form for the same point. */
  readonly objective: number;
}

export interface StepSolver {
  readonly name: string;
  solve(ocp: OcpQp): StepSolution;
  /** Forgets what the solver keeps between steps, if anything. */
  reset(): void;
}

/** The condensed form, dense, with any dense solver, cold: how the exact reference runs. */
export class CondensedStepSolver implements StepSolver {
  readonly name: string;
  private readonly solver: QpSolver;
  private readonly condenser = new Condenser();

  constructor(name: string, solver: QpSolver) {
    this.name = name;
    this.solver = solver;
  }

  solve(ocp: OcpQp): StepSolution {
    const result = this.solver.solve(this.condenser.lower(ocp));
    const inputs = ocp.horizon * ocp.nu;
    return {
      status: result.status,
      iterations: result.iterations,
      du: result.x.slice(0, inputs),
      slack: result.x.slice(inputs),
      objective: result.objective,
    };
  }

  reset(): void {}
}

export interface GiStepSolverOptions {
  readonly settings?: Partial<GoldfarbIdnaniFastSettings>;
}

/**
 * The condensed form, condensed straight into compressed rows, with the fast Goldfarb–Idnani, cold: the MPC's
 * default.
 */
export class GiStepSolver implements StepSolver {
  readonly name: string;
  readonly solver: GoldfarbIdnaniFastSolver;
  private readonly condenser = new RowCondenser();

  constructor(name: string, options: GiStepSolverOptions = {}) {
    this.name = name;
    this.solver = new GoldfarbIdnaniFastSolver(options.settings);
  }

  solve(ocp: OcpQp): StepSolution {
    const result = this.solver.solveRows(this.condenser.lower(ocp));
    const inputs = ocp.horizon * ocp.nu;
    return {
      status: result.status,
      iterations: result.iterations,
      du: result.x.slice(0, inputs),
      slack: result.x.slice(inputs),
      objective: result.objective,
    };
  }

  reset(): void {}
}
