/**
 * The go/no-go benchmark (goNoGo.ts) in Node: its cases are valid on the v1 scenarios, and one case drives with both
 * solvers into a report whose numbers hold together and whose fingerprints repeat. The verdict itself comes from the
 * Chrome worker (bench.html), not from here.
 */
import { describe, expect, it } from 'vitest';

import { overrideScenario, parseScenario } from '@mpc-simulator/core';

import moose from '../../../../scenarios/moose.json';
import ice from '../../../../scenarios/ice.json';
import muSplit from '../../../../scenarios/mu-split.json';
import pedestrian from '../../../../scenarios/pedestrian.json';
import { GO_NO_GO_CASES, GO_NO_GO_CRITERIA, runGoNoGo } from './goNoGo.ts';

const scenarios = {
  pedestrian: parseScenario(pedestrian),
  moose: parseScenario(moose),
  ice: parseScenario(ice),
  'mu-split': parseScenario(muSplit),
};

describe('the go/no-go benchmark', () => {
  it('has valid, distinct cases on the four v1 scenarios', () => {
    const names = GO_NO_GO_CASES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(GO_NO_GO_CASES.map((c) => c.scenario))).toEqual(new Set(['pedestrian', 'moose', 'ice', 'mu-split']));
    for (const c of GO_NO_GO_CASES) expect(() => overrideScenario(scenarios[c.scenario], c.overrides)).not.toThrow();
    expect(GO_NO_GO_CRITERIA).toEqual({ stepP95: 20, stepP99: 35, capped: 0.005, agreement: 0.995 });
  });

  it('drives a case with the fast solver and the exact reference into a consistent report', () => {
    const one = GO_NO_GO_CASES.filter((c) => c.name === 'pedestrian-50-s1');
    const seen: string[] = [];
    const a = runGoNoGo(scenarios, { cases: one, onCase: (r, done, total) => seen.push(`${r.name} ${done}/${total}`) });
    const b = runGoNoGo(scenarios, { cases: one });
    expect(seen).toEqual(['pedestrian-50-s1 1/1']);
    const r = a.cases[0]!;
    // 8 s at 20 Hz; up to 4 QPs per cycle, at least one.
    expect(r.cycles).toBe(160);
    expect(a.steps).toBe(160);
    expect(r.qps).toBeGreaterThanOrEqual(160);
    expect(r.qps).toBeLessThanOrEqual(4 * 160);
    expect(a.qps).toBe(r.qps);
    expect(r.agreeing).toBeLessThanOrEqual(r.cycles);
    expect(a.agreement).toBe(r.agreeing / r.cycles);
    expect(r.closedLoopAgreeing).toBeLessThanOrEqual(r.closedLoopCycles);
    expect(a.closedLoopAgreement).toBe(r.closedLoopAgreeing / r.closedLoopCycles);
    // The twin reads the vehicle and never drives it: the run is the same as without it.
    expect(r.twinNeutral).toBe(true);
    expect(r.step.p50).toBeGreaterThan(0);
    expect(r.step.p50).toBeLessThanOrEqual(r.step.p95);
    expect(r.step.p95).toBeLessThanOrEqual(r.step.p99);
    expect(r.step.p99).toBeLessThanOrEqual(r.step.max);
    // Timing changes nothing: the same fingerprints on every run.
    expect(b.cases[0]?.fingerprint).toBe(r.fingerprint);
    expect(b.cases[0]?.referenceFingerprint).toBe(r.referenceFingerprint);
    expect(a.go).toBe(Object.values(a.checks).every(Boolean));
  }, 120_000);
});
