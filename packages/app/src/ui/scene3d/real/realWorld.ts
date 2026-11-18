/**
 * The realistic 3D scene (Phase 8), in Three.js: the same run the low-poly scene draws (world.ts), with
 * physical materials lit by the sky, soft shadows from the sun, glTF models, asphalt that is dry, wet or iced by its
 * friction, trees and posts beside the road, and a pass of bloom and tone mapping over the frame. It draws what a
 * frame holds and computes no physics; what it adds for the eye alone (the body's lean, a figure's stride) it derives
 * from the frame's own values.
 *
 * The plans, the rings under the obstacles and the ghost's dashed outline are the signs of the low-poly scene, kept as
 * they are: unlit, on the ground, and never told apart by color alone. As there, everything flat lies at height 0,
 * writes no depth and is ordered by `renderOrder`.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  FogExp2,
  Group,
  HalfFloatType,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  NeutralToneMapping,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  Scene,
  SpotLight,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  type Material,
  type Texture,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import type { SceneInfo } from '@mpc-simulator/worker';

import type { FrameView, VehicleView } from '../../../sim/frame.ts';
import type { RoadGeometry } from '../../roadGeometry.ts';
import { chaseCamera, SHAKE_SECONDS, shakeOffset } from '../camera.ts';
import { dashMesh, ribbonIndices, ringMesh, stripMesh, writeRibbon, type FlatMesh } from '../geometry.ts';
import { Resources } from '../models.ts';
import { SCENE_DARK, SCENE_LIGHT } from '../palette.ts';
import type { Inspection, World } from '../types.ts';
import { instantiate, Models, type ModelName } from './assets.ts';
import { bakeAsphalt, bakeIce, bakeVerge, bakeZoneEdge, type SurfaceTextures } from './bake.ts';
import { posts, trees } from './dressing.ts';
import {
  groundGeometry,
  LongRoad,
  softShadow,
  straightDashes,
  straightStrip,
  surfaceKind,
  zoneMesh,
  type SurfaceKind,
} from './ground.ts';
import { Materials, type MaterialSet } from './materials.ts';
import { CAR, CAR_PARTS, MOOSE, TRUCK } from './nominal.ts';
import { DAY, DUSK, lightDirection, Sky, type Atmosphere } from './sky.ts';

/** The order of what lies on the ground, from the bottom up; the solid things above it are drawn after, at 0. */
const ORDER = {
  ground: -20,
  road: -19,
  zone: -18,
  line: -16,
  chosenEdge: -12,
  chosen: -11,
  ring: -10,
  plan: -9,
  shadow: -8,
  ghost: 1,
} as const;

/** Half the width of the plans' ribbons, m, and the length of a dash and its gap on the plans not chosen. */
const CHOSEN_HALF = 0.3;
const CHOSEN_EDGE_HALF = 0.4;
const OTHER_HALF = 0.09;
const DASH_PERIOD = 1.6;

/** The side of a texture's tile on the ground, m, and of the ground itself. */
const TILE = { asphalt: 3, ice: 4, verge: 10 } as const;
const GROUND = 6000;
/** How far the road is carried on, straight, before its start and after its end, m. */
const CARRY = { before: 82.5, after: 300 } as const;
/** The lane's lines: a dash and the gap after it, m, the width of a dashed line and of an edge line. */
const LINE = { dash: 3, gap: 4.5, width: 0.14, edge: 0.15 } as const;

/** The shadows: half the side of the square they cover, how far ahead of the vehicle its middle is, and the sun's distance. */
const SHADOW = { half: 30, ahead: 16, distance: 120, size: 2048 } as const;

/** The body's lean for effect: rad for each m/s² across and along, its limits, and how fast it follows, ms. */
const LEAN = { roll: 0.0085, pitch: 0.0035, maxRoll: 0.09, maxPitch: 0.045, follow: 120 } as const;
/** The tail lamps go on under this deceleration, m/s², and off again above the second. */
const BRAKING = { on: -1.2, off: -0.6 } as const;

interface Ribbon {
  mesh: Mesh;
  positions: Float32Array;
  position: BufferAttribute;
  uvs: Float32Array | null;
  uv: BufferAttribute | null;
}

interface VehicleHandle {
  /** At the center of gravity, turned to the heading. */
  pose: Group;
  /** What leans with the accelerations. */
  body: Object3D;
  steered: Object3D[];
  spins: Object3D[];
  radius: number;
  roll: number;
  pitch: number;
  rollTo: number;
  pitchTo: number;
}

interface Limb {
  node: Object3D;
  /** Its swing at the top of a stride, rad: legs of a pair have opposite signs. */
  swing: number;
}

interface ObstacleHandle {
  /** At the obstacle, not turned: the rings and the model's holder. */
  holder: Group;
  model: Object3D;
  crossing: boolean;
  /** The turn from the road's heading to the way the model faces, rad; null until it is first placed. */
  facing: number | null;
  lastEy: number;
  ringOn: Mesh;
  ringOff: Mesh;
  limbs: Limb[];
  /** Meters walked for one full swing of the limbs, and where the figure is in it, rad. */
  stride: number;
  phase: number;
  /** How much the limbs swing, 0 at rest to 1 walking, and where that is going. */
  gait: number;
  gaitTo: number;
}

/** The models a run needs: the vehicle's, and one for each kind of obstacle that has a model. */
function modelsFor(info: SceneInfo): ModelName[] {
  const names = new Set<ModelName>([info.vehicle.id === 'truck' ? 'truck' : 'car']);
  for (const spec of info.obstacles) {
    if (spec.kind === 'pedestrian') names.add('pedestrian');
    else if (spec.kind === 'animal') names.add('moose');
    else if (spec.length >= 2.5) names.add('car');
  }
  return [...names];
}

/** Something flat and unlit on the ground: a plan, a ring. Drawn with the transparent things, in its order. */
const sign = (options: ConstructorParameters<typeof MeshBasicMaterial>[0] = {}) =>
  new MeshBasicMaterial({ side: DoubleSide, depthWrite: false, transparent: true, ...options });

const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));

export class RealWorld implements World {
  stale = true;

  private readonly renderer: WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(48, 1, 0.5, 900);
  private readonly sky = new Sky();
  private readonly fog = new FogExp2(0, 0.004);
  private readonly sun = new DirectionalLight();
  /** The vehicle's headlamps, lit at dusk: they travel with the ego. */
  private readonly beams = [new SpotLight(0xfff1d6), new SpotLight(0xfff1d6)];
  private readonly models: Models;
  private readonly materials = new Materials();
  /** What lives as long as the world, and what a run's scene holds. */
  private readonly base = new Resources();
  private readonly content = new Resources();
  private readonly asphalt: SurfaceTextures;
  private readonly ice: SurfaceTextures;
  private readonly verge: SurfaceTextures;

  private readonly road_: MeshStandardMaterial;
  private readonly line: MeshStandardMaterial;
  private readonly trunk = new MeshStandardMaterial({ color: 0x3b2a1e, roughness: 1 });
  private readonly foliage = new MeshStandardMaterial({ color: 0x4a6b4e, roughness: 1 });
  private readonly post = new MeshStandardMaterial({ color: 0xe9ebe6, roughness: 0.5 });
  private readonly reflector = new MeshStandardMaterial({ color: 0xffffff, emissive: 0xffa53a, roughness: 0.3 });
  private readonly box = new MeshStandardMaterial({ color: 0x2b302a, roughness: 0.7 });
  private readonly ringOn = sign();
  private readonly ringOff = sign();
  private readonly plan: MeshBasicMaterial;
  private readonly chosen = sign();
  private readonly chosenEdge = sign();
  private readonly contact: MeshBasicMaterial;

  private readonly toLight = new Vector3(0, 1, 0);
  private readonly lightRight = new Vector3(1, 0, 0);
  private readonly lightUp = new Vector3(0, 0, 1);
  private level = 0;
  private reduced = false;
  private braking = false;

  private info: SceneInfo | null = null;
  private road: RoadGeometry | null = null;
  private root: Group | null = null;
  private egoHandle: VehicleHandle | null = null;
  private ghostHandle: VehicleHandle | null = null;
  private obstacles: ObstacleHandle[] = [];
  private others: Ribbon[] = [];
  private chosenFill: Ribbon | null = null;
  private chosenRim: Ribbon | null = null;

  private readonly cameraPose = new Float64Array(6);
  private readonly anchor = { x: 0, y: 0, heading: 0 };
  private readonly offset = { side: 0, up: 0 };
  private readonly point = new Vector3();
  private shakeAge = SHAKE_SECONDS;
  private view: Inspection | null = null;

  /** Throws when the browser gives no WebGL context, or one that cannot draw this scene: the caller falls back. */
  constructor(canvas: HTMLCanvasElement, dark: boolean, models: Models) {
    this.models = models;
    const renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      stencil: true,
      powerPreference: 'high-performance',
    });
    this.renderer = renderer;
    // The frame is drawn in half floats (the sky and the lamps are brighter than white) before it is tone mapped.
    if (!renderer.extensions.has('EXT_color_buffer_float') && !renderer.extensions.has('EXT_color_buffer_half_float')) {
      renderer.dispose();
      throw new Error('This GPU does not draw to floating-point targets.');
    }
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    // The neutral curve keeps a color as it is until it is very bright: the brand's green stays the brand's green.
    renderer.toneMapping = NeutralToneMapping;

    // Four samples a pixel smooth the edges. Only the color is resolved for the passes that follow: resolving the
    // depth and the stencil too, which nothing reads, costs several milliseconds a frame on some drivers.
    const target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      samples: 4,
      stencilBuffer: true,
      resolveDepthBuffer: false,
      resolveStencilBuffer: false,
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), 0.2, 0.3, 1);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.asphalt = bakeAsphalt(renderer);
    this.ice = bakeIce(renderer);
    this.verge = bakeVerge(renderer);
    for (const texture of [this.verge.map, this.verge.normalMap]) texture.repeat.setScalar(GROUND / TILE.verge);

    this.road_ = new MeshStandardMaterial({
      map: this.asphalt.map,
      normalMap: this.asphalt.normalMap,
      roughness: 0.92,
      depthWrite: false,
    });
    this.line = new MeshStandardMaterial({ color: 0xd9dbd4, roughness: 0.6, transparent: true, depthWrite: false });
    const groundMaterial = new MeshStandardMaterial({
      map: this.verge.map,
      normalMap: this.verge.normalMap,
      roughness: 1,
      depthWrite: false,
    });

    // Two texels, one opaque and one clear: repeated along a ribbon by its distance, they dash it.
    const dash = this.base.track(new DataTexture(new Uint8Array([255, 255, 255, 255, 255, 255, 255, 0]), 2, 1));
    dash.wrapS = RepeatWrapping;
    dash.magFilter = NearestFilter;
    dash.minFilter = NearestFilter;
    dash.needsUpdate = true;
    this.plan = sign({ map: dash, opacity: 0.85, alphaTest: 0.5 });
    this.contact = sign({ color: 0x000000, alphaMap: this.base.track(softShadow()), opacity: 0.45 });

    for (const material of [
      this.road_,
      this.line,
      groundMaterial,
      this.trunk,
      this.foliage,
      this.post,
      this.reflector,
      this.box,
      this.ringOn,
      this.ringOff,
      this.plan,
      this.chosen,
      this.chosenEdge,
      this.contact,
    ]) {
      this.base.track(material);
    }

    this.scene.fog = this.fog;
    this.scene.add(this.sky.dome);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.setScalar(SHADOW.size);
    this.sun.shadow.camera.left = -SHADOW.half;
    this.sun.shadow.camera.right = SHADOW.half;
    this.sun.shadow.camera.top = SHADOW.half;
    this.sun.shadow.camera.bottom = -SHADOW.half;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 2 * SHADOW.distance;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);
    for (const beam of this.beams) {
      beam.angle = 0.5;
      beam.penumbra = 0.8;
      beam.distance = 160;
      beam.decay = 1.4;
      beam.intensity = 420;
    }

    const plane = this.base.track(new PlaneGeometry(GROUND, GROUND));
    plane.rotateX(-Math.PI / 2);
    const ground = new Mesh(plane, groundMaterial);
    ground.renderOrder = ORDER.ground;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.setTheme(dark);
  }

  /** Loads the models a run needs, builds its scene and has the GPU ready its programs, before the first frame. */
  async prepare(info: SceneInfo, road: RoadGeometry): Promise<void> {
    await this.models.load(modelsFor(info));
    this.load(info, road);
    await this.warm();
  }

  /**
   * Has the GPU ready the programs of everything in the scene, also of what is not shown yet (the plans, the ghost, a
   * ring): made while the scene waits, they do not stall the frame in which each first appears. The programs are
   * those of the frame's own target, not of the canvas.
   */
  private warm(): Promise<void> {
    const hidden: Object3D[] = [];
    this.root?.traverse((object) => {
      // A lamp that is out stays out: the lights that are lit are part of every program.
      if (object.visible || (object as SpotLight).isLight) return;
      hidden.push(object);
      object.visible = true;
    });
    const before = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.composer.readBuffer);
    const ready = this.renderer.compileAsync(this.scene, this.camera);
    this.renderer.setRenderTarget(before);
    for (const object of hidden) object.visible = false;
    return ready.then(
      () => undefined,
      () => undefined,
    );
  }

  setTheme(dark: boolean): void {
    const atmosphere: Atmosphere = dark ? DUSK : DAY;
    this.scene.environment = this.sky.apply(this.renderer, atmosphere);
    this.scene.environmentIntensity = atmosphere.ambient;
    this.fog.color.setHex(atmosphere.fog);
    this.fog.density = atmosphere.fogDensity;
    this.sun.color.setHex(atmosphere.lightColor);
    this.sun.intensity = atmosphere.lightPower;
    this.toLight.copy(lightDirection(atmosphere));
    this.lightRight.set(0, 1, 0).cross(this.toLight).normalize();
    this.lightUp.copy(this.toLight).cross(this.lightRight);

    this.materials.setDusk(atmosphere.lamps);
    for (const beam of this.beams) beam.visible = atmosphere.lamps;
    this.reflector.emissiveIntensity = atmosphere.lamps ? 1.5 : 0.15;
    this.renderer.toneMappingExposure = atmosphere.exposure;
    this.bloom.strength = atmosphere.lamps ? 0.45 : 0.18;
    this.bloom.threshold = atmosphere.lamps ? 0.9 : 1;

    // The signs on the ground: the brand's green for what the MPC chose, a light neutral for the rest, on dark asphalt.
    const palette = dark ? SCENE_DARK : SCENE_LIGHT;
    this.chosen.color.setHex(palette.chosen);
    this.chosenEdge.color.setHex(palette.chosenEdge);
    this.ringOn.color.setHex(palette.chosen);
    this.plan.color.setHex(SCENE_DARK.plan);
    this.ringOff.color.setHex(SCENE_DARK.plan);
    this.stale = true;
  }

  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced;
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.stale = true;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    // A tall view sees less to its sides: a wider angle keeps the whole road in it.
    this.camera.fov = this.camera.aspect < 1 ? 60 : 48;
    this.camera.updateProjectionMatrix();
  }

  /** Gives up the bloom and half of the shadows' sharpness, once; after that there is nothing left to give up here. */
  degrade(): boolean {
    if (this.level > 0) return false;
    this.level = 1;
    this.bloom.enabled = false;
    this.sun.shadow.mapSize.setScalar(SHADOW.size / 2);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.stale = true;
    return true;
  }

  inspect(view: Inspection | null): void {
    this.view = view;
    this.stale = true;
  }

  /** The material of a zone of the road by what it is, with the mask of its ragged edge. */
  private zone(kind: SurfaceKind, edge: Texture): { material: MeshStandardMaterial; tile: number } {
    const common = { alphaMap: edge, transparent: true, depthWrite: false };
    if (kind === 'ice') {
      const material = new MeshStandardMaterial({
        map: this.ice.map,
        normalMap: this.ice.normalMap,
        normalScale: new Vector2(0.6, 0.6),
        ...(this.ice.roughnessMap ? { roughnessMap: this.ice.roughnessMap } : {}),
        roughness: 1,
        envMapIntensity: 1.25,
        ...common,
      });
      return { material, tile: TILE.ice };
    }
    // Wet asphalt is the same asphalt, darker and smooth enough to mirror the sky; dry, it is the road's own.
    const wet = kind === 'wet';
    const material = new MeshStandardMaterial({
      map: this.asphalt.map,
      normalMap: this.asphalt.normalMap,
      normalScale: new Vector2(wet ? 0.35 : 1, wet ? 0.35 : 1),
      color: wet ? 0x8e949c : 0xffffff,
      roughness: wet ? 0.12 : 0.92,
      envMapIntensity: wet ? 1.2 : 1,
      ...common,
    });
    return { material, tile: TILE.asphalt };
  }

  load(info: SceneInfo, road: RoadGeometry): void {
    if (info === this.info) return;
    this.unload();
    this.stale = true;
    this.info = info;
    this.road = road;
    const needed = modelsFor(info);
    if (!this.models.has(needed)) {
      // A model of this run is still on its way: the scene is built with those at hand, and again when it is here.
      void this.models.load(needed).then(
        () => {
          if (this.info !== info) return;
          this.info = null;
          this.load(info, road);
        },
        () => undefined,
      );
    }
    const root = new Group();
    this.root = root;
    const R = this.content;

    const lit = (flat: FlatMesh, material: Material, order: number, tile: number, local?: Float32Array) => {
      const mesh = new Mesh(R.track(groundGeometry(flat, tile, local)), material);
      mesh.renderOrder = order;
      mesh.receiveShadow = true;
      root.add(mesh);
    };
    const flatSign = (flat: FlatMesh, material: Material, order: number, parent: Object3D) => {
      const geometry = R.track(new BufferGeometry());
      geometry.setAttribute('position', new BufferAttribute(flat.positions, 3));
      geometry.setIndex(flat.indices);
      const mesh = new Mesh(geometry, material);
      mesh.renderOrder = order;
      parent.add(mesh);
      return mesh;
    };

    // The road over its whole width, as its base surface is, then each zone that is something else.
    const left = info.width.left;
    const right = -info.width.right;
    const base = surfaceKind(info.surface.base.mu);
    // Past its two ends the road goes straight on, so that the scene does not stop where the run does.
    const long = new LongRoad(road, CARRY.before, CARRY.after);
    const ends = [
      [long.from, 0],
      [road.length, long.to],
    ] as const;
    lit(stripMesh(road, 0, road.length, right, left), this.road_, ORDER.road, TILE.asphalt);
    for (const [s0, s1] of ends) lit(straightStrip(long, s0, s1, right, left), this.road_, ORDER.road, TILE.asphalt);
    const zones = [
      ...(base === 'dry' ? [] : [{ from: 0, to: road.length, side: 'both' as const, mu: info.surface.base.mu }]),
      ...info.surface.zones.filter((zone) => surfaceKind(zone.mu) !== base),
    ];
    for (const zone of zones) {
      const e0 = zone.side === 'left' ? 0 : right;
      const e1 = zone.side === 'right' ? 0 : left;
      const from = Math.max(0, zone.from);
      const to = Math.min(road.length, zone.to);
      if (to <= from) continue;
      const { flat, local } = zoneMesh(road, from, to, e0, e1);
      const edge = R.track(bakeZoneEdge(this.renderer, to - from, e1 - e0));
      const { material, tile } = this.zone(surfaceKind(zone.mu), edge.texture);
      lit(flat, R.track(material), ORDER.zone, tile, local);
    }

    // The road's edges (solid) and the ego lane's two lines (dashed), where they are not an edge already.
    lit(stripMesh(road, 0, road.length, left - LINE.edge, left), this.line, ORDER.line, 1);
    lit(stripMesh(road, 0, road.length, right, right + LINE.edge), this.line, ORDER.line, 1);
    for (const [s0, s1] of ends) {
      lit(straightStrip(long, s0, s1, left - LINE.edge, left), this.line, ORDER.line, 1);
      lit(straightStrip(long, s0, s1, right, right + LINE.edge), this.line, ORDER.line, 1);
    }
    for (const side of [1, -1]) {
      const ey = info.lane.center + (side * info.lane.width) / 2;
      if (Math.abs(ey - left) < 0.3 || Math.abs(ey - right) < 0.3) continue;
      lit(dashMesh(road, 0, road.length, ey, LINE.dash, LINE.gap, LINE.width), this.line, ORDER.line, 1);
      for (const [s0, s1] of ends) {
        lit(straightDashes(long, s0, s1, ey, LINE.dash, LINE.gap, LINE.width), this.line, ORDER.line, 1);
      }
    }

    root.add(...trees(R, long, left, info.width.right, this.trunk, this.foliage));
    root.add(...posts(R, long, left, info.width.right, this.post, this.reflector));

    // The plans: one thin dashed ribbon for each candidate, and the chosen one's wide ribbon with its rim.
    const points = info.frame.planPoints;
    this.chosenRim = this.ribbon(points, this.chosenEdge, ORDER.chosenEdge, false);
    this.chosenFill = this.ribbon(points, this.chosen, ORDER.chosen, false);
    this.others = Array.from({ length: 4 }, () => this.ribbon(points, this.plan, ORDER.plan, true));

    this.obstacles = info.obstacles.map((spec) => {
      const holder = new Group();
      const made = this.obstacle(spec);
      holder.add(made.model);
      const radius = Math.max(1.3, Math.hypot(spec.length, spec.width) / 2 + 0.5);
      const ringOn = flatSign(ringMesh(radius - 0.09, radius + 0.09, 48), this.ringOn, ORDER.ring, holder);
      const ringOff = flatSign(ringMesh(radius - 0.07, radius + 0.07, 48, 12), this.ringOff, ORDER.ring, holder);
      const patch = 1.3 * Math.max(spec.length, spec.width);
      holder.add(this.blob(patch, patch));
      root.add(holder);
      return { holder, ...made, facing: null, lastEy: 0, ringOn, ringOff, phase: 0, gait: 0, gaitTo: 0 };
    });

    // The ghost translucent with its dashed outline, the ego whole, with the shadow under it and its lamps.
    this.ghostHandle = this.vehicle(info, this.materials.ghost, false);
    if (this.ghostHandle) {
      this.ghostHandle.pose.renderOrder = ORDER.ghost;
      this.ghostHandle.pose.visible = false;
    }
    this.egoHandle = this.vehicle(info, this.materials.ego, true);
    if (this.egoHandle) {
      const { length, width, bodyOffset } = info.vehicle;
      this.beams.forEach((beam, i) => {
        const z = (i === 0 ? -1 : 1) * 0.32 * width;
        beam.position.set(bodyOffset + length / 2 - 0.15, 0.68, z);
        beam.target.position.set(bodyOffset + length / 2 + 30, -0.4, 1.4 * z);
        this.egoHandle?.pose.add(beam, beam.target);
      });
    }

    this.scene.add(root);
    void this.warm();
  }

  /** A soft dark patch on the ground, `length` by `width` m: what stands on it looks set down, not floating. */
  private blob(length: number, width: number): Mesh {
    const plane = this.content.track(new PlaneGeometry(length, width));
    plane.rotateX(-Math.PI / 2);
    const mesh = new Mesh(plane, this.contact);
    mesh.renderOrder = ORDER.shadow;
    return mesh;
  }

  /** A vehicle of the run's size: a copy of its model, the body scaled to the size and the wheels set at the track. */
  private vehicle(info: SceneInfo, set: MaterialSet, ego: boolean): VehicleHandle | null {
    const truck = info.vehicle.id === 'truck';
    const template = this.models.get(truck ? 'truck' : 'car');
    if (!template) return null;
    const { length, width, track, bodyOffset } = info.vehicle;
    // The ghost is the same car with the baseline at the wheel: it has the kit, and no lettering to blur its shell.
    const without = ego ? [] : [CAR_PARTS.livery];
    const model = instantiate(template, set, { outline: !ego, shadows: ego, without });
    const fitted = this.fit(model, truck ? TRUCK : CAR, length, width, track, truck);
    model.position.x = bodyOffset;
    const pose = new Group();
    pose.add(model);
    if (ego) {
      const blob = this.blob(1.1 * length, 1.25 * width);
      blob.position.x = bodyOffset;
      pose.add(blob);
    }
    this.root?.add(pose);
    return { pose, ...fitted, roll: 0, pitch: 0, rollTo: 0, pitchTo: 0 };
  }

  private fit(
    model: Object3D,
    nominal: typeof CAR | typeof TRUCK,
    length: number,
    width: number,
    track: number,
    truck: boolean,
  ): Pick<VehicleHandle, 'body' | 'steered' | 'spins' | 'radius'> {
    const along = length / nominal.length;
    const across = width / nominal.width;
    const body = model.getObjectByName('body') ?? model;
    // A wider car of the core is a taller one; a truck keeps its height.
    body.scale.set(along, truck ? 1 : 1 + Math.max(0, width - nominal.width) * 0.45, across);
    const steered: Object3D[] = [];
    const spins: Object3D[] = [];
    for (const [name, ahead, side] of [
      ['wheel_fl', 1, -1],
      ['wheel_fr', 1, 1],
      ['wheel_rl', -1, -1],
      ['wheel_rr', -1, 1],
    ] as const) {
      const wheel = model.getObjectByName(name);
      const spin = model.getObjectByName(`${name}_spin`);
      if (!wheel || !spin) continue;
      wheel.position.set(ahead * nominal.axle * along, nominal.wheelRadius, (side * track) / 2);
      if (ahead > 0) steered.push(wheel);
      spins.push(spin);
    }
    return { body, steered, spins, radius: nominal.wheelRadius };
  }

  /** An obstacle's model by its kind, to the footprint the scenario gives: `length` along the road, `width` across. */
  private obstacle(
    spec: SceneInfo['obstacles'][number],
  ): Pick<ObstacleHandle, 'model' | 'crossing' | 'limbs' | 'stride'> {
    const limbs = (model: Object3D, pairs: readonly (readonly [string, number])[]): Limb[] =>
      pairs.flatMap(([name, swing]) => {
        const node = model.getObjectByName(name);
        return node ? [{ node, swing }] : [];
      });
    const person = spec.kind === 'pedestrian' ? this.models.get('pedestrian') : undefined;
    if (person) {
      const model = instantiate(person, this.materials.figure, { outline: false, shadows: true });
      const moved = limbs(model, [
        ['leg_l', 0.5],
        ['leg_r', -0.5],
        ['arm_l', -0.4],
        ['arm_r', 0.4],
      ]);
      return { model, crossing: true, limbs: moved, stride: 1.5 };
    }
    const moose = spec.kind === 'animal' ? this.models.get('moose') : undefined;
    if (moose) {
      const model = instantiate(moose, this.materials.figure, { outline: false, shadows: true });
      // It crosses the road: its length is the obstacle's width.
      model.scale.set(spec.width / MOOSE.length, 1, spec.length / MOOSE.width);
      const moved = limbs(model, [
        ['leg_fl', 0.36],
        ['leg_rr', 0.36],
        ['leg_fr', -0.36],
        ['leg_rl', -0.36],
      ]);
      return { model, crossing: true, limbs: moved, stride: 2.2 };
    }
    const car = spec.length >= 2.5 ? this.models.get('car') : undefined;
    if (car && spec.kind !== 'pedestrian' && spec.kind !== 'animal') {
      // A car that only stands on the road is anyone's: no sensor kit and no lettering.
      const without = [CAR_PARTS.sensors, CAR_PARTS.livery];
      const model = instantiate(car, this.materials.traffic, { outline: false, shadows: true, without });
      this.fit(model, CAR, spec.length, spec.width, (CAR.track * spec.width) / CAR.width, false);
      return { model, crossing: false, limbs: [], stride: 1 };
    }
    // Anything else, or a model that is still on its way: a plain block of the obstacle's footprint.
    const block = new Mesh(this.content.track(new BoxGeometry(spec.length, 1, spec.width)), this.box);
    block.position.y = 0.5;
    block.castShadow = true;
    const model = new Group();
    model.add(block);
    return { model, crossing: spec.kind === 'pedestrian' || spec.kind === 'animal', limbs: [], stride: 1 };
  }

  private ribbon(points: number, material: Material, order: number, dashed: boolean): Ribbon {
    const geometry = this.content.track(new BufferGeometry());
    const positions = new Float32Array(6 * points);
    const position = new BufferAttribute(positions, 3);
    position.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', position);
    let uvs: Float32Array | null = null;
    let uv: BufferAttribute | null = null;
    if (dashed) {
      uvs = new Float32Array(4 * points);
      uv = new BufferAttribute(uvs, 2);
      uv.setUsage(DynamicDrawUsage);
      geometry.setAttribute('uv', uv);
    }
    geometry.setIndex(ribbonIndices(points));
    const mesh = new Mesh(geometry, material);
    // Its vertices move every frame: no bounds to cull it by.
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    mesh.visible = false;
    this.root?.add(mesh);
    return { mesh, positions, position, uvs, uv };
  }

  private unload(): void {
    // The headlamps outlive a run's scene: they leave it before it is freed.
    for (const beam of this.beams) {
      beam.removeFromParent();
      beam.target.removeFromParent();
    }
    if (this.root) this.scene.remove(this.root);
    this.content.dispose();
    this.root = null;
    this.info = null;
    this.road = null;
    this.egoHandle = null;
    this.ghostHandle = null;
    this.obstacles = [];
    this.others = [];
    this.chosenFill = null;
    this.chosenRim = null;
    this.shakeAge = SHAKE_SECONDS;
    this.braking = false;
    this.materials.setBraking(false);
  }

  update(frame: FrameView): void {
    const info = this.info;
    const road = this.road;
    if (!info || !road) return;

    const place = (handle: VehicleHandle, v: VehicleView) => {
      handle.pose.position.set(v.x, 0, -v.y);
      handle.pose.rotation.y = v.psi;
      for (const pivot of handle.steered) pivot.rotation.y = v.steer;
      // A wheel that rolls forward turns the other way about Z; the angle is the distance over the radius.
      const angle = -((v.s / handle.radius) % (2 * Math.PI));
      for (const spin of handle.spins) spin.rotation.z = angle;
      // The body leans away from a turn and dips under braking: an effect for the eye, from the frame's accelerations.
      handle.rollTo = this.reduced ? 0 : clamp(v.ay * LEAN.roll, LEAN.maxRoll);
      handle.pitchTo = this.reduced ? 0 : clamp(v.ax * LEAN.pitch, LEAN.maxPitch);
    };
    if (this.egoHandle) place(this.egoHandle, frame.ego);
    if (this.ghostHandle) {
      this.ghostHandle.pose.visible = frame.hasGhost;
      if (frame.hasGhost) place(this.ghostHandle, frame.ghost);
    }
    if (frame.ego.ax < BRAKING.on) this.braking = true;
    else if (frame.ego.ax > BRAKING.off) this.braking = false;
    this.materials.setBraking(this.braking);

    frame.obstacles.forEach((o, i) => {
      const handle = this.obstacles[i];
      if (!handle) return;
      handle.holder.position.set(o.x, 0, -o.y);
      handle.ringOn.visible = o.detected;
      handle.ringOff.visible = !o.detected;
      const moved = Math.abs(o.ey - handle.lastEy) > 1e-4;
      if (handle.crossing) {
        // It faces the way it crosses: toward the ego's lane until it moves, then the way it moves.
        if (handle.facing === null) handle.facing = o.ey < info.lane.center ? Math.PI / 2 : -Math.PI / 2;
        else if (moved) handle.facing = o.ey > handle.lastEy ? Math.PI / 2 : -Math.PI / 2;
        // Its stride is where it is across the road: the same place, the same pose, in a replay as in the run.
        handle.phase = (o.ey / handle.stride) * 2 * Math.PI;
        handle.gaitTo = moved ? 1 : 0;
      }
      handle.lastEy = o.ey;
      handle.model.rotation.y = o.heading + (handle.facing ?? 0);
    });

    let chosen = false;
    frame.plans.forEach((plan, b) => {
      const other = this.others[b];
      if (!other) return;
      other.mesh.visible = plan.solved && !plan.chosen;
      if (!plan.solved) return;
      if (plan.chosen && this.chosenFill && this.chosenRim) {
        chosen = true;
        writeRibbon(plan.points, CHOSEN_HALF, this.chosenFill.positions);
        writeRibbon(plan.points, CHOSEN_EDGE_HALF, this.chosenRim.positions);
        this.chosenFill.position.needsUpdate = true;
        this.chosenRim.position.needsUpdate = true;
      } else if (other.uvs && other.uv) {
        writeRibbon(plan.points, OTHER_HALF, other.positions, other.uvs, DASH_PERIOD);
        other.position.needsUpdate = true;
        other.uv.needsUpdate = true;
      }
    });
    if (this.chosenFill) this.chosenFill.mesh.visible = chosen;
    if (this.chosenRim) this.chosenRim.mesh.visible = chosen;

    this.anchor.x = frame.ego.x;
    this.anchor.y = frame.ego.y;
    this.anchor.heading = road.headingAt(frame.ego.s);
  }

  shake(): void {
    this.shakeAge = 0;
  }

  /** Brings what follows by itself (a body's lean, a figure's gait) closer to where it is going; true while it moves. */
  private settle(elapsed: number): boolean {
    const share = 1 - Math.exp(-Math.max(elapsed, 0) / LEAN.follow);
    let moving = false;
    const toward = (from: number, to: number): number => {
      if (Math.abs(to - from) < 1e-4) return to;
      moving = true;
      return from + (to - from) * share;
    };
    for (const handle of [this.egoHandle, this.ghostHandle]) {
      if (!handle) continue;
      handle.roll = toward(handle.roll, handle.rollTo);
      handle.pitch = toward(handle.pitch, handle.pitchTo);
      handle.body.rotation.x = handle.roll;
      handle.body.rotation.z = handle.pitch;
    }
    for (const handle of this.obstacles) {
      handle.gait = toward(handle.gait, handle.gaitTo);
      const swing = Math.sin(handle.phase) * handle.gait;
      for (const limb of handle.limbs) limb.node.rotation.z = limb.swing * swing;
    }
    return moving;
  }

  /** The shadows cover a square around a point ahead of the vehicle, moved a whole texel at a time so they do not swim. */
  private aimSun(): void {
    const { x, y, heading } = this.anchor;
    this.point.set(x + Math.cos(heading) * SHADOW.ahead, 0, -(y + Math.sin(heading) * SHADOW.ahead));
    const texel = (2 * SHADOW.half) / this.sun.shadow.mapSize.x;
    const right = Math.round(this.point.dot(this.lightRight) / texel) * texel;
    const up = Math.round(this.point.dot(this.lightUp) / texel) * texel;
    const toward = this.point.dot(this.toLight);
    this.point.set(0, 0, 0).addScaledVector(this.lightRight, right).addScaledVector(this.lightUp, up);
    this.point.addScaledVector(this.toLight, toward);
    this.sun.target.position.copy(this.point);
    this.sun.position.copy(this.point).addScaledVector(this.toLight, SHADOW.distance);
    this.sun.target.updateMatrixWorld();
  }

  render(elapsed: number): boolean {
    const moving = this.settle(elapsed);
    const c = this.cameraPose;
    chaseCamera(this.anchor.x, this.anchor.y, this.anchor.heading, c);
    let x = c[0] ?? 0;
    let y = c[1] ?? 0;
    let z = c[2] ?? 0;
    if (this.shakeAge < SHAKE_SECONDS) {
      shakeOffset(this.shakeAge, this.offset);
      // The camera's right, on the ground: the right of the heading, (sin, −cos) in the simulation's axes.
      x += Math.sin(this.anchor.heading) * this.offset.side;
      z += Math.cos(this.anchor.heading) * this.offset.side;
      y += this.offset.up;
      this.shakeAge += Math.max(elapsed, 0) / 1000;
    }
    this.camera.position.set(x, y, z);
    this.camera.lookAt(c[3] ?? 0, c[4] ?? 0, c[5] ?? 0);
    if (this.view) this.lookFrom(this.view);
    this.aimSun();
    this.composer.render();
    this.stale = false;
    return moving || this.shakeAge < SHAKE_SECONDS;
  }

  /** The camera of an inspection: around its target, turned with the road so that 0° is straight behind. */
  private lookFrom(view: Inspection): void {
    const target = view.target === 'ego' ? this.egoHandle?.pose : this.obstacles[view.target]?.holder;
    if (!target) return;
    const around = (view.azimuth * Math.PI) / 180 + this.anchor.heading + Math.PI;
    const above = (view.elevation * Math.PI) / 180;
    const flat = view.distance * Math.cos(above);
    this.camera.position.set(
      target.position.x + flat * Math.cos(around),
      0.7 + view.distance * Math.sin(above),
      target.position.z - flat * Math.sin(around),
    );
    this.camera.lookAt(target.position.x, 0.7, target.position.z);
  }

  dispose(): void {
    this.unload();
    this.base.dispose();
    for (const textures of [this.asphalt, this.ice, this.verge]) textures.dispose();
    this.sky.dispose();
    this.materials.dispose();
    this.models.dispose();
    this.sun.shadow.map?.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

/**
 * Makes the realistic scene on `canvas`, with the models of its first run loaded and its programs ready. Rejects when
 * the browser cannot draw it or a model does not load: the caller then draws the low-poly scene.
 */
export async function createRealWorld(
  canvas: HTMLCanvasElement,
  dark: boolean,
  info: SceneInfo,
  road: RoadGeometry,
): Promise<RealWorld> {
  // The models are on their way while the scene is made: neither waits for the other.
  const models = new Models();
  models.load(modelsFor(info)).catch(() => undefined);
  const world = new RealWorld(canvas, dark, models);
  try {
    await world.prepare(info, road);
  } catch (error) {
    world.dispose();
    throw error;
  }
  return world;
}
