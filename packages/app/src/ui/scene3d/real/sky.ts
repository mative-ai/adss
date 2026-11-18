/**
 * The sky of the realistic scene (Phase 8) and the light it gives: a dome drawn by a shader (a gradient
 * from the horizon to the zenith, the sun with its glow, slow clouds), and the same sky as the scene's environment, so
 * that every surface is lit and mirrors it in high dynamic range. No picture is downloaded.
 *
 * The page's light theme is the day and its dark theme is the dusk, with the vehicle's lamps on. Only the look
 * changes: the run is the same in both.
 */
import {
  BackSide,
  Color,
  Mesh,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';

import { NOISE } from './bake.ts';

/** A time of day: the sky's colors, the light that casts the shadows, the haze, and whether lamps are lit. */
export interface Atmosphere {
  zenith: number;
  horizon: number;
  /** What the sky is under the horizon: the color surfaces mirror from below. */
  ground: number;
  /** Toward the sun, in three's axes (X along the road at its start, Y up, Z to the right). */
  sun: readonly [number, number, number];
  sunColor: number;
  /** The brightness of the sun's disc and of the glow around it, over the sky's. */
  disc: number;
  glow: number;
  /** How much of the sky the clouds may cover, 0 to 1, and their color. */
  clouds: number;
  cloudColor: number;
  /** Toward the light that casts the shadows (the sun by day, the moon at dusk), its color and its strength. */
  light: readonly [number, number, number];
  lightColor: number;
  lightPower: number;
  /** How much the sky lights the scene. */
  ambient: number;
  fog: number;
  fogDensity: number;
  /** The vehicle's lamps and the reflectors beside the road are lit. */
  lamps: boolean;
  /** How much brighter than it is the frame is shown: the eye's own adjustment to the dusk. */
  exposure: number;
}

export const DAY: Atmosphere = {
  zenith: 0x2f6cc4,
  horizon: 0xc3d7ea,
  ground: 0x4b5046,
  sun: [0.55, 0.55, -0.63],
  sunColor: 0xfff0da,
  disc: 60,
  glow: 1,
  clouds: 0.85,
  cloudColor: 0xffffff,
  light: [0.55, 0.55, -0.63],
  lightColor: 0xfff0da,
  lightPower: 3.1,
  ambient: 0.85,
  fog: 0xc3d7ea,
  fogDensity: 0.0036,
  lamps: false,
  exposure: 1,
};

export const DUSK: Atmosphere = {
  zenith: 0x14204a,
  horizon: 0x55517a,
  ground: 0x1a1f24,
  sun: [0.82, -0.03, -0.57],
  sunColor: 0xff7a3c,
  disc: 0,
  glow: 0.6,
  clouds: 0.6,
  cloudColor: 0x2a3052,
  light: [-0.32, 0.78, 0.54],
  lightColor: 0xa9bcff,
  lightPower: 1.3,
  ambient: 1.15,
  fog: 0x2a2c44,
  fogDensity: 0.0042,
  lamps: true,
  exposure: 1.35,
};

const VERTEX = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = position;
    // The dome turns with the camera but never moves: it is drawn at the far plane, behind everything.
    vec4 at = projectionMatrix * vec4(mat3(modelViewMatrix) * position, 1.0);
    gl_Position = at.xyww;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 zenith;
  uniform vec3 horizon;
  uniform vec3 ground;
  uniform vec3 sunDirection;
  uniform vec3 sunColor;
  uniform float disc;
  uniform float glow;
  uniform float clouds;
  uniform vec3 cloudColor;
  varying vec3 vDirection;
  ${NOISE}
  void main() {
    vec3 d = normalize(vDirection);
    float toSun = max(dot(d, sunDirection), 0.0);
    vec3 sky = mix(horizon, zenith, pow(max(d.y, 0.0), 0.42));
    sky += sunColor * glow * (0.3 * pow(toSun, 10.0) + 1.5 * pow(toSun, 160.0));
    if (clouds > 0.0 && d.y > 0.0) {
      vec2 p = d.xz / (d.y + 0.18) * 1.3 + 3.7;
      float cover = smoothstep(0.46, 0.74, fbm(p, 4096.0)) * smoothstep(0.0, 0.22, d.y) * clouds;
      sky = mix(sky, cloudColor * (0.72 + 0.6 * pow(toSun, 4.0)), cover);
    }
    sky += sunColor * disc * smoothstep(0.99982, 0.99994, toSun);
    gl_FragColor = vec4(mix(sky, ground, smoothstep(0.0, -0.06, d.y)), 1.0);
  }
`;

const direction = (v: readonly [number, number, number]) => new Vector3(...v).normalize();

export class Sky {
  /** The dome: add it to the scene. */
  readonly dome: Mesh;
  private readonly material: ShaderMaterial;
  private readonly geometry = new SphereGeometry(1, 32, 16);
  private environment: WebGLRenderTarget | null = null;

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        zenith: { value: new Color() },
        horizon: { value: new Color() },
        ground: { value: new Color() },
        sunDirection: { value: new Vector3(0, 1, 0) },
        sunColor: { value: new Color() },
        disc: { value: 0 },
        glow: { value: 0 },
        clouds: { value: 0 },
        cloudColor: { value: new Color() },
      },
    });
    this.dome = new Mesh(this.geometry, this.material);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -100;
  }

  private set(atmosphere: Atmosphere, disc: number): void {
    const u = this.material.uniforms as Record<string, { value: unknown }>;
    (u.zenith?.value as Color).setHex(atmosphere.zenith);
    (u.horizon?.value as Color).setHex(atmosphere.horizon);
    (u.ground?.value as Color).setHex(atmosphere.ground);
    (u.sunDirection?.value as Vector3).copy(direction(atmosphere.sun));
    (u.sunColor?.value as Color).setHex(atmosphere.sunColor);
    (u.cloudColor?.value as Color).setHex(atmosphere.cloudColor);
    if (u.disc) u.disc.value = disc;
    if (u.glow) u.glow.value = atmosphere.glow;
    if (u.clouds) u.clouds.value = atmosphere.clouds;
  }

  /**
   * Gives the dome a time of day and returns that sky as the scene's environment. The sun's disc is left out of the
   * environment: the light that casts the shadows already stands for it, and it would shine twice on every surface.
   */
  apply(renderer: WebGLRenderer, atmosphere: Atmosphere): Texture {
    this.environment?.dispose();
    this.set(atmosphere, 0);
    const scene = new Scene();
    const copy = new Mesh(this.geometry, this.material);
    copy.frustumCulled = false;
    scene.add(copy);
    const generator = new PMREMGenerator(renderer);
    this.environment = generator.fromScene(scene, 0.02);
    generator.dispose();
    this.set(atmosphere, atmosphere.disc);
    return this.environment.texture;
  }

  dispose(): void {
    this.environment?.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Toward a time of day's shadow-casting light, as a unit vector. */
export const lightDirection = (atmosphere: Atmosphere): Vector3 => direction(atmosphere.light);
