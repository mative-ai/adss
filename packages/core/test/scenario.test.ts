/**
 * The scenario schema (Phase 3): the four v1 files validate, bad scenarios are rejected with the
 * path of the fault, speeds are converted from km/h, and overrides leave the original untouched.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MAX_OBSTACLES, overrideScenario, parseScenario, ScenarioError, type ScenarioJson } from '../src/index.ts';

const V1 = ['pedestrian', 'moose', 'ice', 'mu-split'] as const;
const read = (id: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../scenarios/${id}.json`, import.meta.url), 'utf8'));

const minimal = (): ScenarioJson => ({
  id: 'test',
  vehicle: 'car',
  speed: { initial: 36, reference: 36 },
  duration: 5,
  road: { segments: [{ kind: 'straight', length: 200 }], width: { left: 3.5, right: 3.5 } },
  lane: { center: -1.75, width: 3.5 },
  surface: { base: 'dry' },
  sensor: { range: 80 },
});

const pedestrian = (id: string) => ({
  id,
  kind: 'pedestrian' as const,
  length: 0.5,
  width: 0.5,
  start: { s: 60, ey: -4 },
  velocity: { s: 0, ey: 1.4 },
  trigger: { kind: 'egoReaches' as const, s: 40 },
});

function issues(json: unknown): readonly string[] {
  try {
    parseScenario(json);
  } catch (error) {
    if (error instanceof ScenarioError) return error.issues;
    throw error;
  }
  return [];
}

describe('scenario schema', () => {
  it.each(V1)('accepts scenarios/%s.json, whose id matches its file', (id) => {
    const scenario = parseScenario(read(id));
    expect(scenario.id).toBe(id);
    expect(scenario.obstacles.length).toBeLessThanOrEqual(MAX_OBSTACLES);
  });

  it('converts speeds from km/h and fills the defaults', () => {
    const scenario = parseScenario(minimal());
    expect(scenario.speed.initial).toBeCloseTo(10, 12);
    expect(scenario.speed.reference).toBeCloseTo(10, 12);
    expect(scenario.sensor).toEqual({ period: 50, latency: 0, noise: { position: 0, velocity: 0 }, range: 80 });
    expect(scenario.egoStart).toBe(0);
    expect(scenario.obstacles).toEqual([]);
    expect(scenario.surface.zones).toEqual([]);
  });

  it('gives the moose of moose the animal kind', () => {
    expect(parseScenario(read('moose')).obstacles[0]?.kind).toBe('animal');
  });

  it('defaults an obstacle to visible always', () => {
    const scenario = parseScenario({ ...minimal(), obstacles: [pedestrian('a')] });
    expect(scenario.obstacles[0]?.visibility).toBe('always');
  });

  const bad: [string, (json: ScenarioJson) => unknown, string][] = [
    ['an unknown vehicle', (j) => ({ ...j, vehicle: 'bus' }), 'vehicle'],
    [
      'an unknown obstacle kind',
      (j) => ({ ...j, obstacles: [{ ...pedestrian('a'), kind: 'tree' }] }),
      'obstacles.0.kind',
    ],
    ['an unknown field', (j) => ({ ...j, title: 'Pedestrian' }), '(root)'],
    ['a negative speed', (j) => ({ ...j, speed: { initial: -1, reference: 30 } }), 'speed.initial'],
    ['a zero reference speed', (j) => ({ ...j, speed: { initial: 0, reference: 0 } }), 'speed.reference'],
    ['no road segment', (j) => ({ ...j, road: { ...j.road, segments: [] } }), 'road.segments'],
    ['an unknown segment', (j) => ({ ...j, road: { ...j.road, segments: [{ kind: 'spiral', length: 5 }] } }), 'road'],
    ['a lane off the road', (j) => ({ ...j, lane: { center: -3, width: 3.5 } }), 'lane'],
    ['a start past the road', (j) => ({ ...j, egoStart: 500 }), 'egoStart'],
    ['an unknown surface', (j) => ({ ...j, surface: { base: 'gravel' } }), 'surface.base'],
    [
      'an empty zone',
      (j) => ({ ...j, surface: { base: 'dry', zones: [{ from: 50, to: 50, surface: 'ice' }] } }),
      'surface.zones.0',
    ],
    ['three obstacles', (j) => ({ ...j, obstacles: [pedestrian('a'), pedestrian('b'), pedestrian('c')] }), 'obstacles'],
    ['duplicate obstacle ids', (j) => ({ ...j, obstacles: [pedestrian('a'), pedestrian('a')] }), 'obstacles.1.id'],
    [
      'an obstacle off the road',
      (j) => ({ ...j, obstacles: [{ ...pedestrian('a'), start: { s: 300, ey: 0 } }] }),
      'obstacles.0.start.s',
    ],
    [
      'a hidden obstacle without a trigger',
      (j) => ({ ...j, obstacles: [{ ...pedestrian('a'), trigger: undefined, visibility: 'afterTrigger' }] }),
      'obstacles.0.visibility',
    ],
    ['a fractional sensor period', (j) => ({ ...j, sensor: { range: 80, period: 2.5 } }), 'sensor.period'],
    ['a missing sensor range', (j) => ({ ...j, sensor: {} }), 'sensor.range'],
    ['an infinite duration', (j) => ({ ...j, duration: Infinity }), 'duration'],
    ['a duration shorter than a tick', (j) => ({ ...j, duration: 0.0004 }), 'duration'],
  ];

  it.each(bad)('rejects %s', (_name, mutate, path) => {
    const found = issues(mutate(minimal()));
    expect(found.length).toBeGreaterThan(0);
    expect(
      found.some((issue) => issue.startsWith(path)),
      found.join('\n'),
    ).toBe(true);
  });

  it('rejects what is not an object', () => {
    expect(() => parseScenario('pedestrian')).toThrow(ScenarioError);
    expect(() => parseScenario(null)).toThrow(ScenarioError);
  });
});

describe('overrideScenario', () => {
  const mooseTest = parseScenario(read('moose'));

  it('sets the speed and a trigger distance without touching the original', () => {
    const changed = overrideScenario(mooseTest, { speedKmh: 72, triggerDistance: { moose: 25 } });
    expect(changed.speed.initial).toBeCloseTo(20, 12);
    expect(changed.speed.reference).toBeCloseTo(20, 12);
    const moose = changed.obstacles[0];
    expect(moose?.trigger).toEqual({ kind: 'egoReaches', s: (moose?.start.s ?? 0) - 25 });
    expect(mooseTest.speed.initial).toBeCloseTo(60 / 3.6, 12);
    expect(mooseTest.obstacles[0]?.trigger).toEqual({ kind: 'egoReaches', s: 50 });
  });

  it('rejects an unknown obstacle and a bad speed', () => {
    expect(() => overrideScenario(mooseTest, { triggerDistance: { elk: 20 } })).toThrow(RangeError);
    expect(() => overrideScenario(mooseTest, { speedKmh: 0 })).toThrow(RangeError);
  });
});
