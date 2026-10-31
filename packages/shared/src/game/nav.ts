import type { StaticBody } from './types';

// Navigation for the AI: a 0.5 m occupancy grid built once per map from walls
// and anchored props (with the body radius as clearance), searched with BFS
// on demand. Paths are smoothed by skipping waypoints that are in straight
// sight of each other, so bots walk diagonals instead of staircases.

const CELL = 0.5;

export class NavGrid {
  readonly w: number;
  readonly h: number;
  private blocked: Uint8Array;
  private prev: Int32Array;
  private queue: Int32Array;

  constructor(
    private readonly minX: number,
    private readonly minZ: number,
    maxX: number,
    maxZ: number,
    solids: StaticBody[],
    clearance: number,
  ) {
    this.w = Math.ceil((maxX - minX) / CELL);
    this.h = Math.ceil((maxZ - minZ) / CELL);
    this.blocked = new Uint8Array(this.w * this.h);
    this.prev = new Int32Array(this.w * this.h);
    this.queue = new Int32Array(this.w * this.h);
    for (const b of solids) {
      const x0 = Math.max(0, Math.floor((b.cx - b.hw - clearance - minX) / CELL));
      const x1 = Math.min(this.w - 1, Math.floor((b.cx + b.hw + clearance - minX) / CELL));
      const z0 = Math.max(0, Math.floor((b.cz - b.hh - clearance - minZ) / CELL));
      const z1 = Math.min(this.h - 1, Math.floor((b.cz + b.hh + clearance - minZ) / CELL));
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const cx = minX + (x + 0.5) * CELL;
          const cz = minZ + (z + 0.5) * CELL;
          const dx = Math.max(Math.abs(cx - b.cx) - b.hw, 0);
          const dz = Math.max(Math.abs(cz - b.cz) - b.hh, 0);
          if (dx * dx + dz * dz < clearance * clearance) this.blocked[z * this.w + x] = 1;
        }
      }
    }
  }

  /** Debug view: one char per cell, '#' blocked. */
  dump(): string {
    const rows: string[] = [];
    for (let z = 0; z < this.h; z++) {
      let row = '';
      for (let x = 0; x < this.w; x++) row += this.blocked[z * this.w + x] ? '#' : '.';
      rows.push(row);
    }
    return rows.join('\n');
  }

  walkable(x: number, z: number): boolean {
    const gx = Math.floor((x - this.minX) / CELL);
    const gz = Math.floor((z - this.minZ) / CELL);
    if (gx < 0 || gz < 0 || gx >= this.w || gz >= this.h) return false;
    return this.blocked[gz * this.w + gx] === 0;
  }

  /** Nearest walkable cell centre to a point (spiral search), or null. */
  snap(x: number, z: number): { x: number; z: number } | null {
    const gx = Math.floor((x - this.minX) / CELL);
    const gz = Math.floor((z - this.minZ) / CELL);
    for (let r = 0; r < 10; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const nx = gx + dx;
          const nz = gz + dz;
          if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.h) continue;
          if (this.blocked[nz * this.w + nx] === 0) {
            return { x: this.minX + (nx + 0.5) * CELL, z: this.minZ + (nz + 0.5) * CELL };
          }
        }
      }
    }
    return null;
  }

  /** BFS path from a to b (world points). Null if unreachable. */
  find(ax: number, az: number, bx: number, bz: number): { x: number; z: number }[] | null {
    const a = this.snap(ax, az);
    const b = this.snap(bx, bz);
    if (!a || !b) return null;
    const w = this.w;
    const sx = Math.floor((a.x - this.minX) / CELL);
    const sz = Math.floor((a.z - this.minZ) / CELL);
    const tx = Math.floor((b.x - this.minX) / CELL);
    const tz = Math.floor((b.z - this.minZ) / CELL);
    const start = sz * w + sx;
    const goal = tz * w + tx;
    const prev = this.prev;
    prev.fill(-2);
    prev[start] = -1;
    const q = this.queue;
    let head = 0;
    let tail = 0;
    q[tail++] = start;
    let found = start === goal;
    while (head < tail && !found) {
      const k = q[head++];
      const x = k % w;
      const z = (k / w) | 0;
      for (let d = 0; d < 8; d++) {
        const ox = DX[d];
        const oz = DZ[d];
        const nx = x + ox;
        const nz = z + oz;
        if (nx < 0 || nz < 0 || nx >= w || nz >= this.h) continue;
        const nk = nz * w + nx;
        if (prev[nk] !== -2 || this.blocked[nk]) continue;
        // No corner cutting on diagonals.
        if (ox !== 0 && oz !== 0 && (this.blocked[z * w + nx] || this.blocked[nz * w + x])) continue;
        prev[nk] = k;
        if (nk === goal) {
          found = true;
          break;
        }
        q[tail++] = nk;
      }
    }
    if (!found) return null;
    const cells: number[] = [];
    for (let c = goal; c >= 0; c = prev[c]) cells.push(c);
    cells.reverse();
    // String-pull: keep a waypoint only when the straight line breaks.
    const out: { x: number; z: number }[] = [];
    let anchor = 0;
    for (let i = 1; i < cells.length; i++) {
      if (!this.clearLine(cells[anchor], cells[i])) {
        out.push(this.centre(cells[i - 1]));
        anchor = i - 1;
      }
    }
    out.push({ x: bx, z: bz });
    return out;
  }

  private centre(k: number): { x: number; z: number } {
    return { x: this.minX + ((k % this.w) + 0.5) * CELL, z: this.minZ + (((k / this.w) | 0) + 0.5) * CELL };
  }

  /** Grid line walk between two cells over walkable cells only. */
  private clearLine(a: number, b: number): boolean {
    let x0 = a % this.w;
    let z0 = (a / this.w) | 0;
    const x1 = b % this.w;
    const z1 = (b / this.w) | 0;
    const dx = Math.abs(x1 - x0);
    const dz = Math.abs(z1 - z0);
    const sx = x0 < x1 ? 1 : -1;
    const sz = z0 < z1 ? 1 : -1;
    let err = dx - dz;
    for (;;) {
      if (this.blocked[z0 * this.w + x0]) return false;
      if (x0 === x1 && z0 === z1) return true;
      const e2 = 2 * err;
      if (e2 > -dz) {
        err -= dz;
        x0 += sx;
      }
      if (e2 < dx) {
        err += dx;
        z0 += sz;
      }
    }
  }
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
