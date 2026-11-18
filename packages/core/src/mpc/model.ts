/**
 * The MPC's prediction model: a dynamic single-track model in Frenet coordinates along the road,
 * with Fiala (brush) tires on the estimated friction and static axle loads, and first-order lags for the
 * steering and the longitudinal acceleration. It is deliberately simpler than the four-wheel plant.
 *
 * State x = [s, e_y, e_ψ, vx, vy, r, δ, a_x], input u = [δ_cmd, a_cmd]; the road curvature κ and the friction
 * coefficient μ are parameters, held per stage (the MPC reads μ from a friction preview along the road).
 * Jacobians are written by hand (tested against finite differences), and `discretize` returns the exact
 * derivatives of its RK4 map, so the RTI linearization is consistent with the rollout.
 *
 * Below 3 m/s the lateral and yaw dynamics blend into the kinematic model, as in the plant (vehicle/plant.ts):
 * the tire model's lateral modes grow as 1/vx and would make the explicit RK4 unstable on 25 ms sub-steps
 * (their eigenvalues reach about −230 s⁻¹ for the car at the 1 m/s slip floor), while the kinematic targets
 * relax with a 50 ms lag. At 3 m/s and above the model is the dynamic one, to the bit. The blend can be turned
 * off (`lowSpeedBlend`): the MPC does so without its standstill option, so that the solver corpus and M3 keep
 * their QPs (a few of their plans brake to a standstill inside the horizon).
 *
 * With `standstillHold` the model cannot reverse: each RK4 stage and each sub-step result takes vx = max(0, vx),
 * the plant's standstill latch in the model's terms. The map stays continuous and its Jacobians stay exact on each
 * side of the hold (the held vx row is zero: braking harder at rest changes nothing); exactly at vx = 0 they are
 * the one-sided ones of the moving side. Off, the map is the same to the bit as without it.
 */
import { GRAVITY, wheelbase, type VehicleParams } from '../vehicle/params.ts';

export const NX = 8;
export const NU = 2;
export const STATE = { S: 0, EY: 1, EPSI: 2, VX: 3, VY: 4, R: 5, DELTA: 6, AX: 7 } as const;
export const INPUT = { STEER: 0, ACCEL: 1 } as const;

const { S, EY, EPSI, VX, VY, R, DELTA, AX } = STATE;
/** Slip angles use max(vx, this) so the model stays finite near standstill. */
const SLIP_SPEED_FLOOR = 1;
/** Longest RK4 sub-step, s: with the low-speed blend below, it keeps every mode of the model stable. */
const MAX_SUBSTEP = 0.025;
/**
 * Speed band where the lateral and yaw dynamics blend from kinematic (below) to dynamic (above), m/s, and the lag
 * of the kinematic targets, s: the plant's values. The model blends on vx, the plant on the speed |v|; near
 * standstill they differ by the side slip, which is small there.
 */
const KINEMATIC_FULL = 1;
const DYNAMIC_FULL = 3;
const KINEMATIC_LAG = 0.05;
/** Below this speed the kinematic yaw rate is not limited by the grip (the plant's). */
const KINEMATIC_GRIP_SPEED = 0.1;

/** Fiala lateral force of an axle and its derivative with respect to the slip angle, into out[0] and out[1]. */
export function fiala(alpha: number, stiffness: number, muFz: number, out: Float64Array): void {
  const t = Math.tan(alpha);
  const limit = (3 * muFz) / stiffness;
  if (Math.abs(t) >= limit) {
    out[0] = -muFz * Math.sign(alpha);
    out[1] = 0;
    return;
  }
  const a = Math.abs(t);
  const c2 = stiffness * stiffness;
  out[0] = -stiffness * t + (c2 * a * t) / (3 * muFz) - (c2 * stiffness * t * t * t) / (27 * muFz * muFz);
  const sec2 = 1 + t * t;
  out[1] = (-stiffness + (2 * c2 * a) / (3 * muFz) - (c2 * stiffness * t * t) / (9 * muFz * muFz)) * sec2;
}

/** out = A(rows×inner)·B(inner×cols). */
function matMul(a: Float64Array, b: Float64Array, rows: number, inner: number, cols: number, out: Float64Array): void {
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      let s = 0;
      for (let k = 0; k < inner; k++) s += (a[i * inner + k] ?? 0) * (b[k * cols + j] ?? 0);
      out[i * cols + j] = s;
    }
  }
}

/** Row `row` of jx ← w·row + (1 − w)·gradient, plus `vxTerm` in the vx column. */
function blendRow(jx: Float64Array, row: number, gradient: Float64Array, w: number, vxTerm: number): void {
  for (let col = 0; col < NX; col++) {
    jx[row * NX + col] = w * (jx[row * NX + col] ?? 0) + (1 - w) * (gradient[col] ?? 0);
  }
  jx[row * NX + VX] = (jx[row * NX + VX] ?? 0) + vxTerm;
}

export class PredictionModel {
  readonly params: VehicleParams;
  /** Friction coefficient the controller believes in where it has no preview: the default μ of every stage. */
  mu: number;
  /** Lag of the achieved longitudinal acceleration, s. */
  readonly accelLag: number;
  /** Whether the lateral and yaw dynamics blend into the kinematic model below 3 m/s (on by default). */
  lowSpeedBlend = true;
  /**
   * Whether the vehicle holds at standstill instead of reversing (off by default): vx = max(0, ·) on every RK4
   * stage and sub-step result, so a non-positive acceleration at rest keeps vx at 0, as the plant's standstill
   * latch does (the simulator's vehicles have no reverse gear), and a positive one moves it forward.
   */
  standstillHold = false;
  private readonly fzFront: number;
  private readonly fzRear: number;
  private readonly wheelbase: number;
  /** Arm that turns the kinematic lateral grip into a yaw acceleration limit (the plant's), 1/m. */
  private readonly yawGripArm: number;
  /** Row ∂(kinematic target)/∂x of the low-speed blend, for v̇y and ṙ. */
  private readonly kinVy = new Float64Array(NX);
  private readonly kinR = new Float64Array(NX);
  /** The kinematic targets of v̇y and ṙ. */
  private readonly kin = new Float64Array(2);
  private readonly tire = new Float64Array(2);
  // RK4 work storage.
  private readonly k = [0, 1, 2, 3].map(() => new Float64Array(NX));
  private readonly kx = [0, 1, 2, 3].map(() => new Float64Array(NX * NX));
  private readonly ku = [0, 1, 2, 3].map(() => new Float64Array(NX * NU));
  private readonly jx = new Float64Array(NX * NX);
  private readonly ju = new Float64Array(NX * NU);
  private readonly stage = new Float64Array(NX);
  private readonly stepA = new Float64Array(NX * NX);
  private readonly stepB = new Float64Array(NX * NU);
  private readonly tmpA = new Float64Array(NX * NX);
  private readonly tmpB = new Float64Array(NX * NU);
  private readonly sub = new Float64Array(NX);

  constructor(params: VehicleParams, mu: number) {
    this.params = params;
    this.mu = mu;
    this.accelLag = params.brakeLag;
    const L = wheelbase(params);
    this.wheelbase = L;
    this.yawGripArm = (params.mass * Math.max(params.lf, params.lr)) / params.yawInertia;
    this.fzFront = (params.mass * GRAVITY * params.lr) / L;
    this.fzRear = (params.mass * GRAVITY * params.lf) / L;
  }

  /** Slip angle at which the rear Fiala tire saturates on friction μ: the stability envelope of the rear axle. */
  rearSlipLimit(mu: number = this.mu): number {
    return Math.atan((3 * mu * this.fzRear) / this.params.corneringStiffnessRear);
  }

  /** ẋ = f(x, u; κ, μ); with `jx` and `ju`, also ∂f/∂x (NX×NX) and ∂f/∂u (NX×NU), row-major. */
  derivative(
    x: Float64Array,
    u: Float64Array,
    kappa: number,
    mu: number,
    out: Float64Array,
    jx?: Float64Array,
    ju?: Float64Array,
  ): void {
    const p = this.params;
    const ey = x[EY] ?? 0;
    const epsi = x[EPSI] ?? 0;
    const vx = x[VX] ?? 0;
    const vy = x[VY] ?? 0;
    const r = x[R] ?? 0;
    const delta = x[DELTA] ?? 0;
    const ax = x[AX] ?? 0;
    const cos = Math.cos(epsi);
    const sin = Math.sin(epsi);
    const den = 1 - kappa * ey;
    const along = vx * cos - vy * sin;
    const sDot = along / den;

    const slow = vx < SLIP_SPEED_FLOOR;
    const vxs = slow ? SLIP_SPEED_FLOOR : vx;
    const nf = vy + p.lf * r;
    const nr = vy - p.lr * r;
    const alphaF = Math.atan(nf / vxs) - delta;
    const alphaR = Math.atan(nr / vxs);
    fiala(alphaF, p.corneringStiffnessFront, mu * this.fzFront, this.tire);
    const ff = this.tire[0] ?? 0;
    const dff = this.tire[1] ?? 0;
    fiala(alphaR, p.corneringStiffnessRear, mu * this.fzRear, this.tire);
    const fr = this.tire[0] ?? 0;
    const dfr = this.tire[1] ?? 0;
    const cd = Math.cos(delta);
    const sd = Math.sin(delta);

    out[S] = sDot;
    out[EY] = vx * sin + vy * cos;
    out[EPSI] = r - kappa * sDot;
    out[VX] = ax + r * vy;
    const dynVy = (ff * cd + fr) / p.mass - r * vx;
    const dynR = (p.lf * ff * cd - p.lr * fr) / p.yawInertia;
    out[VY] = dynVy;
    out[R] = dynR;
    out[DELTA] = ((u[0] ?? 0) - delta) / p.steerLag;
    out[AX] = ((u[1] ?? 0) - ax) / this.accelLag;
    const blend = this.lowSpeedBlend && vx < DYNAMIC_FULL;
    let w = 1;
    if (blend) {
      w = Math.max(0, (vx - KINEMATIC_FULL) / (DYNAMIC_FULL - KINEMATIC_FULL));
      this.kinematic(vx, vy, r, delta, mu);
      out[VY] = w * dynVy + (1 - w) * (this.kin[0] ?? 0);
      out[R] = w * dynR + (1 - w) * (this.kin[1] ?? 0);
    }

    if (!jx || !ju) return;
    jx.fill(0);
    ju.fill(0);
    const set = (row: number, col: number, v: number) => {
      jx[row * NX + col] = v;
    };
    // ṡ
    const dsEy = (along * kappa) / (den * den);
    const dsEpsi = (-vx * sin - vy * cos) / den;
    const dsVx = cos / den;
    const dsVy = -sin / den;
    set(S, EY, dsEy);
    set(S, EPSI, dsEpsi);
    set(S, VX, dsVx);
    set(S, VY, dsVy);
    // ė_y
    set(EY, EPSI, vx * cos - vy * sin);
    set(EY, VX, sin);
    set(EY, VY, cos);
    // ė_ψ = r − κ·ṡ
    set(EPSI, EY, -kappa * dsEy);
    set(EPSI, EPSI, -kappa * dsEpsi);
    set(EPSI, VX, -kappa * dsVx);
    set(EPSI, VY, -kappa * dsVy);
    set(EPSI, R, 1);
    // v̇x
    set(VX, VY, r);
    set(VX, R, vy);
    set(VX, AX, 1);
    // Slip-angle derivatives.
    const gf = vxs / (vxs * vxs + nf * nf);
    const gr = vxs / (vxs * vxs + nr * nr);
    const afVy = gf;
    const afR = p.lf * gf;
    const afVx = slow ? 0 : -nf / (vxs * vxs + nf * nf);
    const arVy = gr;
    const arR = -p.lr * gr;
    const arVx = slow ? 0 : -nr / (vxs * vxs + nr * nr);
    // v̇y = (Ff·cos δ + Fr)/m − r·vx
    set(VY, VX, (dff * afVx * cd + dfr * arVx) / p.mass - r);
    set(VY, VY, (dff * afVy * cd + dfr * arVy) / p.mass);
    set(VY, R, (dff * afR * cd + dfr * arR) / p.mass - vx);
    set(VY, DELTA, (-dff * cd - ff * sd) / p.mass);
    // ṙ = (lf·Ff·cos δ − lr·Fr)/Iz
    set(R, VX, (p.lf * dff * afVx * cd - p.lr * dfr * arVx) / p.yawInertia);
    set(R, VY, (p.lf * dff * afVy * cd - p.lr * dfr * arVy) / p.yawInertia);
    set(R, R, (p.lf * dff * afR * cd - p.lr * dfr * arR) / p.yawInertia);
    set(R, DELTA, (p.lf * (-dff * cd - ff * sd)) / p.yawInertia);
    // Lags.
    set(DELTA, DELTA, -1 / p.steerLag);
    set(AX, AX, -1 / this.accelLag);
    ju[DELTA * NU + 0] = 1 / p.steerLag;
    ju[AX * NU + 1] = 1 / this.accelLag;
    if (!blend) return;
    // The blend: row = w·dynamic + (1 − w)·kinematic, plus ∂w/∂vx·(dynamic − kinematic) in the vx column.
    const dw = vx > KINEMATIC_FULL ? 1 / (DYNAMIC_FULL - KINEMATIC_FULL) : 0;
    blendRow(jx, VY, this.kinVy, w, dw * (dynVy - (this.kin[0] ?? 0)));
    blendRow(jx, R, this.kinR, w, dw * (dynR - (this.kin[1] ?? 0)));
  }

  /**
   * The plant's kinematic targets at low speed, within the grip μ·g: the lateral and yaw accelerations that bring
   * vy and r to the kinematic yaw rate vx·tan δ/L in KINEMATIC_LAG. Into `kin`, their gradients over the state
   * into `kinVy` and `kinR`.
   */
  private kinematic(vx: number, vy: number, r: number, delta: number, mu: number): void {
    const p = this.params;
    const out = this.kin;
    const dVy = this.kinVy;
    const dR = this.kinR;
    const grip = mu * GRAVITY;
    const t = Math.tan(delta);
    let yawRate = (vx * t) / this.wheelbase;
    let yrVx = t / this.wheelbase;
    let yrDelta = (vx * (1 + t * t)) / this.wheelbase;
    if (vx > KINEMATIC_GRIP_SPEED && Math.abs(yawRate) > grip / vx) {
      yawRate = (Math.sign(yawRate) * grip) / vx;
      yrVx = -yawRate / vx;
      yrDelta = 0;
    }
    dVy.fill(0);
    dR.fill(0);
    const lateral = (yawRate * p.lr - vy) / KINEMATIC_LAG;
    if (Math.abs(lateral) > grip) {
      out[0] = Math.sign(lateral) * grip;
    } else {
      out[0] = lateral;
      dVy[VX] = (p.lr * yrVx) / KINEMATIC_LAG;
      dVy[VY] = -1 / KINEMATIC_LAG;
      dVy[DELTA] = (p.lr * yrDelta) / KINEMATIC_LAG;
    }
    const yawGrip = grip * this.yawGripArm;
    const yaw = (yawRate - r) / KINEMATIC_LAG;
    if (Math.abs(yaw) > yawGrip) {
      out[1] = Math.sign(yaw) * yawGrip;
    } else {
      out[1] = yaw;
      dR[VX] = yrVx / KINEMATIC_LAG;
      dR[R] = -1 / KINEMATIC_LAG;
      dR[DELTA] = yrDelta / KINEMATIC_LAG;
    }
  }

  /**
   * x⁺ = Φ(x, u; κ, μ) over `duration` with the input held, by RK4 on sub-steps of at most 25 ms. With `a` and
   * `b`, also the exact Jacobians ∂Φ/∂x (NX×NX) and ∂Φ/∂u (NX×NU).
   */
  discretize(
    x: Float64Array,
    u: Float64Array,
    kappa: number,
    mu: number,
    duration: number,
    next: Float64Array,
    a?: Float64Array,
    b?: Float64Array,
  ): void {
    const steps = Math.max(1, Math.ceil(duration / MAX_SUBSTEP - 1e-9));
    const h = duration / steps;
    const want = a !== undefined && b !== undefined;
    this.sub.set(x);
    if (want) {
      a.fill(0);
      for (let i = 0; i < NX; i++) a[i * NX + i] = 1;
      b.fill(0);
    }
    for (let step = 0; step < steps; step++) {
      this.rk4(this.sub, u, kappa, mu, h, next, want);
      this.sub.set(next);
      if (want) {
        // Chain the sub-step: A ← A_s·A, B ← A_s·B + B_s.
        matMul(this.stepA, a, NX, NX, NX, this.tmpA);
        a.set(this.tmpA);
        matMul(this.stepA, b, NX, NX, NU, this.tmpB);
        for (let i = 0; i < NX * NU; i++) b[i] = (this.tmpB[i] ?? 0) + (this.stepB[i] ?? 0);
      }
    }
    next.set(this.sub);
  }

  private rk4(
    x: Float64Array,
    u: Float64Array,
    kappa: number,
    mu: number,
    h: number,
    next: Float64Array,
    want: boolean,
  ): void {
    const weights = [0, 0.5, 0.5, 1];
    for (let s = 0; s < 4; s++) {
      const kS = this.k[s] as Float64Array;
      const w = (weights[s] ?? 0) * h;
      if (s === 0) this.stage.set(x);
      else {
        const prev = this.k[s - 1] as Float64Array;
        for (let i = 0; i < NX; i++) this.stage[i] = (x[i] ?? 0) + w * (prev[i] ?? 0);
      }
      // The standstill hold on the stage: vx = max(0, ·), whose derivative zeroes the stage's vx row.
      const held = this.standstillHold && (this.stage[VX] ?? 0) < 0;
      if (held) this.stage[VX] = 0;
      this.derivative(this.stage, u, kappa, mu, kS, want ? this.jx : undefined, want ? this.ju : undefined);
      if (!want) continue;
      const kxS = this.kx[s] as Float64Array;
      const kuS = this.ku[s] as Float64Array;
      if (s === 0) {
        kxS.set(this.jx);
        kuS.set(this.ju);
        // Held at the start: ∂x_0/∂x is I with its vx entry zeroed, so the vx column of K_0 is.
        if (held) for (let i = 0; i < NX; i++) kxS[i * NX + VX] = 0;
        continue;
      }
      // Stage sensitivities: K_s = J(x_s)·M_s for x, J(x_s)·M_s^u + J_u(x_s) for u, with M_s = ∂x_s/∂x =
      // I + w·K_{s−1} and M_s^u = ∂x_s/∂u = w·K_{s−1}^u, their vx row zeroed when the stage is held.
      const prevX = this.kx[s - 1] as Float64Array;
      const prevU = this.ku[s - 1] as Float64Array;
      for (let i = 0; i < NX * NX; i++) this.tmpA[i] = w * (prevX[i] ?? 0);
      for (let i = 0; i < NX; i++) this.tmpA[i * NX + i] = (this.tmpA[i * NX + i] ?? 0) + 1;
      for (let i = 0; i < NX * NU; i++) this.tmpB[i] = w * (prevU[i] ?? 0);
      if (held) {
        this.tmpA.fill(0, VX * NX, (VX + 1) * NX);
        this.tmpB.fill(0, VX * NU, (VX + 1) * NU);
      }
      matMul(this.jx, this.tmpA, NX, NX, NX, kxS);
      matMul(this.jx, this.tmpB, NX, NX, NU, kuS);
      for (let i = 0; i < NX * NU; i++) kuS[i] = (kuS[i] ?? 0) + (this.ju[i] ?? 0);
    }
    const [k1, k2, k3, k4] = this.k as [Float64Array, Float64Array, Float64Array, Float64Array];
    for (let i = 0; i < NX; i++) {
      next[i] = (x[i] ?? 0) + (h / 6) * ((k1[i] ?? 0) + 2 * (k2[i] ?? 0) + 2 * (k3[i] ?? 0) + (k4[i] ?? 0));
    }
    const held = this.standstillHold && (next[VX] ?? 0) < 0;
    if (held) next[VX] = 0;
    if (!want) return;
    const [x1, x2, x3, x4] = this.kx as [Float64Array, Float64Array, Float64Array, Float64Array];
    const [u1, u2, u3, u4] = this.ku as [Float64Array, Float64Array, Float64Array, Float64Array];
    for (let i = 0; i < NX * NX; i++) {
      this.stepA[i] = (h / 6) * ((x1[i] ?? 0) + 2 * (x2[i] ?? 0) + 2 * (x3[i] ?? 0) + (x4[i] ?? 0));
    }
    for (let i = 0; i < NX; i++) this.stepA[i * NX + i] = (this.stepA[i * NX + i] ?? 0) + 1;
    for (let i = 0; i < NX * NU; i++) {
      this.stepB[i] = (h / 6) * ((u1[i] ?? 0) + 2 * (u2[i] ?? 0) + 2 * (u3[i] ?? 0) + (u4[i] ?? 0));
    }
    if (held) {
      this.stepA.fill(0, VX * NX, (VX + 1) * NX);
      this.stepB.fill(0, VX * NU, (VX + 1) * NU);
    }
  }
}
