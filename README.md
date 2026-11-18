# Mative MPC Simulator

An interactive driving simulation that runs entirely in the browser. A virtual vehicle is driven by a model predictive
controller (MPC) through four emergency scenarios, and its run is shown next to a simpler baseline controller, on the
same road and with the same random seed.

> **Educational simulation, not for homologation** (_simulazione didattica, non omologativa_). It shows how a
> controller reasons in a critical situation. It is not a certified or a production system, and the figures it shows
> describe the simulated vehicle only.

## The scenarios

| Scenario            | What happens                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Pedestrian crossing | At 50 km/h on dry asphalt, a pedestrian crosses the road 20 m ahead.                                   |
| Moose test          | At 60 km/h on dry asphalt, a moose leaves the roadside 20 m ahead and stops in the lane.               |
| Curve with ice      | At 70 km/h in a left curve, a patch of ice (friction μ 0.1) lies in the bend.                          |
| μ-split braking     | At 80 km/h, the left wheels are on ice and the right ones on dry asphalt. A stopped car is 60 m ahead. |

Each run ends with a report that sets the MPC against the baseline. Every figure in it comes from the run.

## How it works

- **The vehicle** has a tire model, actuators and a road with variable friction ([ADR 0005](docs/adr/0005-vehicle-model.md)).
- **The controller** is a real-time-iteration MPC ([ADR 0001](docs/adr/0001-rti-mpc.md)). It plans several candidate
  maneuvers, checks each on a nonlinear rollout and keeps the one with the lowest common cost. Its quadratic-programming
  solvers are written in TypeScript, with no WebAssembly ([ADR 0002](docs/adr/0002-qp-solver-admm.md)).
- **The baseline** runs in lockstep, with the same seed, so the two runs can be compared sample by sample.
- **The simulation is deterministic.** Time is an integer tick at 1 kHz, randomness comes from seeded generators, and a
  run is rebuilt from the scenario, the seed and the configuration. A timing measured in the browser can slow a run
  down, never change its result.
- **The simulation runs in a Web Worker** ([ADR 0006](docs/adr/0006-runtime-worker.md)). The app only draws and sends
  commands: it never computes physics or control.
- **The view** is a 3D scene (Three.js) with a mini-map, a top view, and live charts (uPlot). From 1024 px of width the
  scene is realistic, with glTF models that this repository generates (`npm run models`); on a narrower screen, or when
  the GPU cannot keep up, it is a low-poly one.
- **The interface** is in Italian, English and Spanish, in a light or a dark theme: the system's, unless the visitor picks
  one with the switch in the navbar.

## Repository

| Path              | What is in it                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `packages/core`   | The simulation: vehicle, road, world, sensors, MPC, QP solvers, baseline controller, scenarios. |
| `packages/worker` | The Web Worker adapter: the typed protocol, the pacing and the buffer pool.                     |
| `packages/app`    | The web app (React, Tailwind, Three.js, uPlot).                                                 |
| `packages/cli`    | Headless runs in Node: scenario runs, solver benchmarks.                                        |
| `scenarios`       | The scenario definitions (JSON).                                                                |
| `tools`           | The glTF model generator, the package-boundary probes and the deployment checks.                |
| `deploy`          | The nginx configuration of the Docker image; see [deploy/README.md](deploy/README.md).          |
| `docs`            | The plan and the architecture decision records.                                                 |

## Getting started

You need Node.js 22.18 or later (24 is what CI uses) and npm.

```sh
npm ci
npm run dev                                   # the development server; it opens the simulator directly
npm run verify                                # types, lint, format, package boundaries and tests
npm run sim -- --scenario pedestrian --seed 1     # a headless run: prints the result and its fingerprint
npm run build                                 # the production build of the app
```

The production build asks for an access link and shows a permission screen without one. The development server skips
that check, so use it to see the simulator.

To serve the build, see [deploy/README.md](deploy/README.md).

## License

This project is licensed under the [MIT License](LICENSE). The license text is what governs. In short: you may use,
copy, modify, publish, distribute, sublicense and sell the software, including for commercial purposes, as long as the
copyright notice and the license text stay in every copy or substantial portion of it. The software comes "as is",
without warranty.

**Trademarks.** Mative, the Mative logo and "Mative - Connecting Intelligence" are trademarks of Mative Srl, and the
license does not grant any right to them. The typeface used for headings on Mative's own
deployment is licensed to Mative and is not part of this repository.

**Third-party software.** The libraries in the bundle keep their own licenses, which the build writes to
`third-party-licenses.txt`. What no package carries is in
[packages/app/public/third-party-notices.txt](packages/app/public/third-party-notices.txt).

## Contributing and security

Bug reports and questions are welcome as issues. Pull requests are not being accepted at the moment. To report a
vulnerability, see [SECURITY.md](SECURITY.md).
