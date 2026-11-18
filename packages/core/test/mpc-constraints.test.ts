/**
 * The MPC's Phase 2 constraints that the decision layer builds on: obstacles as
 * half-planes for the two body discs, with the side the decision layer asks for; low speed and vx ≥ 0; the
 * terminal braking feasibility; friction per stage from a preview; the road's g-g demand. Small worlds of their
 * own on a straight or curved road, with a stub track source that reports the true obstacle, optionally with a
 * latency (the object sensor and the scenario runner are not used).
 */
import { describe, expect, it } from 'vitest';

import {
  CHASSIS,
  CondensedStepSolver,
  Condenser,
  Fingerprint,
  GiStepSolver,
  GoldfarbIdnaniFastSolver,
  GoldfarbIdnaniSolver,
  KEY_STAGE,
  MpcController,
  MpcDriver,
  NU,
  NX,
  objective,
  obstacleHalfPlane,
  residuals,
  ROW_KIND,
  rowKey,
  RoadPath,
  RowCondenser,
  STATE,
  runClosedLoop,
  surfaceMap,
  TICK_HZ,
  ticksFor,
  uniformSurface,
  Vehicle,
  VEHICLES,
  wheelbase,
  type Corridor,
  type FrictionPreview,
  type MpcDriverOptions,
  type MpcPlan,
  type ObstacleTrack,
  type OcpQp,
  type QpProblem,
  type Reference,
  type Segment,
  type SurfaceSource,
  type SurfaceZone,
} from '../src/index.ts';

const car = VEHICLES.car;
const LANE = 3.5;
const STRAIGHT: readonly Segment[] = [{ kind: 'straight', length: 600 }];

/** The ego lane, or the ego lane plus the opposite one to its left. */
function corridor(left: number): Corridor {
  return {
    bounds: (_s, out) => {
      out.left = left;
      out.right = -LANE / 2;
    },
  };
}

function cruise(speed: number): Reference {
  return {
    at: (_s, out) => {
      out.ey = 0;
      out.speed = speed;
    },
  };
}

function box(s: number, ey: number, length: number, width: number): ObstacleTrack {
  return { id: 'box', kind: 'static', tick: 0, s, ey, vs: 0, vey: 0, length, width };
}

/** An obstacle's true state at time t, s; the stub sensor stamps the tick it reports. */
type Truth = (t: number) => Omit<ObstacleTrack, 'tick'>;

/** A lead vehicle 30 m ahead at 20 km/h that brakes at `decel` from t = 8 s to rest. */
function braking(decel: number): Truth {
  const v = 20 / 3.6;
  const onset = 8;
  return (t) => {
    const dt = Math.min(Math.max(0, t - onset), v / decel);
    const s = 30 + v * Math.min(t, onset) + v * dt - 0.5 * decel * dt * dt;
    return { id: 'lead', kind: 'vehicle', s, ey: 0, vs: Math.max(0, v - decel * dt), vey: 0, length: 4.5, width: 1.8 };
  };
}

/**
 * Separation between the body (its rectangle) and an obstacle box on a straight road along x (s = x, e_y = y):
 * the largest gap between their projections on the four axes, m. Positive means apart (by at least that much),
 * negative is the depth of the overlap.
 */
function clearance(vehicle: Vehicle, track: Omit<ObstacleTrack, 'tick'>): number {
  const c = vehicle.plant.chassis;
  const x = c[CHASSIS.X] ?? 0;
  const y = c[CHASSIS.Y] ?? 0;
  const psi = c[CHASSIS.PSI] ?? 0;
  const overhang = (car.length - wheelbase(car)) / 2;
  const front = car.lf + overhang;
  const rear = -(car.lr + overhang);
  const half = car.width / 2;
  const cos = Math.cos(psi);
  const sin = Math.sin(psi);
  const corners = [
    [front, half],
    [front, -half],
    [rear, half],
    [rear, -half],
  ].map(([a, b]) => [x + a! * cos - b! * sin, y + a! * sin + b! * cos] as const);
  const boxCorners = [
    [track.s - track.length / 2, track.ey - track.width / 2],
    [track.s - track.length / 2, track.ey + track.width / 2],
    [track.s + track.length / 2, track.ey - track.width / 2],
    [track.s + track.length / 2, track.ey + track.width / 2],
  ] as const;
  let gap = -Infinity;
  for (const [ax, ay] of [
    [1, 0],
    [0, 1],
    [cos, sin],
    [-sin, cos],
  ] as const) {
    const a = corners.map(([px, py]) => px * ax + py * ay);
    const b = boxCorners.map(([px, py]) => px * ax + py * ay);
    gap = Math.max(gap, Math.min(...b) - Math.max(...a), Math.min(...a) - Math.max(...b));
  }
  return gap;
}

interface Run {
  readonly vehicle: Vehicle;
  readonly plans: MpcPlan[];
  /** The step QPs, one per plan. */
  readonly ocps: OcpQp[];
  /** Plant chassis fingerprint over every tick. */
  readonly hash: string;
  readonly minClearance: number;
  /** Speed when the body was closest to the obstacle, m/s. */
  readonly speedAtClosest: number;
  /** Largest |β| in the plant, rad. */
  readonly maxBeta: number;
  readonly maxEy: number;
  /** Speed where the vehicle first reached `markS`, m/s. */
  readonly speedAtMark: number;
  /** Arc length where the commanded deceleration first exceeded 0.3 m/s², m. */
  readonly brakeOnset: number;
}

interface World {
  readonly segments?: readonly Segment[];
  readonly surfaces?: (road: RoadPath) => SurfaceSource;
  readonly mu?: number;
  readonly speed: number;
  /** Reference speed, m/s: the entry speed when absent. */
  readonly target?: number;
  readonly left?: number;
  /** A static obstacle, or a moving one by its true state over time. */
  readonly track?: ObstacleTrack;
  readonly truth?: Truth;
  /** Latency of the stub sensor, ticks: it reports the true state that much before the reading's tick. */
  readonly latency?: number;
  readonly seconds: number;
  readonly markS?: number;
  readonly endS?: number;
  readonly options?: MpcDriverOptions;
}

function drive(world: World): Run {
  const road = new RoadPath({ segments: world.segments ?? STRAIGHT, width: { left: 8, right: 3 } });
  const vehicle = new Vehicle(car, world.surfaces ? world.surfaces(road) : uniformSurface('dry'));
  vehicle.reset(0, 0, 0, world.speed);
  const fixed = world.track;
  const truth: Truth | undefined = world.truth ?? (fixed && (() => fixed));
  const latency = world.latency ?? 0;
  let now = 0;
  const report = (t: Truth) => {
    const tick = Math.max(0, now - latency);
    return [{ ...t(tick / TICK_HZ), tick }];
  };
  const options: MpcDriverOptions = {
    ...(truth && { tracks: { tracks: () => report(truth) } }),
    standstill: true,
    roadDemand: true,
    ...world.options,
  };
  const driver = new MpcDriver(
    car,
    world.mu ?? 1,
    road,
    corridor(world.left ?? LANE / 2),
    cruise(world.target ?? world.speed),
    options,
  );
  const plans: MpcPlan[] = [];
  const ocps: OcpQp[] = [];
  const fingerprint = new Fingerprint();
  let minClearance = Infinity;
  let speedAtClosest = 0;
  let maxBeta = 0;
  let maxEy = 0;
  let speedAtMark = NaN;
  let brakeOnset = NaN;
  const projection = { s: 0, ey: 0, heading: 0, curvature: 0, index: -1 };
  runClosedLoop(
    vehicle,
    {
      periodTicks: driver.periodTicks,
      delayTicks: driver.delayTicks,
      compute: (tick, v, out) => {
        now = tick;
        driver.compute(tick, v, out);
        plans.push(driver.lastPlan!);
        ocps.push(driver.mpc.lastOcp!);
      },
    },
    {
      ticks: ticksFor(world.seconds),
      onTick: (tick, v, command) => {
        now = tick;
        const c = v.plant.chassis;
        fingerprint.add(c);
        const vx = c[CHASSIS.VX] ?? 0;
        const p = road.project(c[CHASSIS.X] ?? 0, c[CHASSIS.Y] ?? 0, projection.index, projection);
        if (vx > 1) maxBeta = Math.max(maxBeta, Math.abs(Math.atan2(c[CHASSIS.VY] ?? 0, vx)));
        maxEy = Math.max(maxEy, p.ey);
        if (world.markS !== undefined && Number.isNaN(speedAtMark) && p.s >= world.markS) speedAtMark = vx;
        if (Number.isNaN(brakeOnset) && command.accel < -0.3) brakeOnset = p.s;
        if (truth) {
          const gap = clearance(v, truth(tick / TICK_HZ));
          if (gap < minClearance) {
            minClearance = gap;
            speedAtClosest = vx;
          }
        }
      },
      until: (_tick, v) => world.endS !== undefined && (v.plant.chassis[CHASSIS.X] ?? 0) > world.endS,
    },
  );
  return {
    vehicle,
    plans,
    ocps,
    hash: fingerprint.digest(),
    minClearance,
    speedAtClosest,
    maxBeta,
    maxEy,
    speedAtMark,
    brakeOnset,
  };
}

const kmh = (v: number) => (v * 3.6).toFixed(1);
const deg = (rad: number) => ((rad * 180) / Math.PI).toFixed(2);

describe('MPC obstacle constraints', () => {
  const obstacle = box(45, 0, 1, 1);
  const stop = drive({ speed: 50 / 3.6, track: obstacle, seconds: 8, options: { side: 'stop' } });

  it("with 'stop' it stops before a static obstacle in the lane at 50 km/h on dry asphalt without touching it", () => {
    const c = stop.vehicle.plant.chassis;
    console.log(
      `stop: closest ${stop.minClearance.toFixed(2)} m at ${kmh(stop.speedAtClosest)} km/h,` +
        ` rest ${kmh(c[CHASSIS.VX] ?? 0)} km/h,` +
        ` braking from s = ${stop.brakeOnset.toFixed(1)} m`,
    );
    expect(stop.minClearance).toBeGreaterThan(0);
    expect(Math.abs(c[CHASSIS.VX] ?? 0)).toBeLessThan(0.1);
    expect(stop.plans.some((p) => p.obstacleRows > 0)).toBe(true);
  }, 60_000);

  it('never plans a speed below zero in a full stop', () => {
    // The lowest speed of every plan's nonlinear rollout, from the first plan to rest.
    const lowest = (run: Run) =>
      Math.min(...run.plans.map((plan) => Math.min(...plan.trajectory.filter((_, i) => i % NX === STATE.VX))));
    const brake: World = { speed: 50 / 3.6, target: 0, seconds: 6 };
    const held = drive(brake);
    const free = drive({ ...brake, options: { standstill: false } });
    console.log(
      `standstill: lowest planned vx ${lowest(stop).toFixed(3)} m/s before the obstacle,` +
        ` ${lowest(held).toFixed(3)} m/s` +
        ` braking to rest; without vx ≥ 0 ${lowest(free).toFixed(3)} m/s`,
    );
    expect(lowest(stop)).toBeGreaterThan(-0.05);
    expect(lowest(held)).toBeGreaterThan(-0.05);
    expect(Math.abs(held.vehicle.plant.chassis[CHASSIS.VX] ?? 0)).toBeLessThan(0.1);
  }, 60_000);

  it("with 'left' it passes a static obstacle with clearance and comes back to its lane", () => {
    const track = box(60, 0, 1, 1);
    const run = drive({
      speed: 50 / 3.6,
      track,
      left: LANE * 1.5,
      seconds: 14,
      endS: 160,
      options: { side: 'left' },
    });
    const c = run.vehicle.plant.chassis;
    console.log(
      `left: closest ${run.minClearance.toFixed(2)} m at ${kmh(run.speedAtClosest)} km/h,` +
        ` widest e_y ${run.maxEy.toFixed(2)} m, back at e_y ${(c[CHASSIS.Y] ?? 0).toFixed(2)} m,` +
        ` ${kmh(c[CHASSIS.VX] ?? 0)} km/h at x = ${(c[CHASSIS.X] ?? 0).toFixed(0)} m`,
    );
    expect(run.minClearance).toBeGreaterThan(0.3);
    expect(c[CHASSIS.X] ?? 0).toBeGreaterThan(160);
    expect(Math.abs(c[CHASSIS.Y] ?? 0)).toBeLessThan(0.3);
    expect(run.speedAtClosest).toBeGreaterThan(40 / 3.6);
  }, 60_000);

  // 'avoid' is not one of the decision layer's maneuvers ('stop', 'left', 'right'): its normal comes from the
  // nominal geometry. Its outcome is pinned here so that a change to it is seen: before a static box in the lane,
  // wherever it sits across the lane, the terminal braking row holds it and it stops.
  for (const ey of [0, 0.6]) {
    it(`with 'avoid' it stops before a static box at e_y ${ey} m without touching it or swerving`, () => {
      const run = drive({
        speed: 50 / 3.6,
        track: box(45, ey, 1, 1),
        left: LANE * 1.5,
        seconds: 8,
        options: { side: 'avoid' },
      });
      const c = run.vehicle.plant.chassis;
      console.log(
        `avoid, box at e_y ${ey} m: closest ${run.minClearance.toFixed(2)} m, widest e_y ${run.maxEy.toFixed(2)} m,` +
          ` |β| max ${deg(run.maxBeta)}°, rest ${kmh(c[CHASSIS.VX] ?? 0)} km/h`,
      );
      expect(run.minClearance).toBeGreaterThan(0);
      expect(Math.abs(c[CHASSIS.VX] ?? 0)).toBeLessThan(0.1);
      expect(run.maxEy).toBeLessThan(0.3);
      expect(run.maxBeta).toBeLessThan((1 * Math.PI) / 180);
    }, 60_000);
  }

  it('runs the same to the bit twice', () => {
    const again = drive({ speed: 50 / 3.6, track: obstacle, seconds: 8, options: { side: 'stop' } });
    expect(again.hash).toBe(stop.hash);
  }, 60_000);
});

describe('MPC terminal braking feasibility', () => {
  it('on ice, brakes early enough for a static obstacle beyond the horizon', () => {
    const track = box(130, 0, 1, 1);
    const world: World = {
      speed: 40 / 3.6,
      mu: 0.1,
      surfaces: () => uniformSurface('ice'),
      track,
      seconds: 25,
      options: { side: 'stop' },
    };
    const on = drive(world);
    const off = drive({ ...world, options: { side: 'stop', terminal: false } });
    console.log(
      `terminal on ice at 40 km/h: braking from s = ${on.brakeOnset.toFixed(1)} m,` +
        ` closest ${on.minClearance.toFixed(2)} m` +
        ` at ${kmh(on.speedAtClosest)} km/h; without it braking from s = ${off.brakeOnset.toFixed(1)} m,` +
        ` closest ${off.minClearance.toFixed(2)} m at ${kmh(off.speedAtClosest)} km/h`,
    );
    expect(on.minClearance).toBeGreaterThan(0);
    expect(on.brakeOnset).toBeLessThan(off.brakeOnset - 20);
    expect(off.minClearance).toBeLessThan(on.minClearance);
  }, 120_000);
});

describe('MPC friction per stage', () => {
  it('slows before an ice patch on a curve that the preview shows, and keeps |β| < 5°', () => {
    const radius = 120;
    const segments: Segment[] = [
      { kind: 'straight', length: 60 },
      { kind: 'clothoid', length: 30, curvatureStart: 0, curvatureEnd: 1 / radius },
      { kind: 'arc', length: 200, curvature: 1 / radius },
      { kind: 'straight', length: 200 },
    ];
    const patch: SurfaceZone = { from: 110, to: 190, surface: 'ice' };
    const preview: FrictionPreview = { at: (s) => (s >= patch.from && s < patch.to ? 0.1 : 1) };
    const world: World = {
      segments,
      surfaces: (road) => surfaceMap(road, 'dry', [patch]),
      speed: 60 / 3.6,
      left: LANE * 1.5,
      seconds: 22,
      markS: patch.from,
      endS: Infinity,
      options: { friction: preview },
    };
    const seen = drive(world);
    const blind = drive({ ...world, options: {} });
    console.log(
      `ice patch on the curve: with the preview ${kmh(seen.speedAtMark)} km/h at the patch,` +
        ` |β| max ${deg(seen.maxBeta)}°;` +
        ` without it ${kmh(blind.speedAtMark)} km/h, |β| max ${deg(blind.maxBeta)}°`,
    );
    expect(seen.maxBeta).toBeLessThan((5 * Math.PI) / 180);
    expect(seen.speedAtMark).toBeLessThan(blind.speedAtMark - 10 / 3.6);
  }, 120_000);
});

describe('the new rows and the fast solver', () => {
  it('starts every slack fixed at its bound and agrees with the exact reference', () => {
    const runs = [
      drive({ speed: 50 / 3.6, track: box(45, 0, 1, 1), seconds: 6, options: { side: 'stop' } }),
      drive({ speed: 50 / 3.6, track: box(60, 0, 1, 1), left: LANE * 1.5, seconds: 8, options: { side: 'left' } }),
      drive({ speed: 50 / 3.6, track: box(40, 0.5, 1, 1), left: LANE * 1.5, seconds: 5, options: { side: 'avoid' } }),
      drive({ speed: 40 / 3.6, mu: 0.1, surfaces: () => uniformSurface('ice'), track: box(130, 0, 1, 1), seconds: 6 }),
    ];
    const condenser = new RowCondenser();
    const fast = new GoldfarbIdnaniFastSolver();
    const step = new GiStepSolver('fast');
    const exact = new CondensedStepSolver('exact', new GoldfarbIdnaniSolver());
    let checked = 0;
    let extra = 0;
    for (const run of runs) {
      run.ocps.forEach((ocp, i) => {
        fast.solveRows(condenser.lower(ocp));
        expect(fast.stats.fixed, `QP ${i}`).toBe(ocp.slacks);
        extra += ocp.slacks - ocp.horizon - Math.ceil(ocp.horizon / 4);
        if (i % 4 !== 0) return;
        const a = step.solve(ocp);
        const b = exact.solve(ocp);
        const scale = Math.max(1, ...Array.from(b.du, Math.abs));
        let du = 0;
        b.du.forEach((v, j) => (du = Math.max(du, Math.abs(a.du[j]! - v))));
        expect(a.status).toBe('solved');
        expect(du / scale, `QP ${i}`).toBeLessThan(1e-6);
        checked++;
      });
    }
    // The runs do exercise the new slacks (obstacles, terminal, vx ≥ 0).
    expect(extra).toBeGreaterThan(100);
    expect(checked).toBeGreaterThan(50);
  }, 120_000);
});

/**
 * Rows a solution may miss by: both Goldfarb–Idnani solvers stop on QuadProg++'s test, which accepts a total
 * violation of order rows·ε·tr(P)·tr(P⁻¹)·100 (about 1e-7 on these QPs).
 */
const ROW_TOLERANCE = 1e-6;
const exp = (v: number) => v.toExponential(2);

function violation(problem: QpProblem, x: Float64Array): number {
  let worst = 0;
  for (let i = 0; i < problem.m; i++) {
    let ax = 0;
    for (let j = 0; j < problem.n; j++) ax += problem.A[i * problem.n + j]! * x[j]!;
    worst = Math.max(worst, problem.l[i]! - ax, ax - problem.u[i]!);
  }
  return worst;
}

/**
 * KKT conditions of a QP point (x, y) in the condensed problem, OSQP's signs (y > 0 on an active upper bound, y < 0
 * on an active lower one): primal feasibility, stationarity ‖Px + q + Aᵀy‖∞ (qp/problem.ts residuals) and
 * complementarity max |y_i|·(distance to the bound its sign names); the last two relative to max(1, ‖q‖∞).
 */
function kkt(problem: QpProblem, x: Float64Array, y: Float64Array): { primal: number; dual: number; comp: number } {
  const { primal, dual } = residuals(problem, x, y);
  let comp = 0;
  for (let i = 0; i < problem.m; i++) {
    let ax = 0;
    for (let j = 0; j < problem.n; j++) ax += problem.A[i * problem.n + j]! * x[j]!;
    const yi = y[i]!;
    const gap = yi > 0 ? problem.u[i]! - ax : yi < 0 ? ax - problem.l[i]! : 0;
    comp = Math.max(comp, Math.abs(yi) * gap);
  }
  const scale = Math.max(1, ...Array.from(problem.q, Math.abs));
  return { primal, dual: dual / scale, comp: comp / scale };
}

interface Agreement {
  readonly checked: number;
  /** Largest du difference relative to max(1, |du_exact|). */
  readonly du: number;
  /** Largest row violation of either solution. */
  readonly rows: number;
  /** Largest (f_fast − f_exact)/max(1, |f_exact|): negative when the fast solution is the better one. */
  readonly objective: number;
  /** The fast solution's own KKT residuals, the largest over the QPs (kkt above). */
  readonly kkt: { readonly primal: number; readonly dual: number; readonly comp: number };
}

/**
 * Solves each step QP with the fast solver and the exact reference, both cold, and compares the solutions; the fast
 * solution's multipliers come from the fast solver on the same rows, whose order the condensed problem keeps.
 */
function agree(ocps: readonly OcpQp[]): Agreement {
  const condenser = new Condenser();
  const rowCondenser = new RowCondenser();
  const fast = new GiStepSolver('fast');
  const fastRows = new GoldfarbIdnaniFastSolver();
  const exact = new CondensedStepSolver('exact', new GoldfarbIdnaniSolver());
  let du = 0;
  let rows = 0;
  let gap = -Infinity;
  const worst = { primal: 0, dual: 0, comp: 0 };
  ocps.forEach((ocp, i) => {
    const a = fast.solve(ocp);
    const b = exact.solve(ocp);
    expect(a.status, `QP ${i}, fast`).toBe('solved');
    expect(b.status, `QP ${i}, exact`).toBe('solved');
    const problem = condenser.lower(ocp);
    const own = fastRows.solveRows(rowCondenser.lower(ocp));
    // The same solver on the same rows: the step solver's point, to the bit.
    expect(Array.from(own.x.subarray(0, a.du.length)), `QP ${i}`).toEqual(Array.from(a.du));
    const k = kkt(problem, own.x, own.y);
    worst.primal = Math.max(worst.primal, k.primal);
    worst.dual = Math.max(worst.dual, k.dual);
    worst.comp = Math.max(worst.comp, k.comp);
    const point = (inputs: Float64Array, slack: Float64Array) => {
      const x = new Float64Array(problem.n);
      x.set(inputs);
      x.set(slack, inputs.length);
      return x;
    };
    const xa = point(a.du, a.slack);
    const xb = point(b.du, b.slack);
    rows = Math.max(rows, violation(problem, xa), violation(problem, xb));
    const scale = Math.max(1, ...Array.from(b.du, Math.abs));
    b.du.forEach((v, j) => (du = Math.max(du, Math.abs(a.du[j]! - v) / scale)));
    const fb = objective(problem, xb);
    gap = Math.max(gap, (objective(problem, xa) - fb) / Math.max(1, Math.abs(fb)));
  });
  return { checked: ocps.length, du, rows, objective: gap, kkt: worst };
}

/**
 * The fast solution's KKT residuals: measured under 1e-13 on every run below (primal 2.8e-14, stationarity
 * 1.6e-15, complementarity 9.1e-15 at the most, all on the oncoming car); four orders of headroom.
 */
const KKT_TOLERANCE = 1e-9;

function expectOptimal(a: Agreement, name: string): void {
  expect(a.kkt.primal, `${name}, primal`).toBeLessThan(KKT_TOLERANCE);
  expect(a.kkt.dual, `${name}, stationarity`).toBeLessThan(KKT_TOLERANCE);
  expect(a.kkt.comp, `${name}, complementarity`).toBeLessThan(KKT_TOLERANCE);
  // No worse than the exact reference.
  expect(a.objective, name).toBeLessThan(1e-9);
}

const kktText = (a: Agreement) =>
  `fast KKT primal ${exp(a.kkt.primal)}, stationarity ${exp(a.kkt.dual)}, complementarity ${exp(a.kkt.comp)}`;

const failed = (run: Run) => run.plans.filter((plan) => plan.status === 'failed').length;

describe('MPC at low speed and standstill', () => {
  it('no plan fails and fast and exact agree on every QP of the stop, brake-to-rest and low-speed runs', () => {
    const runs: [string, Run][] = [
      ['stop at 50 km/h', drive({ speed: 50 / 3.6, track: box(45, 0, 1, 1), seconds: 8, options: { side: 'stop' } })],
      ['brake to rest', drive({ speed: 50 / 3.6, target: 0, seconds: 8 })],
      ['stop at 7 km/h', drive({ speed: 2, track: box(12, 0, 1, 1), seconds: 10, options: { side: 'stop' } })],
      ['creep 1 → 2 m/s', drive({ speed: 1, target: 2, seconds: 8 })],
      ['start from rest', drive({ speed: 0, target: 3, seconds: 6 })],
    ];
    for (const [name, run] of runs) {
      const a = agree(run.ocps);
      console.log(
        `${name}: ${run.plans.length} plans, ${failed(run)} failed;` +
          ` fast vs exact on ${a.checked} QPs: du ${exp(a.du)},` +
          ` rows ${exp(a.rows)}, objective ${exp(a.objective)}; ${kktText(a)}`,
      );
      expect(failed(run), name).toBe(0);
      expect(a.rows, name).toBeLessThan(ROW_TOLERANCE);
      // Optimality is checked on the fast solution's own KKT residuals; du against the exact reference only
      // agrees as far as the reference is accurate (its stationarity residual reaches 3.4e-10 on 'stop at 50 km/h',
      // where du peaks at 9.4e-7): 1e-5 leaves ten times that.
      expectOptimal(a, name);
      expect(a.du, name).toBeLessThan(1e-5);
    }
  }, 180_000);

  it("against an oncoming car under 'stop', the plan holds at rest, never fails, and solves its QPs optimally", () => {
    // The exact reference loses accuracy on a few of these QPs (du against it reaches 1.4e-5, its stationarity
    // residual 4.5e-9): the fast solution is checked on its own KKT residuals and its objective.
    const oncoming: Truth = (t) => {
      const v = -30 / 3.6;
      return { id: 'car', kind: 'vehicle', s: 120 + v * t, ey: 0, vs: v, vey: 0, length: 4.5, width: 1.8 };
    };
    const run = drive({ speed: 50 / 3.6, truth: oncoming, seconds: 7, options: { side: 'stop' } });
    const a = agree(run.ocps);
    // The plan's nonlinear rollout, which the decision layer compares maneuvers on: it stands still and takes the
    // slack (it is hit), it never backs away.
    const lowest = Math.min(
      ...run.plans.map((plan) => Math.min(...plan.trajectory.filter((_, i) => i % NX === STATE.VX))),
    );
    const slack = Math.max(...run.plans.map((plan) => plan.slack));
    console.log(
      `oncoming car: ${run.plans.length} plans, ${failed(run)} failed; lowest planned vx ${lowest.toFixed(3)} m/s,` +
        ` largest slack ${slack.toFixed(2)}; fast vs exact: du ${exp(a.du)},` +
        ` rows ${exp(a.rows)}, objective ${exp(a.objective)}; ${kktText(a)}`,
    );
    expect(failed(run)).toBe(0);
    expect(lowest).toBeGreaterThan(-1e-6);
    expect(Math.abs(run.vehicle.plant.chassis[CHASSIS.VX] ?? 0)).toBeLessThan(0.1);
    expect(slack).toBeGreaterThan(1);
    expect(a.rows).toBeLessThan(ROW_TOLERANCE);
    expectOptimal(a, 'oncoming car');
  }, 120_000);
});

describe('MPC track age', () => {
  const road = new RoadPath({ segments: STRAIGHT, width: { left: 8, right: 3 } });
  /** A pedestrian crossing to the left and toward the vehicle, at (30, −1) m at the plan's start (tick 1050). */
  const walker = (tick: number, age: number): ObstacleTrack => ({
    id: 'p',
    kind: 'pedestrian',
    tick,
    s: 30 + 2 * age,
    ey: -1 - 1.5 * age,
    vs: -2,
    vey: 1.5,
    length: 1.8,
    width: 0.6,
  });
  const plan = (track: ObstacleTrack) => {
    const mpc = new MpcController(car, 1, road, corridor(LANE / 2), cruise(50 / 3.6), undefined, undefined, {
      tracks: { tracks: () => [track] },
      side: 'stop',
      standstill: true,
    });
    const x0 = new Float64Array(NX);
    x0[STATE.VX] = 50 / 3.6;
    const result = mpc.step(x0, 1050);
    return { ocp: mpc.lastOcp!, rows: result.obstacleRows };
  };

  it('predicts each track from its own tick: a report 100 ms old gives the QP of the state at the plan start', () => {
    const truth = plan(walker(1050, 0));
    const late = plan(walker(950, 0.1));
    const stale = plan(walker(1050, 0.1));
    expect(truth.rows).toBeGreaterThan(0);
    expect(late.ocp.rowKeys).toEqual(truth.ocp.rowKeys);
    let worst = 0;
    truth.ocp.lower.forEach((v, i) => {
      if (Number.isFinite(v)) worst = Math.max(worst, Math.abs(late.ocp.lower[i]! - v));
    });
    let off = 0;
    truth.ocp.lower.forEach((v, i) => {
      if (Number.isFinite(v) && truth.ocp.rowKeys[i] === stale.ocp.rowKeys[i])
        off = Math.max(off, Math.abs(stale.ocp.lower[i]! - v));
    });
    console.log(`track age: rows of a 100 ms old report differ by ${exp(worst)}; read as fresh, by ${off.toFixed(3)}`);
    expect(worst).toBeLessThan(1e-9);
    expect(off).toBeGreaterThan(0.01);
  });

  it('yields to a crossing pedestrian reported with a 100 ms latency, without contact', () => {
    const crossing: Truth = (t) => {
      const ey = Math.min(-4 + 1.5 * t, 6);
      return { id: 'p', kind: 'pedestrian', s: 40, ey, vs: 0, vey: ey < 6 ? 1.5 : 0, length: 0.5, width: 0.5 };
    };
    const run = drive({ speed: 50 / 3.6, truth: crossing, latency: 100, seconds: 8, options: { side: 'stop' } });
    console.log(
      `crossing at 100 ms latency: closest ${run.minClearance.toFixed(2)} m at ${kmh(run.speedAtClosest)} km/h,` +
        ` ${failed(run)} failed plans`,
    );
    expect(failed(run)).toBe(0);
    expect(run.minClearance).toBeGreaterThan(0);
  }, 60_000);
});

describe('MPC terminal braking behind a lead', () => {
  for (const decel of [6, 9.81]) {
    it(`following a lead at 20 km/h that brakes at ${decel} m/s² ends without contact`, () => {
      const run = drive({
        speed: 50 / 3.6,
        truth: braking(decel),
        latency: 100,
        seconds: 14,
        options: { side: 'stop' },
      });
      const c = run.vehicle.plant.chassis;
      console.log(
        `lead braking at ${decel} m/s²: closest ${run.minClearance.toFixed(2)} m at ${kmh(run.speedAtClosest)} km/h,` +
          ` rest ${kmh(c[CHASSIS.VX] ?? 0)} km/h, ${failed(run)} failed plans`,
      );
      expect(failed(run)).toBe(0);
      expect(run.minClearance).toBeGreaterThan(0);
      expect(Math.abs(c[CHASSIS.VX] ?? 0)).toBeLessThan(0.2);
    }, 60_000);
  }
});

describe('MPC options and guards', () => {
  it("writes the road's g-g demand only with roadDemand, at the stages on a curve", () => {
    const road = new RoadPath({
      segments: [{ kind: 'arc', length: 400, curvature: 1 / 60 }],
      width: { left: 8, right: 3 },
    });
    const demandRows = (roadDemand: boolean) => {
      const mpc = new MpcController(car, 1, road, corridor(LANE / 2), cruise(82 / 3.6), undefined, undefined, {
        roadDemand,
      });
      const x0 = new Float64Array(NX);
      x0[STATE.VX] = 82 / 3.6;
      mpc.step(x0);
      const keys = new Set(Array.from({ length: mpc.horizon }, (_, k) => rowKey(ROW_KIND.FRICTION, k, 3)));
      return mpc.lastOcp!.rowKeys.filter((key) => keys.has(key)).length;
    };
    expect(demandRows(false)).toBe(0);
    expect(demandRows(true)).toBeGreaterThan(0);
  });

  it('keeps every QP entry finite under a friction preview of 0, below 0 or NaN', () => {
    const preview: FrictionPreview = { at: (s) => (s < 20 ? 1 : s < 40 ? 0 : s < 60 ? -1 : Number.NaN) };
    const run = drive({
      speed: 50 / 3.6,
      track: box(90, 0, 1, 1),
      seconds: 3,
      options: { side: 'stop', friction: preview },
    });
    for (const ocp of run.ocps) {
      for (const values of [ocp.a, ocp.b, ocp.costValue, ocp.linear, ocp.rowValue])
        expect(Array.from(values).every(Number.isFinite)).toBe(true);
      ocp.lower.forEach((l, i) => {
        expect(l < Infinity && !Number.isNaN(l)).toBe(true);
        expect(ocp.upper[i]! > -Infinity && !Number.isNaN(ocp.upper[i]!)).toBe(true);
      });
    }
    expect(run.plans.some((p) => p.terminalGap !== undefined && Number.isFinite(p.terminalGap))).toBe(true);
    expect(failed(run)).toBe(0);
  }, 60_000);
});

describe('MPC track guards and the start tick', () => {
  const road = new RoadPath({ segments: STRAIGHT, width: { left: 8, right: 3 } });
  const walker: ObstacleTrack = {
    id: 'p',
    kind: 'pedestrian',
    tick: 900,
    s: 30,
    ey: -1,
    vs: -2,
    vey: 1.5,
    length: 1.8,
    width: 0.6,
  };
  const options = { tracks: { tracks: () => [walker] }, side: 'stop', standstill: true } as const;
  const controller = (track: ObstacleTrack = walker) =>
    new MpcController(car, 1, road, corridor(LANE / 2), cruise(50 / 3.6), undefined, undefined, {
      ...options,
      tracks: { tracks: () => [track] },
    });

  it('throws on a track whose age is not finite, and plans with it once the tick is there', () => {
    const x0 = new Float64Array(NX);
    x0[STATE.VX] = 50 / 3.6;
    // A JS caller without the tick, or a NaN one: the NaN bounds would read as satisfied and the box be driven through.
    for (const tick of [undefined, Number.NaN]) {
      const mpc = controller({ ...walker, tick: tick as unknown as number });
      expect(() => mpc.step(x0, 1000)).toThrow(/track 'p' has no finite age/);
    }
    expect(() => controller().step(x0, Number.NaN)).toThrow(/no finite age/);
    expect(controller().step(x0, 1000).obstacleRows).toBeGreaterThan(0);
  });

  it('plans from the control tick plus the delay: MpcDriver.compute writes the QP of step(x, tick + delay)', () => {
    const tick = 1000;
    const driver = new MpcDriver(car, 1, road, corridor(LANE / 2), cruise(50 / 3.6), options);
    const vehicle = new Vehicle(car, uniformSurface('dry'));
    vehicle.reset(0, 0.2, 0, 50 / 3.6);
    driver.compute(tick, vehicle, { steer: 0, accel: 0 });
    const ocp = driver.mpc.lastOcp!;
    // The same state predicted by the delay with the command in force (none yet), planned at a given start tick.
    const reference = (startTick: number | undefined) => {
      const mpc = controller();
      const state = driver.observe(vehicle, new Float64Array(NX));
      const s = state[STATE.S] ?? 0;
      const kappa = road.pointAt(s, { x: 0, y: 0, heading: 0, curvature: 0 }).curvature;
      const predicted = new Float64Array(NX);
      mpc.model.discretize(
        state,
        new Float64Array(NU),
        kappa,
        mpc.frictionAt(s),
        driver.delayTicks / TICK_HZ,
        predicted,
      );
      mpc.step(predicted, startTick);
      return mpc.lastOcp!;
    };
    const same = reference(tick + driver.delayTicks);
    expect(ocp.rowKeys).toEqual(same.rowKeys);
    expect(ocp.lower).toEqual(same.lower);
    expect(ocp.upper).toEqual(same.upper);
    expect(ocp.rowKeys.some((key) => Math.floor(key / KEY_STAGE / KEY_STAGE) === ROW_KIND.OBSTACLE)).toBe(true);
    // The tick without the delay, or no age at all, gives other obstacle bounds: the check sees either mistake.
    const differs = (other: OcpQp) =>
      other.rowKeys.length !== ocp.rowKeys.length ||
      other.rowKeys.some((key, i) => key !== ocp.rowKeys[i]) ||
      other.lower.some((v, i) => Number.isFinite(v) && Math.abs(v - ocp.lower[i]!) > 1e-6);
    expect(differs(reference(tick))).toBe(true);
    expect(differs(reference(undefined))).toBe(true);
  });
});

describe('MPC obstacle windows', () => {
  const hp = { ns: 0, ney: 0, clearance: 0 };
  const view = { hs: 0.5, hey: 0.5, inflation: 1.8, buffer: 0, ahead: false };

  it("'stop' takes the box's tangent half-plane just outside its lateral window, within one QP's reach", () => {
    // 0.4 m outside the window (|e_y| ≥ 0.5 + 1.8) and 2 m behind the box.
    const disc = { ...view, ds: -2, dey: 2.7 };
    expect(obstacleHalfPlane('stop', disc, hp)).toBe(false);
    expect(obstacleHalfPlane('stop', { ...disc, reach: 0.3 }, hp)).toBe(false);
    expect(obstacleHalfPlane('stop', { ...disc, reach: 0.5 }, hp)).toBe(true);
    // The normal from the box's closest corner (−0.5, 0.5): back and to the left, and the nominal satisfies it.
    expect(hp.ns).toBeLessThan(0);
    expect(hp.ney).toBeGreaterThan(0);
    expect(Math.hypot(hp.ns, hp.ney)).toBeCloseTo(1, 12);
    expect(hp.clearance).toBeGreaterThanOrEqual(0);
    // Inside the window it is the stop row, whatever the reach; once ahead of the box, none.
    expect(obstacleHalfPlane('stop', { ...disc, dey: 1, reach: 0.5 }, hp)).toBe(true);
    expect([hp.ns, hp.ney]).toEqual([-1, 0]);
    expect(obstacleHalfPlane('stop', { ...disc, reach: 0.5, ahead: true }, hp)).toBe(false);
  });

  it("'left' and 'right' take it just outside the window alongside the box, within one QP's reach", () => {
    const disc = { ...view, ds: -2.6, dey: 0.2, buffer: 0.2 };
    for (const side of ['left', 'right'] as const) {
      expect(obstacleHalfPlane(side, disc, hp)).toBe(false);
      expect(obstacleHalfPlane(side, { ...disc, reach: 0.5 }, hp)).toBe(true);
      // Straight behind the box: the normal points back.
      expect([hp.ns, hp.ney]).toEqual([-1, 0]);
      expect(hp.clearance).toBeGreaterThanOrEqual(0);
      expect(obstacleHalfPlane(side, { ...disc, ds: 0, reach: 0.5 }, hp)).toBe(true);
      expect([hp.ns, hp.ney]).toEqual([0, side === 'left' ? 1 : -1]);
    }
  });
});

describe('MPC terminal braking: a lead moving away', () => {
  const road = new RoadPath({ segments: STRAIGHT, width: { left: 8, right: 3 } });
  const gap = (lead: Partial<ObstacleTrack>) => {
    const track: ObstacleTrack = {
      id: 'lead',
      kind: 'vehicle',
      tick: 0,
      s: 40,
      ey: 0,
      vs: 15,
      vey: 0,
      length: 4.5,
      width: 1.8,
      ...lead,
    };
    const mpc = new MpcController(car, 1, road, corridor(LANE * 1.5), cruise(50 / 3.6), undefined, undefined, {
      tracks: { tracks: () => [track] },
      side: 'stop',
      standstill: true,
    });
    const x0 = new Float64Array(NX);
    x0[STATE.VX] = 50 / 3.6;
    return mpc.step(x0, 0).terminalGap;
  };

  it('counts a lead in the path where it would stop braking now, not where constant velocity takes it', () => {
    // Leaving the lane at 2 m/s: at constant velocity 4.8 m to the left at the horizon end, out of the path; braking
    // now at μ·g it stops 1.5 m to the left, still across the vehicle's e_y.
    expect(gap({ vey: 2 })).toBeDefined();
    expect(gap({})).toBeDefined();
    // In the next lane, holding it or moving further away from the path: no terminal row.
    expect(gap({ ey: 3.5 })).toBeUndefined();
    expect(gap({ ey: 3.5, vey: 2 })).toBeUndefined();
  });
});
