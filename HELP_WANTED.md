# Help wanted

Ideas the maintainers would like help with, from a first pull request to a project of several weeks. Pick one, say so in
an issue, and we agree on the approach before you write much code: this is a small simulator with strict rules
([CONTRIBUTING.md](CONTRIBUTING.md)), and the maintainers decide what goes in. An idea here is an invitation to discuss
it, not a promise to merge it. If you work with an AI coding agent, point it to [AGENTS.md](AGENTS.md).

**Sizes.** _Small_: one focused change, a good first contribution. _Medium_: a feature inside one or two packages.
_Large_: a project across several packages, which needs a design discussion before the code. On GitHub the issues carry
the labels `good first issue` (Small) or `help wanted` (Medium and Large), the size (`size: small`, `size: medium`,
`size: large`), and `needs discussion` for a Large one.

Every item keeps the rules of CONTRIBUTING.md: a green `npm run verify`, a deterministic core, the same seed giving the
same result, interface text in the three languages, and no figure that did not come from a run.

## Large

### Run the scenarios in CARLA

[CARLA](https://carla.org) is an open-source driving simulator (version 1.0 runs on Unreal Engine 5.8) with a Python
API, a synchronous mode and scenario tooling. Build an offline bridge that drives a CARLA vehicle with this
simulator's controller and runs the four scenarios there, to see how the MPC copes with a vehicle model it was not built
for.

- A Python script in a new folder, `tools/carla/`, that talks to a CARLA server through its Python client and to this
  repository's headless runner (`packages/cli`, in Node). CARLA's synchronous mode with a 0.05 s step matches the 20 Hz
  control cycle. Mapping our commands (steering, acceleration, braking) onto CARLA's vehicle controls needs a careful
  calibration.
- An exporter from `scenarios/*.json` to a CARLA scenario. Check first what its scenario tooling supports.
- An importer that turns a CARLA run into the CSV this app already writes and reads (`packages/worker/src/csv.ts`), so
  that the report can set the two side by side.
- Done when one scenario runs end to end, and a README says which CARLA version, which hardware and which commands. The
  results are labeled as a run in CARLA and compared with tolerances, never as bit-identical.
- Keep it all outside the bundle. CARLA is heavy (for 1.0: an NVIDIA RTX 3000-series card or better with 16 GB of video
  memory, and 225 GB of disk). Its code is MIT and its assets CC-BY: copy no asset here without its attribution.

### Choose the controller

Today there is one MPC (a real-time-iteration MPC that plans candidate maneuvers and keeps the cheapest) and one
baseline. Let the user pick the controller and compare them. This is the maintainers' reading of the idea: say in the
issue if you see it differently.

- Other formulations next to the current one, not instead of it: a linear MPC with a single linearization, an LQR lane
  keeper, another horizon or other cost weights, another QP solver written in TypeScript (the bundle allows no
  WebAssembly and no GPL or LGPL code).
- A selector in the interface and a column in the report.
- Done when every controller is deterministic, runs the four scenarios through `npm run sim`, passes the scenario tests
  or says why it should not, and shows its result next to the others.
- Where to start: `packages/core/src/mpc/`, `packages/core/src/baseline/`, `packages/cli`.

### Compare experiments

A page that sets several runs side by side. A run is rebuilt from the scenario, the seed and the configuration, so it is
small to store and exact to replay.

- A history of runs kept in the browser, and nowhere else, with scenario, seed, configuration and metrics.
- A comparison page: a table of metrics and charts of two or more runs, and a link that rebuilds a run for someone
  else.
- An import of the CSV that the app exports.
- Done when a shared link reproduces the same run, and the page works with the keyboard, shows every value as text, and
  exists in the three languages.
- Where to start: `packages/app/src/sim/store.ts`, `packages/app/src/ui/Report.tsx`, `packages/worker/src/csv.ts`.

### More scenarios

A scenario is a JSON file in `scenarios/` (validated by `packages/core/src/scenario/schema.ts`), its text in the three
dictionaries and a test of the outcome it should have; the recipe is in section 8 of [AGENTS.md](AGENTS.md). Ideas: a
car cutting in at highway speed, braking on wet asphalt, a child stepping out between parked cars, a vehicle stopped just
past a blind crest, a crossing vehicle at an intersection.

- At most two critical obstacles in a scenario. A new kind of obstacle or a new vehicle is a discussion first.
- Done when `npm run sim -- --scenario <id>` prints a stable fingerprint, a test states what must happen, and the setup
  is described like the others in `scenarios/README.md`.

### Choose the sensors, and compare them

Today the vehicle has one object sensor: a fused list of tracked objects, with a period, a latency, a range and Gaussian
noise (`packages/core/src/sensors/objects.ts`). The sensors drawn on the car are illustration. Model the sensors a vehicle
could carry (camera, radar, lidar and their combinations), let the user pick them, and show how the choice changes the
result.

- Sensor presets built from **published specifications**: range, field of view, update rate, latency, noise. Every
  figure has a link to its source and the date you read it. Where a datasheet gives no number, write that and do not
  guess.
- A field of view and occlusion are new in the model: the sensor block of the scenario file and its schema grow with
  them.
- A comparison of the results across the scenarios (the worker's `runBatch` runs a list of runs).
- Done when every result is labeled as a simulated estimate from published specifications: not a measurement, not a
  test of any product, and no maker presented as a partner.

### State estimation

Today the controller is given the ego's true state. Estimate it from the noisy sensors with a Kalman filter and run the
MPC on the estimate. It pairs with the sensor item above.

- Done when the estimator is deterministic, the same seed gives the same estimate, and the report shows what the
  estimation cost in each scenario.

### A reference implementation

An offline cross-check of the solver: the same optimal-control problem in Python (CasADi or acados), with the
trajectories and the costs compared with tolerances.

- A new folder, `tools/reference/`, outside the bundle and outside the gate, with a README that says how to run it.
- Done when a document says where the two agree, where they differ and why.

### A learning-based driver

A policy trained offline in Python to imitate the MPC, and a small network that runs in TypeScript (no WebAssembly).
Compare it with the MPC and the baseline, and report honestly where it fails.

- Done when training is reproducible from a seed, the inference is deterministic, and a test pins one fingerprint.

## Medium

### Improve the graphics

The realistic scene is built from glTF models that this repository generates (`npm run models`).

- Lighting, shadows, materials, road markings, better vehicle and obstacle models, weather and night looks.
- Keep 60 fps with four horizons drawn, the low-poly scene for narrow screens, and no camera shake under
  `prefers-reduced-motion`.
- A model changes in its code under `tools/models/`, never in its file. No car maker's badge or name, and no third-party
  model or texture unless it is CC0 with its notice.
- Where to start: `tools/models/`, `packages/app/src/ui/scene3d/real/`.

### Beat the MPC: drive by hand

A mode in which you drive with the keyboard or a gamepad against the MPC and the baseline, on the same road and with the
same seed. Your inputs are part of the run's event log, so the run replays.

- Done when a run with human input replays bit-identically, and the report sets you next to the controllers.

### Explain the decision

The decision panel already shows the maneuvers the MPC weighs. A guided mode for students: why this maneuver, what each
cost means, what changes when you move the friction or the speed.

- Done when the text exists in the three languages and is read well by a screen reader.
- Where to start: `packages/app/src/ui/DecisionPanel.tsx`.

### Sweeps and a safe-speed map

Run a grid (speed by friction, or by trigger distance) in the browser and draw where each controller stops in time or
steers clear, and where it does not. Export the grid as CSV.

- Done when the map is reproducible, every cell is a run of the simulator, and it works on the mobile preset.
- Where to start: `runBatch` in `packages/worker/src/protocol.ts`.

### More surfaces and weather

Wet asphalt, snow and gravel as friction presets, with scenario variants and the matching look.

- Where to start: `packages/core/src/road/`. A new surface is a friction model checked against known braking distances.

### Benchmarks in CI

Publish the solver timings (`npm run bench:qp`) and the run fingerprints on every change, and flag a regression.

- Done when a change that slows the solver or moves a fingerprint is visible in its pull request.

## Small

### A new language

Add German, French, Portuguese or any other language you read well. The recipe is in section 8 of
[AGENTS.md](AGENTS.md), and a test fails when a key or a `{mark}` is missing.

### Imperial units

An option to show mph and feet where the interface shows km/h and meters. The core stays in SI units; the change is in
what is shown.

### A screen-reader pass

Try the simulator with a screen reader and the keyboard only, and fix what you find: the order of focus, the names of
the controls, what is announced when a run ends.

### A guide for newcomers

A short page, with a diagram, on how a run works: the packages, the worker, the tick, the seed, and where a change goes.

### Show the version

Show the version of the simulator in the interface, in a discreet line, and write it in the header of the CSV export, so
that a run says which version made it. The CSV change is a MINOR one: see [VERSIONING.md](VERSIONING.md).

## Not listed here

A new idea is welcome: open an issue with the problem, who it helps and what you would change. Keep it small enough to
review.
