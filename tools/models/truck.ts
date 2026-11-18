/**
 * The rigid truck (Phase 8): a cab over the engine and a box body on a chassis, 8.5 m by 2.5 m, the
 * size of the core's `truck`. Its nodes and its materials are the car's (car.ts), so the app handles the two alike.
 */
import { BoxGeometry, CylinderGeometry, EdgesGeometry, Group, LineSegments, type BufferGeometry } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import { TRUCK } from '../../packages/app/src/ui/scene3d/real/nominal.ts';
import { mesh, OUTLINE, palette } from './materials.ts';
import { at, lineGeometry, merged, symmetric, type Point3 } from './shapes.ts';
import { wheelNode, wheelParts } from './wheel.ts';

const NOSE = TRUCK.length / 2;
/** The cab and the box: size (length, height, width) and center. */
interface Block {
  readonly size: Point3;
  readonly center: Point3;
}
const CAB: Block = { size: [2.0, 2.25, 2.4], center: [NOSE - 1.05, 1.875, 0] };
const BOX: Block = { size: [6.15, 2.65, 2.5], center: [-1.15, 2.425, 0] };

export function buildTruck(): Group {
  const material = palette();
  const root = new Group();
  root.name = 'truck';
  const body = new Group();
  body.name = 'body';
  root.add(body);

  const parts = new Map<string, BufferGeometry[]>();
  const add = (name: string, geometry: BufferGeometry) => {
    const list = parts.get(name) ?? [];
    list.push(geometry);
    parts.set(name, list);
  };
  const front = CAB.center[0] + CAB.size[0] / 2;

  add('trim', at(new BoxGeometry(7.9, 0.28, 0.95), -0.1, 0.92, 0));
  add('paint', at(new RoundedBoxGeometry(...CAB.size, 4, 0.14), ...CAB.center));
  add('cargo', at(new RoundedBoxGeometry(...BOX.size, 3, 0.06), ...BOX.center));
  // The windshield and the door windows, the grille, the bumper and the bar under the tail.
  add('glass', at(new RoundedBoxGeometry(0.04, 0.85, 2.05, 2, 0.018), front + 0.004, 2.42, 0));
  add(
    'glass',
    symmetric(at(new RoundedBoxGeometry(0.75, 0.6, 0.04, 2, 0.018), front - 0.62, 2.46, CAB.size[2] / 2 + 0.002)),
  );
  add('trim', at(new RoundedBoxGeometry(0.04, 0.55, 1.7, 2, 0.018), front + 0.006, 1.36, 0));
  add('trim', at(new RoundedBoxGeometry(0.26, 0.3, 2.46, 2, 0.05), front - 0.02, 0.72, 0));
  add('trim', at(new BoxGeometry(0.1, 0.12, 2.3), -NOSE + 0.1, 0.6, 0));
  add('trim', symmetric(at(new BoxGeometry(0.06, 0.4, 0.2), front - 0.3, 2.5, CAB.size[2] / 2 + 0.16)));
  add('lamp_front', symmetric(at(new BoxGeometry(0.04, 0.12, 0.32), front + 0.008, 1.0, 0.9)));
  add('lamp_rear', symmetric(at(new BoxGeometry(0.04, 0.14, 0.3), -NOSE + 0.012, 1.0, 1.0)));
  // The tanks under the box.
  add('rim', symmetric(at(new CylinderGeometry(0.3, 0.3, 0.9, 20), 0.9, 0.78, 0.92, 0, 0, Math.PI / 2)));

  for (const [name, list] of parts) body.add(mesh(`body_${name}`, merged(list), material(name)));

  // The ghost's lines: the edges of the cab and of the box.
  const edges: number[] = [];
  for (const { size, center } of [CAB, BOX]) {
    const box = new EdgesGeometry(at(new BoxGeometry(...size), ...center));
    edges.push(...(box.getAttribute('position').array as Float32Array));
  }
  const lines = new LineSegments(lineGeometry(edges), material(OUTLINE));
  lines.name = `body_${OUTLINE}`;
  body.add(lines);

  const wheel = wheelParts(TRUCK.wheelRadius, 0.3);
  const z = TRUCK.track / 2;
  const wheels: [string, Point3, number][] = [
    ['wheel_fl', [TRUCK.axle, TRUCK.wheelRadius, -z], 0],
    ['wheel_fr', [TRUCK.axle, TRUCK.wheelRadius, z], 0],
    ['wheel_rl', [-TRUCK.axle, TRUCK.wheelRadius, -z], 0.34],
    ['wheel_rr', [-TRUCK.axle, TRUCK.wheelRadius, z], 0.34],
  ];
  for (const [name, position, twin] of wheels) {
    root.add(wheelNode(name, position, wheel, material, TRUCK.wheelRadius, twin));
  }
  return root;
}
