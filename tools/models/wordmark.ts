/**
 * Mative's wordmark as geometry (Phase 8): the lettering of the MPC's car. The outline is the logo's own,
 * a closed path of lines and cubic curves in a box of 455 by 95; here it becomes flat triangles laid on a surface of the
 * car, a few millimeters off it. No typeface is involved: the letters are the logo's drawing.
 */
import { ShapeGeometry, ShapePath, type BufferGeometry, type Shape } from 'three';

import type { Point3 } from './shapes.ts';

/** The box the outline is drawn in, with y growing downward as in the logo's file. */
const BOX = { width: 455, height: 95 } as const;

const OUTLINE =
  'M0 93.0188V28.1101H24.1491V41.7818C28.3656 31.9433 35.7765 27.0879 46.2539 27.0879C56.7313 27.0879 62.6088 31.6877 63.7588 41.0152C67.7197 32.8377 76.1528 27.0879 88.0357 27.0879C103.88 27.0879 111.418 35.3931 111.418 54.9424V93.0188H87.269V55.198C87.269 49.7037 84.8413 46.765 79.3471 46.765C72.3196 46.765 69.5086 51.3648 68.6142 57.8812C68.1031 61.0755 67.8475 65.9309 67.8475 72.3196V93.0188H43.1873L43.6984 92.3799V55.198C43.6984 50.4704 40.8874 47.5316 35.7765 47.5316C28.7489 47.5316 25.8102 51.3648 24.9158 57.8812C24.4047 61.0755 24.1491 65.9309 24.1491 72.3196V93.0188H0ZM124.195 88.2912C120.618 84.3302 118.829 80.1137 118.829 75.3861C118.829 62.7366 126.623 56.2202 146.428 55.7091L166.361 55.198C166.361 55.0702 166.361 54.8147 166.361 54.6869C166.361 47.7871 163.677 44.7206 155.117 44.7206C147.578 44.7206 143.489 46.5094 142.85 50.2148L120.746 47.9149C121.896 38.5875 128.412 32.7099 137.101 29.26C141.445 27.599 148.345 26.8324 157.544 26.8324C158.055 26.8324 158.439 26.8324 158.95 26.8324C167.766 26.9601 175.049 28.7489 180.671 32.4544C186.293 36.1598 189.104 42.5484 189.104 51.4925V71.8085H198.687V93.0188H183.099C176.455 93.0188 172.494 89.3134 172.494 82.6692V77.3027C168.022 90.08 159.589 94.2965 143.361 94.2965C134.162 94.2965 127.773 92.2522 124.195 88.2912ZM382.808 60.4367C382.808 37.4375 395.713 26.7046 419.096 26.7046C432.001 26.7046 441.201 29.6434 446.695 35.6487C452.189 41.654 455 49.576 455 59.67V64.781H406.702C406.83 73.0862 410.79 78.0694 419.351 78.1971C419.479 78.1971 419.735 78.1971 419.862 78.1971C426.762 78.1971 430.979 74.3639 431.873 71.2974H455C454.617 78.3249 451.295 83.8191 444.906 88.0357C438.517 92.2522 429.956 94.2965 419.224 94.2965C406.83 94.2965 397.758 91.23 391.752 84.9691C385.747 78.836 382.808 70.6585 382.808 60.4367ZM201.754 28.1101H212.614V17.6327L236.764 10.0941V28.1101H253.374V49.0649H236.508V72.1918H256.568V93.0188H224.114C216.575 93.0188 212.359 88.8023 212.359 81.2637V49.0649H201.754V28.1101ZM303.844 28.7489H327.738L342.432 77.0472L357.509 29.26H380.508L359.298 93.0188H325.438L303.844 28.7489ZM263.724 49.0649V28.1101H285.701C293.367 28.1101 297.839 32.071 297.839 39.6097L298.478 93.0188H274.073V49.0649H263.724ZM270.879 10.8607C270.879 10.7329 270.879 10.6052 270.879 10.4774C270.879 3.70542 275.99 0 284.04 0C292.217 0 297.711 3.70542 297.711 10.8607C297.711 18.016 292.345 21.7214 284.04 21.7214C275.479 21.7214 271.007 18.1438 270.879 10.8607ZM406.446 54.6869H432.256C432.256 46.6372 427.018 42.6762 419.479 42.6762C411.94 42.6762 406.446 46.6372 406.446 54.6869ZM141.317 71.1696C141.317 74.6195 144.384 76.9194 149.495 76.9194C153.711 76.9194 157.416 75.7694 160.866 73.3418C164.188 70.9141 165.849 68.2308 165.849 65.0365L150.644 65.8031C143.361 66.1865 141.317 68.1031 141.317 71.1696Z';

/** How many straight pieces a curve of the outline is drawn with. */
const CURVE_STEPS = 6;

/** How tall the wordmark is for each meter of its length. */
export const WORDMARK_ASPECT = BOX.height / BOX.width;

/**
 * The outline as a path with y growing upward. It is written with absolute commands only (M, L, H, V, C, Z), and any
 * other stops the build: a logo redrawn with other commands is read here before it is trusted.
 */
function outlinePath(): ShapePath {
  const path = new ShapePath();
  const up = (y: number) => BOX.height - y;
  let x = 0;
  let y = 0;
  for (const [, command = '', rest = ''] of OUTLINE.matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
    const numbers = (rest.match(/-?\d*\.?\d+/g) ?? []).map(Number);
    let next = 0;
    const take = (): number => {
      const value = numbers[next++];
      if (value === undefined) throw new Error(`The wordmark's outline has a ${command} that is cut short.`);
      return value;
    };
    const each = (step: () => void) => {
      do step();
      while (next < numbers.length);
    };
    if (command === 'M') {
      x = take();
      y = take();
      path.moveTo(x, up(y));
    } else if (command === 'L') {
      each(() => {
        x = take();
        y = take();
        path.lineTo(x, up(y));
      });
    } else if (command === 'H') {
      each(() => {
        x = take();
        path.lineTo(x, up(y));
      });
    } else if (command === 'V') {
      each(() => {
        y = take();
        path.lineTo(x, up(y));
      });
    } else if (command === 'C') {
      each(() => {
        const x1 = take();
        const y1 = take();
        const x2 = take();
        const y2 = take();
        x = take();
        y = take();
        path.bezierCurveTo(x1, up(y1), x2, up(y2), x, up(y));
      });
    } else if (command !== 'Z') {
      throw new Error(`The wordmark's outline uses ${command}, which this reader does not know.`);
    }
  }
  return path;
}

/** The letters as shapes: seven of them (the i is a stem and a dot), with the counters of the a and of the e as holes. */
export function wordmarkShapes(): Shape[] {
  return outlinePath().toShapes();
}

/** A step along a surface, m, short enough to tell which way the surface faces at a point. */
const NEAR = 1e-3;

/**
 * The wordmark `length` m long, laid on a surface. `place(along, up)` is the point of the surface `along` m to the
 * reader's right of the middle of the mark and `up` m above it: laid that way, the mark faces its reader. Its normals
 * are the surface's own, so the mark is lit as what it lies on.
 */
export function wordmark(length: number, place: (along: number, up: number) => Point3): BufferGeometry {
  const geometry = new ShapeGeometry(wordmarkShapes(), CURVE_STEPS);
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const scale = length / BOX.width;
  for (let i = 0; i < position.count; i++) {
    const along = (position.getX(i) - BOX.width / 2) * scale;
    const up = (position.getY(i) - BOX.height / 2) * scale;
    const [x, y, z] = place(along, up);
    const right = place(along + NEAR, up);
    const above = place(along, up + NEAR);
    const [ax, ay, az] = [right[0] - x, right[1] - y, right[2] - z];
    const [bx, by, bz] = [above[0] - x, above[1] - y, above[2] - z];
    // To the reader's right, then up: the two turn toward the reader.
    const [nx, ny, nz] = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
    const size = Math.hypot(nx, ny, nz);
    position.setXYZ(i, x, y, z);
    normal.setXYZ(i, nx / size, ny / size, nz / size);
  }
  position.needsUpdate = true;
  normal.needsUpdate = true;
  return geometry;
}
