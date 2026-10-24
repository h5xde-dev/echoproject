import { Rng } from '../core/rng';
import { CONFIG, TILE } from './config';
import type {
  BushDef,
  FloorRect,
  LampDef,
  MapData,
  PickupDef,
  PowerupDef,
  PowerupKind,
  PropDef,
  PropKind,
  RoomDef,
  RoomTheme,
  StaticBody,
} from './types';
import { WEAPON_ORDER, type WeaponId } from './weapons';

// Co-op levels: a chain of rooms joined by armoured doors. Each room gets a
// theme that decides its prop mix and look (warehouse, office, yard, bunker);
// big rooms get pillars. The first room is a safe start without guards.

interface RawRoom {
  cx0: number;
  cz0: number;
  cx1: number;
  cz1: number;
  doorX: number;
  doorZ: number;
  doorAxis: 'x' | 'z';
  hasDoor: boolean;
}

export interface PropSpec {
  hw: number;
  hh: number;
  hp: number;
  explosive: boolean;
  /** Anchored: never pushed or destroyed; keeps a walkable gap around it. */
  fixed: boolean;
}

export const PROP_TABLE: Record<PropKind, PropSpec> = {
  crate: { hw: 0.75, hh: 0.75, hp: 45, explosive: false, fixed: false },
  barrel: { hw: 0.6, hh: 0.6, hp: 28, explosive: true, fixed: false },
  table: { hw: 1.5, hh: 0.85, hp: 120, explosive: false, fixed: false },
  chair: { hw: 0.5, hh: 0.5, hp: 20, explosive: false, fixed: false },
  cover: { hw: 1.35, hh: 0.4, hp: 260, explosive: false, fixed: true },
  car: { hw: 2.1, hh: 0.95, hp: 999, explosive: false, fixed: true },
  pallet: { hw: 1.0, hh: 0.8, hp: 90, explosive: false, fixed: false },
  drum: { hw: 0.45, hh: 0.45, hp: 35, explosive: false, fixed: false },
  cabinet: { hw: 0.55, hh: 0.4, hp: 999, explosive: false, fixed: true },
  tires: { hw: 0.9, hh: 0.9, hp: 999, explosive: false, fixed: true },
  ammo: { hw: 0.6, hh: 0.35, hp: 40, explosive: false, fixed: false },
};

/** Prop mix per theme: [kind, min, max]. */
const DRESSING: Record<RoomTheme, [PropKind, number, number][]> = {
  warehouse: [['crate', 2, 4], ['pallet', 1, 2], ['barrel', 0, 2], ['drum', 1, 3], ['cover', 0, 1]],
  office: [['table', 1, 3], ['chair', 2, 4], ['cabinet', 1, 2], ['crate', 0, 1]],
  yard: [['car', 1, 1], ['tires', 1, 2], ['cover', 1, 2], ['barrel', 0, 2], ['chair', 0, 1]],
  bunker: [['ammo', 2, 3], ['cover', 1, 2], ['crate', 1, 2], ['barrel', 1, 2], ['cabinet', 0, 1]],
};

export const THEME_LAMP: Record<RoomTheme, number> = {
  warehouse: 0xffb066,
  office: 0xdfe8ff,
  yard: 0x9fb8e0,
  bunker: 0xb0ff9a,
};

const POWERUP_WEIGHTS: [PowerupKind, number][] = [
  ['medkit', 0.31],
  ['armor', 0.22],
  ['damage', 0.14],
  ['rapid', 0.12],
  ['speed', 0.11],
  ['nv', 0.1],
];

export function pickPowerup(roll: number): PowerupKind {
  let acc = 0;
  for (const [kind, w] of POWERUP_WEIGHTS) {
    acc += w;
    if (roll < acc) return kind;
  }
  return 'medkit';
}

export function generateMap(seed: number): MapData {
  const rng = new Rng(seed);
  // Own stream, so adding bushes leaves every other layout decision as it was.
  const bushRng = new Rng(seed ^ 0xb054);
  const bushes: BushDef[] = [];
  const roomCount = rng.int(CONFIG.roomsMin, CONFIG.roomsMax);
  const raw: RawRoom[] = [];

  let cx0 = 1;
  let cz0 = 1;
  for (let i = 0; i < roomCount; i++) {
    const w = rng.int(6, 9);
    const h = rng.int(5, 8);
    const room: RawRoom = {
      cx0,
      cz0,
      cx1: cx0 + w - 1,
      cz1: cz0 + h - 1,
      doorX: 0,
      doorZ: 0,
      doorAxis: 'x',
      hasDoor: false,
    };

    if (i > 0) {
      const prev = raw[i - 1];
      // Must match how the cursor advanced from the previous room (see the
      // end of this loop): even rooms are followed along +x, odd along +z.
      const horizontal = (i - 1) % 2 === 0;
      if (horizontal) {
        // Corridor continues along +x: pick the shared z band.
        const zLo = Math.max(prev.cz0, room.cz0);
        const zHi = Math.min(prev.cz1, room.cz1);
        const doorZ = zLo + rng.int(0, Math.max(0, zHi - zLo));
        room.doorZ = doorZ;
        room.doorX = prev.cx1 + 1;
        room.doorAxis = 'x';
        room.cz0 = Math.min(room.cz0, doorZ);
        room.cz1 = Math.max(room.cz1, doorZ);
      } else {
        const xLo = Math.max(prev.cx0, room.cx0);
        const xHi = Math.min(prev.cx1, room.cx1);
        const doorX = xLo + rng.int(0, Math.max(0, xHi - xLo));
        room.doorX = doorX;
        room.doorZ = prev.cz1 + 1;
        room.doorAxis = 'z';
        room.cx0 = Math.min(room.cx0, doorX);
        room.cx1 = Math.max(room.cx1, doorX);
      }
      room.hasDoor = true;
    }

    raw.push(room);

    // Advance the cursor for the next room, alternating between +x and +z.
    if (i % 2 === 0) {
      cx0 = room.cx1 + 2;
      cz0 = Math.max(1, room.cz0 + rng.int(0, 1));
    } else {
      cz0 = room.cz1 + 2;
      cx0 = Math.max(1, room.cx0 + rng.int(0, 1));
    }
  }

  // Union bounding box of all rooms plus a one-cell margin.
  let maxX = 0;
  let maxZ = 0;
  for (const r of raw) {
    maxX = Math.max(maxX, r.cx1);
    maxZ = Math.max(maxZ, r.cz1);
  }
  const gridW = maxX + 3;
  const gridH = maxZ + 3;

  const floor = new Uint8Array(gridW * gridH);
  const idx = (x: number, z: number) => z * gridW + x;

  for (const r of raw) {
    for (let z = r.cz0; z <= r.cz1; z++) {
      for (let x = r.cx0; x <= r.cx1; x++) floor[idx(x, z)] = 1;
    }
  }

  // Wall cells: solid cells that touch floor.
  const wallCells = new Set<number>();
  for (let z = 0; z < gridH; z++) {
    for (let x = 0; x < gridW; x++) {
      if (floor[idx(x, z)]) continue;
      const near =
        (x > 0 && floor[idx(x - 1, z)]) ||
        (x < gridW - 1 && floor[idx(x + 1, z)]) ||
        (z > 0 && floor[idx(x, z - 1)]) ||
        (z < gridH - 1 && floor[idx(x, z + 1)]);
      if (near) wallCells.add(idx(x, z));
    }
  }

  // Carve doorways out of the wall band and force the door frame cells to exist.
  for (const r of raw) {
    if (!r.hasDoor) continue;
    const dx = r.doorX;
    const dz = r.doorZ;
    wallCells.delete(idx(dx, dz));
    const fx = r.doorAxis === 'x' ? dx : dx - 1;
    const fz = r.doorAxis === 'x' ? dz - 1 : dz;
    const gx = r.doorAxis === 'x' ? dx : dx + 1;
    const gz = r.doorAxis === 'x' ? dz + 1 : dz;
    if (fx >= 0 && fx < gridW && fz >= 0 && fz < gridH) wallCells.add(idx(fx, fz));
    if (gx >= 0 && gx < gridW && gz >= 0 && gz < gridH) wallCells.add(idx(gx, gz));
  }

  // Pillars break up big rooms: single wall cells well inside the room, away
  // from doorways and the room centre (spawn / enemy placement).
  for (let ri = 0; ri < raw.length; ri++) {
    const r = raw[ri];
    const w = r.cx1 - r.cx0 + 1;
    const h = r.cz1 - r.cz0 + 1;
    if (w < 7 || h < 6) continue;
    const count = rng.int(0, w * h > 50 ? 2 : 1);
    const doors = [raw[ri], raw[ri + 1]].filter((d) => d && d.hasDoor);
    const placed: { x: number; z: number }[] = [];
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const x = rng.int(r.cx0 + 2, r.cx1 - 2);
        const z = rng.int(r.cz0 + 2, r.cz1 - 2);
        const mx = (r.cx0 + r.cx1) / 2;
        const mz = (r.cz0 + r.cz1) / 2;
        if (Math.abs(x - mx) < 1.5 && Math.abs(z - mz) < 1.5) continue;
        if (doors.some((d) => Math.abs(d.doorX - x) + Math.abs(d.doorZ - z) < 4)) continue;
        if (placed.some((p) => Math.abs(p.x - x) + Math.abs(p.z - z) < 3)) continue;
        placed.push({ x, z });
        floor[idx(x, z)] = 0;
        wallCells.add(idx(x, z));
        break;
      }
    }
  }

  const walls = mergeWallCells(wallCells, gridW, gridH);

  // Minimap grid: 1 = floor, 2 = wall.
  const cells = new Uint8Array(gridW * gridH);
  for (let i = 0; i < cells.length; i++) {
    cells[i] = floor[i] ? 1 : wallCells.has(i) ? 2 : 0;
  }

  // Room themes: the start is always a quiet warehouse, then a shuffled
  // rotation so neighbouring rooms differ.
  const themeCycle: RoomTheme[] = ['office', 'yard', 'bunker', 'warehouse'];
  for (let i = themeCycle.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [themeCycle[i], themeCycle[j]] = [themeCycle[j], themeCycle[i]];
  }
  const rooms: RoomDef[] = raw.map((r, index) => {
    const minX = r.cx0 * TILE;
    const minZ = r.cz0 * TILE;
    const maxX = (r.cx1 + 1) * TILE;
    const maxZ = (r.cz1 + 1) * TILE;
    const lampOffX = rng.range(-0.22, 0.22) * (maxX - minX);
    const lampOffZ = rng.range(-0.22, 0.22) * (maxZ - minZ);
    return {
      index,
      theme: index === 0 ? 'warehouse' : themeCycle[(index - 1) % themeCycle.length],
      cx0: r.cx0,
      cz0: r.cz0,
      cx1: r.cx1,
      cz1: r.cz1,
      wx: (minX + maxX) / 2,
      wz: (minZ + maxZ) / 2,
      minX,
      minZ,
      maxX,
      maxZ,
      lampX: (minX + maxX) / 2 + lampOffX,
      lampZ: (minZ + maxZ) / 2 + lampOffZ,
      doorX: (r.doorX + 0.5) * TILE,
      doorZ: (r.doorZ + 0.5) * TILE,
      doorAxis: r.doorAxis,
      hasDoor: r.hasDoor,
    };
  });

  const props: PropDef[] = [];
  const pickups: PickupDef[] = [];
  const powerups: PowerupDef[] = [];
  let propId = 1;
  let pickupId = 1;
  let powerupId = 1;

  const pillarBodies = walls;
  const clearOfWalls = (x: number, z: number, hw: number, hh: number, gap: number) =>
    !pillarBodies.some(
      (w) => Math.abs(w.cx - x) < w.hw + hw + gap && Math.abs(w.cz - z) < w.hh + hh + gap,
    );

  for (const room of rooms) {
    // Doorways in and out of this room must stay clear (the exit door is
    // stored on the next room).
    const exit = rooms[room.index + 1];
    const nearDoor = (x: number, z: number, r: number) =>
      (room.hasDoor && Math.hypot(x - room.doorX, z - room.doorZ) < r) ||
      (!!exit && Math.hypot(x - exit.doorX, z - exit.doorZ) < r);
    // The first room's centre is where the squad spawns (players stand ±1.6 m off it).
    const centreClear = room.index === 0 ? 4.5 : 2.6;

    const place = (kind: PropKind, count: number) => {
      const def = PROP_TABLE[kind];
      for (let i = 0; i < count; i++) {
        // Anchored props can never be pushed out of the way, so they keep a
        // walkable gap to walls, doors and every other prop.
        const fixed = def.fixed;
        const gap = fixed ? 1.9 : 0.65;
        for (let attempt = 0; attempt < 16; attempt++) {
          const x = rng.range(room.minX + def.hw + gap, room.maxX - def.hw - gap);
          const z = rng.range(room.minZ + def.hh + gap, room.maxZ - def.hh - gap);
          if (Math.hypot(x - room.wx, z - room.wz) < centreClear) continue;
          if (nearDoor(x, z, fixed ? 5.5 : 3.6)) continue;
          if (!clearOfWalls(x, z, def.hw, def.hh, fixed ? 1.9 : 0.2)) continue;
          if (
            props.some((p) => {
              const both = fixed || p.fixed;
              // Anchored props leave a gap wide enough to walk through.
              return (
                Math.abs(p.x - x) < p.hw + def.hw + (both ? 1.9 : 0.8) &&
                Math.abs(p.z - z) < p.hh + def.hh + (both ? 1.9 : 0.8)
              );
            })
          )
            continue;
          props.push({
            id: propId++,
            kind,
            x,
            z,
            hw: def.hw,
            hh: def.hh,
            explosive: def.explosive,
            fixed: def.fixed,
            hp: def.hp,
            room: room.index,
          });
          break;
        }
      }
    };

    // Anchored pieces first: they are the hardest to fit.
    const mix = [...DRESSING[room.theme]].sort((a, b) => Number(PROP_TABLE[b[0]].fixed) - Number(PROP_TABLE[a[0]].fixed));
    for (const [kind, lo, hi] of mix) place(kind, rng.int(lo, hi));

    const freeSpot = (radius: number): { x: number; z: number } | null => {
      for (let attempt = 0; attempt < 16; attempt++) {
        const x = rng.range(room.minX + 1.4, room.maxX - 1.4);
        const z = rng.range(room.minZ + 1.4, room.maxZ - 1.4);
        if (props.some((p) => Math.abs(p.x - x) < p.hw + radius && Math.abs(p.z - z) < p.hh + radius)) continue;
        if (!clearOfWalls(x, z, radius, radius, 0.3)) continue;
        if (nearDoor(x, z, 3.0)) continue;
        if (pickups.some((p) => Math.hypot(p.x - x, p.z - z) < 2.5)) continue;
        if (powerups.some((p) => Math.hypot(p.x - x, p.z - z) < 2.5)) continue;
        return { x, z };
      }
      return null;
    };

    // Yards grow bushes to hide in.
    if (room.theme === 'yard') {
      const B = CONFIG.bush;
      const want = bushRng.int(B.perYardRoom.min, B.perYardRoom.max);
      for (let i = 0, tries = 0; i < want && tries < 30; tries++) {
        const r = bushRng.range(B.radius.min, B.radius.max);
        const x = bushRng.range(room.minX + r + 0.8, room.maxX - r - 0.8);
        const z = bushRng.range(room.minZ + r + 0.8, room.maxZ - r - 0.8);
        if (props.some((p) => Math.abs(p.x - x) < p.hw + r * 0.7 && Math.abs(p.z - z) < p.hh + r * 0.7)) continue;
        if (bushes.some((b) => Math.hypot(b.x - x, b.z - z) < b.r + r + 1.2)) continue;
        if (nearDoor(x, z, 3.5) || !clearOfWalls(x, z, r, r, 0.3)) continue;
        bushes.push({ x, z, r });
        i++;
      }
    }

    // The start room hands out a first upgrade; later rooms 1-2 weapons.
    const weaponCount = room.index === 0 ? 1 : rng.int(1, 2);
    for (let i = 0; i < weaponCount; i++) {
      const spot = freeSpot(1.0);
      if (!spot) continue;
      const weapon: WeaponId = room.index === 0 ? 'smg' : WEAPON_ORDER[rng.int(1, WEAPON_ORDER.length - 1)];
      pickups.push({ id: pickupId++, weapon, ...spot, room: room.index });
    }
    if (room.index > 0 && rng.next() < 0.75) {
      const spot = freeSpot(0.8);
      if (spot) powerups.push({ id: powerupId++, kind: pickPowerup(rng.next()), ...spot, room: room.index });
    }
  }

  // Floors: every room plus its doorway gap.
  const floors: FloorRect[] = [];
  for (const room of rooms) {
    floors.push({ x0: room.minX - 0.6, z0: room.minZ - 0.6, x1: room.maxX + 0.6, z1: room.maxZ + 0.6, theme: room.theme });
    if (room.hasDoor) {
      const h = TILE / 2 + 0.6;
      floors.push({ x0: room.doorX - h, z0: room.doorZ - h, x1: room.doorX + h, z1: room.doorZ + h, theme: 'bunker' });
    }
  }
  const lamps: LampDef[] = rooms.map((r) => ({ x: r.lampX, z: r.lampZ, color: THEME_LAMP[r.theme] }));

  const spawnRoom = rooms[0];
  const map: MapData = {
    mode: 'coop',
    name: '',
    seed,
    tile: TILE,
    gridW,
    gridH,
    walls,
    rooms,
    props,
    pickups,
    powerups,
    floors,
    lamps,
    bushes,
    spawns: [],
    spawnX: spawnRoom.wx,
    spawnZ: spawnRoom.wz,
    minX: 0,
    minZ: 0,
    maxX: gridW * TILE,
    maxZ: gridH * TILE,
    cells,
  };
  return map;
}

export function mergeWallCells(cells: Set<number>, gw: number, gh: number, cell = TILE): StaticBody[] {
  const visited = new Set<number>();
  const out: StaticBody[] = [];
  const key = (x: number, z: number) => z * gw + x;

  for (let z = 0; z < gh; z++) {
    for (let x = 0; x < gw; x++) {
      if (!cells.has(key(x, z)) || visited.has(key(x, z))) continue;

      let w = 1;
      while (x + w < gw && cells.has(key(x + w, z)) && !visited.has(key(x + w, z))) w++;

      let h = 1;
      grow: while (z + h < gh) {
        for (let i = 0; i < w; i++) {
          const k = key(x + i, z + h);
          if (!cells.has(k) || visited.has(k)) break grow;
        }
        h++;
      }

      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) visited.add(key(x + i, z + j));
      }

      out.push({
        cx: (x + w / 2) * cell,
        cz: (z + h / 2) * cell,
        hw: (w * cell) / 2,
        hh: (h * cell) / 2,
      });
    }
  }

  return out;
}
