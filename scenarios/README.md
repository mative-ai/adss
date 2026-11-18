# v1 scenarios

The four v1 scenarios of `docs/PLAN.md` (Phase 3), validated by `packages/core/src/scenario/schema.ts`
(`parseScenario`). Speeds are in km/h, everything else is SI; road coordinates are s along the reference line and
e_y to its left; traffic is right-hand, so the ego lane is the right one and the opposite lane lies to its left.
The files hold ids only: the copy lives in the app's dictionaries. Tests and the M5 sweeps change speed and
trigger distance with `overrideScenario`, never by editing these files.

All four use the car, a 3.5 m ego lane, and an object sensor at 20 Hz (`period` 50 ticks) with 100 ms latency,
σ 0.1 m on position and σ 0.2 m/s on velocity.

The reference figures below were measured on 2026-11-03 with the plant of Phase 1 (scratch runs, seed 1): full
braking (−10 m/s² command, ABS) from the command to standstill on dry asphalt takes 12.1 m at 50 km/h, 16.9 m at
60 km/h and 29.0 m at 80 km/h; on μ-split at 80 km/h without steering correction the car spins (yaw −235°).

| id           | Setup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pedestrian` | 50 km/h, dry, straight two-lane road (lane center e_y −1.75). A pedestrian (0.5 × 0.5 m) stands on the right curb at s 60, e_y −4, visible from the start; when the ego reaches s 40 (20 m before, TTC about 1.3 s) it crosses at 1.4 m/s for 8 m. Braking from the first sensor report stops in 11.3 m, inside the 17.8 m gap: demanding but solvable (milestone M4).                                                                                                                                           |
| `moose`      | 60 km/h, dry, straight two-lane road. A moose (0.8 m along the road, 2.2 m across) hidden at the roadside (s 70, e_y −5.1) steps out at 3 m/s when the ego reaches s 50 (20 m before) and stops in the ego lane's center after 3.35 m. Braking from the first sensor report still hits at about 18 km/h; braking does not suffice, evading to the left does (an open-loop steer of 0.08 rad clears it). M5 sweeps `triggerDistance.moose`; the solver corpus also varies the speed. The moose has kind `animal`. |
| `ice`        | 70 km/h, a left curve: 60 m straight, 40 m clothoid, 120 m arc of radius 125 m, 40 m clothoid, 140 m straight. An ice patch (μ 0.1) across the whole road from s 140 to 175, inside the arc. On ice the curve allows about 40 km/h (√(0.1·g·126.75) ≈ 11.1 m/s), so a controller that keeps 70 km/h loses the lane, while the friction preview shows the ice from the start and braking on the dry part before s 140 is possible.                                                                                |
| `mu-split`   | 80 km/h, straight road with its reference line on the ego lane's center (e_y 0), so the left wheel track runs on ice and the right one on dry from s 30 on (zone side `left`). A stopped car (4.4 × 1.8 m) in the lane at s 150, hidden until the ego reaches s 90 (60 m before, as uncovered by a vehicle changing lane), forces an emergency stop on split friction, where hard braking yaws the car toward the dry side.                                                                                      |

Measured outcomes of the controllers on these setups are reported by `npm run sim -- --scenario <id>`, not here.

## Surface past the road edges

A surface zone is bounded along the road only (`from`, `to`) and by its side of the reference line, never by the
road's width: `road/surfaceMap.ts` applies it at any e_y. So a vehicle that leaves the road inside a zone stays on
that zone's surface (on `ice`, ice from s 140 to 175 at any distance from the road), and gets the base surface
back only where no zone covers its s. `laneFriction` reads the same zones along the ego lane's wheel tracks.

## What `ice` shows

On this setup the current `BaselineDriver` and an MPC that does not use the friction preview keep about 70 km/h
onto the patch and understeer off the road: the car slides wide with little sideslip (baseline, seed 1: |β| 2.38°
at most, 4.57 m of lateral deviation from the lane center, measured on 2026-11-03 with
`runScenario(ice, { seed: 1, ego: BaselineDriver })`). This is not a property of the plant on ice: with
another lane keeper (gains 1.0 on e_y and 3.0 on e_ψ) at 90 km/h a review of Phase 3 measured |β| 13.8°, the rear
let go on the same patch. On 2026-11-03 the user chose to judge the scenario by losing control rather than by
spinning (ADR 0001, milestone M4): where the baseline leaves its lane or spins, the MPC must stay in its lane with
|β| < 5°. `packages/core/test/m4.test.ts` checks it, and `ice.json` stays as it is.
