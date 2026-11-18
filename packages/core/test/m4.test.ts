/**
 * Milestone M4 (Phase 3) on the v1 scenarios, seed 1. The MPC sees the world as a controller may: the
 * tracks of its own object sensor, the friction preview; until the decision layer picks among maneuvers it
 * drives one, braking in its lane. It does not hit the pedestrian at 50 km/h on dry asphalt; and on the curve with an
 * ice patch, where the baseline controller loses control (it leaves its lane), the MPC stays in its lane with
 * |β| < 5° (the criterion as reformulated on 2026-11-03).
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BaselineDriver,
  MpcDriver,
  parseScenario,
  runScenario,
  VEHICLES,
  type ControllerFactory,
  type Scenario,
} from '../src/index.ts';

function scenario(id: string): Scenario {
  return parseScenario(JSON.parse(readFileSync(new URL(`../../../scenarios/${id}.json`, import.meta.url), 'utf8')));
}

const mpc: ControllerFactory = (c) =>
  new MpcDriver(c.params, c.mu, c.road, c.corridor, c.reference, {
    tracks: c.tracks,
    friction: c.friction,
    standstill: true,
    roadDemand: true,
    side: 'stop',
  });
const baseline: ControllerFactory = (c) => new BaselineDriver(c.params, c.road, c.reference, c.tracks);

/** Whether the body stayed in its lane: the largest lateral deviation of its center plus half its width. */
function inLane(s: Scenario, deviation: number): boolean {
  return deviation + VEHICLES[s.vehicle].width / 2 <= s.lane.width / 2;
}

const FIVE_DEGREES = (5 * Math.PI) / 180;

describe('M4 on the v1 scenarios', () => {
  it('the MPC does not hit the pedestrian at 50 km/h on dry asphalt', () => {
    const pedestrian = scenario('pedestrian');
    expect(pedestrian.speed.initial * 3.6).toBeCloseTo(50, 6);
    expect(pedestrian.surface.base).toBe('dry');
    const result = runScenario(pedestrian, { seed: 1, ego: mpc });
    expect(result.ego.metrics.collided).toBe(false);
    expect(result.ego.end).toBe('duration');
  }, 60_000);

  it('on the ice curve the baseline leaves its lane and the MPC stays in it with |β| < 5°', () => {
    const ice = scenario('ice');
    const result = runScenario(ice, { seed: 1, ego: mpc, ghost: baseline });
    const ego = result.ego.metrics;
    const ghost = result.ghost?.metrics;
    expect(ghost).toBeDefined();
    expect(inLane(ice, ghost?.maxLateralDeviation ?? 0)).toBe(false);
    expect(ego.collided).toBe(false);
    expect(inLane(ice, ego.maxLateralDeviation)).toBe(true);
    expect(ego.maxSideslip).toBeLessThan(FIVE_DEGREES);
  }, 60_000);
});
