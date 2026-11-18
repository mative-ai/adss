/**
 * Vehicle parameter sets (Phase 1), laden: a C-segment car (1450 kg), a van of the 3.5 t class
 * (3200 kg) and a rigid truck of the 18 t class (16 t). SI units throughout; angles in radians, cornering
 * stiffness in N/rad per axle.
 */
export const GRAVITY = 9.81;
export const AIR_DENSITY = 1.225;

export type VehicleId = 'car' | 'van' | 'truck';

export interface VehicleParams {
  readonly id: VehicleId;
  readonly mass: number;
  readonly yawInertia: number;
  /** Distance from the center of gravity to the front axle. */
  readonly lf: number;
  /** Distance from the center of gravity to the rear axle. */
  readonly lr: number;
  readonly cgHeight: number;
  readonly track: number;
  /** Body footprint, m: what must stay inside the corridor; the overhangs split evenly front and rear. */
  readonly length: number;
  readonly width: number;
  readonly wheelRadius: number;
  /** Rotational inertia of one wheel with its share of the driveline. */
  readonly wheelInertia: number;
  readonly corneringStiffnessFront: number;
  readonly corneringStiffnessRear: number;
  readonly drivenAxle: 'front' | 'rear';
  /** Road-wheel steering: limit, rate limit and first-order lag. */
  readonly steerMax: number;
  readonly steerRateMax: number;
  readonly steerLag: number;
  /** Longitudinal command range, m/s²: positive drives, negative brakes. */
  readonly accelMax: number;
  readonly accelMin: number;
  /** Brake actuation: pure delay, then first-order lag. Air brakes make the truck's delay long. */
  readonly brakeDelay: number;
  readonly brakeLag: number;
  readonly driveLag: number;
  /** Drag coefficient times frontal area, m². */
  readonly dragArea: number;
  readonly rollingResistance: number;
}

export const VEHICLES: Readonly<Record<VehicleId, VehicleParams>> = {
  car: {
    id: 'car',
    mass: 1450,
    yawInertia: 2400,
    lf: 1.06,
    lr: 1.59,
    cgHeight: 0.55,
    track: 1.55,
    length: 4.4,
    width: 1.8,
    wheelRadius: 0.31,
    wheelInertia: 1.0,
    corneringStiffnessFront: 1.1e5,
    corneringStiffnessRear: 1.3e5,
    drivenAxle: 'front',
    steerMax: 0.6,
    steerRateMax: 0.6,
    steerLag: 0.08,
    accelMax: 3,
    accelMin: -10,
    brakeDelay: 0.05,
    brakeLag: 0.1,
    driveLag: 0.2,
    dragArea: 0.65,
    rollingResistance: 0.012,
  },
  van: {
    id: 'van',
    mass: 3200,
    yawInertia: 10500,
    lf: 2.0,
    lr: 1.65,
    cgHeight: 0.9,
    track: 1.75,
    length: 5.4,
    width: 2.0,
    wheelRadius: 0.36,
    wheelInertia: 1.6,
    corneringStiffnessFront: 1.6e5,
    corneringStiffnessRear: 2.4e5,
    drivenAxle: 'rear',
    steerMax: 0.6,
    steerRateMax: 0.5,
    steerLag: 0.1,
    accelMax: 2,
    accelMin: -8,
    brakeDelay: 0.08,
    brakeLag: 0.12,
    driveLag: 0.25,
    dragArea: 1.6,
    rollingResistance: 0.012,
  },
  truck: {
    id: 'truck',
    mass: 16000,
    yawInertia: 90000,
    lf: 2.88,
    lr: 1.92,
    cgHeight: 1.5,
    track: 2.05,
    length: 8.5,
    width: 2.5,
    wheelRadius: 0.5,
    wheelInertia: 12,
    corneringStiffnessFront: 4.5e5,
    corneringStiffnessRear: 8.5e5,
    drivenAxle: 'rear',
    steerMax: 0.6,
    steerRateMax: 0.35,
    steerLag: 0.15,
    accelMax: 1,
    accelMin: -6.5,
    brakeDelay: 0.3,
    brakeLag: 0.25,
    driveLag: 0.4,
    dragArea: 5.0,
    rollingResistance: 0.007,
  },
};

export function wheelbase(p: VehicleParams): number {
  return p.lf + p.lr;
}

/** Steady-state understeer gradient m/L·(lr/Cαf − lf/Cαr), rad per m/s² of lateral acceleration. */
export function understeerGradient(p: VehicleParams): number {
  return (p.mass / wheelbase(p)) * (p.lr / p.corneringStiffnessFront - p.lf / p.corneringStiffnessRear);
}

/**
 * Lateral acceleration at which the vehicle would start to tip, from the static stability factor with a
 * 0.8 margin for suspension roll: 0.8·g·T/(2h). Below the grip limit for the van and the truck.
 */
export function rolloverAccel(p: VehicleParams): number {
  return (0.8 * GRAVITY * p.track) / (2 * p.cgHeight);
}
