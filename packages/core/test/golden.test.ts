/**
 * Golden trajectory hash (CLAUDE.md §8, §10): a fixed run whose fingerprint must not change by accident. Any
 * change to the plant, the tires, the actuators, the ABS, the road or the generator changes it; update the
 * literal only with the reason in the commit message. Generated in Node; other engines may differ in the last
 * digit of transcendental functions, so cross-engine checks use tolerances, not this hash.
 */
import { describe, expect, it } from 'vitest';

import { gustLoads, Prng, RoadPath, runOpenLoop, surfaceMap, ticksFor, Vehicle, VEHICLES } from '../src/index.ts';

const GOLDEN = '6df1fb16b6bcfe6b';

describe('golden trajectory', () => {
  it('van on a road with μ zones, a crosswind gust and seeded random commands', () => {
    const road = new RoadPath({
      segments: [
        { kind: 'straight', length: 80 },
        { kind: 'clothoid', length: 40, curvatureStart: 0, curvatureEnd: 1 / 90 },
        { kind: 'arc', length: 90, curvature: 1 / 90 },
        { kind: 'straight', length: 120 },
      ],
      width: { left: 5.25, right: 1.75 },
    });
    const vehicle = new Vehicle(
      VEHICLES.van,
      surfaceMap(road, 'dry', [
        { from: 60, to: 140, side: 'left', surface: 'ice' },
        { from: 140, to: 220, surface: 'wet' },
      ]),
    );
    vehicle.reset(0, 0, 0, 22);
    const rng = Prng.create(7, 0);
    const gust = { start: 4, rise: 0.4, hold: 1.5, fall: 0.6, force: 4500, arm: 0.6 };
    let steer = 0;
    let accel = 0;
    const result = runOpenLoop(vehicle, {
      ticks: ticksFor(12),
      command: (tick, _v, out) => {
        if (tick % 250 === 0) {
          steer = rng.uniform(-0.08, 0.08);
          accel = rng.uniform(-8, 2);
        }
        out.steer = steer;
        out.accel = accel;
      },
      loads: (tick, out) => gustLoads(gust, tick, out),
    });
    expect(result.hash).toBe(GOLDEN);
  });
});
