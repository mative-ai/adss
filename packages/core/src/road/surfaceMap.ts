/**
 * Which surface is under each wheel: a base surface plus zones along the road, on both sides of the reference
 * line or on one side only (μ-split). A map keeps one projection hint per wheel, so each vehicle needs its
 * own; `reset` forgets the hints when the vehicle is placed somewhere new.
 */
import type { SurfaceSource } from '../vehicle/plant.ts';
import { SURFACES, type Surface, type SurfaceId } from '../vehicle/surfaces.ts';
import type { Projection, RoadPath } from './path.ts';

export interface SurfaceZone {
  /** Arc length where the zone starts and ends, m. */
  readonly from: number;
  readonly to: number;
  /** Side of the reference line; both by default. */
  readonly side?: 'both' | 'left' | 'right';
  readonly surface: SurfaceId;
}

/** The same surface everywhere. */
export function uniformSurface(id: SurfaceId): SurfaceSource {
  const surface = SURFACES[id];
  return { at: () => surface, reset: () => {} };
}

export class SurfaceMap implements SurfaceSource {
  private readonly path: RoadPath;
  private readonly base: Surface;
  private readonly zones: readonly SurfaceZone[];
  private readonly hints = new Int32Array(4).fill(-1);
  /** Per wheel: the last projection was far off the road, so a far result is expected, not a stale hint. */
  private readonly offRoad = [false, false, false, false];
  private readonly projection: Projection = { s: 0, ey: 0, heading: 0, curvature: 0, index: -1 };

  constructor(path: RoadPath, base: SurfaceId, zones: readonly SurfaceZone[]) {
    this.path = path;
    this.base = SURFACES[base];
    this.zones = zones;
  }

  reset(): void {
    this.hints.fill(-1);
    this.offRoad.fill(false);
  }

  at(wheel: number, x: number, y: number): Surface {
    const p = this.path.project(x, y, this.hints[wheel] ?? -1, this.projection, !this.offRoad[wheel]);
    this.hints[wheel] = p.index;
    this.offRoad[wheel] = this.path.isFar(p.ey);
    if (!Number.isFinite(p.s) || !Number.isFinite(p.ey)) return this.base;
    for (const zone of this.zones) {
      if (p.s < zone.from || p.s >= zone.to) continue;
      const side = zone.side ?? 'both';
      if (side === 'both' || (side === 'left' ? p.ey > 0 : p.ey < 0)) return SURFACES[zone.surface];
    }
    return this.base;
  }
}

export function surfaceMap(path: RoadPath, base: SurfaceId, zones: readonly SurfaceZone[]): SurfaceMap {
  return new SurfaceMap(path, base, zones);
}
