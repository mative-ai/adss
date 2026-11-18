// Public API of the simulation core: math, the vehicle, the road and the world (Phase 1); the MPC
// and its QP solvers (Phase 2); the scenarios, the sensors, the baseline controller, the scenario run and the MPC's
// decision layer (Phase 3).
export { wrapAngle } from './math/angle.ts';
export { cholesky, choleskySolve, ldl, ldlSolve, multiply, multiplyTransposed, normInf } from './math/dense.ts';
export { Fingerprint } from './math/hash.ts';
export { Prng } from './math/prng.ts';
export {
  AEB_DECEL_ENGAGE,
  AEB_DECEL_RELEASE,
  AEB_HOLD_GAP,
  AEB_LATERAL_MARGIN,
  AEB_TTC_ENGAGE,
  AEB_TTC_RELEASE,
  BaselineDriver,
  type BaselineOptions,
} from './baseline/baseline.ts';
export {
  BRANCH_DEFAULTS,
  BRANCH_IDS,
  brakeDecel,
  BrakeReference,
  EvadeReference,
  obstacleBand,
  pathObstacles,
  stillLateralSpeed,
  type BranchGeometry,
  type BranchId,
  type BranchSettings,
  type PathAnalysis,
  type PathObstacle,
} from './mpc/branches.ts';
export {
  DecisionDriver,
  encounterSwitches,
  maneuverChanges,
  MAX_CYCLE_QPS,
  type CandidateReport,
  type DecisionDriverOptions,
  type DecisionReport,
} from './mpc/decisionDriver.ts';
export { MpcDriver, type MpcDriverOptions } from './mpc/driver.ts';
export { Condenser } from './mpc/lowering.ts';
export { fiala, INPUT, NU, NX, PredictionModel, STATE } from './mpc/model.ts';
export {
  defaultMpcSettings,
  defaultSteps,
  defaultStepSolver,
  MPC_CONSTRAINT_DEFAULTS,
  MpcController,
  type Corridor,
  type MpcConstraintSettings,
  type MpcOptions,
  type MpcPlan,
  type MpcSettings,
  type Reference,
} from './mpc/mpc.ts';
export {
  brakingRoom,
  HELD_SUFFIX,
  heldSource,
  HOLD_MIN_LATERAL_SPEED,
  obstacleHalfPlane,
  predictTrack,
  STILL_NOISE_SIGMAS,
  vehicleDiscs,
  withHeldCopies,
  type DiscView,
  type HalfPlane,
  type ObstacleSide,
  type VehicleDiscs,
} from './mpc/obstacles.ts';
export { KEY_STAGE, OcpQp, ROW_KIND, rowKey } from './mpc/ocpQp.ts';
export {
  beats,
  bestCandidate,
  DECISION_SCALES,
  DECISION_WEIGHTS,
  DecisionSelector,
  evaluateCandidate,
  separation,
  SWITCH_CYCLES,
  SWITCH_IMPROVEMENT,
  type CandidateEvaluation,
  type DecisionContext,
  type DecisionFallback,
  type DecisionReason,
  type DecisionScales,
  type DecisionTerms,
  type DecisionWeights,
  type Selection,
} from './mpc/selector.ts';
export {
  MAX_OBSTACLES,
  overrideScenario,
  parseScenario,
  ScenarioError,
  scenarioSchema,
  type ObjectSensorConfig,
  type Scenario,
  type ScenarioJson,
  type ScenarioObstacle,
  type ScenarioOverrides,
} from './scenario/schema.ts';
export { ObjectSensor } from './sensors/objects.ts';
export type { FrictionPreview, LaneGeometry, ObstacleTrack, TrackSource } from './sensors/views.ts';
export {
  MetricsTracker,
  SLIP_MIN_SPEED,
  STANDSTILL,
  STRONG_BRAKE,
  type RoadPose,
  type RunMetrics,
} from './sim/metrics.ts';
export {
  laneFriction,
  laneReference,
  rectanglesOverlap,
  roadCorridor,
  RUN_RECORD,
  RUN_RECORD_SIZE,
  runScenario,
  ScenarioRun,
  TRACK_LOG_SIZE,
  vehicleFingerprint,
  VehicleWorld,
  type ControllerContext,
  type ControllerFactory,
  type FingerprintedRun,
  type RunEvent,
  type ScenarioRunOptions,
  type ScenarioRunResult,
  type VehicleRun,
} from './sim/scenarioRun.ts';
export { STREAM } from './sim/streams.ts';
export { RowCondenser } from './mpc/rowCondenser.ts';
export {
  CondensedStepSolver,
  GiStepSolver,
  type GiStepSolverOptions,
  type StepSolution,
  type StepSolver,
} from './mpc/stepSolver.ts';
export { runClosedLoop, type ClosedLoopOptions, type Controller } from './sim/closedLoop.ts';
export { rowsFromDense, type RowQpProblem } from './qp/giRows.ts';
export { GoldfarbIdnaniSolver, type GoldfarbIdnaniSettings } from './qp/goldfarbIdnani.ts';
export {
  GI_FAST_DEFAULTS,
  GoldfarbIdnaniFastSolver,
  type GoldfarbIdnaniFastSettings,
  type GoldfarbIdnaniFastStats,
} from './qp/goldfarbIdnaniFast.ts';
export {
  objective,
  residuals,
  type QpProblem,
  type QpResult,
  type QpSolver,
  type QpStatus,
  type WarmStart,
} from './qp/problem.ts';
export { RoadPath, SAMPLE_STEP, type Projection, type RoadPoint, type RoadSpec, type Segment } from './road/path.ts';
export { isoLaneChange, type Lane, type LaneChangeCourse } from './scenario/isoLaneChange.ts';
export { SurfaceMap, surfaceMap, uniformSurface, type SurfaceZone } from './road/surfaceMap.ts';
export { secondsAt, ticksFor, TICK_HZ, TICK_SECONDS } from './sim/clock.ts';
export { RECORD_SIZE, runOpenLoop, type OpenLoopOptions, type OpenLoopResult } from './sim/openLoop.ts';
export { Abs, ABS_TARGET, absTargetSlip } from './vehicle/abs.ts';
export { Actuators, type DriverCommand } from './vehicle/actuators.ts';
export { magic, magicSlope, peakArgument, shareArgument } from './vehicle/magicFormula.ts';
export {
  AIR_DENSITY,
  GRAVITY,
  rolloverAccel,
  understeerGradient,
  VEHICLES,
  wheelbase,
  type VehicleId,
  type VehicleParams,
} from './vehicle/params.ts';
export {
  CHASSIS,
  CHASSIS_SIZE,
  Plant,
  type ExternalLoads,
  type PlantInputs,
  type SurfaceSource,
} from './vehicle/plant.ts';
export { SLIP_STIFFNESS, SURFACES, type Surface, type SurfaceId } from './vehicle/surfaces.ts';
export { LATERAL_C, LATERAL_E, lateralPeakSlip, tireForces } from './vehicle/tire.ts';
export { Vehicle, type VehicleOptions } from './vehicle/vehicle.ts';
export { obstacleMoving, Obstacles, type ObstacleSpec, type ObstacleState, type Trigger } from './world/obstacles.ts';
export { gustLevel, gustLoads, type Gust } from './world/wind.ts';
