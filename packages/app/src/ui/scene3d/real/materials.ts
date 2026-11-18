/**
 * The physical materials of the realistic scene (Phase 8): the paint under its clear coat, the glass,
 * the rubber and the metal of the wheels, the lamps, the figures. A model's parts carry a material's name
 * (tools/models/materials.ts) and take the material of that name from one of the sets made here: the MPC's vehicle,
 * the ghost, a parked car, a figure.
 *
 * The design's rules hold in this scene too: its one green is the MPC's vehicle and the trajectory it chose; the ghost
 * is told from it without color, by being translucent and drawn with a dashed outline.
 *
 * The MPC's car also carries a sensor kit and Mative's wordmark (tools/models/sensors.ts, wordmark.ts), each with its
 * own materials here.
 */
import {
  AlwaysStencilFunc,
  LineDashedMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NotEqualStencilFunc,
  ReplaceStencilOp,
  type Material,
} from 'three';

/** The name of the lines a model draws itself with (the builder's OUTLINE). */
export const OUTLINE = 'outline';

/** Materials by the names the models use. */
export type MaterialSet = Record<string, Material>;

/** The ego writes 1 in the stencil where it is drawn; the ghost is drawn only where the stencil is not 1. */
const EGO_STENCIL = {
  stencilWrite: true,
  stencilRef: 1,
  stencilFunc: AlwaysStencilFunc,
  stencilZPass: ReplaceStencilOp,
} as const;
const GHOST_STENCIL = { stencilWrite: true, stencilRef: 1, stencilFunc: NotEqualStencilFunc } as const;

/** The brand's green, and the graphite of a car that is not the MPC's. */
const GREEN = 0x4db936;
const GRAPHITE = 0x3a3f42;
/** The brand's ink, which its wordmark is drawn in on the green, and the light it is drawn in on a dark ground. */
const INK = 0x0d230b;
const PAPER = 0xf7f8f4;

/**
 * How bright the lamps are, as a multiple of their color: by day, at dusk, and the tail lamps under braking. The
 * beacon is the ring of light under the dome of the sensor kit.
 */
const LAMPS = {
  front: { day: 0.5, dusk: 5 },
  rear: { day: 0.25, dusk: 1.2, braking: 3.2 },
  beacon: { day: 0.35, dusk: 2.4 },
} as const;

export class Materials {
  /** The MPC's vehicle: it marks its pixels, so that the ghost keeps out of them. */
  readonly ego: MaterialSet;
  /** A car that only stands in the scene. */
  readonly traffic: MaterialSet;
  /** The ghost: every part in one translucent material, and its dashed lines. */
  readonly ghost: MaterialSet;
  /** A person, an animal, a plain obstacle. */
  readonly figure: MaterialSet;

  private readonly all: Material[] = [];
  private readonly frontLamps: MeshStandardMaterial[] = [];
  private readonly rearLamps: MeshStandardMaterial[] = [];
  private readonly beacons: MeshStandardMaterial[] = [];
  private readonly egoRear: MeshStandardMaterial;
  private dusk = false;
  private braking = false;

  constructor() {
    this.ego = this.vehicle(GREEN, EGO_STENCIL);
    this.egoRear = this.ego.lamp_rear as MeshStandardMaterial;
    this.traffic = this.vehicle(GRAPHITE, {});

    const shell = this.keep(
      new MeshStandardMaterial({
        color: 0xe3e7dd,
        roughness: 0.25,
        transparent: true,
        opacity: 0.26,
        depthWrite: false,
        ...GHOST_STENCIL,
      }),
    );
    // With the transparent things, as the shell is: after the ego's glass, which has then marked its pixels too.
    const lines = this.keep(
      new LineDashedMaterial({ color: 0xf7f8f4, dashSize: 0.3, gapSize: 0.18, transparent: true, ...GHOST_STENCIL }),
    );
    this.ghost = { ...Object.fromEntries(Object.keys(this.ego).map((name) => [name, shell])), [OUTLINE]: lines };

    const matte = (color: number, roughness: number) => this.keep(new MeshStandardMaterial({ color, roughness }));
    this.figure = {
      figure: matte(0xd9ddd2, 0.55),
      figure_joint: matte(0x2b302a, 0.6),
      fur: matte(0x3d2b1f, 1),
      fur_light: matte(0x8a7558, 1),
      antler: matte(0xb9a88a, 0.75),
      hoof: matte(0x1c1a17, 0.7),
    };
    this.light();
  }

  private keep<T extends Material>(material: T): T {
    this.all.push(material);
    return material;
  }

  /** A vehicle's materials around a paint of `color`. */
  private vehicle(color: number, stencil: Partial<typeof EGO_STENCIL>): MaterialSet {
    const standard = (options: ConstructorParameters<typeof MeshStandardMaterial>[0]) =>
      this.keep(new MeshStandardMaterial({ ...options, ...stencil }));
    const front = standard({ color: 0xffffff, emissive: 0xfff3dc, roughness: 0.15 });
    const rear = standard({ color: 0x4a0505, emissive: 0xff1a0a, roughness: 0.15 });
    const beacon = standard({ color: 0x10240d, emissive: GREEN, roughness: 0.3 });
    this.frontLamps.push(front);
    this.rearLamps.push(rear);
    this.beacons.push(beacon);
    return {
      // A metallic base under a clear coat: the coat gives the sharp mirror of the sky, the base the color.
      paint: this.keep(
        new MeshPhysicalMaterial({
          color,
          metalness: 0.55,
          roughness: 0.42,
          clearcoat: 1,
          clearcoatRoughness: 0.05,
          ...stencil,
        }),
      ),
      // The black of a car's roof, its pillars and its mirrors, under the same clear coat.
      paint_dark: this.keep(
        new MeshPhysicalMaterial({
          color: 0x0b0d0c,
          metalness: 0.1,
          roughness: 0.4,
          clearcoat: 0.5,
          clearcoatRoughness: 0.12,
          ...stencil,
        }),
      ),
      cargo: standard({ color: 0xe8eae6, roughness: 0.55 }),
      // Tinted glass: nearly opaque, mirroring the sky more as it is seen more from the side.
      glass: this.keep(
        new MeshPhysicalMaterial({
          color: 0x0a0f0c,
          roughness: 0.03,
          transparent: true,
          opacity: 0.88,
          envMapIntensity: 1.4,
          ...stencil,
        }),
      ),
      trim: standard({ color: 0x0d0e0d, roughness: 0.62 }),
      interior: standard({ color: 0x151615, roughness: 0.95 }),
      rubber: standard({ color: 0x090909, roughness: 0.92 }),
      rim: standard({ color: 0xc4c7cb, metalness: 1, roughness: 0.28 }),
      rim_dark: standard({ color: 0x35383b, metalness: 0.9, roughness: 0.45 }),
      lamp_front: front,
      lamp_rear: rear,
      // The sensor kit: satin housings, the black windows the sensors look through, the ring of light under the dome.
      sensor_shell: standard({ color: 0xe9ebe6, roughness: 0.38 }),
      sensor_glass: standard({ color: 0x050605, metalness: 0.2, roughness: 0.08 }),
      sensor_light: beacon,
      // Mative's wordmark: ink on the green paint, as on the green block of its sites, and light on the dark glass.
      livery: standard({ color: INK, roughness: 0.55 }),
      livery_light: standard({ color: PAPER, roughness: 0.55 }),
    };
  }

  private light(): void {
    for (const lamp of this.frontLamps) lamp.emissiveIntensity = this.dusk ? LAMPS.front.dusk : LAMPS.front.day;
    for (const lamp of this.rearLamps) lamp.emissiveIntensity = this.dusk ? LAMPS.rear.dusk : LAMPS.rear.day;
    for (const lamp of this.beacons) lamp.emissiveIntensity = this.dusk ? LAMPS.beacon.dusk : LAMPS.beacon.day;
    if (this.braking) this.egoRear.emissiveIntensity = LAMPS.rear.braking;
  }

  /** Lights the lamps for the dusk, or dims them for the day. */
  setDusk(dusk: boolean): void {
    this.dusk = dusk;
    this.light();
  }

  /** The MPC's vehicle brakes, or no longer does: its tail lamps say so. */
  setBraking(braking: boolean): void {
    if (braking === this.braking) return;
    this.braking = braking;
    this.light();
  }

  dispose(): void {
    for (const material of this.all) material.dispose();
  }
}
