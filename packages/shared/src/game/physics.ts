import { clamp } from '../core/math';
import type { StaticBody } from './types';

export interface RayHit {
  t: number;
  nx: number;
  nz: number;
}

export interface DoorBody extends StaticBody {
  open: boolean;
}

const GRID_CELL = 9;

export class PhysicsWorld {
  readonly walls: StaticBody[];
  readonly doors: DoorBody[] = [];
  private grid = new Map<number, StaticBody[]>();
  private gridW = 0;

  constructor(walls: StaticBody[]) {
    this.walls = walls;
    this.rebuild();
  }

  rebuild(): void {
    this.grid.clear();
    if (this.walls.length === 0) return;

    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const w of this.walls) {
      minX = Math.min(minX, w.cx - w.hw);
      minZ = Math.min(minZ, w.cz - w.hh);
      maxX = Math.max(maxX, w.cx + w.hw);
      maxZ = Math.max(maxZ, w.cz + w.hh);
    }
    this.gridW = Math.ceil((maxX - minX) / GRID_CELL) + 1;

    for (const w of this.walls) {
      const gx0 = Math.floor((w.cx - w.hw - minX) / GRID_CELL);
      const gx1 = Math.floor((w.cx + w.hw - minX) / GRID_CELL);
      const gz0 = Math.floor((w.cz - w.hh - minZ) / GRID_CELL);
      const gz1 = Math.floor((w.cz + w.hh - minZ) / GRID_CELL);
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const key = gz * this.gridW + gx;
          let list = this.grid.get(key);
          if (!list) {
            list = [];
            this.grid.set(key, list);
          }
          list.push(w);
        }
      }
    }
  }

  addDoor(d: DoorBody): void {
    this.doors.push(d);
  }

  query(minX: number, minZ: number, maxX: number, maxZ: number, out: StaticBody[]): StaticBody[] {
    out.length = 0;
    if (this.walls.length === 0) return out;

    let minX2 = Infinity;
    let minZ2 = Infinity;
    let maxX2 = -Infinity;
    let maxZ2 = -Infinity;
    for (const w of this.walls) {
      minX2 = Math.min(minX2, w.cx - w.hw);
      minZ2 = Math.min(minZ2, w.cz - w.hh);
      maxX2 = Math.max(maxX2, w.cx + w.hw);
      maxZ2 = Math.max(maxZ2, w.cz + w.hh);
    }

    const gx0 = Math.floor((minX - minX2) / GRID_CELL);
    const gx1 = Math.floor((maxX - minX2) / GRID_CELL);
    const gz0 = Math.floor((minZ - minZ2) / GRID_CELL);
    const gz1 = Math.floor((maxZ - minZ2) / GRID_CELL);

    const seen = new Set<StaticBody>();
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const list = this.grid.get(gz * this.gridW + gx);
        if (!list) continue;
        for (const w of list) {
          if (seen.has(w)) continue;
          seen.add(w);
          out.push(w);
        }
      }
    }
    return out;
  }

  /** All static bodies that currently block movement or bullets. */
  solids(out: StaticBody[]): StaticBody[] {
    out.length = 0;
    for (const d of this.doors) if (!d.open) out.push(d);
    return out;
  }

  /** Nearest static hit along a segment, or null. */
  castSegment(
    x0: number,
    z0: number,
    dx: number,
    dz: number,
    maxT: number,
    scratch: StaticBody[],
  ): RayHit | null {
    let best: RayHit | null = null;
    let bestBody: StaticBody | null = null;

    const test = (b: StaticBody) => {
      const hit = rayAabb(x0, z0, dx, dz, b);
      if (hit && hit.t <= maxT && (!best || hit.t < best.t)) {
        best = hit;
        bestBody = b;
      }
    };

    const minX = Math.min(x0, x0 + dx * maxT);
    const maxX = Math.max(x0, x0 + dx * maxT);
    const minZ = Math.min(z0, z0 + dz * maxT);
    const maxZ = Math.max(z0, z0 + dz * maxT);
    this.query(minX, minZ, maxX, maxZ, scratch);
    for (const b of scratch) test(b);
    for (const d of this.doors) if (!d.open) test(d);

    void bestBody;
    return best;
  }

  /** True when nothing blocks the segment (line of sight). */
  lineOfSight(x0: number, z0: number, x1: number, z1: number, scratch: StaticBody[]): boolean {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return true;
    return this.castSegment(x0, z0, dx / len, dz / len, len, scratch) === null;
  }
}

export function rayAabb(
  x0: number,
  z0: number,
  dx: number,
  dz: number,
  b: StaticBody,
): RayHit | null {
  let tmin = 0;
  let tmax = 1;
  let nx = 0;
  let nz = 0;

  if (Math.abs(dx) < 1e-9) {
    if (x0 < b.cx - b.hw || x0 > b.cx + b.hw) return null;
  } else {
    const inv = 1 / dx;
    let t1 = (b.cx - b.hw - x0) * inv;
    let t2 = (b.cx + b.hw - x0) * inv;
    let sign = -1;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
      sign = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      nx = sign;
      nz = 0;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }

  if (Math.abs(dz) < 1e-9) {
    if (z0 < b.cz - b.hh || z0 > b.cz + b.hh) return null;
  } else {
    const inv = 1 / dz;
    let t1 = (b.cz - b.hh - z0) * inv;
    let t2 = (b.cz + b.hh - z0) * inv;
    let sign = -1;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
      sign = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      nx = 0;
      nz = sign;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }

  if (tmin < 0 || tmin > 1) return null;
  return { t: tmin, nx, nz };
}

/** Pushes a circle out of an axis-aligned box. Mutates `pos`. */
export function resolveCircleBox(
  pos: { x: number; z: number },
  radius: number,
  cx: number,
  cz: number,
  hw: number,
  hh: number,
): boolean {
  const closestX = clamp(pos.x, cx - hw, cx + hw);
  const closestZ = clamp(pos.z, cz - hh, cz + hh);
  const dx = pos.x - closestX;
  const dz = pos.z - closestZ;
  const d2 = dx * dx + dz * dz;

  if (d2 > radius * radius) return false;

  if (d2 < 1e-8) {
    // Deep inside the box: eject along the shallowest axis.
    const px = hw - Math.abs(pos.x - cx);
    const pz = hh - Math.abs(pos.z - cz);
    if (px < pz) {
      pos.x = cx + (pos.x >= cx ? 1 : -1) * (hw + radius);
    } else {
      pos.z = cz + (pos.z >= cz ? 1 : -1) * (hh + radius);
    }
    return true;
  }

  const d = Math.sqrt(d2);
  const push = radius - d;
  pos.x += (dx / d) * push;
  pos.z += (dz / d) * push;
  return true;
}
