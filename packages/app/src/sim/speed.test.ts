/**
 * The top speed a visitor gives the vehicle (Phase 4): the steps of the command, and that every scenario
 * is written for a speed the command can come back to.
 */
import { describe, expect, it } from 'vitest';

import { SCENARIOS, scenarioSpeedKmh } from './scenarios.ts';
import { SPEED_RANGE, stepSpeed } from './speed.ts';

describe('the top speed', () => {
  it('goes one step up or down, and stops at the two ends of the range', () => {
    expect(stepSpeed(50, 1)).toBe(60);
    expect(stepSpeed(50, -1)).toBe(40);
    expect(stepSpeed(SPEED_RANGE.max, 1)).toBe(SPEED_RANGE.max);
    expect(stepSpeed(SPEED_RANGE.min, -1)).toBe(SPEED_RANGE.min);
  });

  it("can come back to every scenario's own speed", () => {
    const { min, max, step } = SPEED_RANGE;
    for (const { id } of SCENARIOS) {
      const own = scenarioSpeedKmh(id);
      expect(own, id).toBeDefined();
      expect(own, id).toBeGreaterThanOrEqual(min);
      expect(own, id).toBeLessThanOrEqual(max);
      expect(((own ?? 0) - min) % step, id).toBe(0);
    }
    expect(scenarioSpeedKmh('pedestrian')).toBe(50);
    expect(scenarioSpeedKmh(null)).toBeUndefined();
  });
});
