/**
 * `npm run sim -- --scenario <id> --seed <n>`: a scenario run without the interface. It reads
 * scenarios/<id>.json, validates it, runs it with the controllers of sim/controllers.ts, and prints the metrics
 * of each vehicle, the decision layer's summary (switches, the maneuvers chosen over time, fallbacks), the run's
 * fingerprint, the step solver's time per QP and the ego's time per control step. The same scenario, seed and options
 * give the same fingerprint on every run (CLAUDE.md §10); the times vary, and are not part of the result.
 *
 * Options: --scenario <id> (required)  --seed <n> (default 1)  --speed <km/h> (initial and reference speed)
 *          --controller decision|stop (default decision; stop is the single-maneuver MPC of tranche 1)
 *          --out <file> (JSON report)
 */
import { readFileSync, writeFileSync } from 'node:fs';

import {
  encounterSwitches,
  maneuverChanges,
  overrideScenario,
  parseScenario,
  runScenario,
  ScenarioError,
  type RunMetrics,
  type Scenario,
  type VehicleRun,
} from '@mpc-simulator/core';

import { summarize } from './bench/stats.ts';
import { SIM_CONTROLLERS, simControllers, type SimControllerId } from './sim/controllers.ts';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  console.error(
    'Usage: npm run sim -- --scenario <id> [--seed <n>] [--speed <km/h>] [--controller decision|stop] [--out <file>]',
  );
  process.exit(1);
}

const id = option('scenario');
if (id === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(id)) fail('Missing or invalid --scenario.');
const seed = Number(option('seed') ?? 1);
if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) fail('--seed must be an unsigned 32-bit integer.');
const speedOption = option('speed');
const speedKmh = speedOption === undefined ? undefined : Number(speedOption);
if (speedKmh !== undefined && !(speedKmh > 0 && Number.isFinite(speedKmh))) fail('--speed must be positive, km/h.');
const out = option('out');
const controllerOption = option('controller') ?? 'decision';
if (!(SIM_CONTROLLERS as readonly string[]).includes(controllerOption)) fail('--controller must be decision or stop.');
const controller = controllerOption as SimControllerId;

const file = new URL(`../../../scenarios/${id}.json`, import.meta.url);
let json: unknown;
try {
  json = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  fail(`Cannot read scenarios/${id}.json: ${(error as Error).message}`);
}
function load(): Scenario {
  try {
    const parsed = parseScenario(json);
    return speedKmh === undefined ? parsed : overrideScenario(parsed, { speedKmh });
  } catch (error) {
    if (error instanceof ScenarioError) fail(`scenarios/${id}.json: ${error.message}`);
    throw error;
  }
}
const scenario = load();

const controllers = simControllers({ controller, velocityNoise: scenario.sensor.noise.velocity });
const wall = performance.now();
const result = runScenario(scenario, { seed, ego: controllers.ego, ghost: controllers.ghost });
const wallMs = performance.now() - wall;

const DEG = 180 / Math.PI;
const fixed = (v: number | null, digits: number, unit: string) => (v === null ? '-' : `${v.toFixed(digits)} ${unit}`);
function report(name: string, run: VehicleRun): void {
  const m: RunMetrics = run.metrics;
  console.log(`${name}: end ${run.end} at ${m.duration.toFixed(3)} s (tick ${run.ticks})`);
  const rows: [string, string][] = [
    [
      'collision',
      m.collided
        ? `${m.collisionObstacle}, ${(m.impactSpeed ?? 0) < 0 ? 'struck from behind' : 'closing'} ` +
          `${fixed(Math.abs(m.impactSpeed ?? 0) * 3.6, 1, 'km/h')} (ego ${fixed((m.egoImpactSpeed ?? 0) * 3.6, 1, 'km/h')})`
        : 'none',
    ],
    ['min TTC', fixed(m.minTtc, 2, 's')],
    ['stopping distance', fixed(m.stoppingDistance, 2, 'm')],
    ['max lateral deviation', fixed(m.maxLateralDeviation, 2, 'm')],
    ['peak lateral accel', `${fixed(m.peakLateralAccel, 2, 'm/s²')} (${(m.peakLateralAccel / 9.81).toFixed(2)} g)`],
    ['max sideslip |β|', fixed(m.maxSideslip * DEG, 2, '°')],
    ['final speed', fixed(m.finalSpeed * 3.6, 1, 'km/h')],
    ['distance', fixed(m.distance, 1, 'm')],
  ];
  for (const [label, value] of rows) console.log(`  ${label.padEnd(22)} ${value}`);
}

/**
 * The decision layer's run: events, switches (in all, and the most per encounter with one obstacle, core
 * encounterSwitches), the changes of the maneuver in force (returns to B0 included), the maneuvers chosen over time
 * and the fallback cycles.
 */
function decisionSummary() {
  const decisions = controllers.decisions;
  const timeline: { t: number; chosen: string; reason: string }[] = [];
  let events = 0;
  let switches = 0;
  let inEvent = false;
  const fallbacks = { noFeasible: 0, solverFailed: 0 };
  for (const d of decisions) {
    if (d.event && !inEvent) events++;
    inEvent = d.event;
    if (d.switched) switches++;
    if (d.fallback !== 'none') fallbacks[d.fallback]++;
    if (timeline.at(-1)?.chosen !== d.chosen) timeline.push({ t: d.tick / 1000, chosen: d.chosen, reason: d.reason });
  }
  const maxSwitchesPerEncounter = Math.max(0, ...encounterSwitches(decisions).values());
  const changes = maneuverChanges(decisions);
  return { cycles: decisions.length, events, switches, maxSwitchesPerEncounter, changes, fallbacks, timeline };
}

console.log(`Scenario ${scenario.id}, seed ${seed}, ${(scenario.speed.initial * 3.6).toFixed(1)} km/h (simulation)`);
console.log(
  `ego controller: ${controller === 'decision' ? 'MPC with the decision layer' : 'MPC, one maneuver (stop)'}`,
);
report('ego', result.ego);
if (result.ghost) report('ghost', result.ghost);
const decision = controller === 'decision' ? decisionSummary() : null;
if (decision) {
  console.log(
    `decisions: ${decision.cycles} cycles, ${decision.events} events, ${decision.switches} switches ` +
      `(at most ${decision.maxSwitchesPerEncounter} per encounter), ${decision.changes} maneuver changes ` +
      `(returns to the lane included, the last aside), fallback cycles: no feasible candidate ` +
      `${decision.fallbacks.noFeasible}, solver failed ${decision.fallbacks.solverFailed}`,
  );
  const steps = decision.timeline.map((e) => `${e.t.toFixed(2)} s ${e.chosen} (${e.reason})`);
  console.log(`  chosen over time: ${steps.join(' > ')}`);
}
const solve = summarize(controllers.solveMs);
const step = summarize(controllers.stepMs);
const ms = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '-');
const qps = controllers.solveMs.length;
console.log(`step solver: ${qps} QPs, p50 ${ms(solve.p50)} ms, p95 ${ms(solve.p95)} ms, max ${ms(solve.max)} ms`);
console.log(
  `control step: ${controllers.stepMs.length} steps, p50 ${ms(step.p50)} ms, p95 ${ms(step.p95)} ms, ` +
    `max ${ms(step.max)} ms, at most ${Math.max(0, ...controllers.stepQps)} QPs per step`,
);
console.log(`wall time ${wallMs.toFixed(0)} ms`);
console.log(`fingerprint ${result.fingerprint}`);

if (out !== undefined) {
  const vehicle = (run: VehicleRun) => ({ end: run.end, ticks: run.ticks, events: run.events, metrics: run.metrics });
  const report = {
    scenario: scenario.id,
    seed,
    speedKmh: scenario.speed.initial * 3.6,
    fingerprint: result.fingerprint,
    ego: vehicle(result.ego),
    ghost: result.ghost ? vehicle(result.ghost) : null,
    controller,
    decision,
    solver: { qps: controllers.solveMs.length, p50Ms: solve.p50, p95Ms: solve.p95, maxMs: solve.max },
    step: {
      steps: controllers.stepMs.length,
      p50Ms: step.p50,
      p95Ms: step.p95,
      maxMs: step.max,
      maxQps: Math.max(0, ...controllers.stepQps),
    },
  };
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report written to ${out}`);
}
