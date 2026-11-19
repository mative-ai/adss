# AGENTS.md

Guidance for AI coding agents, and for the people who run them from a command-line console (Claude Code, Codex CLI,
Gemini CLI, OpenCode and the like). A tool that reads `AGENTS.md` gets the rules here; section 9 says what to do for one
that does not. What the project is and how to run it is in `README.md`, how to contribute (what is in scope, pull
requests, the license of a contribution) is in `CONTRIBUTING.md`, and ideas to pick up are in `HELP_WANTED.md`. The
numbers of the sections below are cited by comments in the code and stay as they are.

## At a glance

The repository is an npm workspace (`packages/core`, `worker`, `app`, `cli`) with one gate, `npm run verify`, the CI in
`.github/workflows/verify.yml` and the boundary probes in `tools/boundaries/`. Node is `^22.18` or `24`: the sources run
with type stripping, and imports carry their `.ts` extension.

| Command                                         | What it does                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `npm ci`                                        | Installs the dependencies.                                            |
| `npm run dev`                                   | The development server: opens the simulator.                          |
| `npx vitest run <file>`                         | One test file. Run a focused test first.                              |
| `npm run verify`                                | The gate: types, lint, Prettier, package boundaries, tests (minutes). |
| `npm run build`                                 | The production build of the app. Run it after a change to the app.    |
| `npm run sim -- --scenario pedestrian --seed 1` | A headless run: prints the result and its fingerprint.                |
| `npm run bench:qp`                              | The quadratic-programming solver benchmark, in Node.                  |
| `npm run models`                                | Rebuilds the glTF models of the 3D scene (`tools/models`).            |

Comments in the code mention the phases the simulator was built in. Phase 1 is the vehicle, the road and the world in
`packages/core`, with the golden trajectory hash in `packages/core/test/golden.test.ts`; Phase 2, the RTI-MPC and the QP
solver, with `npm run bench:qp` in Node (the go/no-go runs in a Chrome worker: `/bench.html`); Phase 3, the four
scenarios in `scenarios/`, the baseline ghost, the MPC's constraints and decision layer, and `npm run sim`; Phase 4, the
simulation in a Web Worker and the interface in `packages/app`; Phase 8, the realistic 3D scene in
`packages/app/src/ui/scene3d/real/`, with glTF models built by `npm run models`. The milestones (M0 to M8) are the
acceptance checks of those phases: section 6 says how each one is checked.

## 1. Working rules

- Everything you write is in English: code, comments, commit messages and pull request text. The interface copy is in
  all three languages (section 4). Commit messages are Conventional Commits, with the package or area as scope
  (`feat(core): …`, `fix(mpc): …`, `feat(app): …`): the subject says what changed in the simulator's behavior.
- Before a substantial task: check `git status`, read `README.md`, `CONTRIBUTING.md` and the code the task touches,
  preserve valid local work, implement only the requested scope.
- The scope is the four scenarios (pedestrian crossing, moose test, curve with an ice patch, μ-split braking), at most 2
  critical obstacles, and the rigid truck. More scenarios, vehicles or kinds of obstacle start only after a discussion
  in an issue. So does a new dependency, a change to the MPC, the QP solver or the vehicle model, and a change to the
  worker protocol.
- Explore with targeted reads and greps. Never read `package-lock.json`, `node_modules/`, `dist/`, `coverage/`,
  `*.tsbuildinfo`, `playwright-report/`, `test-results/` or binary assets (fonts, textures, models). Golden files and
  the recorded-QP corpus are large: never read them whole; read their schema or one case, or compare them with the CLI.
- Work on a branch (`feat/…` or `fix/…`). Never push, merge, rebase, force-push, `git reset --hard` or `git clean`
  unless the person you work for asked, never discard work you did not make, and commit only when asked.
- A check that fails is not loosened to pass. The guards of the core (`.dependency-cruiser.cjs`, the
  `mpc/core-determinism` block of `eslint.config.mjs`, `tools/boundaries/`), the response headers
  (`deploy/security-headers.conf`, only together with its test) and the golden values change only with a stated reason.
- Do not change the version or tag a release. For a change that a user can see, add a line under `Unreleased` in
  `CHANGELOG.md`, and say in the pull request when the change touches the contract (`VERSIONING.md`).
- Browser automation tools leave screenshots and snapshots in their own folder (Playwright's MCP writes to
  `.playwright-mcp/`): delete them when done, never commit them.

## 2. Priorities

In order: correctness of physics and control, determinism, truth of content, security, privacy, accessibility,
performance, i18n parity across it/en/es, maintainability, speed. Never trade correctness or determinism for frame
rate: on a slow device the real-time factor drops, never the correctness of the result. Never invent a figure,
certification, capability or benchmark result.

## 3. Secrets and personal data

The simulator is a static site: everything in its bundle is readable by anyone. Never print or commit a secret: none in
replies, summaries, tool output, files, diffs, commit or pull request text, or logs. Refer to a secret by its variable
name.

- Vite publishes every `VITE_` variable in the browser bundle: never put a secret in one.
- The simulator receives no personal data. `localStorage` holds only the visitor's theme choice (`mpc-theme`). No
  cookies, analytics or tracking.
- No internal endpoint or private data goes in the bundle.

## 4. Content and claims

- Copy lives in typed dictionaries for it, en and es; the language comes from `?lng=` or the browser, and English is the
  default. Every key exists in all three languages, actually translated, in the same change.
- The simulator states that it is an educational simulation, not for homologation, in every language. Simulated data and
  results are labeled as a simulation.
- Publish only claims and figures that the repository proves: a number shown as a result comes from a run of the
  simulator. Never present the simulator as a certified or production system.
- The license notices the bundled libraries require stay as the licenses require: the build writes them to
  `third-party-licenses.txt`, and what no package carries is in `packages/app/public/third-party-notices.txt`
  (QuadProg++ in full, no third-party model or texture). A new library or asset adds its notice in the same change.

## 5. Architecture boundaries and determinism

- `packages/core` is the pure TypeScript simulation (`math/`, `vehicle/`, `road/`, `world/`, `sensors/`, `mpc/`, `qp/`,
  `baseline/`, `sim/`, `scenario/`). Its lib is ES2022 without `DOM` and `zod` is its only dependency: no `window` or
  `document`, no import of `three` or `react`. Three guards enforce it: the core's tsconfig, the `mpc/core-determinism`
  block of `eslint.config.mjs` and `.dependency-cruiser.cjs` (`npm run check:boundaries`). The probes in
  `tools/boundaries/` prove that each still fires (M0): never loosen a guard to make a probe pass.
- `packages/worker` is the `postMessage` adapter, the pacing and the buffer pool. `packages/cli` runs headless in Node:
  sweeps, the solver benchmark, golden comparisons. `scenarios/*.json` are validated with zod.
- `tools/models/` builds the glTF models of the realistic scene into `packages/app/src/assets/models/`
  (`npm run models`). A model changes in its code, never in its file: run the command after the change and commit the
  files with it (a test fails when the two differ). The app replaces a model's materials by their names and moves its
  named nodes: keep both when a model is replaced by a more detailed one. The only name on a model is Mative's, on the
  MPC's car (its wordmark and the sensor kit, in the nodes `livery` and `sensors`): never a car maker's badge, name or
  grille, nor any other company's mark, and no maker or model is named in the code.
- `deploy/` and the `Dockerfile` serve the build with an unprivileged nginx. The response headers and the
  Content-Security-Policy are in `deploy/security-headers.conf`, and `tools/deploy/headers.test.ts` guards them: no
  inline script, no `eval`, no WebAssembly, nothing but the page's own origin, no query string in a log. Change a header
  together with its test, and write a script the page needs as a file of its own (`packages/app/public/theme-init.js`).
- `packages/app` (Vite, React 19, Tailwind 4, Three.js, uPlot, Canvas 2D mini-map) only renders and sends commands: it
  never computes physics or control. Every screen covers five states: loading, empty, error, partial, success. UI work
  can start on a mock worker that runs only the baseline controller.
- SI units inside `core` (m, s, kg, rad, N); km/h, degrees and g appear only where values are shown.
- Time is an integer tick at 1 kHz; never accumulate time in floats. Physics runs at 1 kHz, the IMU at 100 Hz, objects
  and MPC at 20 Hz, frames to the main thread at about 60 Hz.
- Randomness comes only from seeded PRNG streams (`Prng.create(seed, stream)`, xoshiro128\*\*), one per purpose. Never
  `Math.random`, `Date.now`, `performance.now` or `new Date()` in `core`.
- The solver stops on an iteration cap, never on a time budget. The computation delay the MPC compensates is a
  configuration parameter, never a measured time. Measured time may change the pacing (real-time factor, automatic slow
  motion), never the simulated result.
- A run is rebuilt from scenario, seed, configuration and event log, and replays bit-identical in the same engine (M6);
  comparisons across Chrome, Safari and Firefox use tolerances. Everything that changes the result (horizon, maneuvers,
  the mobile preset with N = 20 and 3 maneuvers, delays, noise) is configuration recorded with the run. The ghost
  baseline runs in lockstep with the same seed.
- The worker protocol is typed and versioned: `init`, `control`, `setSpeed`, `setParams`, `runBatch`, `exportCsv`,
  `returnBuffer` in; `ready`, `frame`, `decision`, `event`, `metrics`, `csv`, `error` out. Frames travel as transferred
  `Float64Array` buffers and come back with `returnBuffer`. A protocol change updates both sides and the version in the
  same change.
- The decisions that shape the simulator (the RTI-MPC, the QP solver, the vehicle model) change only after a discussion
  in an issue. Candidate maneuvers are compared on the common decision cost of their nonlinear rollout, never on raw QP
  costs. No GPL or LGPL solver goes in the bundle.

## 6. Validation

The gate is `npm run verify`: TypeScript without errors in every package, ESLint, Prettier, dependency-cruiser
(`npm run check:boundaries`) and `npm test` (Vitest, including the M0 probes). CI runs it and then `npm run build`. Run
focused tests first (`npx vitest run <file>`), then the gate, in the background if your tool allows it: it takes a few
minutes. By area:

- `vehicle/` and `road/`: the analytic M1 tests (braking distance, understeer gradient, standstill, no NaN on random
  commands, same seed same hash, at least 50 times real time in Node).
- `qp/` and `mpc/`: solver agreement (M2), Jacobians against finite differences and the moose test (M3), the scenario
  criteria (M4, M5), and `npm run bench:qp` for the solver in Node. The go/no-go is decided in a Chrome worker on a
  reference laptop (`npm run dev`, then `/bench.html`): p95 of a full step ≤ 20 ms, p99 ≤ 35 ms, iteration cap hit in
  ≤ 0.5 % of QPs, chosen maneuver equal to the reference at the same state in ≥ 99.5 % of steps. Node timings alone
  never decide it.
- Determinism: `npm run sim -- --scenario pedestrian --seed 1` gives the same hash on every run; live run and replay
  are bit-identical (M6); the CSV export reloads without loss and the ghost hash matches (M8). Compare the fingerprint
  before and after your change: if it moved, say why.
- UI: `npm run dev`, then a browser, driven by hand or by an automation tool, in light and dark, at 1440 and 390 px:
  every scenario up to the report, keyboard (Space, R, arrows), `prefers-reduced-motion` (no camera shake, top view by
  default), values also in text, every language whose copy changed. Then a performance trace: 60 fps with 4 horizons
  drawn (M7), no main-thread task above 50 ms, initial resources under 2 MB, Three.js loaded only with the 3D scene.

A golden file changes only with a stated reason, never to make a failing test pass. Code that compiles is not done.
Inspect the final diff.

## 7. Done means

The requested behavior exists, relevant checks pass, the same seed gives the same hash on every run and every golden
hash that changed has its reason stated, no known regression remains in other scenarios or packages, configuration is
documented, integration assumptions are verified, the diff is inspected and no unrelated work was discarded. If
something is unfinished, say what remains, why, what was verified and what manual action is needed.

## 8. Recipes

**Add a scenario** (discuss it in an issue first):

1. Write `scenarios/<id>.json`, validated by `parseScenario` in `packages/core/src/scenario/schema.ts`. Copy an existing
   file and read `scenarios/README.md`: speeds in km/h, everything else in SI units, the file holds ids and no copy, at
   most two critical obstacles.
2. Register it in `packages/app/src/sim/scenarios.ts`, and write its title and its description in the three dictionaries
   (`packages/app/src/i18n/en.ts`, `it.ts`, `es.ts`; `types.ts` lists the keys).
3. If the solver benchmarks should sweep it, add its id to `ScenarioId` in `packages/cli/src/bench/scenarioCorpus.ts`.
4. State the outcome it must have in a test, like the tests that already cover the four (`packages/core/test/`), check
   that `npm run sim -- --scenario <id> --seed 1` prints a stable fingerprint, and add it to the README's table.

**Add a language:** add its code to `LANGUAGES` in `packages/app/src/i18n/types.ts`, write its dictionary in a new file
next to `en.ts` (the type `Dictionary` lists every key), and register it in `DICTIONARIES` in
`packages/app/src/i18n/index.ts`. `i18n.test.ts` fails when a language lacks a key or a `{mark}`.

**Change a 3D model:** change its code under `tools/models/`, run `npm run models`, commit the files the command writes.
Keep the material names and the named nodes.

**Change the worker protocol:** update both sides and the version in `packages/worker/src/protocol.ts` in the same
commit, with a test.

**Change a response header:** edit `deploy/security-headers.conf` and `tools/deploy/headers.test.ts` together.

**Add a dependency:** only after a discussion; none under a GPL or LGPL license in the bundle (MIT, BSD, Apache-2.0 and
OFL are fine); its notice goes to `packages/app/public/third-party-notices.txt` in the same change.

## 9. Using this file with your tool

`AGENTS.md` is a plain Markdown convention that many coding agents read when they start in a repository. If yours looks
for a file of another name, point it here rather than copying the rules, so that there is one copy to keep true. For
Claude Code, which reads `CLAUDE.md`, create that file in your own checkout with one line, `@AGENTS.md`, and do not
commit it. Some tools take a setting for the file name instead of a file: follow their documentation.

When a task is unclear, ask the person you work for, or read `CONTRIBUTING.md` and open an issue, before you write
code that cannot be merged.
