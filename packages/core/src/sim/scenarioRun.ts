/**
 * A scenario run (Phase 3): the world a v1 scenario describes, built from (scenario, seed,
 * configuration) alone, with the ego vehicle and an optional ghost stepped in lockstep at 1 kHz.
 *
 * Each vehicle has its own copy of the world: its surface map, its obstacles (so an egoReaches trigger follows
 * that vehicle) and its object sensor, created with the same seed so both see the same noise. The road, the
 * gust and the scenario are shared. The command rule is runClosedLoop's: a command computed at tick t takes
 * effect at t + delayTicks.
 *
 * Per tick and vehicle: project onto the road, update the obstacles and the sensor, check collisions (the
 * body's rectangle against each obstacle's, oriented along the road at its s), compute when the controller is
 * due, apply the command in force, record, step the plant. A vehicle's run ends at its first collision, at the
 * end of the road or at the scenario's duration; at the duration the state after the last step is observed,
 * measured and recorded too, so VehicleRun.ticks, RunMetrics.duration and the last record agree.
 *
 * The fingerprint covers, for the ego then the ghost: the records, the events and the published tracks.
 */
import { wrapAngle } from '../math/angle.ts';
import { Fingerprint } from '../math/hash.ts';
import type { Corridor, Reference } from '../mpc/mpc.ts';
import { RoadPath, type Projection, type RoadPoint } from '../road/path.ts';
import { surfaceMap, type SurfaceMap } from '../road/surfaceMap.ts';
import type { Scenario } from '../scenario/schema.ts';
import { ObjectSensor } from '../sensors/objects.ts';
import type { FrictionPreview, LaneGeometry, TrackSource } from '../sensors/views.ts';
import type { DriverCommand } from '../vehicle/actuators.ts';
import { VEHICLES, type VehicleParams } from '../vehicle/params.ts';
import { CHASSIS, type ExternalLoads } from '../vehicle/plant.ts';
import { SURFACES } from '../vehicle/surfaces.ts';
import { Vehicle } from '../vehicle/vehicle.ts';
import { Obstacles } from '../world/obstacles.ts';
import { gustLoads } from '../world/wind.ts';
import { ticksFor } from './clock.ts';
import type { Controller } from './closedLoop.ts';
import { MetricsTracker, type RunMetrics } from './metrics.ts';

/**
 * What a controller may know about the scenario: the vehicle, the road, the lane, the reference, the friction it
 * expects and its object sensor. Never the scenario itself: its obstacle specs are the true world, which a
 * controller sees only through `tracks`.
 */
export interface ControllerContext {
  readonly params: VehicleParams;
  readonly road: RoadPath;
  /** The drivable road between its edges. */
  readonly corridor: Corridor;
  /** The ego lane's center at the scenario's reference speed. */
  readonly reference: Reference;
  readonly lane: LaneGeometry;
  /** Mean μ of the two wheel tracks along the ego lane, from the surface zones. */
  readonly friction: FrictionPreview;
  /** This vehicle's object sensor. */
  readonly tracks: TrackSource;
  /** μ of the scenario's base surface: what a controller assumes without a preview. */
  readonly mu: number;
}

export type ControllerFactory = (context: ControllerContext) => Controller;

export interface ScenarioRunOptions {
  /** Seed of the run's PRNG streams (unsigned 32-bit). */
  readonly seed: number;
  readonly ego: ControllerFactory;
  /** The ghost, in its own copy of the world. */
  readonly ghost?: ControllerFactory;
  /** Record period, ticks (default 10: 100 Hz). */
  readonly recordEvery?: number;
}

/**
 * Layout of a record: one row every `recordEvery` ticks, plus the final state's row at the scenario's duration
 * (see VehicleWorld.finish), whether or not its tick is a multiple of the period.
 */
export const RUN_RECORD = {
  TICK: 0,
  X: 1,
  Y: 2,
  PSI: 3,
  VX: 4,
  VY: 5,
  R: 6,
  S: 7,
  EY: 8,
  /** Actual road-wheel angle, rad. */
  STEER: 9,
  /** Command in force: steering, rad, and acceleration, m/s². */
  STEER_CMD: 10,
  ACCEL_CMD: 11,
  AX: 12,
  AY: 13,
} as const;
export const RUN_RECORD_SIZE = 14;

/** Values per published track in a run's track log: tick, obstacle index, s, e_y, v_s, v_ey. */
export const TRACK_LOG_SIZE = 6;

export type RunEvent =
  | { readonly kind: 'trigger'; readonly tick: number; readonly obstacle: string }
  | {
      readonly kind: 'collision';
      readonly tick: number;
      readonly obstacle: string;
      /**
       * Signed closing speed along the road, m/s, the same value as RunMetrics.impactSpeed: negative when the ego
       * is struck from behind by a faster obstacle.
       */
      readonly speed: number;
    }
  | { readonly kind: 'roadEnd'; readonly tick: number };

const EVENT_CODE = { trigger: 1, collision: 2, roadEnd: 3 } as const;

export interface VehicleRun {
  /** RUN_RECORD_SIZE values per row. */
  readonly records: Float64Array;
  readonly events: readonly RunEvent[];
  /** TRACK_LOG_SIZE values per published track. */
  readonly trackLog: Float64Array;
  readonly metrics: RunMetrics;
  /**
   * Tick of the vehicle's last state: the collision or road-end tick, or the scenario's tick count when the run
   * reaches its duration (the state after the last step, observed and recorded by finish). RunMetrics.duration is
   * this tick in seconds.
   */
  readonly ticks: number;
  readonly end: 'duration' | 'collision' | 'roadEnd';
}

export interface ScenarioRunResult {
  readonly scenario: string;
  readonly seed: number;
  readonly ego: VehicleRun;
  readonly ghost: VehicleRun | null;
  /** Fingerprint of ego and ghost records, events and tracks (math/hash.ts). */
  readonly fingerprint: string;
}

/** The corridor between the road's edges. */
export function roadCorridor(road: RoadPath): Corridor {
  const { left, right } = road.width;
  return {
    bounds(_s, out) {
      out.left = left;
      out.right = -right;
    },
  };
}

/** The lane's center at a constant speed. */
export function laneReference(lane: LaneGeometry, speed: number): Reference {
  return {
    at(_s, out) {
      out.ey = lane.center;
      out.speed = speed;
    },
  };
}

/**
 * The friction a controller expects along the road: the mean μ under the left and the right wheel tracks (e_y ± half
 * the track, e_y the ego lane's center when not given), with the side rule of road/surfaceMap.ts (left is e_y > 0).
 */
export function laneFriction(scenario: Scenario, params: VehicleParams): FrictionPreview {
  const base = SURFACES[scenario.surface.base].mu;
  const zones = scenario.surface.zones;
  const half = params.track / 2;
  const muAt = (s: number, ey: number): number => {
    for (const zone of zones) {
      if (s < zone.from || s >= zone.to) continue;
      const side = zone.side ?? 'both';
      if (side === 'both' || (side === 'left' ? ey > 0 : ey < 0)) return SURFACES[zone.surface].mu;
    }
    return base;
  };
  return { at: (s, ey = scenario.lane.center) => (muAt(s, ey + half) + muAt(s, ey - half)) / 2 };
}

interface Rectangle {
  x: number;
  y: number;
  heading: number;
  halfLength: number;
  halfWidth: number;
}

/** Separating-axis test of two oriented rectangles. */
export function rectanglesOverlap(a: Readonly<Rectangle>, b: Readonly<Rectangle>): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const axes = [a.heading, a.heading + Math.PI / 2, b.heading, b.heading + Math.PI / 2];
  for (const angle of axes) {
    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    const extent = (r: Readonly<Rectangle>) => {
      const c = Math.cos(r.heading);
      const s = Math.sin(r.heading);
      return r.halfLength * Math.abs(c * nx + s * ny) + r.halfWidth * Math.abs(-s * nx + c * ny);
    };
    if (Math.abs(dx * nx + dy * ny) > extent(a) + extent(b)) return false;
  }
  return true;
}

/** One vehicle with its own copy of the world. */
export class VehicleWorld {
  readonly vehicle: Vehicle;
  readonly surfaces: SurfaceMap;
  readonly obstacles: Obstacles;
  readonly sensor: ObjectSensor;
  readonly controller: Controller;
  readonly context: ControllerContext;
  /** The vehicle in road coordinates at the current tick. */
  readonly pose = { s: 0, ey: 0, epsi: 0 };
  /** Command in force. */
  readonly applied: DriverCommand = { steer: 0, accel: 0 };
  end: VehicleRun['end'] | null = null;
  ticks = 0;

  private readonly scenario: Scenario;
  private readonly road: RoadPath;
  private readonly metrics: MetricsTracker;
  private readonly recordEvery: number;
  private readonly projection: Projection = { s: 0, ey: 0, heading: 0, curvature: 0, index: -1 };
  private readonly point: RoadPoint = { x: 0, y: 0, heading: 0, curvature: 0 };
  private readonly pending: { at: number; steer: number; accel: number }[] = [];
  private readonly computed: DriverCommand = { steer: 0, accel: 0 };
  private readonly loads: ExternalLoads = { fy: 0, mz: 0 };
  private readonly records: number[] = [];
  private readonly trackLog: number[] = [];
  private readonly events: RunEvent[] = [];
  private readonly triggered: boolean[];
  private readonly body: Rectangle = { x: 0, y: 0, heading: 0, halfLength: 0, halfWidth: 0 };
  private readonly other: Rectangle = { x: 0, y: 0, heading: 0, halfLength: 0, halfWidth: 0 };
  private readonly bodyOffset: number;

  constructor(
    scenario: Scenario,
    road: RoadPath,
    shared: Omit<ControllerContext, 'tracks'>,
    factory: ControllerFactory,
    seed: number,
    recordEvery: number,
  ) {
    const params = shared.params;
    this.scenario = scenario;
    this.road = road;
    this.recordEvery = recordEvery;
    this.surfaces = surfaceMap(road, scenario.surface.base, scenario.surface.zones);
    this.vehicle = new Vehicle(params, this.surfaces);
    this.obstacles = new Obstacles(scenario.obstacles);
    this.sensor = new ObjectSensor(scenario.obstacles, scenario.sensor, seed);
    this.triggered = scenario.obstacles.map(() => false);
    this.metrics = new MetricsTracker(this.vehicle, scenario.lane, scenario.obstacles);
    // The body's center lies (lf − lr)/2 ahead of the center of gravity: the overhangs split evenly.
    this.bodyOffset = (params.lf - params.lr) / 2;
    this.body.halfLength = params.length / 2;
    this.body.halfWidth = params.width / 2;

    const start = road.pointAt(scenario.egoStart, this.point);
    const ey = scenario.lane.center;
    this.vehicle.reset(
      start.x - Math.sin(start.heading) * ey,
      start.y + Math.cos(start.heading) * ey,
      start.heading,
      scenario.speed.initial,
    );
    this.applied.steer = this.vehicle.actuators.steer;
    this.context = { ...shared, tracks: this.sensor };
    this.controller = factory(this.context);
  }

  /** Advances one tick; returns false once the run of this vehicle has ended. */
  advance(tick: number): boolean {
    if (this.end !== null) return false;
    if (!this.observe(tick, true)) return false;

    const controller = this.controller;
    if (tick % controller.periodTicks === 0) {
      controller.compute(tick, this.vehicle, this.computed);
      this.pending.push({ at: tick + controller.delayTicks, steer: this.computed.steer, accel: this.computed.accel });
    }
    this.applyDue(tick);

    this.metrics.update(tick, this.vehicle, this.pose, this.applied, this.obstacles);
    if (tick % this.recordEvery === 0) this.record(tick);

    if (this.scenario.gust) gustLoads(this.scenario.gust, tick, this.loads);
    this.vehicle.step(this.applied, this.loads);
    return true;
  }

  /**
   * Ends the run at the scenario's duration: the state after the last step, at `tick`, is observed like any
   * other (a contact or the road's end there still counts), measured and recorded, but not stepped. The final row
   * is recorded whatever `tick` is, a multiple of the record period or not, so VehicleRun.ticks,
   * RunMetrics.duration and the last record always share this tick (advance() never reached it, so the row is not
   * a duplicate).
   *
   * The controller is not asked for a command here. Commands that fall due at `tick` are put in force, so the
   * final row and the metrics show the command in force at the final state, but they never act: no step follows.
   */
  finish(tick: number): void {
    if (this.end !== null) return;
    if (!this.observe(tick, false)) return;
    this.applyDue(tick);
    this.metrics.update(tick, this.vehicle, this.pose, this.applied, this.obstacles);
    this.record(tick);
    this.end = 'duration';
  }

  /**
   * The world at `tick`: the vehicle in road coordinates, the obstacles, the sensor when `sense`, then the end
   * checks. Returns false, with `end` set, at a collision or at the road's end.
   */
  private observe(tick: number, sense: boolean): boolean {
    const c = this.vehicle.plant.chassis;
    const p = this.road.project(c[CHASSIS.X] ?? 0, c[CHASSIS.Y] ?? 0, this.projection.index, this.projection);
    this.pose.s = p.s;
    this.pose.ey = p.ey;
    this.pose.epsi = wrapAngle((c[CHASSIS.PSI] ?? 0) - p.heading);
    this.ticks = tick;

    this.obstacles.update(tick, p.s);
    this.scenario.obstacles.forEach((spec, i) => {
      if (!this.triggered[i] && (this.obstacles.states[i]?.triggeredAt ?? -1) >= 0 && spec.trigger !== undefined) {
        this.triggered[i] = true;
        this.events.push({ kind: 'trigger', tick, obstacle: spec.id });
      }
    });
    if (sense && this.sensor.update(tick, this.obstacles, p.s, p.ey)) {
      for (const track of this.sensor.tracks()) {
        const index = this.scenario.obstacles.findIndex((o) => o.id === track.id);
        this.trackLog.push(tick, index, track.s, track.ey, track.vs, track.vey);
      }
    }

    const hit = this.collision();
    if (hit >= 0) {
      this.metrics.update(tick, this.vehicle, this.pose, this.applied, this.obstacles);
      const speed = this.metrics.collide(tick, this.vehicle, this.pose, this.obstacles, hit);
      this.events.push({ kind: 'collision', tick, obstacle: this.scenario.obstacles[hit]?.id ?? '', speed });
      this.end = 'collision';
      return false;
    }
    if (p.s >= this.road.length - 1) {
      this.events.push({ kind: 'roadEnd', tick });
      this.metrics.update(tick, this.vehicle, this.pose, this.applied, this.obstacles);
      this.end = 'roadEnd';
      return false;
    }
    return true;
  }

  /** Puts in force the commands due by `tick`. */
  private applyDue(tick: number): void {
    while (this.pending.length > 0 && (this.pending[0]?.at ?? Infinity) <= tick) {
      const next = this.pending.shift();
      if (next) {
        this.applied.steer = next.steer;
        this.applied.accel = next.accel;
      }
    }
  }

  /** Rows recorded so far (RUN_RECORD_SIZE values each), for a reader that follows the run (the worker's frames). */
  get recordedRows(): number {
    return this.records.length / RUN_RECORD_SIZE;
  }

  /** Copies the rows from `from` to the last into `out` at `offset`, as many as fit; returns how many it copied. */
  copyRows(from: number, out: Float64Array, offset = 0): number {
    const rows = Math.max(0, Math.min(this.recordedRows - from, Math.floor((out.length - offset) / RUN_RECORD_SIZE)));
    for (let i = 0; i < rows * RUN_RECORD_SIZE; i++) out[offset + i] = this.records[from * RUN_RECORD_SIZE + i] ?? 0;
    return rows;
  }

  /** The events so far, in order. */
  get eventLog(): readonly RunEvent[] {
    return this.events;
  }

  result(): VehicleRun {
    return {
      records: Float64Array.from(this.records),
      events: this.events,
      trackLog: Float64Array.from(this.trackLog),
      metrics: this.metrics.result(),
      ticks: this.ticks,
      end: this.end ?? 'duration',
    };
  }

  private record(tick: number): void {
    const c = this.vehicle.plant.chassis;
    const plant = this.vehicle.plant;
    this.records.push(
      tick,
      c[CHASSIS.X] ?? 0,
      c[CHASSIS.Y] ?? 0,
      c[CHASSIS.PSI] ?? 0,
      c[CHASSIS.VX] ?? 0,
      c[CHASSIS.VY] ?? 0,
      c[CHASSIS.R] ?? 0,
      this.pose.s,
      this.pose.ey,
      this.vehicle.actuators.steer,
      this.applied.steer,
      this.applied.accel,
      plant.ax,
      plant.ay,
    );
  }

  /** Index of the first obstacle the body overlaps, or −1. */
  private collision(): number {
    const c = this.vehicle.plant.chassis;
    const psi = c[CHASSIS.PSI] ?? 0;
    const body = this.body;
    body.heading = psi;
    body.x = (c[CHASSIS.X] ?? 0) + this.bodyOffset * Math.cos(psi);
    body.y = (c[CHASSIS.Y] ?? 0) + this.bodyOffset * Math.sin(psi);
    const reach = this.vehicle.params.length;
    for (let i = 0; i < this.scenario.obstacles.length; i++) {
      const spec = this.scenario.obstacles[i];
      const state = this.obstacles.states[i];
      if (!spec || !state) continue;
      // Cheap reject in road coordinates before the exact test.
      const ds = state.s - this.pose.s;
      const dey = state.ey - this.pose.ey;
      const near = reach + Math.max(spec.length, spec.width);
      if (ds * ds + dey * dey > near * near) continue;
      const point = this.road.pointAt(state.s, this.point);
      const other = this.other;
      other.x = point.x - Math.sin(point.heading) * state.ey;
      other.y = point.y + Math.cos(point.heading) * state.ey;
      other.heading = point.heading;
      other.halfLength = spec.length / 2;
      other.halfWidth = spec.width / 2;
      if (rectanglesOverlap(body, other)) return i;
    }
    return -1;
  }
}

/** A scenario run that can be stepped tick by tick (the worker paces it) or run to the end (runScenario). */
export class ScenarioRun {
  readonly scenario: Scenario;
  readonly seed: number;
  readonly road: RoadPath;
  readonly ego: VehicleWorld;
  readonly ghost: VehicleWorld | null;
  /** Ticks of the scenario's duration. */
  readonly ticks: number;
  private tick = 0;

  constructor(scenario: Scenario, options: ScenarioRunOptions) {
    const seed = options.seed >>> 0;
    if (seed !== options.seed) throw new RangeError(`The seed must be an unsigned 32-bit integer: ${options.seed}`);
    const recordEvery = options.recordEvery ?? 10;
    if (!(recordEvery >= 1) || !Number.isInteger(recordEvery)) throw new RangeError('Bad record period');
    this.scenario = scenario;
    this.seed = seed;
    this.ticks = ticksFor(scenario.duration);
    const params = VEHICLES[scenario.vehicle];
    this.road = new RoadPath(scenario.road);
    const shared: Omit<ControllerContext, 'tracks'> = {
      params,
      road: this.road,
      corridor: roadCorridor(this.road),
      reference: laneReference(scenario.lane, scenario.speed.reference),
      lane: scenario.lane,
      friction: laneFriction(scenario, params),
      mu: SURFACES[scenario.surface.base].mu,
    };
    this.ego = new VehicleWorld(scenario, this.road, shared, options.ego, seed, recordEvery);
    this.ghost = options.ghost ? new VehicleWorld(scenario, this.road, shared, options.ghost, seed, recordEvery) : null;
  }

  /** The next tick to simulate. */
  get now(): number {
    return this.tick;
  }

  get done(): boolean {
    return this.tick >= this.ticks || (this.ego.end !== null && (this.ghost === null || this.ghost.end !== null));
  }

  /** Advances both vehicles by one tick; returns false when the run is over. */
  step(): boolean {
    if (this.done) return false;
    this.ego.advance(this.tick);
    this.ghost?.advance(this.tick);
    this.tick++;
    if (this.tick >= this.ticks) {
      this.ego.finish(this.tick);
      this.ghost?.finish(this.tick);
    }
    return !this.done;
  }

  result(): ScenarioRunResult {
    const ego = this.ego.result();
    const ghost = this.ghost ? this.ghost.result() : null;
    const print = new Fingerprint();
    for (const run of ghost ? [ego, ghost] : [ego]) addVehicle(print, this.scenario, run);
    return { scenario: this.scenario.id, seed: this.seed, ego, ghost, fingerprint: print.digest() };
  }
}

/** What a vehicle's fingerprint is made of. */
export type FingerprintedRun = Pick<VehicleRun, 'records' | 'events' | 'trackLog' | 'ticks'>;

/** One vehicle's part of a run's fingerprint: its records, events, track log and last tick, in this order. */
function addVehicle(print: Fingerprint, scenario: Scenario, run: FingerprintedRun): void {
  print.add(run.records);
  for (const event of run.events) {
    const index = 'obstacle' in event ? scenario.obstacles.findIndex((o) => o.id === event.obstacle) : -1;
    print.add(Float64Array.of(EVENT_CODE[event.kind], event.tick, index, event.kind === 'collision' ? event.speed : 0));
  }
  print.add(run.trackLog);
  print.addNumber(run.ticks);
}

/**
 * The fingerprint of one vehicle's run alone (the ego's or the ghost's), on the same data as the run's fingerprint:
 * what a run saved and read back (the worker's CSV) is checked against.
 */
export function vehicleFingerprint(scenario: Scenario, run: FingerprintedRun): string {
  const print = new Fingerprint();
  addVehicle(print, scenario, run);
  return print.digest();
}

/** Runs a scenario to the end. */
export function runScenario(scenario: Scenario, options: ScenarioRunOptions): ScenarioRunResult {
  const run = new ScenarioRun(scenario, options);
  while (run.step());
  return run.result();
}
