/**
 * The scenario file (Phase 3): JSON validated with zod, then converted to the SI values the core
 * runs on. Only the speeds are written in km/h, because that is how a scenario is described; parseScenario turns
 * them into m/s. Everything else is SI (m, s, rad, N). A scenario holds ids, never user-facing copy: the copy
 * lives in the app's typed dictionaries.
 *
 * Coordinates are the road's: s along its reference line, e_y to its left. Traffic is right-hand, so the ego
 * lane is the right one and the opposite lane, the one an evasion uses, lies to its left. The road's width is
 * the drivable corridor on each side of the reference line.
 *
 * Visibility of an obstacle before its trigger: 'always' (default) means the object sensor reports it whenever
 * it is within range, as a pedestrian standing on the curb before stepping out; 'afterTrigger' means it is
 * hidden until it moves, as an animal stepping out of the trees or an object uncovered late.
 *
 * The four v1 scenarios (scenarios/*.json, documented in scenarios/README.md) use these files; tests and the
 * sweeps of milestone M5 change speed and trigger distance with overrideScenario, never by editing the files.
 */
import { z } from 'zod';

import type { RoadSpec, Segment } from '../road/path.ts';
import type { SurfaceZone } from '../road/surfaceMap.ts';
import type { LaneGeometry } from '../sensors/views.ts';
import type { VehicleId } from '../vehicle/params.ts';
import type { SurfaceId } from '../vehicle/surfaces.ts';
import type { ObstacleSpec } from '../world/obstacles.ts';
import type { Gust } from '../world/wind.ts';

/** The v1 limit on critical obstacles (CLAUDE.md §1). */
export const MAX_OBSTACLES = 2;

const finite = z.number().refine(Number.isFinite, 'must be finite');
const positive = z.number().positive().refine(Number.isFinite, 'must be finite');
const nonNegative = z.number().nonnegative().refine(Number.isFinite, 'must be finite');
const surfaceId = z.enum(['dry', 'wet', 'snow', 'ice']);

const segmentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('straight'), length: positive }),
  z.strictObject({ kind: z.literal('arc'), length: positive, curvature: finite }),
  z.strictObject({ kind: z.literal('clothoid'), length: positive, curvatureStart: finite, curvatureEnd: finite }),
]);

const triggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('time'), at: nonNegative }),
  z.strictObject({ kind: z.literal('egoReaches'), s: finite }),
]);

const obstacleSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase id'),
  kind: z.enum(['pedestrian', 'animal', 'vehicle', 'static']),
  length: positive,
  width: positive,
  start: z.strictObject({ s: finite, ey: finite }),
  velocity: z.strictObject({ s: finite, ey: finite }),
  trigger: triggerSchema.optional(),
  travel: positive.optional(),
  visibility: z.enum(['always', 'afterTrigger']).default('always'),
});

const sensorSchema = z.strictObject({
  /** Update period, ticks: 50 at 1 kHz is 20 Hz. */
  period: z.number().int().positive().default(50),
  /** Age of the reported state, ticks. */
  latency: z.number().int().nonnegative().default(0),
  /** Standard deviations of the Gaussian noise: position (m) on s and e_y, velocity (m/s) on both components. */
  noise: z.strictObject({ position: nonNegative.default(0), velocity: nonNegative.default(0) }).prefault({}),
  /** Distance in road coordinates beyond which an obstacle is not reported, m. */
  range: positive,
});

/** The scenario file as written: speeds in km/h, everything else SI. */
export const scenarioSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase id'),
    vehicle: z.enum(['car', 'van', 'truck']),
    /** km/h: the ego's speed at the start and the speed its reference asks for. */
    speed: z.strictObject({ initial: nonNegative, reference: positive }),
    /** s, at least one tick: a run of none would have no state at all. */
    duration: positive.min(0.001, 'must last at least one tick (0.001 s)').max(120),
    road: z.strictObject({
      start: z.strictObject({ x: finite, y: finite, heading: finite }).optional(),
      segments: z.array(segmentSchema).min(1),
      width: z.strictObject({ left: positive, right: positive }),
    }),
    lane: z.strictObject({ center: finite, width: positive }),
    /** Arc length where the ego starts, on the lane's center, m. */
    egoStart: nonNegative.default(0),
    surface: z.strictObject({
      base: surfaceId,
      zones: z
        .array(
          z.strictObject({
            from: finite,
            to: finite,
            side: z.enum(['both', 'left', 'right']).optional(),
            surface: surfaceId,
          }),
        )
        .default([]),
    }),
    obstacles: z.array(obstacleSchema).max(MAX_OBSTACLES).default([]),
    gust: z
      .strictObject({
        start: nonNegative,
        rise: positive,
        hold: nonNegative,
        fall: positive,
        force: finite,
        arm: finite,
      })
      .optional(),
    sensor: sensorSchema,
  })
  .superRefine((scenario, ctx) => {
    const length = scenario.road.segments.reduce((sum, segment) => sum + segment.length, 0);
    const { left, right } = scenario.road.width;
    const { center, width } = scenario.lane;
    if (center + width / 2 > left || center - width / 2 < -right) {
      ctx.addIssue({ code: 'custom', path: ['lane'], message: 'the lane must lie within the road width' });
    }
    if (scenario.egoStart >= length) {
      ctx.addIssue({ code: 'custom', path: ['egoStart'], message: 'the ego must start on the road' });
    }
    scenario.surface.zones.forEach((zone, i) => {
      if (!(zone.from < zone.to)) {
        ctx.addIssue({ code: 'custom', path: ['surface', 'zones', i], message: 'a zone needs from < to' });
      }
    });
    const ids = new Set<string>();
    scenario.obstacles.forEach((obstacle, i) => {
      if (ids.has(obstacle.id)) {
        ctx.addIssue({ code: 'custom', path: ['obstacles', i, 'id'], message: 'obstacle ids must be unique' });
      }
      ids.add(obstacle.id);
      if (obstacle.start.s < 0 || obstacle.start.s > length) {
        ctx.addIssue({
          code: 'custom',
          path: ['obstacles', i, 'start', 's'],
          message: 'the obstacle must be on the road',
        });
      }
      if (obstacle.visibility === 'afterTrigger' && obstacle.trigger === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['obstacles', i, 'visibility'],
          message: 'an obstacle hidden until its trigger needs a trigger',
        });
      }
    });
  });

export type ScenarioJson = z.input<typeof scenarioSchema>;

/** An obstacle of a scenario: the world's spec plus how the object sensor sees it before its trigger. */
export interface ScenarioObstacle extends ObstacleSpec {
  readonly visibility: 'always' | 'afterTrigger';
}

/** The object sensor's configuration (see sensors/objects.ts). */
export interface ObjectSensorConfig {
  readonly period: number;
  readonly latency: number;
  readonly noise: { readonly position: number; readonly velocity: number };
  readonly range: number;
}

/** A validated scenario in SI units. */
export interface Scenario {
  readonly id: string;
  readonly vehicle: VehicleId;
  /** m/s */
  readonly speed: { readonly initial: number; readonly reference: number };
  readonly duration: number;
  readonly road: RoadSpec;
  readonly lane: LaneGeometry;
  readonly egoStart: number;
  readonly surface: { readonly base: SurfaceId; readonly zones: readonly SurfaceZone[] };
  readonly obstacles: readonly ScenarioObstacle[];
  readonly gust?: Gust;
  readonly sensor: ObjectSensorConfig;
}

/** Thrown by parseScenario with every issue zod found, one per line. */
export class ScenarioError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid scenario:\n${issues.join('\n')}`);
    this.name = 'ScenarioError';
    this.issues = issues;
  }
}

const KMH = 1 / 3.6;

/** Validates a scenario file and converts it to SI; throws ScenarioError when it is not valid. */
export function parseScenario(json: unknown): Scenario {
  const result = scenarioSchema.safeParse(json);
  if (!result.success) {
    throw new ScenarioError(
      result.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const data = result.data;
  return {
    id: data.id,
    vehicle: data.vehicle,
    speed: { initial: data.speed.initial * KMH, reference: data.speed.reference * KMH },
    duration: data.duration,
    road: {
      ...(data.road.start ? { start: data.road.start } : {}),
      segments: data.road.segments as Segment[],
      width: data.road.width,
    },
    lane: data.lane,
    egoStart: data.egoStart,
    surface: data.surface,
    obstacles: data.obstacles.map((o) => ({
      id: o.id,
      kind: o.kind,
      length: o.length,
      width: o.width,
      start: o.start,
      velocity: o.velocity,
      ...(o.trigger ? { trigger: o.trigger } : {}),
      ...(o.travel !== undefined ? { travel: o.travel } : {}),
      visibility: o.visibility,
    })),
    ...(data.gust ? { gust: data.gust } : {}),
    sensor: data.sensor,
  };
}

export interface ScenarioOverrides {
  /** Initial and reference speed, km/h. */
  readonly speedKmh?: number;
  /**
   * Per obstacle id: the distance from the obstacle's start at which the ego triggers it, m (an egoReaches
   * trigger at start.s − distance). Milestone M5 sweeps it with the speed.
   */
  readonly triggerDistance?: Readonly<Record<string, number>>;
}

/** A copy of `scenario` with its speed or its trigger distances changed. */
export function overrideScenario(scenario: Scenario, overrides: ScenarioOverrides): Scenario {
  const distances = overrides.triggerDistance ?? {};
  for (const id of Object.keys(distances)) {
    if (!scenario.obstacles.some((o) => o.id === id)) throw new RangeError(`No obstacle '${id}' in ${scenario.id}`);
  }
  const speed = overrides.speedKmh;
  if (speed !== undefined && !(speed > 0 && Number.isFinite(speed))) throw new RangeError(`Bad speed: ${speed}`);
  return {
    ...scenario,
    speed: speed !== undefined ? { initial: speed * KMH, reference: speed * KMH } : scenario.speed,
    obstacles: scenario.obstacles.map((o) => {
      const distance = distances[o.id];
      if (distance === undefined) return o;
      return { ...o, trigger: { kind: 'egoReaches', s: o.start.s - distance } };
    }),
  };
}
