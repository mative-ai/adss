/**
 * The simulation session (session.ts): a run played live, in irregular slices with frames between them, is the run of
 * a batch to the bit, and the run `npm run sim` gives (M6); the frames carry every telemetry row once, the candidate
 * plans and the obstacles; the configuration is checked; the mobile preset drives the v1 runs as the four maneuvers.
 */
import { describe, expect, it } from 'vitest';

import { RUN_RECORD, RUN_RECORD_SIZE, ScenarioError } from '@mpc-simulator/core';

import moose from '../../../scenarios/moose.json';
import muSplit from '../../../scenarios/mu-split.json';
import pedestrian from '../../../scenarios/pedestrian.json';
import {
  DEFAULT_CONFIG,
  FRAME,
  MOBILE_CONFIG,
  OBSTACLE,
  PLAN,
  PLAN_HEADER,
  PLANS,
  TELEMETRY_MAX,
  VEHICLE,
  VEHICLE_SIZE,
  type SessionConfig,
} from './protocol.ts';
import { checkRun, ConfigError, runSession, SimulationSession } from './session.ts';

/** The fingerprint `npm run sim -- --scenario pedestrian --seed 1` prints (decision layer and ghost, 2026-11-04). */
const PEDONE_SIM_FINGERPRINT = '5af4e5267d2ed928';

/** Slices of ticks a live run might take: a few ms, a stalled turn, a step of a control cycle. */
const SLICES = [1, 7, 16, 3, 250, 50, 9, 33, 1000, 2, 120];

describe('a session played live', () => {
  it('ends with the fingerprint of the batch run and of npm run sim, however it is sliced and timed', () => {
    let clock = 0;
    const live = new SimulationSession(pedestrian, 1, {}, () => (clock += 1e6 * Math.sin(clock + 1)));
    const frame = new Float64Array(live.layout.length);
    for (let i = 0; !live.done; i++) {
      if (i % 5 === 4) live.stepCycle();
      else live.advance(SLICES[i % SLICES.length]!);
      live.writeFrame(frame, 1, true);
      live.takeDecisions();
      live.takeEvents();
    }
    const batch = runSession(pedestrian, 1);
    expect(live.metrics().fingerprint).toBe(batch.metrics().fingerprint);
    expect(batch.metrics().fingerprint).toBe(PEDONE_SIM_FINGERPRINT);
  }, 60_000);

  it('carries every telemetry row in its frames once and in order, a frame skipped or not', () => {
    const session = new SimulationSession(pedestrian, 2);
    const frame = new Float64Array(session.layout.length);
    const rows = { ego: [] as number[], ghost: [] as number[] };
    const read = () => {
      session.writeFrame(frame, 1, false);
      const L = session.layout;
      const ego = frame[FRAME.EGO_ROWS]!;
      const ghost = frame[FRAME.GHOST_ROWS]!;
      rows.ego.push(...frame.subarray(L.egoTelemetry, L.egoTelemetry + ego * VEHICLE_SIZE));
      rows.ghost.push(...frame.subarray(L.ghostTelemetry, L.ghostTelemetry + ghost * VEHICLE_SIZE));
      return ego + ghost;
    };
    // A long stall between frames: 100 rows per vehicle wait, TELEMETRY_MAX at a time.
    session.advance(1000);
    expect(read()).toBe(2 * TELEMETRY_MAX);
    while (!session.done) {
      session.advance(40);
      read();
    }
    while (read() > 0);
    const result = session.run.result();
    expect(rows.ego.length % RUN_RECORD_SIZE).toBe(0);
    expect(Float64Array.from(rows.ego)).toEqual(result.ego.records);
    expect(Float64Array.from(rows.ghost)).toEqual(result.ghost?.records);
    expect(session.unsentRows).toBe(0);
  }, 60_000);

  it("names the vehicle block as the core's records, and counts the rows no frame has carried yet", () => {
    expect(VEHICLE).toEqual(RUN_RECORD);
    expect(VEHICLE_SIZE).toBe(RUN_RECORD_SIZE);
    const session = new SimulationSession(pedestrian, 1);
    session.advance(1000);
    const rows = session.run.ego.recordedRows + (session.run.ghost?.recordedRows ?? 0);
    expect(session.unsentRows).toBe(rows);
    session.writeFrame(new Float64Array(session.layout.length), 1, true);
    expect(session.unsentRows).toBe(rows - 2 * TELEMETRY_MAX);
  });

  it('draws the cycle: the vehicles, the obstacles, one chosen candidate among the ones solved', () => {
    const session = new SimulationSession(moose, 1);
    const L = session.layout;
    const frame = new Float64Array(L.length);
    // Into the moose's event: the evasion is chosen (`npm run sim`: left at 3.15 s).
    session.advance(3300);
    session.writeFrame(frame, 0.5, true);
    expect(frame[FRAME.TICK]).toBe(3300);
    expect(frame[FRAME.RATE]).toBe(0.5);
    expect(frame[L.ego + VEHICLE.VX]).toBeGreaterThan(10);
    // The moose where the core's contact test puts it: off the road line by its e_y, to the left when positive.
    const obstacleAt = L.obstacles;
    const state = session.run.ego.obstacles.states[0]!;
    const p = session.run.road.pointAt(state.s, { x: 0, y: 0, heading: 0, curvature: 0 });
    expect(frame[obstacleAt + OBSTACLE.DETECTED]).toBe(1);
    expect([frame[obstacleAt + OBSTACLE.S], frame[obstacleAt + OBSTACLE.EY]]).toEqual([state.s, state.ey]);
    expect(frame[obstacleAt + OBSTACLE.X]).toBeCloseTo(p.x - Math.sin(p.heading) * state.ey, 9);
    expect(frame[obstacleAt + OBSTACLE.Y]).toBeCloseTo(p.y + Math.cos(p.heading) * state.ey, 9);
    let chosen = 0;
    let solved = 0;
    for (let b = 0; b < PLANS; b++) {
      const at = L.plans + b * L.planSize;
      if (frame[at + PLAN.CHOSEN] === 1) {
        chosen++;
        // The plan starts at the state it was made for, tick 3250 plus the 50 ticks of delay: the ego now.
        const dx = frame[at + PLAN_HEADER]! - frame[L.ego + VEHICLE.X]!;
        const dy = frame[at + PLAN_HEADER + 1]! - frame[L.ego + VEHICLE.Y]!;
        expect(Math.hypot(dx, dy)).toBeLessThan(0.5);
      }
      if (frame[at + PLAN.SOLVED] === 1) {
        solved++;
        expect(frame.subarray(at + PLAN_HEADER, at + L.planSize).every(Number.isFinite)).toBe(true);
      }
    }
    expect(chosen).toBe(1);
    expect(solved).toBeGreaterThanOrEqual(2);
    const decisions = session.takeDecisions();
    expect(decisions.length).toBe(3300 / 50);
    expect(decisions.at(-1)?.report.chosen).toBe('left');
  });

  it('reports each event once, the end last', () => {
    const session = runSession(moose, 1);
    const events = session.takeEvents();
    expect(events.filter((e) => e.kind === 'trigger').map((e) => ('vehicle' in e ? e.vehicle : ''))).toEqual([
      'ego',
      'ghost',
    ]);
    expect(events.at(-1)).toEqual({ kind: 'end', tick: session.tick });
    expect(session.takeEvents()).toEqual([]);
  }, 60_000);

  it('reports the events in tick order however the run is sliced', () => {
    // pedestrian, seed 1: the ghost's pedestrian starts at 2918, the ego's at 2945, in the same control cycle.
    const slices = (slice: (s: SimulationSession) => void) => {
      const session = new SimulationSession(pedestrian, 1);
      const events = [];
      while (!session.done) {
        slice(session);
        events.push(...session.takeEvents());
      }
      return events;
    };
    const byCycle = slices((s) => s.stepCycle());
    expect(byCycle).toEqual(slices((s) => s.advance(1)));
    const ticks = byCycle.map((e) => ('tick' in e ? e.tick : -1));
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
    expect(byCycle.filter((e) => e.kind === 'trigger').map((e) => ('vehicle' in e ? e.vehicle : ''))).toEqual([
      'ghost',
      'ego',
    ]);
  }, 60_000);

  it('ends at its last state, the metrics so far say who is still running', () => {
    // mu-split, seed 3: both vehicles crash, the ego last at 7913; the run stops there, not at its next tick.
    const session = new SimulationSession(muSplit, 3);
    session.advance(5000);
    expect(session.metrics().ego.end).toBe('running');
    while (!session.done) session.advance(1000);
    const result = session.run.result();
    expect([result.ego.end, result.ghost?.end]).toEqual(['collision', 'collision']);
    expect(session.takeEvents().at(-1)).toEqual({ kind: 'end', tick: result.ego.ticks });
    const frame = new Float64Array(session.layout.length);
    session.writeFrame(frame, 0, false);
    expect(frame[FRAME.TICK]).toBe(result.ego.ticks);
    expect(session.metrics().ego.end).toBe('collision');
  }, 60_000);

  it('steps to the next control cycle', () => {
    const session = new SimulationSession(pedestrian, 1);
    expect(session.stepCycle()).toBe(50);
    expect(session.tick).toBe(50);
    session.advance(23);
    expect(session.stepCycle()).toBe(27);
    expect(session.tick).toBe(100);
  });

  it('runs a shorter horizon, 15 stages, the same on every run', () => {
    const a = runSession(pedestrian, 3, { horizon: 15 });
    const b = runSession(pedestrian, 3, { horizon: 15 });
    expect(a.layout.planPoints).toBe(16);
    expect(a.metrics().fingerprint).toBe(b.metrics().fingerprint);
    expect(a.metrics().fingerprint).not.toBe(runSession(pedestrian, 3).metrics().fingerprint);
  }, 60_000);

  it('drives the mobile preset as the four maneuvers: in v1, right is never the one chosen', () => {
    // moose, seed 1, evades to the left; mu-split, seed 3, ends on a collision.
    for (const [scenario, seed] of [
      [moose, 1],
      [muSplit, 3],
    ] as const) {
      const mobile = runSession(scenario, seed, MOBILE_CONFIG);
      expect(mobile.config.horizon).toBe(DEFAULT_CONFIG.horizon);
      expect(mobile.metrics().fingerprint).toBe(runSession(scenario, seed).metrics().fingerprint);
    }
  }, 60_000);

  it('refuses a configuration or a scenario that cannot run', () => {
    expect(() => new SimulationSession(pedestrian, 1, { horizon: 5 })).toThrow(ConfigError);
    expect(() => new SimulationSession(pedestrian, 1, { maneuvers: ['brake', 'left'] })).toThrow(ConfigError);
    expect(() => new SimulationSession(pedestrian, 1, { maneuvers: ['keep', 'keep'] })).toThrow(ConfigError);
    expect(() => new SimulationSession(pedestrian, 1, { delayTicks: -1 })).toThrow(ConfigError);
    expect(() => new SimulationSession(pedestrian, 1, { noise: { position: -1, velocity: 0 } })).toThrow(ConfigError);
    expect(() => new SimulationSession(pedestrian, 1, { triggerDistance: { nobody: 20 } })).toThrow(RangeError);
    expect(() => new SimulationSession(pedestrian, 1, { triggerDistance: { pedestrian: Number.NaN } })).toThrow(
      ConfigError,
    );
    expect(() => new SimulationSession({ id: 'x' }, 1)).toThrow(ScenarioError);
    // A field left undefined or of the wrong shape: a ghost undefined would run without one and rebuild with it.
    const shapes: unknown[] = [
      { ghost: undefined },
      { ghost: 'yes' },
      { maneuvers: null },
      { maneuvers: 'keep' },
      { scales: null },
      { triggerDistance: 5 },
    ];
    for (const config of shapes) {
      expect(() => new SimulationSession(pedestrian, 1, config as Partial<SessionConfig>)).toThrow(ConfigError);
    }
    // The same checks before a batch, without building the run, and the seed's.
    expect(() => checkRun(pedestrian, 1, { horizon: 21 })).toThrow(ConfigError);
    expect(() => checkRun(pedestrian, 1, { triggerDistance: { pedestrian: -1 } })).toThrow(ConfigError);
    expect(() => checkRun({ id: 'x' }, 1)).toThrow(ScenarioError);
    expect(() => checkRun(pedestrian, 1.5)).toThrow(ConfigError);
    expect(() => checkRun(pedestrian, 2 ** 32)).toThrow(ConfigError);
    expect(() => checkRun(pedestrian, 2 ** 32 - 1, { horizon: 15, triggerDistance: { pedestrian: 0 } })).not.toThrow();
  });
});
