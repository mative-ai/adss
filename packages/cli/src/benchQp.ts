/**
 * `npm run bench:qp`: the solver benchmark, in Node. It records the corpus (bench/corpus.ts: the
 * moose runs and the v1 scenario runs of bench/scenarioCorpus.ts), prints its fingerprint, measures each candidate
 * on it (bench/measure.ts), then drives every run again with the candidate as the MPC's step solver: the
 * closed-loop check, where the plans the candidate returns are the ones the car follows. On the moose runs it
 * compares the cones; on the scenario runs it compares the outcome with the exact solver's run (collision, impact
 * speed, lateral deviation) and says which runs stay bit-identical. Node timings show the direction; the go/no-go
 * at the end of M5 runs in a Chrome worker on the reference laptop (AGENTS.md §6).
 *
 * The scenario runs include the decision layer of Phase 3 (bench/scenarioCorpus.ts): up to 4 candidate maneuvers'
 * QPs per step, one stream each, with each candidate's cold starts recorded as resets.
 *
 * Options: --corpus moose|scenarios|all (default all: the go/no-go needs at least 5000 QPs, the moose runs alone
 *          have fewer)  --candidates a,b (default: all)  --runs name,… (default: all of the chosen corpus)
 *          --passes 3  --no-closed-loop  --out report.json
 */
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';

import type { StepSolver } from '@mpc-simulator/core';

import { CORPUS_RUNS, drive, M3_RUN, recordCorpus, type CorpusChoice } from './bench/corpus.ts';
import { ACCEL_TOLERANCE, measure, STEER_TOLERANCE, type Measure, type Summaries } from './bench/measure.ts';
import { CANDIDATES } from './bench/registry.ts';
import { driveScenario, SCENARIO_CASES } from './bench/scenarioCorpus.ts';
import { summarize, type Summary } from './bench/stats.ts';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const list = (value: string | undefined) => value?.split(',').filter((v) => v.length > 0);

const CHOICES: readonly CorpusChoice[] = ['moose', 'scenarios', 'all'];
const choiceOption = option('corpus') ?? 'all';
const choice = CHOICES.find((c) => c === choiceOption);
const passes = Number(option('passes') ?? 3);
const runNames = list(option('runs'));
const candidateNames = list(option('candidates'));
const closedLoop = !process.argv.includes('--no-closed-loop');
const out = option('out');

const candidates = candidateNames ? CANDIDATES.filter((c) => candidateNames.includes(c.name)) : CANDIDATES;
const unknown = (candidateNames ?? []).filter((name) => !CANDIDATES.some((c) => c.name === name));
const knownRuns = [...CORPUS_RUNS.map((r) => r.name), ...SCENARIO_CASES.map((c) => c.name)];
const unknownRuns = (runNames ?? []).filter((name) => !knownRuns.includes(name));
if (!choice || unknown.length > 0 || unknownRuns.length > 0 || candidates.length === 0 || !(passes >= 1)) {
  console.error(`--corpus: ${CHOICES.join(' | ')}. Unknown candidates: ${unknown.join(', ') || '-'}.`);
  console.error(`Known candidates: ${CANDIDATES.map((c) => c.name).join(', ')}`);
  console.error(`Unknown runs: ${unknownRuns.join(', ') || '-'}. Known runs: ${knownRuns.join(', ')}`);
  process.exit(1);
}

const ms = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '-');
const sci = (v: number) => (Number.isFinite(v) ? v.toExponential(1) : '-');
const pct = (v: number) => `${(100 * v).toFixed(1)}%`;
const kmh = (v: number | null) => (v === null ? '-' : `${(Math.abs(v) * 3.6).toFixed(1)} km/h`);
const fourWay = (s: Summary, f: (v: number) => string) => `${f(s.p50)} / ${f(s.p95)} / ${f(s.p99)} / ${f(s.max)}`;

console.log(`Recording the ${choice} corpus with the exact solver (gi-condensed)…`);
const corpus = recordCorpus({ choice, ...(runNames ? { names: runNames } : {}) });
if (corpus.runs.length === 0) {
  console.error(`No run of the ${choice} corpus is in --runs.`);
  process.exit(1);
}
const obstacleQps = corpus.runs.reduce((sum, r) => sum + r.obstacleQps, 0);
const resets = corpus.runs.reduce((sum, r) => sum + r.resets, 0);
console.log(
  `${corpus.steps.length} QPs (${corpus.uniqueQps} distinct) in ${corpus.runs.length} runs, ${obstacleQps} with ` +
    `obstacle rows, ${resets} after a solver reset; corpus fingerprint ${corpus.fingerprint}`,
);
for (const names of corpus.duplicateRuns) console.log(`  warning: these runs record the same QPs: ${names.join(', ')}`);
for (const d of corpus.moose) {
  console.log(
    `  ${d.run.name.padEnd(28)} ${String(d.ocps.length).padStart(4)} QPs, worst outside ${ms(d.worstOutside)} m`,
  );
}
corpus.scenarios.forEach((d) => {
  const run = corpus.runs.find((r) => r.name === d.run.name);
  const outcome = d.metrics.collided
    ? `collision ${d.metrics.collisionObstacle} ${kmh(d.metrics.impactSpeed)}`
    : 'none';
  console.log(
    `  ${d.run.name.padEnd(28)} ${String(run?.qps ?? 0).padStart(4)} QPs (${run?.obstacleQps ?? 0} obstacle, ` +
      `${run?.resets ?? 0} reset), ` +
      `end ${d.end}, ${outcome}, max lateral deviation ${ms(d.metrics.maxLateralDeviation)} m`,
  );
});

interface MooseLoop {
  /** Worst distance outside the cones per run, m. */
  readonly worstOutside: Record<string, number>;
  /** Runs where the exact solver keeps every cone up and this candidate does not. */
  readonly conesDown: string[];
  /**
   * Runs where the body went more than 1 cm farther outside than with the exact solver. On runs the exact solver
   * fails too, the course is beyond the car's grip and the outcome is sensitive to rounding: read these with the
   * distances, not as a verdict.
   */
  readonly worseThanExact: string[];
  readonly m3Clean: boolean;
}

interface ScenarioLoop {
  /** Runs whose collision outcome (collided or not, which obstacle, end) differs from the exact solver's. */
  readonly outcomeChanged: string[];
  /** Runs whose fingerprint equals the exact solver's: the same trajectory to the bit. */
  readonly bitIdentical: number;
  /** Largest |Δ impact speed| over the runs where both collide, m/s. */
  readonly maxImpactSpeedDelta: number;
  /** Largest |Δ max lateral deviation|, m. */
  readonly maxLateralDelta: number;
  /** The run of the largest |Δ max lateral deviation|. */
  readonly maxLateralDeltaRun: string;
}

interface ClosedLoop {
  readonly moose?: MooseLoop;
  readonly scenarios?: ScenarioLoop;
  /** Whole controller step (state prediction, rollout, linearization, QP, solve, final rollout), ms. */
  readonly stepMs: Summary;
  readonly solveMs: Summary;
  readonly scenarioStepMs?: Summary;
}

function closedLoopCheck(create: () => StepSolver): ClosedLoop {
  const stepMs: number[] = [];
  const solveMs: number[] = [];
  let moose: MooseLoop | undefined;
  let scenarios: ScenarioLoop | undefined;
  if (corpus.moose.length > 0) {
    const drives = corpus.moose.map((d) => drive(d.run, create()));
    const worstOutside = Object.fromEntries(drives.map((d) => [d.run.name, d.worstOutside]));
    const exactOutside = (i: number) => corpus.moose[i]?.worstOutside ?? 0;
    moose = {
      worstOutside,
      conesDown: drives.filter((d, i) => exactOutside(i) === 0 && d.worstOutside > 0).map((d) => d.run.name),
      worseThanExact: drives.filter((d, i) => d.worstOutside > exactOutside(i) + 0.01).map((d) => d.run.name),
      m3Clean: (worstOutside[M3_RUN.name] ?? 0) === 0,
    };
    for (const d of drives) {
      stepMs.push(...d.stepMs);
      solveMs.push(...d.solveMs);
    }
  }
  let scenarioStepMs: Summary | undefined;
  if (corpus.scenarios.length > 0) {
    const drives = corpus.scenarios.map((exact) => ({ exact, own: driveScenario(exact.run, create) }));
    const outcomeChanged = drives
      .filter(({ exact, own }) => {
        const a = exact.metrics;
        const b = own.metrics;
        return exact.end !== own.end || a.collided !== b.collided || a.collisionObstacle !== b.collisionObstacle;
      })
      .map(({ exact }) => exact.run.name);
    let maxImpactSpeedDelta = 0;
    let maxLateralDelta = 0;
    let maxLateralDeltaRun = '-';
    for (const { exact, own } of drives) {
      const a = exact.metrics;
      const b = own.metrics;
      if (a.impactSpeed !== null && b.impactSpeed !== null) {
        maxImpactSpeedDelta = Math.max(maxImpactSpeedDelta, Math.abs(a.impactSpeed - b.impactSpeed));
      }
      const lateral = Math.abs(a.maxLateralDeviation - b.maxLateralDeviation);
      if (lateral > maxLateralDelta) {
        maxLateralDelta = lateral;
        maxLateralDeltaRun = exact.run.name;
      }
    }
    scenarios = {
      outcomeChanged,
      bitIdentical: drives.filter(({ exact, own }) => exact.fingerprint === own.fingerprint).length,
      maxImpactSpeedDelta,
      maxLateralDelta,
      maxLateralDeltaRun,
    };
    const scenarioSteps = drives.flatMap(({ own }) => own.stepMs);
    scenarioStepMs = summarize(scenarioSteps);
    stepMs.push(...scenarioSteps);
    for (const { own } of drives) solveMs.push(...own.solveMs);
  }
  return {
    ...(moose ? { moose } : {}),
    ...(scenarios ? { scenarios } : {}),
    stepMs: summarize(stepMs),
    solveMs: summarize(solveMs),
    ...(scenarioStepMs ? { scenarioStepMs } : {}),
  };
}

function printSummaries(label: string, s: Summaries): void {
  console.log(`  ${label}`);
  console.log(`    QP ms p50/p95/p99/max   ${fourWay(s.timeMs, ms)} over ${s.qps} QPs`);
  console.log(`    iterations              ${fourWay(s.iterations, String)}, capped ${pct(s.capped)}`);
  console.log(`    first-command error     steer ${fourWay(s.steerError, sci)} rad`);
  console.log(`                            accel ${fourWay(s.accelError, sci)} m/s²`);
  console.log(`    whole-plan error        steer ${fourWay(s.planSteerError, sci)} rad`);
  console.log(`                            accel ${fourWay(s.planAccelError, sci)} m/s²`);
  console.log(`    off (> ${STEER_TOLERANCE} rad or > ${ACCEL_TOLERANCE} m/s²) ${pct(s.off)}, failed ${s.failed}`);
}

interface Report extends Measure {
  readonly closedLoop?: ClosedLoop;
}

const reports: Report[] = [];
for (const candidate of candidates) {
  console.log(`\nMeasuring ${candidate.name}: ${candidate.note}`);
  const result = measure(candidate, corpus, passes);
  const loop = closedLoop ? closedLoopCheck(() => candidate.create()) : undefined;
  reports.push({ ...result, ...(loop ? { closedLoop: loop } : {}) });
  printSummaries(`${choice}, deterministic ${result.deterministic ? 'yes' : 'NO'}`, result);
  for (const [source, s] of Object.entries(result.bySource ?? {})) printSummaries(source, s);
  if (loop) {
    console.log(`  closed loop: step ms p50/p95/p99/max ${fourWay(loop.stepMs, ms)}`);
    if (loop.scenarioStepMs) console.log(`    scenario runs' step ms    ${fourWay(loop.scenarioStepMs, ms)}`);
    const m = loop.moose;
    if (m) {
      console.log(
        `    moose: M3 ${m.m3Clean ? 'clean' : 'CONES DOWN'}, cones down where exact is clean: ` +
          `${m.conesDown.join(', ') || 'none'}`,
      );
      const distances = corpus.moose.map(
        (d) => `${d.run.name} ${ms(m.worstOutside[d.run.name] ?? 0)} (exact ${ms(d.worstOutside)})`,
      );
      console.log(`    worst outside, m: ${distances.join(', ')}`);
      console.log(`    more than 1 cm farther outside than exact: ${m.worseThanExact.join(', ') || 'none'}`);
    }
    const s = loop.scenarios;
    if (s) {
      console.log(
        `    scenarios: outcome changed ${s.outcomeChanged.join(', ') || 'none'}; bit-identical to exact ` +
          `${s.bitIdentical}/${corpus.scenarios.length}; max |Δ impact speed| ${kmh(s.maxImpactSpeedDelta)}, ` +
          `max |Δ lateral deviation| ${ms(s.maxLateralDelta)} m (${s.maxLateralDeltaRun})`,
      );
    }
  }
}

console.log(
  `\n${choice} corpus, ${corpus.steps.length} QPs, fingerprint ${corpus.fingerprint}, ${passes} passes` +
    '\n| candidate | QP ms p50 / p95 / p99 / max | iterations p50 / p95 / max | capped | off | plan error p99 ' +
    '(rad, m/s²) | deterministic | step ms p95 / p99 | M3 | scenario outcome changed |',
);
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of reports) {
  const it = `${r.iterations.p50} / ${r.iterations.p95} / ${r.iterations.max}`;
  const plan = `${sci(r.planSteerError.p99)}, ${sci(r.planAccelError.p99)}`;
  const loop = r.closedLoop;
  const step = loop ? `${ms(loop.stepMs.p95)} / ${ms(loop.stepMs.p99)}` : '-';
  const m3 = loop?.moose ? (loop.moose.m3Clean ? 'clean' : 'cones down') : '-';
  const changed = loop?.scenarios ? loop.scenarios.outcomeChanged.join(', ') || 'none' : '-';
  console.log(
    `| ${r.name} | ${fourWay(r.timeMs, ms)} | ${it} | ${pct(r.capped)} | ${pct(r.off)} | ${plan} | ` +
      `${r.deterministic ? 'yes' : 'no'} | ${step} | ${m3} | ${changed} |`,
  );
}
console.log(
  'The decision runs solve up to 4 candidate maneuvers per step. The chosen-maneuver agreement of the go/no-go' +
    ' is measured by the Chrome-worker run: `npm run dev`, then /bench.html.',
);

if (out) {
  const report = {
    config: { corpus: choice, passes, runs: corpus.runs.map((r) => r.name), closedLoop },
    environment: { node: process.version, cpu: cpus()[0]?.model ?? 'unknown', date: new Date().toISOString() },
    corpus: {
      fingerprint: corpus.fingerprint,
      qps: corpus.steps.length,
      uniqueQps: corpus.uniqueQps,
      resets,
      duplicateRuns: corpus.duplicateRuns,
      runs: corpus.runs,
      moose: corpus.moose.map((d) => ({ run: d.run.name, exactWorstOutside: d.worstOutside })),
      scenarios: corpus.scenarios.map((d) => ({
        run: d.run.name,
        controller: d.run.controller,
        end: d.end,
        fingerprint: d.fingerprint,
        collided: d.metrics.collided,
        impactSpeed: d.metrics.impactSpeed,
        maxLateralDeviation: d.metrics.maxLateralDeviation,
      })),
    },
    tolerances: { steer: STEER_TOLERANCE, accel: ACCEL_TOLERANCE },
    candidates: reports,
  };
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nReport written to ${out}`);
}
