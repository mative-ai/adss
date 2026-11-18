/**
 * A run saved as CSV and read back without loss (M8). The `#` lines of the header hold what rebuilds
 * the run (the scenario as given, the seed, the configuration, the tick it had reached) and its fingerprints; then one
 * table, its first column naming the row's kind:
 * - `record`: a vehicle's 100 Hz record, in the core's RUN_RECORD layout (the columns of the header row);
 * - `event`: kind, tick, obstacle, closing speed (collisions only);
 * - `track`: a track the vehicle's sensor published: tick, obstacle index, s, e_y, v_s, v_ey.
 * Numbers are written in JavaScript's shortest form that reads back to the same double (−0 as "-0"), so a vehicle
 * read back has the fingerprint of the run it came from (vehicleFingerprint of the core). A run saved before its end
 * says so (`running` for a vehicle still on its way) and rebuilds by running to its tick. Ids need no quoting: the
 * scenario's are lowercase letters, digits and dashes.
 */
import {
  RUN_RECORD,
  RUN_RECORD_SIZE,
  TRACK_LOG_SIZE,
  vehicleFingerprint,
  type FingerprintedRun,
  type RunEvent,
  type VehicleRun,
} from '@mpc-simulator/core';

import { PROTOCOL_VERSION } from './protocol.ts';
import type { SimulationSession } from './session.ts';

export const CSV_FORMAT = 'mpc-simulator-run';

const COLUMNS = Object.keys(RUN_RECORD).map((k) => k.toLowerCase());

export type CsvVehicleId = 'ego' | 'ghost';

/** How a vehicle's run ended, or `running` in a run saved before its end. */
export type CsvEnd = VehicleRun['end'] | 'running';
const ENDS: readonly string[] = ['duration', 'collision', 'roadEnd', 'running'] satisfies CsvEnd[];

/** A vehicle read back: what its fingerprint is made of, the fingerprint the file states, and how its run ended. */
export interface CsvVehicle extends FingerprintedRun {
  readonly fingerprint: string;
  readonly end: CsvEnd;
}

export interface RunCsv {
  readonly version: number;
  readonly scenario: unknown;
  readonly seed: number;
  readonly config: unknown;
  /** The tick the run had reached: its last one, or less in a run saved before its end. */
  readonly tick: number;
  readonly fingerprint: string;
  readonly ego: CsvVehicle;
  readonly ghost: CsvVehicle | null;
}

/** A number as a cell: the shortest form that reads back to the same double, −0 as "-0" (String(-0) is "0"). */
export const csvNumber = (v: number) => (Object.is(v, -0) ? '-0' : String(v));

/** The session's run, so far or to its end, as CSV text. */
export function runToCsv(session: SimulationSession): string {
  const result = session.run.result();
  const lines = [
    `# ${CSV_FORMAT} ${PROTOCOL_VERSION}`,
    `# scenario ${JSON.stringify(session.json)}`,
    `# seed ${session.seed}`,
    `# config ${JSON.stringify(session.config)}`,
    `# tick ${session.tick}`,
    `# fingerprint ${result.fingerprint}`,
  ];
  const vehicles: { id: CsvVehicleId; run: VehicleRun; end: CsvEnd }[] = [
    { id: 'ego', run: result.ego, end: session.run.ego.end ?? 'running' },
  ];
  if (result.ghost) vehicles.push({ id: 'ghost', run: result.ghost, end: session.run.ghost?.end ?? 'running' });
  for (const { id, run, end } of vehicles) {
    lines.push(`# vehicle ${id} ${vehicleFingerprint(session.scenario, run)} ${end} ${run.ticks}`);
  }
  lines.push(
    '# rows: record (the columns below), event (kind, tick, obstacle, speed), track (tick, obstacle, s, ey, vs, vey)',
  );
  lines.push(['table', 'vehicle', ...COLUMNS].join(','));
  for (const { id, run } of vehicles) {
    for (let i = 0; i < run.records.length; i += RUN_RECORD_SIZE) {
      lines.push(`record,${id},${Array.from(run.records.subarray(i, i + RUN_RECORD_SIZE), csvNumber).join(',')}`);
    }
    for (const e of run.events) {
      const obstacle = 'obstacle' in e ? e.obstacle : '';
      const speed = e.kind === 'collision' ? csvNumber(e.speed) : '';
      lines.push(`event,${id},${e.kind},${e.tick},${obstacle},${speed}`);
    }
    for (let i = 0; i < run.trackLog.length; i += TRACK_LOG_SIZE) {
      lines.push(`track,${id},${Array.from(run.trackLog.subarray(i, i + TRACK_LOG_SIZE), csvNumber).join(',')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export class CsvError extends Error {
  override readonly name = 'CsvError';
}

/** Reads a CSV written by runToCsv back. */
export function parseRunCsv(text: string): RunCsv {
  const header = new Map<string, string>();
  const vehicles = new Map<CsvVehicleId, { fingerprint: string; end: CsvEnd; ticks: number }>();
  const records = new Map<CsvVehicleId, number[]>();
  const tracks = new Map<CsvVehicleId, number[]>();
  const events = new Map<CsvVehicleId, RunEvent[]>();
  const vehicleId = (v: string | undefined): CsvVehicleId => {
    if (v === 'ego' || v === 'ghost') return v;
    throw new CsvError(`Unknown vehicle: ${String(v)}`);
  };
  const numbers = (cells: readonly string[], count: number): number[] => {
    if (cells.length !== count) throw new CsvError(`Expected ${count} values, got ${cells.length}`);
    return cells.map((c) => {
      const v = Number(c);
      if (c === '' || (Number.isNaN(v) && c !== 'NaN')) throw new CsvError(`Not a number: ${c}`);
      return v;
    });
  };
  /** A tick or a count: an integer from 0. */
  const whole = (cell: string | undefined): number => {
    const v = Number(cell);
    if (cell === undefined || cell === '' || !Number.isInteger(v) || v < 0) throw new CsvError(`Not a tick: ${cell}`);
    return v;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue;
    if (line.startsWith('# ')) {
      const body = line.slice(2);
      const space = body.indexOf(' ');
      const key = space < 0 ? body : body.slice(0, space);
      const value = space < 0 ? '' : body.slice(space + 1);
      if (key === 'vehicle') {
        const [id, fingerprint, end, ticks] = value.split(' ');
        if (!fingerprint || end === undefined || !ENDS.includes(end)) throw new CsvError(`Bad vehicle: ${value}`);
        vehicles.set(vehicleId(id), { fingerprint, end: end as CsvEnd, ticks: whole(ticks) });
      } else {
        header.set(key, value);
      }
      continue;
    }
    const cells = line.split(',');
    const [table, vehicle, ...rest] = cells;
    if (table === 'table') continue;
    const id = vehicleId(vehicle);
    if (table === 'record') {
      const list = records.get(id) ?? [];
      list.push(...numbers(rest, RUN_RECORD_SIZE));
      records.set(id, list);
    } else if (table === 'track') {
      const list = tracks.get(id) ?? [];
      list.push(...numbers(rest, TRACK_LOG_SIZE));
      tracks.set(id, list);
    } else if (table === 'event') {
      const [kind, tick, obstacle, speed] = rest;
      const list = events.get(id) ?? [];
      const at = whole(tick);
      if (kind === 'trigger') list.push({ kind, tick: at, obstacle: obstacle ?? '' });
      else if (kind === 'collision') {
        list.push({ kind, tick: at, obstacle: obstacle ?? '', speed: numbers([speed ?? ''], 1)[0] ?? 0 });
      } else if (kind === 'roadEnd') list.push({ kind, tick: at });
      else throw new CsvError(`Unknown event: ${String(kind)}`);
      events.set(id, list);
    } else {
      throw new CsvError(`Unknown row: ${String(table)}`);
    }
  }
  const format = header.get(CSV_FORMAT);
  if (format === undefined) throw new CsvError('Not a run saved by the simulator');
  const version = Number(format);
  if (version !== PROTOCOL_VERSION) throw new CsvError(`Saved by protocol ${format}, read by ${PROTOCOL_VERSION}`);
  const vehicle = (id: CsvVehicleId): CsvVehicle | null => {
    const v = vehicles.get(id);
    if (!v) return null;
    return {
      fingerprint: v.fingerprint,
      end: v.end,
      ticks: v.ticks,
      records: Float64Array.from(records.get(id) ?? []),
      events: events.get(id) ?? [],
      trackLog: Float64Array.from(tracks.get(id) ?? []),
    };
  };
  const ego = vehicle('ego');
  if (!ego) throw new CsvError('No ego in the file');
  return {
    version,
    scenario: JSON.parse(header.get('scenario') ?? 'null') as unknown,
    seed: Number(header.get('seed')),
    config: JSON.parse(header.get('config') ?? 'null') as unknown,
    tick: whole(header.get('tick')),
    fingerprint: header.get('fingerprint') ?? '',
    ego,
    ghost: vehicle('ghost'),
  };
}
