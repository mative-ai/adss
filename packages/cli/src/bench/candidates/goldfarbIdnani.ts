/**
 * The MPC's solver: the fast Goldfarb–Idnani (core qp/goldfarbIdnaniFast.ts), and the same solver on
 * the reference's path, which isolates what fixing the slacks at their bound saves. The other solvers that were tried
 * are no longer in the tree.
 */
import { GiStepSolver } from '@mpc-simulator/core';

import type { Candidate } from '../candidate.ts';

export const candidates: readonly Candidate[] = [
  {
    name: 'gi-fast',
    note: 'fast Goldfarb–Idnani, own condensing, slacks fixed at their bound until it drops, cold: the MPC default',
    create: () => new GiStepSolver('gi-fast'),
  },
  {
    name: 'gi-fast-plain',
    note: 'fast Goldfarb–Idnani, own condensing into compressed rows, the reference path (no bounds fixed), cold',
    create: () => new GiStepSolver('gi-fast-plain', { settings: { eliminateBounds: false } }),
  },
];
