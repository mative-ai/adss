import { describe, expect, it } from 'vitest';

import { MpcDriver, type OcpQp, type StepSolution, type StepSolver } from '@mpc-simulator/core';

import type { Candidate } from './candidate.ts';
import { corpusFingerprint, recordCorpus, type Corpus, type CorpusStep } from './corpus.ts';
import { measure, same } from './measure.ts';
import { recordingSolver, type SolverCall } from './recording.ts';
import { driveScenario, SCENARIO_CASES, type ScenarioCase } from './scenarioCorpus.ts';

const solution = (value: number): StepSolution => ({
  status: 'solved',
  iterations: 1,
  du: Float64Array.of(value, value),
  slack: new Float64Array(0),
  objective: value,
});

/** A solver that answers with how many QPs it has seen since its last reset, and logs what it was asked. */
function countingSolver(log: string[]): StepSolver {
  let seen = 0;
  return {
    name: 'counting',
    solve() {
      log.push(`solve ${seen}`);
      return solution(seen++);
    },
    reset() {
      log.push('reset');
      seen = 0;
    },
  };
}

const qp = {} as OcpQp;

describe('recordingSolver', () => {
  it('flags the QPs that follow a reset of their stream', () => {
    const calls: SolverCall[] = [];
    const solver = recordingSolver(countingSolver([]), 3, (call) => calls.push(call));
    solver.solve(qp);
    solver.reset();
    solver.reset();
    solver.solve(qp);
    solver.solve(qp);
    expect(calls.map((c) => [c.stream, c.reset])).toEqual([
      [3, false],
      [3, true],
      [3, false],
    ]);
  });
});

describe('scenario recording', () => {
  const base = SCENARIO_CASES.find((c) => c.name === 'pedestrian-40-stop-s1') as ScenarioCase;

  it('records the resets the controller makes, in the QP stream they belong to', () => {
    // An ego that resets its solver before every other QP, as the decision layer cold-starts an unchosen candidate.
    const resetting: ScenarioCase = {
      ...base,
      ego: (c, solver) => {
        const inner = solver();
        let n = 0;
        const flaky: StepSolver = {
          name: inner.name,
          solve(ocp) {
            if (n++ % 2 === 1) inner.reset();
            return inner.solve(ocp);
          },
          reset: () => inner.reset(),
        };
        return new MpcDriver(c.params, c.mu, c.road, c.corridor, c.reference, {
          solver: flaky,
          tracks: c.tracks,
          friction: c.friction,
          standstill: true,
          roadDemand: true,
          side: 'stop',
        });
      },
    };
    const calls: SolverCall[] = [];
    driveScenario(
      resetting,
      () => countingSolver([]),
      (call) => calls.push(call),
    );
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.every((c, i) => c.stream === 0 && c.reset === (i % 2 === 1))).toBe(true);
  }, 60_000);

  it('gives the same corpus and fingerprint on every recording, and the fingerprint sees every change', () => {
    const a = recordCorpus({ choice: 'scenarios', names: [base.name] });
    const b = recordCorpus({ choice: 'scenarios', names: [base.name] });
    expect(a.steps.length).toBeGreaterThan(100);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.steps.every((s, i) => same(s.exact, a.steps[i]?.exact))).toBe(true);
    expect(a.duplicateRuns).toEqual([]);

    const steps = [...a.steps];
    const flip = (i: number, change: (s: CorpusStep) => CorpusStep) =>
      corpusFingerprint(
        a.runs,
        steps.map((s, j) => (j === i ? change(s) : s)),
      );
    expect(flip(5, (s) => ({ ...s, reset: !s.reset }))).not.toBe(a.fingerprint);
    expect(flip(5, (s) => ({ ...s, stream: s.stream + 1 }))).not.toBe(a.fingerprint);
    const upper = [...(steps[5]?.ocp.upper ?? [])];
    upper[0] = (upper[0] ?? 0) * (1 + 1e-15) + 1e-300;
    const withUpper = (ocp: OcpQp): OcpQp => Object.assign(Object.create(Object.getPrototypeOf(ocp)), ocp, { upper });
    expect(flip(5, (s) => ({ ...s, ocp: withUpper(s.ocp) }))).not.toBe(a.fingerprint);
    // Two recordings of a whole run with the exact solver: about 4 s alone, over 9 s inside the full suite.
  }, 60_000);
});

describe('measure', () => {
  it('replays the recorded resets on the solver of the same run and stream', () => {
    const log: string[] = [];
    const candidate: Candidate = { name: 'counting', note: 'test', create: () => countingSolver(log) };
    const step = (run: number, stream: number, reset: boolean): CorpusStep => ({
      run,
      stream,
      reset,
      ocp: qp,
      exact: solution(0),
    });
    const corpus = {
      choice: 'scenarios',
      runs: [{ name: 'r', source: 'scenarios', qps: 4, obstacleQps: 0, resets: 1 }],
      steps: [step(0, 0, false), step(0, 1, false), step(0, 0, false), step(0, 0, true)],
      moose: [],
      scenarios: [],
      fingerprint: '',
      uniqueQps: 4,
      duplicateRuns: [],
    } as unknown as Corpus;
    const result = measure(candidate, corpus, 1);
    // Warm-up pass, then one timed pass: stream 0 sees 0, 1, then a reset and 0 again; stream 1 has its own solver.
    const once = ['solve 0', 'solve 0', 'solve 1', 'reset', 'solve 0'];
    expect(log).toEqual([...once, ...once]);
    expect(result.deterministic).toBe(true);
  });
});
