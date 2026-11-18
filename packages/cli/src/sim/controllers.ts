/**
 * The controllers `npm run sim` drives a scenario with, in one place. The ego is, by default, the MPC with the
 * decision layer: up to four candidate maneuvers per control cycle, compared on the common decision cost of
 * their rollouts (core mpc/decisionDriver.ts). `--controller stop` drives the single maneuver of tranche 1 instead:
 * the MPC braking in its lane ('stop'). Both get what the scenario lets a controller know: the obstacle tracks of
 * their own sensor, the friction preview, vx ≥ 0 with the low-speed model (standstill) and the road's demand on
 * curves. The decision layer counts a track as standing below 2.5 σ of the scenario's own sensor velocity noise
 * (core stillLateralSpeed). The ghost is the baseline controller, with its own sensor, as the comparison the report shows.
 *
 * Each step solver is wrapped to time each QP, and the ego's control step is timed whole (observe, predict, every
 * candidate's QP and rollout, the decision); the times are measured here, in the CLI, never in the core.
 */
import {
  BaselineDriver,
  DecisionDriver,
  defaultStepSolver,
  MpcDriver,
  stillLateralSpeed,
  type Controller,
  type ControllerFactory,
  type DecisionReport,
  type StepSolver,
} from '@mpc-simulator/core';

export const SIM_CONTROLLERS = ['decision', 'stop'] as const;
export type SimControllerId = (typeof SIM_CONTROLLERS)[number];

export interface SimControllers {
  readonly ego: ControllerFactory;
  readonly ghost?: ControllerFactory;
  /** Time of each step-solver call of the ego, ms, in call order. */
  readonly solveMs: number[];
  /** Time of each control step of the ego, ms, and the QPs it solved, in call order. */
  readonly stepMs: number[];
  readonly stepQps: number[];
  /** The decision layer's report of every control cycle (empty for `stop`). */
  readonly decisions: DecisionReport[];
}

export interface SimControllerOptions {
  readonly ghost?: boolean;
  readonly controller?: SimControllerId;
  /** The scenario's sensor velocity noise σ, m/s (scenario.sensor.noise.velocity); the v1 sensor's when absent. */
  readonly velocityNoise?: number;
}

export function simControllers(options: SimControllerOptions = {}): SimControllers {
  const solveMs: number[] = [];
  const stepMs: number[] = [];
  const stepQps: number[] = [];
  const decisions: DecisionReport[] = [];
  const timedSolver = (): StepSolver => {
    const solver = defaultStepSolver();
    return {
      name: solver.name,
      solve(ocp) {
        const start = performance.now();
        const solution = solver.solve(ocp);
        solveMs.push(performance.now() - start);
        return solution;
      },
      reset: () => solver.reset(),
    };
  };
  const timed = (controller: Controller): Controller => ({
    periodTicks: controller.periodTicks,
    delayTicks: controller.delayTicks,
    compute(tick, vehicle, out) {
      const qps = solveMs.length;
      const start = performance.now();
      controller.compute(tick, vehicle, out);
      stepMs.push(performance.now() - start);
      stepQps.push(solveMs.length - qps);
    },
  });
  const ego: ControllerFactory = (context) => {
    if (options.controller === 'stop') {
      return timed(
        new MpcDriver(context.params, context.mu, context.road, context.corridor, context.reference, {
          solver: timedSolver(),
          tracks: context.tracks,
          friction: context.friction,
          standstill: true,
          roadDemand: true,
          side: 'stop',
        }),
      );
    }
    return timed(
      new DecisionDriver(context.params, context.mu, context.road, context.corridor, context.reference, context.lane, {
        solver: () => timedSolver(),
        tracks: context.tracks,
        friction: context.friction,
        ...(options.velocityNoise !== undefined && {
          branch: { stillLateralSpeed: stillLateralSpeed(options.velocityNoise) },
        }),
        onDecision: (report) => decisions.push(report),
      }),
    );
  };
  const ghost: ControllerFactory = (context) =>
    new BaselineDriver(context.params, context.road, context.reference, context.tracks);
  return options.ghost === false
    ? { ego, solveMs, stepMs, stepQps, decisions }
    : { ego, ghost, solveMs, stepMs, stepQps, decisions };
}
