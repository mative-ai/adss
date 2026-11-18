/**
 * The car (Phase 8): a compact crossover of no make, 4.4 m by 1.8 m, the size of the core's `car`. A
 * blunt nose under a long hood, a belt line that rises to a wide rear pillar, a black roof over the body's color and a
 * tail cut short and upright. Its skin is one surface, swept from the tail to the nose: at every station a half
 * cross-section runs from the middle of the floor, around the sill, up the side to the shoulder, up the glass and over
 * the roof to the middle. Four curves along the car give the section its size (half width, belt line, cabin height,
 * floor), and the wheel arches lift its lower edge. The glass, the pillars, the roof and the lower cladding are parts
 * of that same surface, by material; lamps, bands and door gaps are patches lifted a few millimeters off it.
 *
 * The MPC's car is this one with two things more, each a node in `body` that comes off whole: `sensors`, the kit of a
 * car that drives itself (sensors.ts), and `livery`, Mative's wordmark on the front doors, on the hood and on the
 * hatch's glass (wordmark.ts). No other name and no maker's badge is on the car.
 *
 * Nodes the app relies on: `body` (it leans with the accelerations), `sensors` and `livery` in it, `wheel_fl`,
 * `wheel_fr`, `wheel_rl`, `wheel_rr` and their `_spin`. Materials by name: materials.ts.
 */
import { BoxGeometry, Group, LineSegments, SphereGeometry, TorusGeometry, type BufferGeometry } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import { CAR, CAR_PARTS } from '../../packages/app/src/ui/scene3d/real/nominal.ts';
import { mesh, OUTLINE, palette } from './materials.ts';
import { sensorKit } from './sensors.ts';
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
import { wordmark } from './wordmark.ts';

const L = CAR.length;
const NOSE = L / 2;
const WHEEL_WIDTH = 0.215;
/** The radius of a wheel arch, about the wheel's center. */
const ARCH = 0.42;

// The four curves along the car, by x (m from the middle, forward positive).
/** Half the width: full between the axles, drawn in a little at the two ends, whose corners are round. */
const HALF = curve([
  [-2.2, 0.69],
  [-2.12, 0.79],
  [-1.9, 0.872],
  [-1.2, 0.9],
  [0, 0.9],
  [1.0, 0.895],
  [1.6, 0.88],
  [1.95, 0.832],
  [2.12, 0.745],
  [2.2, 0.65],
]);
/** The belt line: the hood's edge ahead of the cabin, the foot of the glass along it, the top of the tail behind. */
const BELT = curve([
  [-2.2, 1.115],
  [-1.9, 1.14],
  [-1.2, 1.1],
  [-0.2, 1.035],
  [0.6, 0.995],
  [1.0, 0.985],
  [1.5, 0.955],
  [1.9, 0.92],
  [2.1, 0.885],
  [2.2, 0.855],
]);
/** The cabin's height over the belt line: none over the hood, the windshield from 0.95 back to 0.2, the hatch's glass. */
const CABIN = curve([
  [-2.2, 0],
  [-2.1, 0.015],
  [-1.72, 0.345],
  [-1.2, 0.4],
  [-0.4, 0.48],
  [0.2, 0.47],
  [0.95, 0],
  [2.2, 0],
]);
const FLOOR = curve([
  [-2.2, 0.36],
  [-1.9, 0.27],
  [-1.0, 0.21],
  [1.0, 0.21],
  [1.9, 0.25],
  [2.2, 0.31],
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

/** The `v` between `v0` and `v1` where `value` is `target`, for a value that only grows or only falls on the way. */
function solve(value: (v: number) => number, v0: number, v1: number, target: number): number {
  const rising = value(v1) > value(v0);
  let low = v0;
  let high = v1;
  for (let i = 0; i < 40; i++) {
    const middle = (low + high) / 2;
    if (value(middle) < target === rising) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/** How far out the side of the body is at `x`, at the height `y`: between the sill and the shoulder. */
const sideZ = (x: number, y: number): number =>
  section(
    x,
    solve((v) => section(x, v)[1], V.floor, V.side, y),
  )[0];

/** The height of the top of the body at `x`, `z` m from the middle: the roof, the glass at its two ends, the hood. */
const topY = (x: number, z: number): number =>
  section(
    x,
    solve((v) => section(x, v)[0], V.glass, 1, Math.abs(z)),
  )[1];

/** The lettering: how long each wordmark is, m, where its middle is, and how far it stands off the surface. */
const LIVERY = {
  lift: 0.004,
  door: { length: 0.84, x: 0.3, y: 0.62 },
  hood: { length: 0.66, x: 1.5 },
  hatch: { length: 0.9, x: -1.925 },
} as const;

/** How much longer than its run along the car a slope of the top is at `x`: a mark laid on it keeps its proportions. */
function stretch(x: number): number {
  const rise = (topY(x + 0.05, 0) - topY(x - 0.05, 0)) / 0.1;
  return Math.hypot(1, rise);
}

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

/** The rows of the side, from the sill up, in the black cladding that runs along the sills and under the bumpers. */
const CLADDING_ROWS = 3;
/**
 * The side windows, by x: from the windshield's pillar back to the rear one, with the pillar between the doors; behind
 * `kick` their lower edge climbs to `climb` of their height at the rear pillar.
 */
const WINDOWS = { front: 0.42, rear: -1.3, pillar: -0.25, kick: -0.85, climb: 0.5 } as const;
/** The windshield and the hatch's glass, by x. */
const SCREEN = { front: [0.27, 0.93], rear: [-2.07, -1.74] } as const;

/** The material of the skin's quad between stations i and i + 1, rows j and j + 1. */
function skin(i: number, j: number): string {
  const a = STATIONS[i] as Station;
  const b = STATIONS[i + 1] as Station;
  const x = (a.x + b.x) / 2;
  const rise = cabin(x);
  // The two faces of the car are in its color all over: their bands and intakes are parts set on them.
  if (a.scale < 1 || b.scale < 1) return 'paint';
  if (j < SIDE_ROW) return 'trim';
  if (j < SHOULDER_ROW) return j - SIDE_ROW < CLADDING_ROWS ? 'trim' : 'paint';
  if (j < GLASS_ROW) return 'paint';
  if (j < ROOF_ROW) {
    if (rise < 0.02) return 'paint';
    // Ahead of the front door, the flank of the windshield's pillar, black with the roof.
    if (x > WINDOWS.front) return 'paint_dark';
    // The wide rear pillar, in the body's color.
    if (x < WINDOWS.rear) return 'paint';
    return Math.abs(x - WINDOWS.pillar) < 0.045 ? 'trim' : 'glass';
  }
  // The hood and the top of the tail.
  if (rise < 0.02 || x >= SCREEN.front[1] || x <= SCREEN.rear[0]) return 'paint';
  const edge = j - ROOF_ROW < 2;
  // The windshield between two black pillars, the hatch's glass between two in the body's color.
  if (x > SCREEN.front[0]) return edge ? 'paint_dark' : 'glass';
  if (x < SCREEN.rear[1]) return edge ? 'paint' : 'glass';
  return 'paint_dark';
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
    [SCREEN.rear[1], V.shoulder],
    [SCREEN.front[0], V.shoulder],
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

  /** A patch of the skin between two stations and two shares of the way around the section, on both sides. */
  const patch = (x0: number, x1: number, nx: number, v0: number, v1: number, nv: number, lift: number) =>
    symmetric(gridGeometry(lifted(sampleGrid(skinAt, steps(x0, x1, nx), steps(v0, v1, nv)), lift)));
  /** A patch of the side between two stations and two heights, on both sides. */
  const band = (x0: number, x1: number, nx: number, y0: number, y1: number, lift: number) => {
    const sampled = sampleGrid((x, y) => [x, y, sideZ(x, y)], steps(x0, x1, nx), steps(y0, y1, 2));
    return symmetric(gridGeometry(lifted(sampled, lift)));
  };
  const side = (t: number) => lerp(V.floor, V.side, t);
  /**
   * A plate on the face of the nose (`toward` 1) or of the tail (−1): `tall` by `wide`, its outer face `out` m past the
   * last section, and `deep` m thick.
   */
  const plate = (toward: 1 | -1, y: number, tall: number, wide: number, out: number, round = 0.014, deep = 0.03) =>
    at(new RoundedBoxGeometry(deep, tall, wide, 2, round), toward * (NOSE + out - deep / 2), y, 0);
  /** A band from corner to corner: a plate as wide as the end of the body and deep enough to meet the sides. */
  const across = (toward: 1 | -1, y: number, tall: number, out: number, round: number) =>
    plate(toward, y, tall, 2 * (HALF(toward * NOSE) + out - 0.04), out, round, 0.08);

  // The nose: a black band from corner to corner with three slim lamps a side, and the intake under it.
  const lamps = { y: 0.725, tall: 0.115 } as const;
  add('trim', across(1, lamps.y, lamps.tall, 0.052, 0.02));
  add('trim', band(1.9, NOSE, 8, lamps.y - lamps.tall / 2, lamps.y + lamps.tall / 2, 0.003));
  for (const z of [0.3, 0.415, 0.53]) {
    add('lamp_front', symmetric(at(new RoundedBoxGeometry(0.03, 0.042, 0.092, 2, 0.012), NOSE + 0.045, lamps.y, z)));
  }
  add('lamp_front', band(1.98, 2.18, 6, lamps.y - 0.02, lamps.y + 0.024, 0.006));
  add('trim', plate(1, 0.43, 0.17, 1.04, 0.052));

  // The tail: a black band from corner to corner with one strip of light along it, the plate's recess and the bumper.
  const strip = { y: 0.955, tall: 0.11 } as const;
  add('trim', across(-1, strip.y, strip.tall, 0.052, 0.02));
  add('trim', band(-NOSE, -1.9, 8, strip.y - strip.tall / 2, strip.y + strip.tall / 2, 0.003));
  add('lamp_rear', across(-1, strip.y, 0.032, 0.058, 0.01));
  add('lamp_rear', band(-NOSE, -1.93, 7, strip.y - 0.016, strip.y + 0.016, 0.009));
  add('trim', plate(-1, 0.66, 0.12, 0.52, 0.052, 0.012));
  add('trim', plate(-1, 0.45, 0.15, 1.12, 0.052));

  // The gaps around the doors, the front door's handle, and the rear one's, hidden in the rear pillar.
  for (const x of [0.85, WINDOWS.pillar, -0.98]) {
    add('trim', patch(x - 0.005, x + 0.005, 1, side(0.3), V.shoulder, 10, 0.0012));
  }
  add('trim', band(-0.17, -0.04, 3, BELT(-0.1) - 0.16, BELT(-0.1) - 0.128, 0.004));
  const glassAt = (t: number) => lerp(V.shoulder, V.glass, t);
  add('trim', patch(WINDOWS.rear - 0.13, WINDOWS.rear - 0.03, 2, glassAt(0.14), glassAt(0.5), 3, 0.002));
  // Behind the middle of the rear door the windows' lower edge climbs to the rear pillar: a wedge of the body's
  // color over the glass, as thin as a hair where it starts.
  const climb = (x: number) => 0.02 + ((WINDOWS.climb - 0.02) * (WINDOWS.kick - x)) / (WINDOWS.kick - WINDOWS.rear);
  const wedge = sampleGrid(
    (x, share) => skinAt(x, lerp(V.shoulder, glassAt(climb(x)), share)),
    steps(WINDOWS.rear - 0.005, WINDOWS.kick, 8),
    steps(0, 1, 3),
  );
  add('paint', symmetric(gridGeometry(lifted(wedge, 0.002))));

  // The cladding of the wheel arches: a flat band around each, which also covers the arch's steps between stations.
  for (const center of [CAR.axle, -CAR.axle]) {
    const ring = new TorusGeometry(ARCH + 0.02, 0.05, 8, 28, Math.PI).scale(1, 1, 0.45);
    add('trim', symmetric(at(ring, center, CAR.wheelRadius, HALF(center) - 0.012)));
  }
  // The roof's spoiler, over the top of the hatch's glass.
  const lip = SCREEN.rear[1] - 0.045;
  const fall = Math.atan((topY(lip + 0.08, 0) - topY(lip - 0.08, 0)) / 0.16);
  add('paint_dark', at(new RoundedBoxGeometry(0.2, 0.03, 1.36, 2, 0.012), lip, topY(lip, 0) + 0.012, 0, 0, 0, fall));

  // What is seen through the arches and through the glass.
  add('trim', at(new BoxGeometry(3.9, 0.42, 1.28), 0, 0.46, 0));
  add('interior', at(new BoxGeometry(2.15, 0.42, 1.3), -0.625, 1.01, 0));
  // The door mirrors, black with the roof.
  const mirrorX = 0.62;
  add(
    'paint_dark',
    symmetric(
      at(new SphereGeometry(1, 12, 8).scale(0.085, 0.06, 0.11), mirrorX, BELT(mirrorX) + 0.06, HALF(mirrorX) + 0.07),
    ),
  );
  add('trim', symmetric(at(new BoxGeometry(0.05, 0.02, 0.09), mirrorX, BELT(mirrorX) + 0.04, HALF(mirrorX) + 0.005)));

  for (const [name, list] of parts) body.add(mesh(`body_${name}`, merged(list), material(name)));
  const lines = new LineSegments(outline(), material(OUTLINE));
  lines.name = `body_${OUTLINE}`;
  body.add(lines);

  // Mative's wordmark, each one turned to who reads it: from either side on the front doors, from ahead on the hood,
  // from behind on the hatch's glass. On the left door it reads from the nose to the tail, never mirrored.
  const livery = new Group();
  livery.name = CAR_PARTS.livery;
  const { lift, door, hood, hatch } = LIVERY;
  const doors = [1, -1].map((flank) =>
    wordmark(door.length, (along, up): Point3 => {
      const x = door.x + flank * along;
      const y = door.y + up;
      return [x, y, flank * (sideZ(x, y) + lift)];
    }),
  );
  const onHood = wordmark(hood.length, (along, up): Point3 => {
    const x = hood.x - up / stretch(hood.x);
    return [x, topY(x, along) + lift, -along];
  });
  livery.add(mesh(`${CAR_PARTS.livery}_dark`, merged([...doors, onHood]), material('livery')));
  const onHatch = wordmark(hatch.length, (along, up): Point3 => {
    const x = hatch.x + up / stretch(hatch.x);
    return [x, topY(x, along) + lift, along];
  });
  livery.add(mesh(`${CAR_PARTS.livery}_light`, merged([onHatch]), material('livery_light')));
  body.add(livery);

  body.add(sensorKit({ nose: NOSE, top: topY, side: sideZ }, material));

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
