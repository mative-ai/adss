/**
 * The object sensor (Phase 3): a fused object list in road coordinates, as a camera and radar
 * pair would give it after tracking. The scenario run calls `update` once per tick with the true obstacles and
 * the ego's position; every `period` ticks the sensor publishes one track per reported obstacle.
 *
 * - Latency: a track is the obstacle's true state `latency` ticks before the publication; while the run is
 *   younger than that, the oldest state there is (tick 0). The track's `tick` is the tick of that state, so a
 *   reader at tick t knows its age, (t − track.tick)/TICK_HZ: the latency plus the time since the publication.
 * - Velocity: the spec's velocity while the obstacle moves (world/obstacles.ts obstacleMoving), else 0.
 * - Noise: Gaussian, σ `noise.position` on s and on e_y, σ `noise.velocity` on both velocity components, from
 *   `Prng.create(seed, STREAM.OBJECTS)`. Every publication draws four normals for every obstacle, in the order
 *   of the specs, reported or not: the draws never depend on what is visible, so two sensors with the same seed
 *   (the ego's and the ghost's) apply the same noise to the same obstacle at the same tick.
 * - What is reported: obstacles whose measured center is within `range` of the ego (Euclidean in road
 *   coordinates, all around the vehicle: a fused object list, not one forward beam), and that are visible at the
 *   delayed tick. A 'visible always' obstacle is reported before its trigger too (a pedestrian on the curb is seen
 *   before stepping out); an 'afterTrigger' obstacle only from its trigger on (it comes out of hiding).
 */
import { Prng } from '../math/prng.ts';
import type { ObjectSensorConfig, ScenarioObstacle } from '../scenario/schema.ts';
import { STREAM } from '../sim/streams.ts';
import { obstacleMoving, type Obstacles } from '../world/obstacles.ts';
import type { ObstacleTrack, TrackSource } from './views.ts';

/** Values kept per obstacle and tick in the latency buffer. */
const S = 0;
const EY = 1;
const VS = 2;
const VEY = 3;
const VISIBLE = 4;
const SLOT = 5;

export class ObjectSensor implements TrackSource {
  readonly config: ObjectSensorConfig;
  private readonly specs: readonly ScenarioObstacle[];
  private readonly seed: number;
  private prng: Prng;
  /** Ring buffer of latency + 1 ticks: [tick slot][obstacle][SLOT]. */
  private readonly history: Float64Array;
  private readonly depth: number;
  private filled = 0;
  private published: ObstacleTrack[] = [];
  private publishedAt = -1;
  private readonly noise = new Float64Array(4);

  constructor(specs: readonly ScenarioObstacle[], config: ObjectSensorConfig, seed: number) {
    if (!(config.period >= 1) || !Number.isInteger(config.period)) throw new RangeError('Bad sensor period');
    if (!(config.latency >= 0) || !Number.isInteger(config.latency)) throw new RangeError('Bad sensor latency');
    this.specs = specs;
    this.config = config;
    this.seed = seed;
    this.prng = Prng.create(seed, STREAM.OBJECTS);
    this.depth = config.latency + 1;
    this.history = new Float64Array(this.depth * specs.length * SLOT);
  }

  reset(): void {
    this.prng = Prng.create(this.seed, STREAM.OBJECTS);
    this.history.fill(0);
    this.filled = 0;
    this.published = [];
    this.publishedAt = -1;
  }

  /** The tracks of the latest publication. */
  tracks(): readonly ObstacleTrack[] {
    return this.published;
  }

  /** Tick of the latest publication, −1 before the first. */
  get lastPublication(): number {
    return this.publishedAt;
  }

  /**
   * Records the true obstacles at `tick` (after `obstacles.update(tick, …)`) and publishes when the tick is a
   * multiple of the period. Call once per tick, in order, from tick 0. Returns whether it published.
   */
  update(tick: number, obstacles: Obstacles, egoS: number, egoEy: number): boolean {
    const n = this.specs.length;
    const slot = tick % this.depth;
    for (let i = 0; i < n; i++) {
      const spec = this.specs[i] as ScenarioObstacle;
      const state = obstacles.states[i];
      if (!state) throw new RangeError('The sensor and the world must share the obstacle specs');
      const triggered = state.triggeredAt >= 0;
      const moving = obstacleMoving(spec, state, tick);
      const k = (slot * n + i) * SLOT;
      this.history[k + S] = state.s;
      this.history[k + EY] = state.ey;
      this.history[k + VS] = moving ? spec.velocity.s : 0;
      this.history[k + VEY] = moving ? spec.velocity.ey : 0;
      this.history[k + VISIBLE] = spec.visibility === 'always' || triggered ? 1 : 0;
    }
    if (this.filled < this.depth) this.filled++;
    if (tick % this.config.period !== 0) return false;

    // The oldest state kept: `latency` ticks ago once the buffer is full.
    const stateTick = tick - (this.filled - 1);
    const delayedSlot = stateTick % this.depth;
    const { position, velocity } = this.config.noise;
    const range2 = this.config.range * this.config.range;
    const tracks: ObstacleTrack[] = [];
    for (let i = 0; i < n; i++) {
      const spec = this.specs[i] as ScenarioObstacle;
      for (let j = 0; j < 4; j++) this.noise[j] = this.prng.normal();
      const k = (delayedSlot * n + i) * SLOT;
      if (this.history[k + VISIBLE] !== 1) continue;
      const s = (this.history[k + S] ?? 0) + position * (this.noise[0] ?? 0);
      const ey = (this.history[k + EY] ?? 0) + position * (this.noise[1] ?? 0);
      const ds = s - egoS;
      const dey = ey - egoEy;
      if (ds * ds + dey * dey > range2) continue;
      tracks.push({
        id: spec.id,
        kind: spec.kind,
        tick: stateTick,
        s,
        ey,
        vs: (this.history[k + VS] ?? 0) + velocity * (this.noise[2] ?? 0),
        vey: (this.history[k + VEY] ?? 0) + velocity * (this.noise[3] ?? 0),
        length: spec.length,
        width: spec.width,
      });
    }
    this.published = tracks;
    this.publishedAt = tick;
    return true;
  }
}
