/**
 * Milestone M1 (Phase 1): the plant against analytic results. The analytic cases remove
 * aerodynamic drag and rolling resistance, so that the closed-form references apply exactly.
 */
import { describe, expect, it } from 'vitest';

import {
  ABS_TARGET,
  CHASSIS,
  GRAVITY,
  gustLoads,
  Prng,
  RoadPath,
  runOpenLoop,
  SURFACES,
  surfaceMap,
  ticksFor,
  understeerGradient,
  uniformSurface,
  Vehicle,
  VEHICLES,
  wheelbase,
  type ExternalLoads,
  type SurfaceId,
  type VehicleId,
  type VehicleParams,
} from '../src/index.ts';

const VEHICLE_IDS: VehicleId[] = ['car', 'van', 'truck'];
const SURFACE_IDS: SurfaceId[] = ['dry', 'wet', 'snow', 'ice'];
const analytic = (p: VehicleParams): VehicleParams => ({ ...p, dragArea: 0, rollingResistance: 0 });

/**
 * Time lost to the brake's first-order lag, as time at full deceleration. The lagged request a_req(1 − e^(−t/τ))
 * reaches the limit `decel` at t*, and only the deficit before t* counts: τ − t*·(a_req/decel − 1). It equals τ
 * when the request is the limit, and shrinks when the request is far above it (10 m/s² asked on ice).
 */
function lagLoss(lag: number, request: number, decel: number): number {
  if (request <= decel * (1 + 1e-9)) return lag;
  const tStar = -lag * Math.log(1 - decel / request);
  return lag - tStar * (request / decel - 1);
}

function stoppingDistance(p: VehicleParams, surface: SurfaceId, v0: number, abs = true): number {
  const vehicle = new Vehicle(p, uniformSurface(surface), { abs });
  vehicle.reset(0, 0, 0, v0);
  runOpenLoop(vehicle, {
    ticks: ticksFor(150),
    recordEvery: 1000,
    command: (_tick, _vehicle, out) => {
      out.steer = 0;
      out.accel = p.accelMin;
    },
    until: (_tick, v) => v.plant.latched,
  });
  expect(vehicle.plant.latched).toBe(true);
  return vehicle.plant.chassis[CHASSIS.X] ?? 0;
}

describe('M1 stopping distance from 100 km/h', () => {
  const v0 = 100 / 3.6;
  // As configured, and with brakes strong enough that every vehicle is limited by grip on every surface.
  const variants = [
    { name: 'as configured', params: (id: VehicleId) => analytic(VEHICLES[id]) },
    { name: 'grip-limited', params: (id: VehicleId) => ({ ...analytic(VEHICLES[id]), accelMin: -12 }) },
  ];
  for (const variant of variants) {
    for (const vehicleId of VEHICLE_IDS) {
      for (const surfaceId of SURFACE_IDS) {
        it(`${vehicleId} on ${surfaceId}, ${variant.name}: within 5 % of v²/(2a) + v·τ, never below v²/(2μg)`, () => {
          const p = variant.params(vehicleId);
          const mu = SURFACES[surfaceId].mu;
          const distance = stoppingDistance(p, surfaceId, v0);

          // Grip-limited at the ABS target (a = η·μ·g), unless the brakes cannot ask for that much.
          const request = -p.accelMin;
          const decel = Math.min(request, ABS_TARGET * mu * GRAVITY);
          const tau = p.brakeDelay + lagLoss(p.brakeLag, request, decel);
          const expected = (v0 * v0) / (2 * decel) + v0 * tau;
          expect(
            Math.abs(distance / expected - 1),
            `stopped in ${distance.toFixed(1)} m, expected ${expected.toFixed(1)} m`,
          ).toBeLessThan(0.05);
          expect(distance).toBeGreaterThan((v0 * v0) / (2 * mu * GRAVITY));
        });
      }
    }
  }

  // With the brakes asking well above the grip, the wheels lock unless the ABS holds them near their peak.
  // (Asking just at the grip, as the car's −10 m/s² on dry asphalt does, they do not lock at all.)
  for (const surfaceId of SURFACE_IDS) {
    it(`car on ${surfaceId}, grip-limited: the ABS stops shorter than locked wheels`, () => {
      const p = { ...analytic(VEHICLES.car), accelMin: -12 };
      expect(stoppingDistance(p, surfaceId, v0, true)).toBeLessThan(stoppingDistance(p, surfaceId, v0, false));
    });
  }
});

describe('M1 understeer gradient on dry asphalt', () => {
  for (const vehicleId of VEHICLE_IDS) {
    it(`${vehicleId}: within 10 % of m/L·(lr/Cαf − lf/Cαr)`, () => {
      const p = analytic(VEHICLES[vehicleId]);
      const L = wheelbase(p);
      const speed = 20;
      const vehicle = new Vehicle(p, uniformSurface('dry'));
      vehicle.reset(0, 0, 0, speed);
      const ramp = ticksFor(30);
      const lateral: number[] = [];
      const excess: number[] = [];
      runOpenLoop(vehicle, {
        ticks: ramp,
        recordEvery: 1000,
        command: (tick, v, out) => {
          const c = v.plant.chassis;
          const vx = c[CHASSIS.VX] ?? 0;
          const r = c[CHASSIS.R] ?? 0;
          const ay = vx * r;
          // Quasi-steady samples in the linear range: δ = L/R + K·ay, with 1/R = r/vx.
          if (tick % 100 === 0 && ay > 0.5 && ay < 2.5) {
            lateral.push(ay);
            excess.push(v.actuators.steer - (L * r) / vx);
          }
          out.steer = (0.05 * tick) / ramp;
          out.accel = 2 * (speed - vx);
        },
      });
      expect(lateral.length).toBeGreaterThan(50);

      const n = lateral.length;
      const meanX = lateral.reduce((a, b) => a + b, 0) / n;
      const meanY = excess.reduce((a, b) => a + b, 0) / n;
      let sxy = 0;
      let sxx = 0;
      for (let i = 0; i < n; i++) {
        const dx = (lateral[i] ?? 0) - meanX;
        sxy += dx * ((excess[i] ?? 0) - meanY);
        sxx += dx * dx;
      }
      const measured = sxy / sxx;
      const theory = understeerGradient(p);
      expect(
        Math.abs(measured / theory - 1),
        `measured ${measured.toExponential(3)}, theory ${theory.toExponential(3)}`,
      ).toBeLessThan(0.1);
    });
  }
});

/** Invariants that must hold after every tick, whatever the commands. */
function invariantViolation(vehicle: Vehicle): string | null {
  const plant = vehicle.plant;
  const values = [...plant.chassis, ...plant.omega, ...plant.fz];
  if (!values.every(Number.isFinite)) return 'non-finite state';
  let load = 0;
  for (let i = 0; i < 4; i++) {
    const fz = plant.fz[i] ?? 0;
    if ((plant.omega[i] ?? 0) < 0) return `wheel ${i} turning backwards`;
    if (fz < 0) return `negative load on wheel ${i}`;
    const mu = plant.surfaces[i]?.mu ?? 0;
    if (Math.hypot(plant.fx[i] ?? 0, plant.fy[i] ?? 0) > mu * fz * (1 + 1e-9) + 1e-9)
      return `wheel ${i} beyond friction`;
    load += fz;
  }
  const weight = vehicle.params.mass * GRAVITY;
  if (Math.abs(load - weight) > 1e-6 * weight) return `total load ${load.toFixed(1)} N, weight ${weight.toFixed(1)} N`;
  return null;
}

describe('M1 robustness', () => {
  it('stays still for 10 s after stopping, then drives off', () => {
    const vehicle = new Vehicle(VEHICLES.car, uniformSurface('dry'));
    vehicle.reset(0, 0, 0, 30 / 3.6);
    const brake = (_tick: number, _v: Vehicle, out: { steer: number; accel: number }) => {
      out.steer = 0;
      out.accel = -5;
    };
    runOpenLoop(vehicle, { ticks: ticksFor(10), command: brake, until: (_t, v) => v.plant.latched });
    expect(vehicle.plant.latched).toBe(true);

    const x0 = vehicle.plant.chassis[CHASSIS.X] ?? 0;
    let maxSpeed = 0;
    runOpenLoop(vehicle, {
      ticks: ticksFor(10),
      command: (tick, v, out) => {
        maxSpeed = Math.max(maxSpeed, v.speed);
        brake(tick, v, out);
      },
    });
    expect(maxSpeed).toBeLessThan(1e-6);
    expect(Math.abs((vehicle.plant.chassis[CHASSIS.X] ?? 0) - x0)).toBeLessThan(1e-9);

    runOpenLoop(vehicle, {
      ticks: ticksFor(3),
      command: (_tick, _v, out) => {
        out.steer = 0;
        out.accel = 2;
      },
    });
    expect(vehicle.speed).toBeGreaterThan(2);
  });

  it('keeps its invariants on every tick of 10 000 random command sequences', () => {
    const rng = Prng.create(20261102, 1);
    const fleet = VEHICLE_IDS.flatMap((v) =>
      SURFACE_IDS.flatMap((s) => [true, false].map((abs) => new Vehicle(VEHICLES[v], uniformSurface(s), { abs }))),
    );
    const failures: string[] = [];
    for (let n = 0; n < 10_000; n++) {
      const vehicle = fleet[rng.integer(0, fleet.length - 1)] as Vehicle;
      const p = vehicle.params;
      vehicle.reset(0, 0, rng.uniform(-Math.PI, Math.PI), rng.uniform(0, 40));
      let steer = 0;
      let accel = 0;
      runOpenLoop(vehicle, {
        ticks: 300,
        recordEvery: 300,
        command: (tick, v, out) => {
          if (tick % 50 === 0) {
            steer = rng.uniform(-p.steerMax, p.steerMax);
            accel = rng.uniform(p.accelMin, p.accelMax);
          }
          out.steer = steer;
          out.accel = accel;
          if (tick > 0 && failures.length < 5) {
            const violation = invariantViolation(v);
            if (violation) failures.push(`sequence ${n}, tick ${tick}: ${violation}`);
          }
        },
      });
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('keeps its invariants over 5 s runs with μ zones, a μ-split and crosswind gusts', () => {
    const rng = Prng.create(20261102, 2);
    const road = new RoadPath({
      segments: [
        { kind: 'straight', length: 60 },
        { kind: 'arc', length: 120, curvature: 1 / 80 },
        { kind: 'straight', length: 200 },
      ],
      width: { left: 5.25, right: 1.75 },
    });
    const failures: string[] = [];
    for (let n = 0; n < 200; n++) {
      const id = VEHICLE_IDS[rng.integer(0, 2)] as VehicleId;
      const p = VEHICLES[id];
      const vehicle = new Vehicle(
        p,
        surfaceMap(road, 'dry', [
          { from: 40, to: 90, surface: 'ice' },
          { from: 90, to: 160, side: 'left', surface: 'snow' },
          { from: 160, to: 220, surface: 'wet' },
        ]),
        { abs: rng.next() < 0.7 },
      );
      vehicle.reset(0, 0, 0, rng.uniform(5, 35));
      const gust = {
        start: rng.uniform(0, 3),
        rise: 0.3,
        hold: 1,
        fall: 0.5,
        force: rng.uniform(-6000, 6000),
        arm: 0.5,
      };
      let steer = 0;
      let accel = 0;
      runOpenLoop(vehicle, {
        ticks: ticksFor(5),
        recordEvery: 1000,
        command: (tick, v, out) => {
          if (tick % 200 === 0) {
            steer = rng.uniform(-0.3, 0.3);
            accel = rng.uniform(p.accelMin, p.accelMax);
          }
          out.steer = steer;
          out.accel = accel;
          if (tick > 0 && failures.length < 5) {
            const violation = invariantViolation(v);
            if (violation) failures.push(`run ${n} (${id}), tick ${tick}: ${violation}`);
          }
        },
        loads: (tick, out: ExternalLoads) => gustLoads(gust, tick, out),
      });
    }
    expect(failures).toEqual([]);
  }, 120_000);

  const randomRun = (vehicle: Vehicle, seed: number) => {
    const rng = Prng.create(seed, 3);
    vehicle.reset(0, 0, 0, 25);
    let steer = 0;
    let accel = 0;
    return runOpenLoop(vehicle, {
      ticks: ticksFor(10),
      command: (tick, _v, out) => {
        if (tick % 200 === 0) {
          steer = rng.uniform(-0.1, 0.1);
          accel = rng.uniform(-6, 2);
        }
        out.steer = steer;
        out.accel = accel;
      },
    }).hash;
  };

  it('gives the same trajectory hash for the same seed, a different one for another seed', () => {
    const fresh = () => new Vehicle(VEHICLES.car, uniformSurface('wet'));
    expect(randomRun(fresh(), 7)).toBe(randomRun(fresh(), 7));
    expect(randomRun(fresh(), 7)).not.toBe(randomRun(fresh(), 8));
  });

  it('gives the same hash when one instance is reset and run again', () => {
    const road = new RoadPath({ segments: [{ kind: 'straight', length: 400 }], width: { left: 5.25, right: 1.75 } });
    const vehicle = new Vehicle(
      VEHICLES.van,
      surfaceMap(road, 'dry', [{ from: 30, to: 300, side: 'left', surface: 'ice' }]),
    );
    const first = randomRun(vehicle, 11);
    randomRun(vehicle, 12);
    expect(randomRun(vehicle, 11)).toBe(first);
  });

  it('runs two plants on road surface maps at least 50 times faster than real time in Node', () => {
    const road = new RoadPath({
      segments: [
        { kind: 'straight', length: 100 },
        { kind: 'arc', length: 300, curvature: 1 / 150 },
      ],
      width: { left: 5.25, right: 1.75 },
    });
    const zones = [{ from: 50, to: 300, side: 'left' as const, surface: 'wet' as const }];
    const a = new Vehicle(VEHICLES.car, surfaceMap(road, 'dry', zones));
    const b = new Vehicle(VEHICLES.truck, surfaceMap(road, 'dry', zones));
    const command = { steer: 0.02, accel: -2 };
    const drive = (ticks: number) => {
      for (let i = 0; i < ticks; i++) {
        a.step(command);
        b.step(command);
      }
    };
    a.reset(0, 0, 0, 20);
    b.reset(0, 0, 0, 20);
    drive(1000);
    const simulated = 8;
    const start = performance.now();
    drive(ticksFor(simulated));
    const elapsed = (performance.now() - start) / 1000;
    expect(simulated / elapsed, `real-time factor ${(simulated / elapsed).toFixed(0)}`).toBeGreaterThanOrEqual(50);
  });
});
