/** The exact reference every candidate is compared with. */
import type { Candidate } from '../candidate.ts';
import { exactSolver } from '../corpus.ts';

export const candidates: readonly Candidate[] = [
  { name: 'gi-condensed', note: 'Goldfarb–Idnani, condensed, cold: the exact reference', create: exactSolver },
];
