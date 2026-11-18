/**
 * The 3D scene (Phase 4) in Three.js: the road with its surfaces colored by their friction, the lane, the
 * vehicles, the obstacles and the plans of the candidate maneuvers (the chosen one a wide green ribbon, the others thin
 * and dashed), seen from a camera behind the ego. It draws what a frame holds and computes no physics.
 *
 * As in the top view, color never carries a meaning alone: the ghost is translucent with a dashed outline, a slippery
 * zone is hatched, an obstacle's ring is solid when the sensor tracks it and dashed when it does not.
 *
 * Everything flat lies on the ground at height 0 and writes no depth: its order is `renderOrder` (ORDER), so nothing
 * flickers against the road however far it is, and the vehicles and the obstacles, drawn after, still cover it.
 */
import {
  AlwaysStencilFunc,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  LineDashedMaterial,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NearestFilter,
  NotEqualStencilFunc,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  ReplaceStencilOp,
  Scene,
  WebGLRenderer,
  type Material,
} from 'three';

import type { SceneInfo } from '@mpc-simulator/worker';

import type { FrameView, VehicleView } from '../../sim/frame.ts';
import type { RoadGeometry } from '../roadGeometry.ts';
import { chaseCamera, SHAKE_SECONDS, shakeOffset } from './camera.ts';
import { dashMesh, hatchMesh, ribbonIndices, ringMesh, stripMesh, writeRibbon, type FlatMesh } from './geometry.ts';
import { obstacleModel, Resources, vehicleModel, type VehicleMaterials } from './models.ts';
import { SCENE_DARK, SCENE_LIGHT, slipperiness, type ScenePalette } from './palette.ts';

/** The order of what lies on the ground, from the bottom up; the solid things above it are drawn after, at 0. */
const ORDER = {
  ground: -20,
  road: -19,
  zone: -18,
  hatch: -17,
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
/** Meters between two posts beside the road, and from the road's edge to them. */
const POST_EVERY = 20;
const POST_OFFSET = 0.8;

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
  steered: Object3D[];
}

interface ObstacleHandle {
  /** At the obstacle, not turned: the rings and the model's holder. */
  holder: Group;
  model: Group;
  crossing: boolean;
  /** The turn from the road's heading to the way the model faces, rad; null until it is first placed. */
  facing: number | null;
  lastEy: number;
  ringOn: Mesh;
  ringOff: Mesh;
}

function geometryOf(resources: Resources, flat: FlatMesh): BufferGeometry {
  const geometry = resources.track(new BufferGeometry());
  geometry.setAttribute('position', new BufferAttribute(flat.positions, 3));
  geometry.setIndex(flat.indices);
  return geometry;
}

/** A material for something flat on the ground: no depth written, seen from both sides. */
const decal = (options: { transparent?: boolean; opacity?: number } = {}) =>
  new MeshBasicMaterial({ side: DoubleSide, depthWrite: false, ...options });

/** The ego writes 1 in the stencil where it is drawn; the ghost is drawn only where the stencil is not 1. */
const EGO_STENCIL = {
  stencilWrite: true,
  stencilRef: 1,
  stencilFunc: AlwaysStencilFunc,
  stencilZPass: ReplaceStencilOp,
} as const;
const GHOST_STENCIL = { stencilWrite: true, stencilRef: 1, stencilFunc: NotEqualStencilFunc } as const;

const solid = (options: Partial<typeof EGO_STENCIL> = {}) => new MeshLambertMaterial({ flatShading: true, ...options });

export class SceneWorld {
  /** The drawing is behind what the scene holds (a new size, theme or run): the next `render` brings it up to date. */
  stale = true;

  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(48, 1, 0.5, 700);
  private readonly background = new Color();
  private readonly fog = new Fog(0, 70, 280);
  /** What lives as long as the world: the materials, the ground, the dash texture. */
  private readonly base = new Resources();
  /** What a run's scene holds, replaced with the run. */
  private readonly content = new Resources();
  private readonly dash: DataTexture;

  private readonly ground = decal();
  private readonly line = decal();
  private readonly hatch = decal();
  private readonly post = solid();
  // The ego marks the pixels it covers in the stencil and the ghost keeps out of them: as in the top view the ego is
  // always whole, and the ghost shows only beside it, wherever the two stand (in the same place, at the start of a run).
  private readonly ego = solid(EGO_STENCIL);
  private readonly cabin = solid(EGO_STENCIL);
  private readonly egoWheel = solid(EGO_STENCIL);
  private readonly ghost = new MeshLambertMaterial({
    flatShading: true,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    ...GHOST_STENCIL,
  });
  private readonly ghostEdge = new LineDashedMaterial({ dashSize: 0.22, gapSize: 0.14, ...GHOST_STENCIL });
  private readonly wheel = solid();
  private readonly obstacle = solid();
  private readonly ringOn = decal();
  private readonly ringOff = decal();
  private readonly plan: MeshBasicMaterial;
  private readonly chosen = decal();
  private readonly chosenEdge = decal();
  private readonly shadow = decal({ transparent: true, opacity: 0.2 });
  /** The road's surfaces of the run, each with its friction: colored between asphalt and slippery by it. */
  private surfaces: { material: MeshBasicMaterial; mu: number }[] = [];

  private palette: ScenePalette;
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
  private shakeAge = SHAKE_SECONDS;

  /** Throws when the browser gives no WebGL context: the caller falls back to the top view. */
  constructor(canvas: HTMLCanvasElement, dark: boolean) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, stencil: true, powerPreference: 'high-performance' });
    this.palette = dark ? SCENE_DARK : SCENE_LIGHT;

    // Two texels, one opaque and one clear: repeated along a ribbon by its distance, they dash it.
    this.dash = this.base.track(new DataTexture(new Uint8Array([255, 255, 255, 255, 255, 255, 255, 0]), 2, 1));
    this.dash.wrapS = RepeatWrapping;
    this.dash.magFilter = NearestFilter;
    this.dash.minFilter = NearestFilter;
    this.dash.needsUpdate = true;
    this.plan = new MeshBasicMaterial({
      side: DoubleSide,
      depthWrite: false,
      map: this.dash,
      transparent: true,
      opacity: 0.7,
      alphaTest: 0.5,
    });
    for (const material of this.materials()) this.base.track(material);

    this.scene.background = this.background;
    this.scene.fog = this.fog;
    this.scene.add(new HemisphereLight(0xffffff, 0x8c9584, 1.5));
    const sun = new DirectionalLight(0xffffff, 1.6);
    sun.position.set(-40, 80, 30);
    this.scene.add(sun);

    const plane = this.base.track(new PlaneGeometry(8000, 8000));
    plane.rotateX(-Math.PI / 2);
    const ground = new Mesh(plane, this.ground);
    ground.renderOrder = ORDER.ground;
    this.scene.add(ground);
    this.paint();
  }

  private materials(): Material[] {
    return [
      this.ground,
      this.line,
      this.hatch,
      this.post,
      this.ego,
      this.cabin,
      this.egoWheel,
      this.wheel,
      this.ghost,
      this.ghostEdge,
      this.obstacle,
      this.ringOn,
      this.ringOff,
      this.plan,
      this.chosen,
      this.chosenEdge,
      this.shadow,
    ];
  }

  /** Gives every material the color the palette has for it. */
  private paint(): void {
    const p = this.palette;
    this.background.setHex(p.sky);
    this.fog.color.setHex(p.sky);
    this.ground.color.setHex(p.ground);
    this.line.color.setHex(p.line);
    this.hatch.color.setHex(p.hatch);
    this.post.color.setHex(p.post);
    this.ego.color.setHex(p.ego);
    this.cabin.color.setHex(p.cabin);
    this.egoWheel.color.setHex(p.wheel);
    this.wheel.color.setHex(p.wheel);
    this.ghost.color.setHex(p.ghost);
    this.ghostEdge.color.setHex(p.ghostEdge);
    this.obstacle.color.setHex(p.obstacle);
    this.ringOn.color.setHex(p.chosen);
    this.ringOff.color.setHex(p.plan);
    this.plan.color.setHex(p.plan);
    this.chosen.color.setHex(p.chosen);
    this.chosenEdge.color.setHex(p.chosenEdge);
    this.shadow.color.setHex(p.shadow);
    const slippery = new Color(p.slippery);
    for (const { material, mu } of this.surfaces) material.color.setHex(p.asphalt).lerp(slippery, slipperiness(mu));
  }

  setTheme(dark: boolean): void {
    this.palette = dark ? SCENE_DARK : SCENE_LIGHT;
    this.paint();
    this.stale = true;
  }

  /** Sizes the drawing: CSS pixels, and the device pixels drawn for each (the adaptive resolution's scale). */
  resize(width: number, height: number, pixelRatio: number): void {
    this.stale = true;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    // A tall view sees less to its sides: a wider angle keeps the whole road in it.
    this.camera.fov = this.camera.aspect < 1 ? 60 : 48;
    this.camera.updateProjectionMatrix();
  }

  /** Builds the scene of a run; the one before it is freed. The same scene again is left as it is. */
  load(info: SceneInfo, road: RoadGeometry): void {
    if (info === this.info) return;
    this.unload();
    this.stale = true;
    this.info = info;
    this.road = road;
    const root = new Group();
    this.root = root;
    const R = this.content;

    const flat = (mesh: FlatMesh, material: Material, order: number, parent: Object3D = root) => {
      const object = new Mesh(geometryOf(R, mesh), material);
      object.renderOrder = order;
      parent.add(object);
      return object;
    };
    const surface = (mu: number) => {
      const material = R.track(decal());
      this.surfaces.push({ material, mu });
      return material;
    };

    // The road and its surfaces: the base over its whole width, then each zone, hatched.
    const left = info.width.left;
    const right = -info.width.right;
    flat(stripMesh(road, 0, road.length, right, left), surface(info.surface.base.mu), ORDER.road);
    for (const zone of info.surface.zones) {
      const e0 = zone.side === 'left' ? 0 : right;
      const e1 = zone.side === 'right' ? 0 : left;
      flat(stripMesh(road, zone.from, zone.to, e0, e1), surface(zone.mu), ORDER.zone);
      flat(hatchMesh(road, zone.from, zone.to, e0, e1, 1.6, 0.12), this.hatch, ORDER.hatch);
    }

    // The road's edges (solid) and the ego lane's two lines (dashed), where they are not an edge already.
    flat(stripMesh(road, 0, road.length, left - 0.15, left), this.line, ORDER.line);
    flat(stripMesh(road, 0, road.length, right, right + 0.15), this.line, ORDER.line);
    for (const side of [1, -1]) {
      const ey = info.lane.center + (side * info.lane.width) / 2;
      if (Math.abs(ey - left) < 0.3 || Math.abs(ey - right) < 0.3) continue;
      flat(dashMesh(road, 0, road.length, ey, 3, 4.5, 0.14), this.line, ORDER.line);
    }

    // Posts beside the road: they give the eye the speed that a bare road does not.
    const count = Math.floor(road.length / POST_EVERY) + 1;
    const posts = R.track(new InstancedMesh(R.track(new BoxGeometry(0.12, 0.9, 0.12)), this.post, 2 * count));
    const place = new Object3D();
    const at = { x: 0, y: 0 };
    for (let i = 0; i < count; i++) {
      [left + POST_OFFSET, right - POST_OFFSET].forEach((ey, k) => {
        road.pointAt(i * POST_EVERY, ey, at);
        place.position.set(at.x, 0.45, -at.y);
        place.rotation.y = road.headingAt(i * POST_EVERY);
        place.updateMatrix();
        posts.setMatrixAt(2 * i + k, place.matrix);
      });
    }
    posts.instanceMatrix.needsUpdate = true;
    root.add(posts);

    // The plans: one thin dashed ribbon for each candidate, and the chosen one's wide ribbon with its rim.
    const points = info.frame.planPoints;
    this.chosenRim = this.ribbon(points, this.chosenEdge, ORDER.chosenEdge, false);
    this.chosenFill = this.ribbon(points, this.chosen, ORDER.chosen, false);
    this.others = Array.from({ length: 4 }, () => this.ribbon(points, this.plan, ORDER.plan, true));

    // The obstacles, each with its two rings and its shadow.
    this.obstacles = info.obstacles.map((spec) => {
      const holder = new Group();
      const materials: VehicleMaterials = { body: this.obstacle, cabin: this.obstacle, wheel: this.wheel };
      const { root: model, crossing } = obstacleModel(R, spec, materials);
      holder.add(model);
      const radius = Math.max(1.3, Math.hypot(spec.length, spec.width) / 2 + 0.5);
      const ringOn = flat(ringMesh(radius - 0.09, radius + 0.09, 48), this.ringOn, ORDER.ring, holder);
      const ringOff = flat(ringMesh(radius - 0.07, radius + 0.07, 48, 12), this.ringOff, ORDER.ring, holder);
      flat(ringMesh(0, Math.max(spec.length, spec.width) * 0.6, 20), this.shadow, ORDER.shadow, holder);
      root.add(holder);
      return { holder, model, crossing, facing: null, lastEy: 0, ringOn, ringOff };
    });

    // The ghost translucent with a dashed outline, the ego solid with its shadow.
    const size = { ...info.vehicle, truck: info.vehicle.id === 'truck' };
    const vehicle = (materials: VehicleMaterials, shadow: boolean): VehicleHandle => {
      const pose = new Group();
      const model = vehicleModel(R, size, materials);
      model.root.position.x = info.vehicle.bodyOffset;
      pose.add(model.root);
      if (shadow) {
        const plane = R.track(new PlaneGeometry(size.length * 1.08, size.width * 1.16));
        plane.rotateX(-Math.PI / 2);
        const blob = new Mesh(plane, this.shadow);
        blob.position.x = info.vehicle.bodyOffset;
        blob.renderOrder = ORDER.shadow;
        pose.add(blob);
      }
      root.add(pose);
      return { pose, steered: model.steered };
    };
    this.ghostHandle = vehicle({ body: this.ghost, cabin: this.ghost, wheel: this.ghost, edge: this.ghostEdge }, false);
    this.ghostHandle.pose.renderOrder = ORDER.ghost;
    this.ghostHandle.pose.visible = false;
    this.egoHandle = vehicle({ body: this.ego, cabin: this.cabin, wheel: this.egoWheel }, true);

    this.scene.add(root);
    this.paint();
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
    if (this.root) this.scene.remove(this.root);
    this.content.dispose();
    this.root = null;
    this.info = null;
    this.road = null;
    this.surfaces = [];
    this.egoHandle = null;
    this.ghostHandle = null;
    this.obstacles = [];
    this.others = [];
    this.chosenFill = null;
    this.chosenRim = null;
    this.shakeAge = SHAKE_SECONDS;
  }

  /** Moves everything to where a frame says it is. */
  update(frame: FrameView): void {
    const info = this.info;
    const road = this.road;
    if (!info || !road || !this.egoHandle || !this.ghostHandle) return;

    const pose = (handle: VehicleHandle, v: VehicleView) => {
      handle.pose.position.set(v.x, 0, -v.y);
      handle.pose.rotation.y = v.psi;
      for (const pivot of handle.steered) pivot.rotation.y = v.steer;
    };
    pose(this.egoHandle, frame.ego);
    this.ghostHandle.pose.visible = frame.hasGhost;
    if (frame.hasGhost) pose(this.ghostHandle, frame.ghost);

    frame.obstacles.forEach((o, i) => {
      const handle = this.obstacles[i];
      if (!handle) return;
      handle.holder.position.set(o.x, 0, -o.y);
      handle.ringOn.visible = o.detected;
      handle.ringOff.visible = !o.detected;
      if (handle.crossing) {
        // It faces the way it crosses: toward the ego's lane until it moves, then the way it moves.
        if (handle.facing === null) handle.facing = o.ey < info.lane.center ? Math.PI / 2 : -Math.PI / 2;
        else if (Math.abs(o.ey - handle.lastEy) > 1e-4)
          handle.facing = o.ey > handle.lastEy ? Math.PI / 2 : -Math.PI / 2;
        handle.lastEy = o.ey;
      }
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

  /** Starts the camera's shake: the ego's impact. The caller leaves it out for reduced motion. */
  shake(): void {
    this.shakeAge = 0;
  }

  /** Draws the scene, `elapsed` ms after the frame before; true while the camera still moves by itself. */
  render(elapsed: number): boolean {
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
    this.renderer.render(this.scene, this.camera);
    this.stale = false;
    return this.shakeAge < SHAKE_SECONDS;
  }

  /** Frees the scene and its WebGL context. */
  dispose(): void {
    this.unload();
    this.base.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
