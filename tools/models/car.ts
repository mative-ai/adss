/**
 * The car (Phase 8): a compact five-door of no make, 4.4 m by 1.8 m, the size of the core's `car`. Its
 * skin is one surface, swept from the tail to the nose: at every station a half cross-section runs from the middle of
 * the floor, around the sill, up the side to the shoulder, up the glass and over the roof to the middle. Four curves
 * along the car give the section its size (half width, belt line, cabin height, floor), and the wheel arches lift
 * its lower edge. The glass, the pillars and the lower cladding are parts of that same surface, by material; lamps
 * and door gaps are patches lifted a few millimeters off it.
 *
 * Nodes the app relies on: `body` (it leans with the accelerations), `wheel_fl`, `wheel_fr`, `wheel_rl`, `wheel_rr`
 * and their `_spin`. Materials by name: materials.ts.
 */
import { BoxGeometry, Group, LineSegments, SphereGeometry, TorusGeometry, type BufferGeometry } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import { CAR } from '../../packages/app/src/ui/scene3d/real/nominal.ts';
import { mesh, OUTLINE, palette } from './materials.ts';
import {
  at,
  cubic,
  curve,
  gridGeometries,
  gridGeometry,
  lerp,
  lifted,
  lineGeometry,
  merged,
  path,
  quad,
  sampleGrid,
  steps,
  symmetric,
  type Point2,
  type Point3,
} from './shapes.ts';
import { wheelNode, wheelParts } from './wheel.ts';

const L = CAR.length;
const NOSE = L / 2;
const WHEEL_WIDTH = 0.215;
/** The radius of a wheel arch, about the wheel's center. */
const ARCH = 0.42;

// The four curves along the car, by x (m from the middle, forward positive).
const HALF = curve([
  [-2.2, 0.6],
  [-2.13, 0.76],
  [-1.95, 0.865],
  [-1.2, 0.9],
  [0, 0.9],
  [1.0, 0.895],
  [1.7, 0.86],
  [2.02, 0.79],
  [2.15, 0.68],
  [2.2, 0.56],
]);
const BELT = curve([
  [-2.2, 1.04],
  [-1.9, 1.07],
  [-1.0, 1.05],
  [0, 1.02],
  [0.85, 0.995],
  [1.4, 0.93],
  [1.9, 0.84],
  [2.12, 0.76],
  [2.2, 0.71],
]);
/** The cabin's height over the belt line: none over the hood, the windshield from 0.85 back to 0.25, the hatch's glass. */
const CABIN = curve([
  [-2.2, 0],
  [-2.1, 0.02],
  [-1.55, 0.4],
  [-0.9, 0.455],
  [-0.2, 0.46],
  [0.25, 0.42],
  [0.85, 0],
  [2.2, 0],
]);
const FLOOR = curve([
  [-2.2, 0.34],
  [-1.9, 0.24],
  [-1.0, 0.19],
  [1.0, 0.19],
  [1.9, 0.22],
  [2.2, 0.3],
]);

const cabin = (x: number): number => Math.max(0, CABIN(x));

/** The body's lower edge: the floor, lifted over each wheel by its arch. */
function lowerEdge(x: number): number {
  let y = FLOOR(x);
  for (const center of [CAR.axle, -CAR.axle]) {
    const dx = x - center;
    if (Math.abs(dx) < ARCH) y = Math.max(y, CAR.wheelRadius + Math.sqrt(ARCH * ARCH - dx * dx));
  }
  return y;
}

/** Where the section's parts end, as a share of the way around it: floor, side, shoulder, glass; the roof is the rest. */
const V = { floor: 0.14, side: 0.52, shoulder: 0.57, glass: 0.78 } as const;
const SILL = 0.07;
const INSET = 0.035;
/** How far the glass leans in for each meter it rises. */
const TUMBLE = 0.36;

/** The right half of the cross-section at `x`: (z, y) at `v`, from the middle of the floor (0) to that of the roof (1). */
function section(x: number, v: number): [number, number] {
  const half = HALF(x);
  const low = lowerEdge(x);
  const belt = BELT(x);
  const rise = cabin(x);
  const roof = belt + rise;
  const shoulder = belt - 0.05;
  const corner = Math.min(0.085, 0.4 * rise);
  const top = half - INSET - TUMBLE * Math.max(0, rise - corner);
  const crown = 0.035 + 0.02 * (1 - Math.min(1, rise / 0.2));
  if (v <= V.floor) return [(v / V.floor) * (half - SILL), low];
  if (v <= V.side) {
    const t = (v - V.floor) / (V.side - V.floor);
    return cubic([half - SILL, low], [half, low], [half + 0.012, lerp(low, shoulder, 0.55)], [half, shoulder], t);
  }
  if (v <= V.shoulder) {
    const t = (v - V.side) / (V.shoulder - V.side);
    return quad([half, shoulder], [half - 0.004, belt - 0.008], [half - INSET, belt], t);
  }
  const g0: Point2 = [half - INSET, belt];
  const g1: Point2 = [top, roof - corner];
  if (v <= V.glass) {
    const t = (v - V.shoulder) / (V.glass - V.shoulder);
    const bulge = 0.012 * Math.min(1, rise / 0.3);
    return quad(g0, [lerp(g0[0], g1[0], 0.5) + bulge, lerp(g0[1], g1[1], 0.5)], g1, t);
  }
  const t = (v - V.glass) / (1 - V.glass);
  return cubic(g1, [top - 0.012, roof - 0.1 * corner], [0.5 * top, roof + crown], [0, roof + crown], t);
}

const skinAt = (x: number, v: number): Point3 => {
  const [z, y] = section(x, v);
  return [x, y, z];
};

/** A station of the sweep: a section of the body, or one of the rings that close an end (smaller, pushed out). */
interface Station {
  x: number;
  scale: number;
  shift: number;
}

const BODY_STATIONS = 64;
/** The rings that close an end, from the body's last section to the middle of the face: scale and bulge, m. */
const CAP: readonly Point2[] = [
  [0.93, 0.014],
  [0.78, 0.032],
  [0.45, 0.045],
  [0, 0.05],
];

const STATIONS: Station[] = [
  ...[...CAP].reverse().map(([scale, bulge]) => ({ x: -NOSE, scale, shift: -bulge })),
  ...steps(-NOSE, NOSE, BODY_STATIONS).map((x) => ({ x, scale: 1, shift: 0 })),
  ...CAP.map(([scale, bulge]) => ({ x: NOSE, scale, shift: bulge })),
];

function stationPoint(station: Station, v: number): Point3 {
  const [z, y] = section(station.x, v);
  if (station.scale === 1) return [station.x, y, z];
  const middle = (lowerEdge(station.x) + BELT(station.x)) / 2;
  return [station.x + station.shift, middle + (y - middle) * station.scale, z * station.scale];
}

/** The rows of quads each part of the section has, and the ring of the sweep they make. */
const ROWS = { floor: 4, side: 10, shoulder: 3, glass: 6, roof: 9 } as const;
const RING = [
  ...steps(0, V.floor, ROWS.floor),
  ...steps(V.floor, V.side, ROWS.side).slice(1),
  ...steps(V.side, V.shoulder, ROWS.shoulder).slice(1),
  ...steps(V.shoulder, V.glass, ROWS.glass).slice(1),
  ...steps(V.glass, 1, ROWS.roof, 1.4).slice(1),
];
const SIDE_ROW = ROWS.floor;
const SHOULDER_ROW = SIDE_ROW + ROWS.side;
const GLASS_ROW = SHOULDER_ROW + ROWS.shoulder;
const ROOF_ROW = GLASS_ROW + ROWS.glass;

/** The material of the skin's quad between stations i and i + 1, rows j and j + 1. */
function skin(i: number, j: number): string {
  const a = STATIONS[i] as Station;
  const b = STATIONS[i + 1] as Station;
  const x = (a.x + b.x) / 2;
  const cap = a.scale < 1 || b.scale < 1;
  const rise = cabin(x);
  if (j < SIDE_ROW) return 'trim';
  // The two faces of the car are in its color down to the floor.
  if (cap) return 'paint';
  // The cladding along the sills.
  if (j < SHOULDER_ROW) return j - SIDE_ROW < 2 ? 'trim' : 'paint';
  if (j < GLASS_ROW) return 'paint';
  if (j < ROOF_ROW) {
    // The side windows, from the windshield's pillar to the hatch's, with the middle pillar between the doors.
    if (rise < 0.12 || x > 0.3 || x < -1.62) return 'paint';
    return Math.abs(x + 0.2) < 0.05 ? 'trim' : 'glass';
  }
  if (rise < 0.02) return 'paint';
  // The windshield and the hatch's glass, each between two pillars in the body's color.
  const pillar = j - ROOF_ROW < 2;
  if ((x > 0.27 && x < 0.86) || (x > -2.08 && x < -1.55)) return pillar ? 'paint' : 'glass';
  return 'paint';
}

/** The lines the ghost is drawn with: the body's long edges, a few of its sections and the wheel arches. */
function outline(): BufferGeometry {
  const segments: number[] = [];
  const xs = steps(-NOSE, NOSE, 44);
  for (const v of [V.floor, V.side, V.shoulder]) {
    path(
      xs.map((x) => skinAt(x, v)),
      segments,
    );
  }
  // The roof's edge, where there is a cabin under it.
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i] as number;
    const x1 = xs[i + 1] as number;
    if (cabin(x0) > 0.03 && cabin(x1) > 0.03) path([skinAt(x0, V.glass), skinAt(x1, V.glass)], segments);
  }
  // The two ends whole, and the hoops of the cabin where the roof starts and ends.
  for (const [x, from] of [
    [-NOSE, V.floor],
    [-1.55, V.shoulder],
    [0.25, V.shoulder],
    [NOSE, V.floor],
  ] as const) {
    path(
      steps(from, 1, 24).map((v) => skinAt(x, v)),
      segments,
    );
  }
  for (const center of [CAR.axle, -CAR.axle]) {
    path(
      steps(0, Math.PI, 16).map((a): Point3 => [
        center + ARCH * Math.cos(a),
        CAR.wheelRadius + ARCH * Math.sin(a),
        HALF(center),
      ]),
      segments,
    );
  }
  const both = lineGeometry(segments, true);
  // The line along the middle, once.
  const middle: number[] = [];
  path(
    xs.map((x) => skinAt(x, 1)),
    middle,
  );
  const all = [...(both.getAttribute('position').array as Float32Array), ...middle];
  return lineGeometry(all);
}

export function buildCar(): Group {
  const material = palette();
  const root = new Group();
  root.name = 'car';
  const body = new Group();
  body.name = 'body';
  root.add(body);

  const parts = new Map<string, BufferGeometry[]>();
  const add = (name: string, geometry: BufferGeometry) => {
    const list = parts.get(name) ?? [];
    list.push(geometry);
    parts.set(name, list);
  };

  // The skin, and its ends: the points of the last ring are one, and face straight out.
  const grid = sampleGrid(
    (i, v) => stationPoint(STATIONS[i] as Station, v),
    STATIONS.map((_, i) => i),
    RING,
  );
  for (const i of [0, STATIONS.length - 1]) {
    for (let j = 0; j < grid.nv; j++) grid.normals.set([i === 0 ? -1 : 1, 0, 0], 3 * (i * grid.nv + j));
  }
  for (const [name, geometry] of gridGeometries(grid, skin)) add(name, symmetric(geometry));

  const patch = (x0: number, x1: number, nx: number, v0: number, v1: number, nv: number, lift: number) =>
    symmetric(gridGeometry(lifted(sampleGrid(skinAt, steps(x0, x1, nx), steps(v0, v1, nv)), lift)));
  const side = (t: number) => lerp(V.floor, V.side, t);

  // Lamps on the corners, and a bar of light across the tail.
  add('lamp_front', patch(1.8, 2.19, 10, side(0.52), side(0.88), 4, 0.004));
  add('lamp_rear', patch(-2.19, -1.96, 6, side(0.76), side(0.95), 3, 0.004));
  add('lamp_rear', at(new RoundedBoxGeometry(0.03, 0.04, 1.0, 2, 0.01), -NOSE - 0.036, 0.93, 0));
  // The plate's recess and the lower bumper on the tail.
  add('trim', at(new RoundedBoxGeometry(0.03, 0.12, 0.54, 2, 0.012), -NOSE - 0.04, 0.7, 0));
  add('trim', at(new RoundedBoxGeometry(0.03, 0.1, 1.02, 2, 0.012), -NOSE - 0.04, 0.44, 0));
  // The grille and the lower intake on the nose.
  add('trim', at(new RoundedBoxGeometry(0.03, 0.11, 0.84, 2, 0.012), NOSE + 0.038, 0.57, 0));
  add('trim', at(new RoundedBoxGeometry(0.03, 0.09, 0.98, 2, 0.012), NOSE + 0.04, 0.4, 0));
  // The gaps around the doors.
  for (const x of [0.8, -0.2, -0.92]) add('trim', patch(x - 0.005, x + 0.005, 1, side(0.22), V.shoulder, 10, 0.0012));
  // The trims of the wheel arches, which also cover the arch's steps from one station to the next.
  for (const center of [CAR.axle, -CAR.axle]) {
    const ring = new TorusGeometry(ARCH, 0.028, 8, 24, Math.PI);
    add('trim', symmetric(at(ring, center, CAR.wheelRadius, HALF(center) - 0.014)));
  }
  // What is seen through the arches and through the glass.
  add('trim', at(new BoxGeometry(3.9, 0.42, 1.28), 0, 0.46, 0));
  add('interior', at(new BoxGeometry(2.2, 0.42, 1.25), -0.55, 1.08, 0));
  // The door mirrors.
  const mirrorX = 0.74;
  add(
    'paint',
    symmetric(
      at(new SphereGeometry(1, 12, 8).scale(0.085, 0.06, 0.11), mirrorX, BELT(mirrorX) + 0.05, HALF(mirrorX) + 0.07),
    ),
  );
  add('trim', symmetric(at(new BoxGeometry(0.05, 0.02, 0.09), mirrorX, BELT(mirrorX) + 0.03, HALF(mirrorX) + 0.005)));

  for (const [name, list] of parts) body.add(mesh(`body_${name}`, merged(list), material(name)));
  const lines = new LineSegments(outline(), material(OUTLINE));
  lines.name = `body_${OUTLINE}`;
  body.add(lines);

  const wheel = wheelParts(CAR.wheelRadius, WHEEL_WIDTH);
  const z = CAR.track / 2;
  const wheels: [string, Point3][] = [
    ['wheel_fl', [CAR.axle, CAR.wheelRadius, -z]],
    ['wheel_fr', [CAR.axle, CAR.wheelRadius, z]],
    ['wheel_rl', [-CAR.axle, CAR.wheelRadius, -z]],
    ['wheel_rr', [-CAR.axle, CAR.wheelRadius, z]],
  ];
  for (const [name, position] of wheels) root.add(wheelNode(name, position, wheel, material, CAR.wheelRadius));
  return root;
}
