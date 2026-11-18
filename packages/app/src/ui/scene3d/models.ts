/**
 * The low-poly models of the 3D scene (Phase 4): the vehicle (a car or the rigid truck, to the size the
 * scene gives), and the obstacles by their kind (a pedestrian, an animal, a stopped vehicle, or a plain box). A model
 * stands on the ground at its origin and faces +X, with its width along Z (geometry.ts has the axes). The footprint is
 * the simulation's; the heights and the shapes above it are drawing only.
 */
import {
  BoxGeometry,
  CylinderGeometry,
  EdgesGeometry,
  ExtrudeGeometry,
  Group,
  IcosahedronGeometry,
  LineSegments,
  Mesh,
  Object3D,
  Shape,
  type BufferGeometry,
  type Material,
} from 'three';

/** What a model holds on the GPU, to free when the scene's content is replaced. */
export class Resources {
  private readonly items: { dispose(): void }[] = [];

  track<T extends { dispose(): void }>(item: T): T {
    this.items.push(item);
    return item;
  }

  dispose(): void {
    for (const item of this.items.splice(0)) item.dispose();
  }
}

export interface VehicleMaterials {
  body: Material;
  cabin: Material;
  wheel: Material;
  /** A dashed outline over the body's edges: the ghost's, so that it is not told from the ego by color alone. */
  edge?: Material;
  /** The housings of the sensor kit: the MPC's car and its ghost carry the kit, a car that only stands there does not. */
  kit?: Material;
}

export interface VehicleModel {
  /** Centered on the body, on the ground. */
  root: Group;
  /** The pivots of the front wheels: they turn about Y with the steering. */
  steered: Object3D[];
}

/** A side profile (x forward, y up) pulled across `width`, centered on Z. */
function extruded(resources: Resources, points: readonly (readonly [number, number])[], width: number): BufferGeometry {
  const shape = new Shape();
  points.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  geometry.translate(0, 0, -width / 2);
  return resources.track(geometry);
}

function box(resources: Resources, x: number, y: number, z: number): BufferGeometry {
  return resources.track(new BoxGeometry(x, y, z));
}

export function vehicleModel(
  resources: Resources,
  size: { length: number; width: number; track: number; truck: boolean },
  materials: VehicleMaterials,
): VehicleModel {
  const root = new Group();
  const { length: L, width: W } = size;

  const add = (geometry: BufferGeometry, material: Material, x = 0, y = 0, z = 0) => {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    root.add(mesh);
    if (materials.edge) {
      const outline = new LineSegments(resources.track(new EdgesGeometry(geometry, 30)), materials.edge);
      outline.computeLineDistances();
      outline.position.copy(mesh.position);
      root.add(outline);
    }
  };

  let radius: number;
  let axle: number;
  if (size.truck) {
    radius = 0.5;
    axle = 0.33 * L;
    add(box(resources, L, 0.3, 0.86 * W), materials.cabin, 0, 0.85);
    add(box(resources, 0.24 * L, 2.0, W), materials.body, 0.38 * L, 2.0);
    add(box(resources, 0.72 * L, 2.6, W), materials.cabin, -0.14 * L, 2.3);
  } else {
    // The roof rises with the width: the wider vehicle of the core is a taller one.
    const k = 1 + Math.max(0, W - 1.8) * 0.45;
    radius = 0.33;
    axle = 0.31 * L;
    const lower: [number, number][] = [
      [-0.5 * L, 0.3 * k],
      [-0.5 * L, 0.82 * k],
      [-0.45 * L, 0.9 * k],
      [0.27 * L, 0.9 * k],
      [0.47 * L, 0.74 * k],
      [0.5 * L, 0.5 * k],
      [0.48 * L, 0.3 * k],
    ];
    const upper: [number, number][] = [
      [-0.41 * L, 0.9 * k],
      [-0.27 * L, 1.42 * k],
      [0.05 * L, 1.42 * k],
      [0.25 * L, 0.9 * k],
    ];
    add(extruded(resources, lower, W), materials.body);
    add(extruded(resources, upper, 0.84 * W), materials.cabin);
    // The roof in the body's color, over the glass: seen from behind and above, the vehicle keeps its color.
    add(box(resources, 0.34 * L, 0.07, 0.88 * W), materials.body, -0.11 * L, 1.42 * k + 0.035);
    if (materials.kit) {
      // The sensor kit, in the few shapes this scene has: the fairing on the roof with the lidar's dome, the pod that
      // looks ahead, and a lidar on each front fender.
      const roof = 1.42 * k + 0.07;
      add(box(resources, 0.27 * L, 0.06, 0.5 * W), materials.kit, -0.09 * L, roof + 0.03);
      add(resources.track(new CylinderGeometry(0.15, 0.18, 0.28, 10)), materials.cabin, -0.095 * L, roof + 0.2);
      add(box(resources, 0.06 * L, 0.1, 0.28 * W), materials.kit, 0.012 * L, roof + 0.08);
      for (const side of [1, -1]) {
        add(box(resources, 0.2, 0.13, 0.12), materials.kit, 0.234 * L, 0.9 * k + 0.02, side * (W / 2 + 0.03));
      }
    }
  }

  // The wheels at the track's width, a little proud of the body so that the steering shows.
  const wheel = resources.track(new CylinderGeometry(radius, radius, 0.3, 12));
  wheel.rotateX(Math.PI / 2);
  const steered: Object3D[] = [];
  for (const front of [true, false]) {
    for (const side of [1, -1]) {
      const pivot = new Object3D();
      pivot.position.set(front ? axle : -axle, radius, (side * size.track) / 2);
      pivot.add(new Mesh(wheel, materials.wheel));
      root.add(pivot);
      if (front) steered.push(pivot);
    }
  }
  return { root, steered };
}

/** A person on foot, 1.75 m tall, facing +X. */
function pedestrian(resources: Resources, material: Material): Group {
  const root = new Group();
  const part = (geometry: BufferGeometry, x: number, y: number, z: number) => {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    root.add(mesh);
  };
  const leg = box(resources, 0.14, 0.86, 0.15);
  const arm = box(resources, 0.1, 0.56, 0.1);
  part(leg, 0, 0.43, 0.1);
  part(leg, 0, 0.43, -0.1);
  part(box(resources, 0.22, 0.62, 0.42), 0, 1.17, 0);
  part(arm, 0, 1.18, 0.27);
  part(arm, 0, 1.18, -0.27);
  part(resources.track(new IcosahedronGeometry(0.13, 0)), 0, 1.62, 0);
  return root;
}

/** A moose, `long` m from tail to nose and `thick` m across, facing +X. */
function animal(resources: Resources, material: Material, long: number, thick: number): Group {
  const root = new Group();
  const part = (geometry: BufferGeometry, x: number, y: number, z: number, tilt = 0) => {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.z = tilt;
    root.add(mesh);
  };
  const leg = box(resources, 0.13, 1.16, 0.13);
  for (const x of [0.18 * long, -0.32 * long]) {
    part(leg, x, 0.58, 0.26 * thick);
    part(leg, x, 0.58, -0.26 * thick);
  }
  part(box(resources, 0.62 * long, 0.74, 0.74 * thick), -0.08 * long, 1.5, 0);
  part(box(resources, 0.26 * long, 0.3, 0.6 * thick), 0.12 * long, 1.94, 0);
  part(box(resources, 0.3 * long, 0.3, 0.3), 0.33 * long, 1.72, 0, -0.4);
  const antler = box(resources, 0.1, 0.08, 0.5);
  part(antler, 0.3 * long, 2.06, 0.36);
  part(antler, 0.3 * long, 2.06, -0.36);
  return root;
}

export interface ObstacleModel {
  root: Group;
  /** It faces the way it crosses the road (a pedestrian, an animal), not along the road. */
  crossing: boolean;
}

/** An obstacle's model by its kind, to the footprint the scenario gives: `length` along the road, `width` across. */
export function obstacleModel(
  resources: Resources,
  spec: { kind: string; length: number; width: number },
  materials: VehicleMaterials,
): ObstacleModel {
  if (spec.kind === 'pedestrian') return { root: pedestrian(resources, materials.body), crossing: true };
  if (spec.kind === 'animal') {
    return { root: animal(resources, materials.body, spec.width, spec.length), crossing: true };
  }
  if (spec.length >= 2.5) {
    const size = { length: spec.length, width: spec.width, track: spec.width - 0.3, truck: false };
    return { root: vehicleModel(resources, size, materials).root, crossing: false };
  }
  const root = new Group();
  const mesh = new Mesh(box(resources, spec.length, 1, spec.width), materials.body);
  mesh.position.y = 0.5;
  root.add(mesh);
  return { root, crossing: false };
}
