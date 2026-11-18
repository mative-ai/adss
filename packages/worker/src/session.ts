/**
 * A simulation session (Phase 4): one scenario run, built from a scenario, a seed and a configuration,
 * stepped as the pacing asks and read as it goes. It has no worker globals and no timers: the worker entry
 * (worker.ts) drives it from messages and a Pacer, the tests from Node. The ego is the decision layer as `npm run sim`
 * drives it (or the single-maneuver MPC), the ghost the baseline controller, in lockstep with the same seed
 * (ScenarioRun of the core: physics at 1 kHz, objects and the MPC at 20 Hz, records at 100 Hz).
 *
 * Each step of the ego's controller is timed with the session's clock for the solver's chart: the time is reported,
 * never used, so a run is the same however long its steps take and however it is paced (M6).
 */
import {
  BaselineDriver,
  BRANCH_IDS,
  CHASSIS,
  DecisionDriver,
  defaultMpcSettings,
  MpcDriver,
  NX,
  overrideScenario,
  parseScenario,
  ScenarioRun,
  STATE,
  stillLateralSpeed,
  SURFACES,
  vehicleFingerprint,
  VEHICLES,
  type Controller,
  type ControllerContext,
  type ControllerFactory,
  type DecisionReport,
  type MpcPlan,
  type MpcSettings,
  type RoadPoint,
  type Scenario,
  type VehicleParams,
  type VehicleRun,
  type VehicleWorld,
} from '@mpc-simulator/core';

import {
  DEFAULT_CONFIG,
  FLAG,
  FRAME,
  frameLayout,
  HORIZON_RANGE,
  OBSTACLE,
  OBSTACLE_SIZE,
  PLAN,
  PLAN_HEADER,
  PLANS,
  PROTOCOL_VERSION,
  ROAD_SAMPLE,
  ROAD_SAMPLE_STEP,
  TELEMETRY_MAX,
  VEHICLE,
  VEHICLE_SIZE,
  type FrameLayout,
  type SceneInfo,
  type SessionConfig,
  type SessionEvent,
  type SessionMetrics,
  type VehicleSummary,
} from './protocol.ts';

/** A configuration that cannot run: an unknown maneuver, a horizon out of range, a negative noise, a field's shape. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const isRecord = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `base` with `change` over it, checked. Each field must have its shape: a field the page left undefined would run one
 * way here and another once a CSV's JSON dropped it (a ghost undefined runs without one, and its file rebuilds with it).
 */
export function resolveConfig(base: SessionConfig, change: Partial<SessionConfig> = {}): SessionConfig {
  const config: SessionConfig = { ...base, ...change };
  if (config.controller !== 'decision' && config.controller !== 'stop') {
    throw new ConfigError(`Unknown controller: ${String(config.controller)}`);
  }
  if (typeof config.ghost !== 'boolean') throw new ConfigError(`The ghost is on or off: ${String(config.ghost)}`);
  if (!Array.isArray(config.maneuvers)) throw new ConfigError('The maneuvers must be a list');
  if (!isRecord(config.scales)) throw new ConfigError('The cost scales must be an object');
  if (config.triggerDistance !== undefined && !isRecord(config.triggerDistance)) {
    throw new ConfigError('The trigger distances must be an object');
  }
  const { min, max } = HORIZON_RANGE;
  if (!Number.isInteger(config.horizon) || config.horizon < min || config.horizon > max) {
    throw new ConfigError(`The horizon must be an integer from ${min} to ${max} stages: ${config.horizon}`);
  }
  const known = new Set<string>(BRANCH_IDS);
  if (!config.maneuvers.every((m) => known.has(m)) || !config.maneuvers.includes('keep')) {
    throw new ConfigError(`The maneuvers must be among ${BRANCH_IDS.join(', ')}, keep included`);
  }
  if (new Set(config.maneuvers).size !== config.maneuvers.length) throw new ConfigError('A maneuver is repeated');
  if (!Number.isInteger(config.delayTicks) || config.delayTicks < 0 || config.delayTicks > 500) {
    throw new ConfigError(`The delay must be an integer from 0 to 500 ticks: ${config.delayTicks}`);
  }
  for (const scale of Object.values(config.scales)) {
    if (!(typeof scale === 'number' && scale > 0 && Number.isFinite(scale))) throw new ConfigError('Bad cost scale');
  }
  const noise = config.noise;
  if (noise && !(noise.position >= 0 && noise.velocity >= 0 && Number.isFinite(noise.position + noise.velocity))) {
    throw new ConfigError('The sensor noise must be finite and not negative');
  }
  for (const distance of Object.values(config.triggerDistance ?? {})) {
    if (!(typeof distance === 'number' && distance >= 0 && Number.isFinite(distance))) {
      throw new ConfigError(`A trigger distance must be finite and not negative: ${String(distance)}`);
    }
  }
  return config;
}

/**
 * Checks, without building it, that a run can start: its configuration, its scenario with the configuration's changes
 * and its seed (ScenarioRun's rule). A batch checks all its runs so, before the first.
 */
export function checkRun(json: unknown, seed: number, config: Partial<SessionConfig> = {}): void {
  sessionScenario(json, resolveConfig(DEFAULT_CONFIG, config));
  if (seed >>> 0 !== seed) throw new ConfigError(`The seed must be an unsigned 32-bit integer: ${seed}`);
}

/** The MPC's settings for a configuration: its horizon's first stages and its scales over the defaults. */
export function mpcSettings(params: VehicleParams, config: SessionConfig): MpcSettings {
  const defaults = defaultMpcSettings(params);
  return {
    ...defaults,
    steps: defaults.steps.slice(0, config.horizon),
    scales: { ...defaults.scales, ...config.scales },
  };
}

/** The scenario a configuration runs: the file's, with its speed, trigger distances and sensor noise changed. */
export function sessionScenario(json: unknown, config: SessionConfig): Scenario {
  let scenario = parseScenario(json);
  if (config.speedKmh !== undefined || config.triggerDistance !== undefined) {
    scenario = overrideScenario(scenario, {
      ...(config.speedKmh !== undefined && { speedKmh: config.speedKmh }),
      ...(config.triggerDistance !== undefined && { triggerDistance: config.triggerDistance }),
    });
  }
  if (config.noise) scenario = { ...scenario, sensor: { ...scenario.sensor, noise: { ...config.noise } } };
  return scenario;
}

export interface TimedDecision {
  readonly report: DecisionReport;
  /** The control step's time, ms, by the session's clock. */
  readonly stepMs: number;
}

export class SimulationSession {
  readonly scenario: Scenario;
  readonly seed: number;
  readonly config: SessionConfig;
  readonly layout: FrameLayout;
  readonly run: ScenarioRun;
  /** The scenario as it came, for a CSV that rebuilds the run. */
  readonly json: unknown;
  private decisionDriver: DecisionDriver | undefined;
  private stopDriver: MpcDriver | undefined;
  private readonly clock: () => number;
  private readonly decisions: TimedDecision[] = [];
  private readonly events: SessionEvent[] = [];
  private egoEvents = 0;
  private ghostEvents = 0;
  private egoRows = 0;
  private ghostRows = 0;
  private ended = false;
  private readonly point: RoadPoint = { x: 0, y: 0, heading: 0, curvature: 0 };

  constructor(json: unknown, seed: number, config: Partial<SessionConfig> = {}, clock = () => performance.now()) {
    this.json = json;
    this.config = resolveConfig(DEFAULT_CONFIG, config);
    const scenario = sessionScenario(json, this.config);
    this.scenario = scenario;
    this.seed = seed;
    this.clock = clock;
    this.layout = frameLayout(scenario.obstacles.length, this.config.horizon);
    const ego: ControllerFactory = (c) => this.timed(this.ego(c, scenario));
    const ghost: ControllerFactory = (c) => new BaselineDriver(c.params, c.road, c.reference, c.tracks);
    this.run = new ScenarioRun(scenario, { seed, ego, ...(this.config.ghost && { ghost }) });
  }

  private ego(c: ControllerContext, scenario: Scenario): Controller {
    const settings = mpcSettings(c.params, this.config);
    if (this.config.controller === 'stop') {
      this.stopDriver = new MpcDriver(c.params, c.mu, c.road, c.corridor, c.reference, {
        settings,
        delayTicks: this.config.delayTicks,
        tracks: c.tracks,
        friction: c.friction,
        standstill: true,
        roadDemand: true,
        side: 'stop',
      });
      return this.stopDriver;
    }
    this.decisionDriver = new DecisionDriver(c.params, c.mu, c.road, c.corridor, c.reference, c.lane, {
      settings,
      delayTicks: this.config.delayTicks,
      tracks: c.tracks,
      friction: c.friction,
      maneuvers: this.config.maneuvers,
      branch: { stillLateralSpeed: stillLateralSpeed(scenario.sensor.noise.velocity) },
    });
    return this.decisionDriver;
  }

  /** The controller with each step timed, and the decision layer's report kept with its time. */
  private timed(driver: Controller): Controller {
    return {
      periodTicks: driver.periodTicks,
      delayTicks: driver.delayTicks,
      compute: (tick, vehicle, out) => {
        const start = this.clock();
        driver.compute(tick, vehicle, out);
        const stepMs = this.clock() - start;
        const report = this.decisionDriver?.lastDecision;
        if (report !== undefined) this.decisions.push({ report, stepMs });
      },
    };
  }

  /** The next tick to simulate. */
  get tick(): number {
    return this.run.now;
  }

  get done(): boolean {
    return this.run.done;
  }

  /** The ticks of a control cycle (the MPC's period). */
  get period(): number {
    return this.run.ego.controller.periodTicks;
  }

  /** Telemetry rows recorded and not yet written in a frame, the ego's and the ghost's. */
  get unsentRows(): number {
    const ghost = this.run.ghost ? this.run.ghost.recordedRows - this.ghostRows : 0;
    return this.run.ego.recordedRows - this.egoRows + ghost;
  }

  /** Simulates up to `ticks` ticks; returns how many it simulated (fewer once the run is over). */
  advance(ticks: number): number {
    let done = 0;
    for (; done < ticks && !this.run.done; done++) this.run.step();
    this.collect();
    return done;
  }

  /** Simulates to the next control cycle (the step command); returns the ticks simulated. */
  stepCycle(): number {
    return this.advance(this.period - (this.tick % this.period));
  }

  /** The tick of the run's last state once it is over: the scenario's duration, or the last vehicle's end. */
  private get lastTick(): number {
    return Math.max(this.run.ego.ticks, this.run.ghost?.ticks ?? 0);
  }

  /**
   * The vehicles' new events, merged by tick (the ego's first at the same tick): each log is in tick order and a slice
   * holds whole ticks, so the stream is the same however the run is sliced (M6).
   */
  private collect(): void {
    const ego = this.run.ego.eventLog;
    const ghost = this.run.ghost?.eventLog ?? [];
    for (;;) {
      const e = ego[this.egoEvents];
      const g = ghost[this.ghostEvents];
      if (e && (!g || e.tick <= g.tick)) {
        this.events.push({ ...e, vehicle: 'ego' });
        this.egoEvents++;
      } else if (g) {
        this.events.push({ ...g, vehicle: 'ghost' });
        this.ghostEvents++;
      } else break;
    }
    if (this.run.done && !this.ended) {
      this.ended = true;
      this.events.push({ kind: 'end', tick: this.lastTick });
    }
  }

  /** The decision layer's cycles since the last call, in order. */
  takeDecisions(): TimedDecision[] {
    return this.decisions.splice(0);
  }

  /** The events since the last call, in order. */
  takeEvents(): SessionEvent[] {
    return this.events.splice(0);
  }

  /**
   * Writes the frame of the current tick into `out` (at least layout.length values) and returns its length: the
   * vehicles now, the obstacles, the candidate plans of the last control cycle, and the telemetry rows recorded since
   * the previous frame (up to TELEMETRY_MAX each; the rest come with the next frames, none is lost).
   */
  writeFrame(out: Float64Array, rate: number, playing: boolean): number {
    const L = this.layout;
    const run = this.run;
    out[FRAME.VERSION] = PROTOCOL_VERSION;
    out[FRAME.TICK] = run.done ? this.lastTick : this.tick;
    out[FRAME.RATE] = rate;
    let flags = (run.done ? FLAG.DONE : 0) | (run.ego.end !== null ? FLAG.EGO_ENDED : 0) | (playing ? FLAG.PLAYING : 0);
    if (run.ghost) flags |= FLAG.GHOST | (run.ghost.end !== null ? FLAG.GHOST_ENDED : 0);
    out[FRAME.FLAGS] = flags;
    this.writeVehicle(run.ego, out, L.ego);
    if (run.ghost) this.writeVehicle(run.ghost, out, L.ghost);
    else out.fill(Number.NaN, L.ghost, L.ghost + VEHICLE_SIZE);
    this.writeObstacles(out);
    this.writePlans(out);
    const telemetry = TELEMETRY_MAX * VEHICLE_SIZE;
    const egoRows = run.ego.copyRows(this.egoRows, out.subarray(L.egoTelemetry, L.egoTelemetry + telemetry));
    this.egoRows += egoRows;
    out[FRAME.EGO_ROWS] = egoRows;
    const ghostRows = run.ghost?.copyRows(this.ghostRows, out.subarray(L.ghostTelemetry, L.ghostTelemetry + telemetry));
    this.ghostRows += ghostRows ?? 0;
    out[FRAME.GHOST_ROWS] = ghostRows ?? 0;
    return L.length;
  }

  /** The vehicle in the VEHICLE layout: the plant now, its last observation one tick earlier while it runs. */
  private writeVehicle(world: VehicleWorld, out: Float64Array, at: number): void {
    const c = world.vehicle.plant.chassis;
    const plant = world.vehicle.plant;
    out[at + VEHICLE.TICK] = world.ticks;
    out[at + VEHICLE.X] = c[CHASSIS.X] ?? 0;
    out[at + VEHICLE.Y] = c[CHASSIS.Y] ?? 0;
    out[at + VEHICLE.PSI] = c[CHASSIS.PSI] ?? 0;
    out[at + VEHICLE.VX] = c[CHASSIS.VX] ?? 0;
    out[at + VEHICLE.VY] = c[CHASSIS.VY] ?? 0;
    out[at + VEHICLE.R] = c[CHASSIS.R] ?? 0;
    out[at + VEHICLE.S] = world.pose.s;
    out[at + VEHICLE.EY] = world.pose.ey;
    out[at + VEHICLE.STEER] = world.vehicle.actuators.steer;
    out[at + VEHICLE.STEER_CMD] = world.applied.steer;
    out[at + VEHICLE.ACCEL_CMD] = world.applied.accel;
    out[at + VEHICLE.AX] = plant.ax;
    out[at + VEHICLE.AY] = plant.ay;
  }

  private writeObstacles(out: Float64Array): void {
    const L = this.layout;
    const world = this.run.ego;
    const tracks = world.sensor.tracks();
    this.scenario.obstacles.forEach((spec, i) => {
      const at = L.obstacles + i * OBSTACLE_SIZE;
      const state = world.obstacles.states[i];
      if (!state) return;
      const p = this.run.road.pointAt(state.s, this.point);
      out[at + OBSTACLE.X] = p.x - Math.sin(p.heading) * state.ey;
      out[at + OBSTACLE.Y] = p.y + Math.cos(p.heading) * state.ey;
      out[at + OBSTACLE.HEADING] = p.heading;
      out[at + OBSTACLE.S] = state.s;
      out[at + OBSTACLE.EY] = state.ey;
      out[at + OBSTACLE.DETECTED] = tracks.some((t) => t.id === spec.id) ? 1 : 0;
    });
  }

  /** The candidates of the last control cycle, in world coordinates; NaN points for a candidate not solved. */
  private writePlans(out: Float64Array): void {
    const L = this.layout;
    const report = this.decisionDriver?.lastDecision;
    for (let b = 0; b < PLANS; b++) {
      const id = BRANCH_IDS[b]!;
      const at = L.plans + b * L.planSize;
      let plan: MpcPlan | undefined;
      let feasible = 0;
      let chosen = 0;
      if (this.decisionDriver) {
        const candidate = report?.candidates.find((c) => c.id === id);
        plan = candidate ? this.decisionDriver.plan(id) : undefined;
        feasible = candidate?.feasible ? 1 : 0;
        chosen = report?.chosen === id ? 1 : 0;
      } else if (b === 0 && this.stopDriver?.lastPlan) {
        plan = this.stopDriver.lastPlan;
        chosen = 1;
        feasible = Number.NaN;
      }
      out[at + PLAN.SOLVED] = plan ? 1 : 0;
      out[at + PLAN.FEASIBLE] = feasible;
      out[at + PLAN.CHOSEN] = chosen;
      for (let k = 0; k < L.planPoints; k++) {
        const point = at + PLAN_HEADER + 2 * k;
        if (!plan) {
          out[point] = Number.NaN;
          out[point + 1] = Number.NaN;
          continue;
        }
        const s = plan.trajectory[k * NX + STATE.S] ?? 0;
        const ey = plan.trajectory[k * NX + STATE.EY] ?? 0;
        const p = this.run.road.pointAt(s, this.point);
        out[point] = p.x - Math.sin(p.heading) * ey;
        out[point + 1] = p.y + Math.cos(p.heading) * ey;
      }
    }
  }

  /** The scene for `ready`: the road, the lane, the surfaces and the obstacles' sizes. */
  scene(): SceneInfo {
    const road = this.run.road;
    const count = Math.floor(road.length / ROAD_SAMPLE_STEP) + 1;
    const samples = new Float64Array(count * ROAD_SAMPLE);
    for (let i = 0; i < count; i++) {
      const s = Math.min(i * ROAD_SAMPLE_STEP, road.length);
      const p = road.pointAt(s, this.point);
      samples.set([s, p.x, p.y, p.heading, p.curvature], i * ROAD_SAMPLE);
    }
    const scenario = this.scenario;
    const params = VEHICLES[scenario.vehicle];
    return {
      scenario: scenario.id,
      ticks: this.run.ticks,
      vehicle: {
        id: params.id,
        length: params.length,
        width: params.width,
        track: params.track,
        // As the core's contact test places the body: the overhangs split evenly.
        bodyOffset: (params.lf - params.lr) / 2,
      },
      road: samples,
      width: { left: scenario.road.width.left, right: scenario.road.width.right },
      lane: { center: scenario.lane.center, width: scenario.lane.width },
      surface: {
        base: { id: scenario.surface.base, mu: SURFACES[scenario.surface.base].mu },
        zones: scenario.surface.zones.map((z) => ({
          from: z.from,
          to: z.to,
          side: z.side ?? 'both',
          id: z.surface,
          mu: SURFACES[z.surface].mu,
        })),
      },
      obstacles: scenario.obstacles.map((o) => ({ id: o.id, kind: o.kind, length: o.length, width: o.width })),
      frame: this.layout,
    };
  }

  /** The run's metrics and fingerprints: at its end, or so far (a vehicle still on its way is `running`). */
  metrics(batch?: SessionMetrics['batch']): SessionMetrics {
    const result = this.run.result();
    const summary = (run: VehicleRun, world: VehicleWorld): VehicleSummary => ({
      end: world.end ?? 'running',
      ticks: run.ticks,
      metrics: run.metrics,
      fingerprint: vehicleFingerprint(this.scenario, run),
    });
    const ghost = this.run.ghost;
    return {
      scenario: this.scenario.id,
      seed: this.seed,
      config: this.config,
      fingerprint: result.fingerprint,
      ego: summary(result.ego, this.run.ego),
      ghost: result.ghost && ghost ? summary(result.ghost, ghost) : null,
      ...(batch && { batch }),
    };
  }
}

/** Runs a session to its end without frames (a batch run) and returns it. */
export function runSession(json: unknown, seed: number, config: Partial<SessionConfig> = {}): SimulationSession {
  const session = new SimulationSession(json, seed, config);
  while (!session.done) session.advance(1000);
  return session;
}
