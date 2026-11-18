/** Every candidate the benchmark knows: the exact reference first, then the MPC's solver. */
import type { Candidate } from './candidate.ts';
import { candidates as baseline } from './candidates/baseline.ts';
import { candidates as goldfarbIdnani } from './candidates/goldfarbIdnani.ts';

export const CANDIDATES: readonly Candidate[] = [...baseline, ...goldfarbIdnani];
