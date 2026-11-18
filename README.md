# MPC Autonomous Driving Simulator

An interactive driving simulation that runs entirely in the browser. A virtual vehicle is driven by a model predictive
controller (MPC) through four emergency scenarios, and its run is shown next to a simpler baseline controller, on the
same road and with the same random seed.

> **Educational simulation, not for homologation.** It shows how a controller reasons in a critical situation. It is not
> a certified or a production system, and the figures it shows describe the simulated vehicle only.

## The scenarios

| Scenario                | What happens                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| Pedestrian crossing     | At 50 km/h on dry asphalt, a pedestrian crosses the road 20 m ahead.                                   |
| Moose test              | At 60 km/h on dry asphalt, a moose leaves the roadside 20 m ahead and stops in the lane.               |
| Curve with an ice patch | At 70 km/h in a left curve, a patch of ice (friction μ 0.1) lies across the bend.                      |
| μ-split braking         | At 80 km/h, the left wheels are on ice and the right ones on dry asphalt. A stopped car is 60 m ahead. |

Each run ends with a report that sets the MPC against the baseline. Every figure in it comes from the run.

## How it works

- **The vehicle** has a tire model, actuators and a road with variable friction.
- **The controller** is a real-time-iteration MPC. It plans several candidate maneuvers, checks each on a nonlinear
  rollout and keeps the one with the lowest common cost. Its quadratic-programming solvers are written in TypeScript,
  with no WebAssembly.
- **The baseline** runs in lockstep, with the same seed, so the two runs can be compared sample by sample.
- **The simulation is deterministic.** Time is an integer tick at 1 kHz, randomness comes from seeded generators, and a
  run is rebuilt from the scenario, the seed and the configuration. A timing measured in the browser can slow a run
  down, never change its result.
- **The simulation runs in a Web Worker.** The app only draws and sends commands: it never computes physics or control.
- **The view** is a 3D scene (Three.js) with a mini-map, a top view, and live charts (uPlot). From 1024 px of width the
  scene is realistic, with glTF models that this repository generates (`npm run models`); on a narrower screen, or when
  the GPU cannot keep up, it is a low-poly one.
- **The interface** is in English, Italian and Spanish, in a light or a dark theme. It opens in your browser's language
  when it is one of the three, and in English otherwise; `?lng=it` or `?lng=es` in the address picks one. The theme is the
  system's, unless you pick one with the switch in the top corner.

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

## Getting started

You need Node.js 22.18 or later (24 is what CI uses) and npm.

```sh
npm ci
npm run dev                                       # the development server: opens the simulator
npm run verify                                    # types, lint, format, package boundaries and tests
npm run sim -- --scenario pedestrian --seed 1     # a headless run: prints the result and its fingerprint
npm run build                                     # the production build of the app
```

The scenarios of `npm run sim` are `pedestrian`, `moose`, `ice` and `mu-split`. The same scenario and seed always print
the same fingerprint.

To serve the build, see [deploy/README.md](deploy/README.md): a hardened nginx image, with the response headers and the
Content-Security-Policy in one file.

## Contributing

Pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it says what is in scope, which rules a change
has to keep, and how to run the checks.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

This project is licensed under the [MIT License](LICENSE). The license text is what governs. In short: you may use,
copy, modify, publish, distribute, sublicense and sell the software, including for commercial purposes, as long as the
copyright notice and the license text stay in every copy or substantial portion of it. The software comes "as is",
without warranty.

**Trademarks.** Mative and the Mative logo are trademarks of Mative Srl, and the license does not grant any right to
them.

## Acknowledgements

The simulator stands on [three.js](https://threejs.org), [React](https://react.dev),
[uPlot](https://github.com/leeoniya/uPlot), the Poppins typeface and QuadProg++ by Luca Di Gaspero, whose structure the
quadratic-programming solvers follow. The licenses of the libraries in the bundle are written by the build to
`third-party-licenses.txt`, and what no package carries is in
[packages/app/public/third-party-notices.txt](packages/app/public/third-party-notices.txt).
