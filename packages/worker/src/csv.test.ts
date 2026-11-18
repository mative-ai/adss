/**
 * M8 (Phase 4): a run saved as CSV reads back without loss, to the bit, and the ghost read back has the
 * ghost's fingerprint; the file alone rebuilds the run.
 */
import { describe, expect, it } from 'vitest';

import { parseScenario, vehicleFingerprint } from '@mpc-simulator/core';

import muSplit from '../../../scenarios/mu-split.json';
import pedestrian from '../../../scenarios/pedestrian.json';
import { CsvError, csvNumber, parseRunCsv, runToCsv } from './csv.ts';
import type { SessionConfig } from './protocol.ts';
import { runSession, SimulationSession } from './session.ts';

/** The same doubles to the bit (−0 and NaN payloads included). */
function sameBits(a: Float64Array, b: Float64Array): boolean {
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

describe('M8: the CSV of a run', () => {
  it('reads back to the bit, with the fingerprints of the run, and rebuilds it', () => {
    const session = runSession(muSplit, 2);
    const result = session.run.result();
    const metrics = session.metrics();
    const csv = parseRunCsv(runToCsv(session));
    for (const [read, run] of [
      [csv.ego, result.ego],
      [csv.ghost, result.ghost],
    ] as const) {
      expect(read).not.toBeNull();
      expect(run).not.toBeNull();
      expect(sameBits(read!.records, run!.records)).toBe(true);
      expect(sameBits(read!.trackLog, run!.trackLog)).toBe(true);
      expect(read!.events).toEqual(run!.events);
      expect(read!.ticks).toBe(run!.ticks);
      expect(read!.end).toBe(run!.end);
    }
    const scenario = parseScenario(csv.scenario);
    expect(vehicleFingerprint(scenario, csv.ghost!)).toBe(metrics.ghost?.fingerprint);
    expect(csv.ghost?.fingerprint).toBe(metrics.ghost?.fingerprint);
    expect(vehicleFingerprint(scenario, csv.ego)).toBe(metrics.ego.fingerprint);
    // The file alone: scenario, seed and configuration give the same run again.
    const again = runSession(csv.scenario, csv.seed, csv.config as Partial<SessionConfig>);
    expect(again.metrics().fingerprint).toBe(csv.fingerprint);
    expect(csv.fingerprint).toBe(metrics.fingerprint);
    expect(csv.tick).toBe(session.tick);
    // Opened and saved again with Windows line ends, it reads the same.
    expect(parseRunCsv(runToCsv(session).replaceAll('\n', '\r\n'))).toEqual(csv);
  }, 60_000);

  it('says when a run was saved before its end, and rebuilds it to the tick it had reached', () => {
    const session = new SimulationSession(pedestrian, 3);
    session.advance(3000);
    const csv = parseRunCsv(runToCsv(session));
    expect(csv.tick).toBe(3000);
    expect([csv.ego.end, csv.ghost?.end]).toEqual(['running', 'running']);
    expect(vehicleFingerprint(parseScenario(csv.scenario), csv.ego)).toBe(csv.ego.fingerprint);
    const again = new SimulationSession(csv.scenario, csv.seed, csv.config as Partial<SessionConfig>);
    again.advance(csv.tick);
    expect(again.metrics().fingerprint).toBe(csv.fingerprint);
    expect(csv.fingerprint).not.toBe(runSession(pedestrian, 3).metrics().fingerprint);
  }, 60_000);

  it('keeps −0, NaN and the infinities, and refuses a file it did not write', () => {
    const text = [
      '# mpc-simulator-run 1',
      '# scenario null',
      '# seed 1',
      '# config {}',
      '# tick 1',
      '# fingerprint 0',
      '# vehicle ego 0 duration 1',
      `record,ego,0,-0,NaN,Infinity,-Infinity,5e-324,${Number.MAX_VALUE},0.1,0,0,0,0,0,0`,
    ].join('\n');
    const record = parseRunCsv(text).ego.records;
    expect(Object.is(record[1], -0)).toBe(true);
    expect(record[2]).toBeNaN();
    expect(record[3]).toBe(Number.POSITIVE_INFINITY);
    expect(record[4]).toBe(Number.NEGATIVE_INFINITY);
    expect(record[5]).toBe(5e-324);
    expect(record[6]).toBe(Number.MAX_VALUE);
    expect(() => parseRunCsv('a,b,c\n1,2,3\n')).toThrow(CsvError);
    expect(() => parseRunCsv(`${text}\nrecord,ego,1,2`)).toThrow(CsvError);
    // Another version of the format, an event without its tick, a vehicle with an end it does not know.
    expect(() => parseRunCsv(text.replace('run 1', 'run 2'))).toThrow(CsvError);
    expect(() => parseRunCsv(`${text}\nevent,ego,roadEnd,,,`)).toThrow(CsvError);
    expect(() => parseRunCsv(text.replace('duration 1', 'crashed 1'))).toThrow(CsvError);
  });

  it('writes −0, NaN, the infinities and the extremes so that they read back to the bit', () => {
    // No v1 run records a −0: the writer's cells are checked here, one record of RUN_RECORD's 14 values.
    const values = [
      -0,
      Number.NaN,
      Infinity,
      -Infinity,
      5e-324,
      Number.MAX_VALUE,
      2 ** 53 + 2,
      0.1,
      -1e-300,
      0,
      1,
      2,
      3,
      4,
    ];
    const text = [
      '# mpc-simulator-run 1',
      '# tick 1',
      '# vehicle ego 0 duration 1',
      `record,ego,${values.map(csvNumber).join(',')}`,
    ].join('\n');
    expect(sameBits(parseRunCsv(text).ego.records, Float64Array.from(values))).toBe(true);
  });

  it('rebuilds a run of another configuration from the file alone', () => {
    const config: Partial<SessionConfig> = {
      ghost: false,
      horizon: 15,
      maneuvers: ['keep', 'brake'],
      noise: { position: 0.2, velocity: 0.1 },
      speedKmh: 45,
    };
    const session = runSession(pedestrian, 4, config);
    const csv = parseRunCsv(runToCsv(session));
    expect(csv.ghost).toBeNull();
    const again = runSession(csv.scenario, csv.seed, csv.config as Partial<SessionConfig>);
    expect(again.metrics().fingerprint).toBe(session.metrics().fingerprint);
    expect(again.metrics().fingerprint).not.toBe(runSession(pedestrian, 4).metrics().fingerprint);
  }, 60_000);
});
