/**
 * The sensor kit of the MPC's car (Phase 8): what a car that drives itself carries where anyone can see
 * it, in shapes of no maker. On the roof, a fairing with the long-range lidar under its dome, over a collar of cameras
 * and a ring of light, a pod that looks ahead and two that look back from the corners; a small lidar on each front
 * fender, on the nose and on the tail; radar panels on the four corners of the bumpers.
 *
 * It is drawing only. The simulation's sensor is the core's list of objects, with its range, latency and noise: none of
 * these parts measures anything, and the scene never says one does.
 *
 * Materials by name (materials.ts): `sensor_shell` for the housings, `sensor_glass` for the windows the sensors look
 * through, `sensor_light` for the ring under the dome.
 */
import {
  CylinderGeometry,
  Group,
  LatheGeometry,
  LineSegments,
  Vector2,
  type BufferGeometry,
  type Material,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import { CAR_PARTS } from '../../packages/app/src/ui/scene3d/real/nominal.ts';
import { mesh, OUTLINE } from './materials.ts';
import {
  at,
  blister,
  gridGeometry,
  lifted,
  lineGeometry,
  merged,
  path,
  sampleGrid,
  steps,
  symmetric,
  type Point2,
  type Point3,
} from './shapes.ts';

/** What the kit asks of the body it is mounted on, m: its right half, the left one being its mirror image. */
export interface Body {
  /** How far ahead of the middle the nose ends, and behind it the tail. */
  nose: number;
  /** The height of the top (the roof, the glass at its two ends, the hood) at `x`, `z` m from the middle. */
  top(x: number, z: number): number;
  /** How far out the side is at `x`, at the height `y`. */
  side(x: number, y: number): number;
}

/** The fairing on the roof: where its middle is, half its length and its width, and how far it stands off the roof. */
const FAIRING = { x: -0.4, length: 0.6, width: 0.46, height: 0.05 } as const;
/** How square the fairing's outline is: 2 is an ellipse, and the higher the squarer. */
const SQUARENESS = 4;
/** The share of the way out where the fairing's edge starts to round down to the roof. */
const EDGE = 0.8;

/** Where the dome stands on the fairing, and how far its foot is sunk in it. */
const DOME = { x: -0.42, sunk: 0.004 } as const;
/** The dome's parts from its foot up, each a profile of (radius, height) turned about the dome's axis. */
const DOME_PARTS: readonly (readonly [string, readonly Point2[]])[] = [
  [
    'sensor_shell',
    [
      [0.205, -0.012],
      [0.196, 0.018],
      [0.172, 0.04],
    ],
  ],
  // The collar the cameras look out of, all around.
  [
    'sensor_glass',
    [
      [0.172, 0.04],
      [0.177, 0.058],
      [0.177, 0.104],
      [0.166, 0.118],
    ],
  ],
  [
    'sensor_light',
    [
      [0.166, 0.118],
      [0.169, 0.125],
      [0.166, 0.132],
    ],
  ],
  [
    'sensor_shell',
    [
      [0.166, 0.132],
      [0.152, 0.143],
      [0.128, 0.15],
    ],
  ],
  // The lidar's window, closed at the top.
  [
    'sensor_glass',
    [
      [0.128, 0.15],
      [0.131, 0.168],
      [0.131, 0.268],
      [0.124, 0.29],
      [0.1, 0.306],
      [0.05, 0.313],
      [0, 0.315],
    ],
  ],
];
/** The rings the ghost draws the dome with: (radius, height) over its foot. */
const DOME_RINGS: readonly Point2[] = [
  [0.177, 0.08],
  [0.131, 0.268],
];

/** How far a radar panel stands off the bumper it is on. */
const PANEL_LIFT = 0.005;

/** The fairing's point at `angle` around its middle and at `share` of the way out to its rim. */
function fairingPoint(body: Body, angle: number, share: number): Point3 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const x = FAIRING.x + share * FAIRING.length * Math.sign(cos) * Math.abs(cos) ** (2 / SQUARENESS);
  const z = share * FAIRING.width * Math.sign(sin) * Math.abs(sin) ** (2 / SQUARENESS);
  const out = Math.max(0, (share - EDGE) / (1 - EDGE));
  // The rim goes a little into the roof, so that no light shows under it.
  const rise = share >= 1 ? -0.08 : Math.sqrt(1 - out * out);
  return [x, body.top(x, z) + FAIRING.height * rise, z];
}

/** The sensor kit as the node `sensors`, to hang from the body it was made for. */
export function sensorKit(body: Body, material: (name: string) => Material): Group {
  const parts = new Map<string, BufferGeometry[]>();
  const add = (name: string, geometry: BufferGeometry) => {
    const list = parts.get(name) ?? [];
    list.push(geometry);
    parts.set(name, list);
  };

  add(
    'sensor_shell',
    blister((angle, share) => fairingPoint(body, angle, share), 48, [0.4, EDGE, 0.88, 0.94, 0.98, 1]),
  );

  // The dome, on the fairing.
  const foot = body.top(DOME.x, 0) + FAIRING.height - DOME.sunk;
  for (const [name, profile] of DOME_PARTS) {
    const turned = new LatheGeometry(
      profile.map(([radius, height]) => new Vector2(radius, height)),
      40,
    );
    add(name, at(turned, DOME.x, foot, 0));
  }

  // The pod that looks ahead, at the front of the fairing: it leans with the roof and is sunk a little into it.
  const podX = 0.06;
  const lean = Math.atan((body.top(podX + 0.1, 0) - body.top(podX - 0.1, 0)) / 0.2);
  const podY = body.top(podX, 0) + 0.045;
  add('sensor_shell', at(new RoundedBoxGeometry(0.26, 0.11, 0.5, 3, 0.04), podX, podY, 0, 0, 0, lean));
  const ahead = new RoundedBoxGeometry(0.03, 0.05, 0.42, 2, 0.012).translate(0.122, 0.012, 0);
  add('sensor_glass', at(ahead, podX, podY, 0, 0, 0, lean));

  // The two pods on the rear corners of the roof, each looking back and out.
  const rear = { x: -1.3, z: 0.56, turn: 0.6 } as const;
  const rearY = body.top(rear.x, rear.z) + 0.022;
  add(
    'sensor_shell',
    symmetric(at(new RoundedBoxGeometry(0.15, 0.07, 0.12, 2, 0.028), rear.x, rearY, rear.z, 0, rear.turn)),
  );
  const back = new RoundedBoxGeometry(0.02, 0.04, 0.085, 2, 0.008).translate(-0.07, 0, 0);
  add('sensor_glass', symmetric(at(back, rear.x, rearY, rear.z, 0, rear.turn)));

  // A lidar on each front fender: a bracket half in the body, the turning head on it and its cap.
  const fender = { x: 1.03, y: 0.86 } as const;
  const fenderZ = body.side(fender.x, fender.y);
  add(
    'sensor_shell',
    symmetric(at(new RoundedBoxGeometry(0.18, 0.08, 0.11, 2, 0.03), fender.x, fender.y, fenderZ + 0.012)),
  );
  add(
    'sensor_glass',
    symmetric(at(new CylinderGeometry(0.046, 0.046, 0.06, 20), fender.x, fender.y + 0.066, fenderZ + 0.03)),
  );
  add(
    'sensor_shell',
    symmetric(at(new CylinderGeometry(0.05, 0.046, 0.014, 20), fender.x, fender.y + 0.103, fenderZ + 0.03)),
  );

  // One on the nose and one on the tail: a window in its frame, and the head that bulges out of it.
  for (const [toward, y, wide] of [
    [1, 0.57, 0.3],
    [-1, 0.835, 0.26],
  ] as const) {
    const x = toward * body.nose;
    add('sensor_shell', at(new RoundedBoxGeometry(0.03, 0.1, wide, 2, 0.014), x + toward * 0.04, y, 0));
    add('sensor_glass', at(new RoundedBoxGeometry(0.03, 0.07, wide - 0.05, 2, 0.012), x + toward * 0.046, y, 0));
    add('sensor_glass', at(new CylinderGeometry(0.042, 0.042, 0.05, 20), x + toward * 0.028, y, 0));
  }

  // The radars: a panel on each corner of the bumpers, on the skin.
  const panel = (x0: number, x1: number, y0: number, y1: number) => {
    const grid = sampleGrid((x, y) => [x, y, body.side(x, y)], steps(x0, x1, 4), steps(y0, y1, 2));
    return symmetric(gridGeometry(lifted(grid, PANEL_LIFT)));
  };
  add('sensor_glass', panel(1.97, 2.11, 0.5, 0.585));
  add('sensor_glass', panel(-2.12, -1.99, 0.5, 0.59));

  const kit = new Group();
  kit.name = CAR_PARTS.sensors;
  for (const [name, list] of parts) kit.add(mesh(`${CAR_PARTS.sensors}_${name}`, merged(list), material(name)));

  // What the ghost draws of the kit: the fairing's rim and two rings of the dome.
  const segments: number[] = [];
  const closed = (points: Point3[]) => path([...points, points[0] as Point3], segments);
  closed(steps(0, 2 * Math.PI, 48).map((angle) => fairingPoint(body, angle, 0.98)));
  for (const [radius, height] of DOME_RINGS) {
    closed(
      steps(0, 2 * Math.PI, 32).map((angle): Point3 => [
        DOME.x + radius * Math.cos(angle),
        foot + height,
        radius * Math.sin(angle),
      ]),
    );
  }
  const lines = new LineSegments(lineGeometry(segments), material(OUTLINE));
  lines.name = `${CAR_PARTS.sensors}_${OUTLINE}`;
  kit.add(lines);
  return kit;
}
