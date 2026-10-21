/**
 * Level progression check across many seeds: clear each room (enemies are
 * killed directly), then walk the player to the next room along a grid path
 * (BFS around walls and anchored props) using the real movement code. Every
 * map must be completable.
 */
import { CONFIG } from '../src/game/config';
import { generateMap } from '../src/game/levelgen';
import { Sim } from '../src/game/sim';
import type { StaticBody } from '../src/game/types';

const out: string[] = [];
let failures = 0;
const dt = CONFIG.tickDt;
const STEP = 0.5;
const CLEAR = CONFIG.player.radius + 0.1;

function blocked(x: number, z: number, solids: StaticBody[]): boolean {
  for (const b of solids) {
    const dx = Math.max(Math.abs(x - b.cx) - b.hw, 0);
    const dz = Math.max(Math.abs(z - b.cz) - b.hh, 0);
    if (dx * dx + dz * dz < CLEAR * CLEAR) return true;
  }
  return false;
}

function findPath(sim: Sim, fx: number, fz: number, tx: number, tz: number): { x: number; z: number }[] | null {
  const map = sim.map;
  const solids: StaticBody[] = [
    ...map.walls,
    ...sim.doors.filter((d) => !d.body.open).map((d) => d.body),
    ...sim.props.filter((p) => p.alive && p.fixed).map((p) => ({ cx: p.x, cz: p.z, hw: p.hw, hh: p.hh })),
  ];
  const w = Math.ceil((map.maxX - map.minX) / STEP) + 1;
  const h = Math.ceil((map.maxZ - map.minZ) / STEP) + 1;
  const key = (x: number, z: number) => z * w + x;
  const cell = (v: number, min: number) => Math.round((v - min) / STEP);
  const sx = cell(fx, map.minX), sz = cell(fz, map.minZ);
  let gx = cell(tx, map.minX), gz = cell(tz, map.minZ);
  // Snap the goal to the nearest free cell (like NavGrid.snap).
  snap: for (let r = 0; r < 6; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (!blocked(map.minX + (gx + dx) * STEP, map.minZ + (gz + dz) * STEP, solids)) {
          gx += dx;
          gz += dz;
          break snap;
        }
      }
    }
  }
  const prev = new Int32Array(w * h).fill(-2);
  prev[key(sx, sz)] = -1;
  const queue = [key(sx, sz)];
  for (let qi = 0; qi < queue.length; qi++) {
    const k = queue[qi];
    const x = k % w, z = (k / w) | 0;
    if (x === gx && z === gz) {
      const path: { x: number; z: number }[] = [];
      for (let c = k; c >= 0; c = prev[c]) path.push({ x: map.minX + (c % w) * STEP, z: map.minZ + ((c / w) | 0) * STEP });
      return path.reverse();
    }
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + ox, nz = z + oz;
      if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
      const nk = key(nx, nz);
      if (prev[nk] !== -2) continue;
      if (blocked(map.minX + nx * STEP, map.minZ + nz * STEP, solids)) continue;
      prev[nk] = k;
      queue.push(nk);
    }
  }
  return null;
}

for (let seed = 1; seed <= 300; seed++) {
  const map = generateMap(seed * 2654435761 >>> 0);
  const sim = new Sim(map);
  const me = sim.addPlayer('local', 'test', 1);
  let won = false;
  let stuck = '';
  const tick = () => {
    for (const a of sim.actors.values()) if (a.kind === 'enemy' && a.alive) sim.damageActor(a, 1e6, me.id);
    me.hp = me.maxHp;
    sim.step(dt);
    for (const e of sim.drainEvents()) if (e.type === 'victory') won = true;
  };
  for (let room = 0; room < map.rooms.length && !stuck && !won; room++) {
    for (let i = 0; i < 120; i++) tick();
    const next = map.rooms[room + 1];
    if (!next || won) break;
    // Head for the free spot nearest the next room's centre.
    let goal = { x: next.wx, z: next.wz };
    search: for (let r = 0; r < 8; r += 0.5) {
      for (let k = 0; k < 16; k++) {
        const gx = next.wx + Math.cos((k / 16) * Math.PI * 2) * r;
        const gz = next.wz + Math.sin((k / 16) * Math.PI * 2) * r;
        if (sim.nav.walkable(gx, gz)) {
          goal = { x: gx, z: gz };
          break search;
        }
      }
    }
    const path = findPath(sim, me.x, me.z, goal.x, goal.z);
    if (!path) {
      const toDoor = findPath(sim, me.x, me.z, next.doorX, next.doorZ);
      const fromDoor = findPath(sim, next.doorX, next.doorZ, goal.x, goal.z);
      const fixed = sim.props.filter((p) => p.fixed && (p.room === room || p.room === room + 1)).map((p) => `${p.room}:${p.x.toFixed(1)},${p.z.toFixed(1)}`);
      console.log(seed, 'toDoor', !!toDoor, 'fromDoor', !!fromDoor, 'door', next.doorX, next.doorZ, next.doorAxis, 'me', me.x.toFixed(1), me.z.toFixed(1), 'room', JSON.stringify([map.rooms[room].minX, map.rooms[room].maxX, map.rooms[room].minZ, map.rooms[room].maxZ]), 'next', JSON.stringify([next.minX, next.maxX, next.minZ, next.maxZ]), 'fixed', fixed.join(' '));
      {
        const solids: StaticBody[] = [
          ...map.walls,
          ...sim.doors.filter((d) => !d.body.open).map((d) => d.body),
          ...sim.props.filter((p) => p.alive && p.fixed).map((p) => ({ cx: p.x, cz: p.z, hw: p.hw, hh: p.hh })),
        ];
        const rows: string[] = [];
        for (let z = next.doorZ - 6; z <= next.doorZ + 14; z += 0.5) {
          let row = '';
          for (let x = next.doorX - 12; x <= next.doorX + 12; x += 0.5) {
            const isProp = sim.props.some((p) => p.alive && p.fixed && Math.abs(p.x - x) <= p.hw && Math.abs(p.z - z) <= p.hh);
            const isWall = map.walls.some((w) => Math.abs(w.cx - x) <= w.hw && Math.abs(w.cz - z) <= w.hh);
            row += isWall ? '#' : isProp ? 'P' : blocked(x, z, solids) ? '+' : Math.hypot(x - me.x, z - me.z) < 0.5 ? '@' : '.';
          }
          rows.push(row);
        }
        console.log(`seed ${seed}\n` + rows.join('\n'));
      }
      stuck = `no path from room ${room + 1} to room ${room + 2}`;
      break;
    }
    let t = 0;
    for (const wp of path) {
      while (Math.hypot(me.x - wp.x, me.z - wp.z) > 0.35 && t < 30) {
        const l = Math.hypot(wp.x - me.x, wp.z - me.z);
        sim.moveActor(me, (wp.x - me.x) / l, (wp.z - me.z) / l, dt);
        tick();
        t += dt;
      }
    }
    if (t >= 30) stuck = `stuck walking to room ${room + 2} at (${me.x.toFixed(1)}, ${me.z.toFixed(1)})`;
    else if (sim.roomIndex !== room + 1) stuck = `roomIndex ${sim.roomIndex} after reaching room ${room + 2}`;
  }
  for (let i = 0; i < 90 && !won && !stuck; i++) tick();
  const ok = won && !stuck;
  if (!ok) failures++;
  out.push(`${ok ? 'PASS' : 'FAIL'} seed ${seed} rooms=${map.rooms.length} ${stuck || (won ? '' : 'no victory')}`);
}
out.push(`${failures} failures`);
document.getElementById('out')!.textContent = out.join('\n');
(window as unknown as { __result: string }).__result = out.join('\n');
