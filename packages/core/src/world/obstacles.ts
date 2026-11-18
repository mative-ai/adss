/**
 * Obstacles in road coordinates (s along the line, e_y to its left): a pedestrian or an animal that steps out, a
 * vehicle that cuts in, a static object. Each one waits for its trigger, then moves at constant velocity for at most
 * `travel` metres. Positions come from the integer tick of the trigger, never from accumulated time.
 */
import { TICK_HZ } from '../sim/clock.ts';

export type Trigger =
  | { readonly kind: 'time'; /** s */ readonly at: number }
  | { readonly kind: 'egoReaches'; /** Arc length the ego vehicle must reach, m. */ readonly s: number };

export interface ObstacleSpec {
  readonly id: string;
  readonly kind: 'pedestrian' | 'animal' | 'vehicle' | 'static';
  readonly length: number;
  readonly width: number;
  readonly start: { readonly s: number; readonly ey: number };
  /** Velocity along and across the road once triggered, m/s. */
  readonly velocity: { readonly s: number; readonly ey: number };
  /** Moves from the first tick when absent. */
  readonly trigger?: Trigger;
  /** Distance covered before stopping, m; unlimited when absent. */
  readonly travel?: number;
}

export interface ObstacleState {
  s: number;
  ey: number;
  /** Tick of the trigger, or −1 while waiting. */
  triggeredAt: number;
}

/**
 * Whether the obstacle moves at `tick`: triggered, with a nonzero velocity, and not yet past its travel. The one
 * rule the world, the object sensor and the metrics share: while it holds the obstacle moves at its spec velocity,
 * otherwise it stands still.
 */
export function obstacleMoving(spec: ObstacleSpec, state: Readonly<ObstacleState>, tick: number): boolean {
  if (state.triggeredAt < 0) return false;
  const speed = Math.hypot(spec.velocity.s, spec.velocity.ey);
  return speed > 0 && (spec.travel === undefined || (tick - state.triggeredAt) / TICK_HZ < spec.travel / speed);
}

export class Obstacles {
  readonly specs: readonly ObstacleSpec[];
  readonly states: ObstacleState[];

  constructor(specs: readonly ObstacleSpec[]) {
    const ids = new Set(specs.map((spec) => spec.id));
    if (ids.size !== specs.length) throw new RangeError('Obstacle ids must be unique');
    this.specs = specs;
    this.states = specs.map((spec) => ({ s: spec.start.s, ey: spec.start.ey, triggeredAt: -1 }));
    this.reset();
  }

  reset(): void {
    this.specs.forEach((spec, i) => {
      const state = this.states[i] as ObstacleState;
      state.s = spec.start.s;
      state.ey = spec.start.ey;
      state.triggeredAt = spec.trigger ? -1 : 0;
    });
  }

  /** Positions at `tick`, given the ego vehicle's arc length. Call once per tick, in order. */
  update(tick: number, egoS: number): void {
    this.specs.forEach((spec, i) => {
      const state = this.states[i] as ObstacleState;
      if (state.triggeredAt < 0) {
        const trigger = spec.trigger;
        if (trigger === undefined) {
          state.triggeredAt = 0;
        } else if (trigger.kind === 'time') {
          // The nominal tick, so the position does not depend on how often update() is called.
          const nominal = Math.round(trigger.at * TICK_HZ);
          if (tick < nominal) return;
          state.triggeredAt = nominal;
        } else {
          if (egoS < trigger.s) return;
          state.triggeredAt = tick;
        }
      }
      // Time spent moving: since the trigger while it moves, else the whole travel (or none at zero velocity).
      const speed = Math.hypot(spec.velocity.s, spec.velocity.ey);
      let elapsed = 0;
      if (obstacleMoving(spec, state, tick)) elapsed = (tick - state.triggeredAt) / TICK_HZ;
      else if (spec.travel !== undefined && speed > 0) elapsed = spec.travel / speed;
      state.s = spec.start.s + spec.velocity.s * elapsed;
      state.ey = spec.start.ey + spec.velocity.ey * elapsed;
    });
  }
}
