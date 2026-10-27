import { mergeWallCells, PROP_TABLE, THEME_LAMP } from './levelgen';
import type {
  BushDef,
  FloorRect,
  GameMode,
  LampDef,
  MapData,
  PickupDef,
  PowerupDef,
  PowerupKind,
  PropDef,
  PropKind,
  RoomDef,
  RoomTheme,
  TrenchDef,
} from './types';
import type { WeaponId } from './weapons';

// Hand-made deathmatch arenas. Each row lists the left half (20 cells) plus
// the centre cell; the right half is mirrored, so every arena is fair from
// both sides. Cells are 1.5 m.
//
//   #  wall          S  spawn point       L  lamp
//   C crate  B barrel  K concrete block  V car  T tires  P pallet
//   D drum  M electrical cabinet  A ammo box  t table  c chair
//   1 SMG  2 shotgun  3 rifle  4 sniper  5 LMG  6 flamethrower (weapon pickups)
//   h medkit  r armor  x damage  s speed  f rapid fire  n night vision (powerups)
//   Y bush (no collision; hides whoever keeps quiet in it)
//   = trench (slows you; crouched in it you are hidden, long shots from the open hit less)

export const CELL = 1.5;

export interface ArenaInfo {
  id: string;
  name: string;
  theme: RoomTheme;
  rows: string[];
}

export const ARENAS: ArenaInfo[] = [
  {
    id: 'sklad',
    name: 'Склад',
    theme: 'warehouse',
    rows: [
    '#####################',
    '#S........#.........L',
    '#.........#.........#',
    '#..PP.....#....CC...#',
    '#..PP.....D....CC...h',
    '#...................#',
    '#.L....C............#',
    '#......C.....####....',
    '####.........#.....1.',
    '#..#.........#.......',
    '#..D....######..K....',
    '#.....L.............L',
    '#S....DD......r......',
    '#.......#####........',
    '#..C....#.......PP...',
    '#..C....#...2...PP..x',
    '#.......#...........#',
    '####....#####...L...#',
    '#...................#',
    '#.f..C........CC....#',
    '#.....L.......CC...3.',
    '#S...................',
    '#####################',
    ],
  },
  {
    id: 'dvor',
    name: 'Двор',
    theme: 'yard',
    rows: [
    '#####################',
    '#S.......L.......#...',
    '#................#.h.',
    '#..V.....T.......#...',
    '#.....Y..............',
    '#.......####......L..',
    '#..K....#..1.........',
    '#.......#.......V....',
    '#...Y.........T......',
    '#####...........#####',
    '#...#..L........#....',
    '#.r.#...........#..x.',
    '#...#....K...Y..#....',
    '#..................L.',
    '#S......T............',
    '#....Y.....#####.....',
    '#..V.......#...#..3..',
    '#..........#.f.#..Y..',
    '#....L.....#...#.....',
    '#S...................',
    '#####################',
    ],
  },
  {
    id: 'bunker',
    name: 'Бункер',
    theme: 'bunker',
    rows: [
    '#####################',
    '#S..#.......#.......#',
    '#...#...L...#...h...#',
    '#...D.......M.......#',
    '#...........#...L...#',
    '#####..##########..##',
    '#....n.....#........#',
    '#.L..AA....#..K.....#',
    '#..........#.....1...',
    '#..K.......D.........',
    '#####..#####..#######',
    '#...........#.......#',
    '#.r...L.....#..L..x.#',
    '#S..........D.......#',
    '#####..######..##...#',
    '#..............#....#',
    '#..AA.....2....#..s..',
    '#.L............M.....',
    '#S..................#',
    '#####################',
    ],
  },
  {
    // Night forest: open ground, tree lines, thickets to hide in, little light.
    id: 'les',
    name: 'Лес',
    theme: 'forest',
    rows: [
    '#####################',
    '#S.....Y.......#.....',
    '#.....YY.......#..Y..',
    '#..K.......L...#.YY.n',
    '#........##..........',
    '#..Y.....#.....K.....',
    '#.YY.....#...........',
    '#........#..YY...#..L',
    '####.........YY..#...',
    '#..........1.....#...',
    '#S...L...........#.h.',
    '#........####........',
    '#.YY.....#..Y........',
    '#..Y..K..#.YYY...K...',
    '#........#..Y......Y.',
    '#.......L.......Y..YY',
    '####.......Y....YY...',
    '#..r......YY.........',
    '#.........Y....#..3..',
    '#S.............#.....',
    '#####################',
    ],
  },
  {
    // Offices: rooms and corridors with more than one way into each.
    id: 'ofis',
    name: 'Офис',
    theme: 'office',
    rows: [
    '#####################',
    '#S...#.....L#........',
    '#....#.tt...#..M..h..',
    '#....#......#........',
    '#.L.....c...#####..##',
    '#....#......#........',
    '######..#####...L....',
    '#.......#......tt....',
    '#..A....#...........#',
    '#S..L.......2....####',
    '#.......#...........#',
    '######..#####..#.....',
    '#....#......#..#..r..',
    '#.tt.#..L...#..#.....',
    '#....#..........#....',
    '#....####..##..##..##',
    '#.....M......#......L',
    '#..c.........#..3....',
    '#S....#......#....x..',
    '#####################',
    ],
  },
  {
    // Container port: steel boxes stacked into lanes, cars, an open quay.
    id: 'port',
    name: 'Порт',
    theme: 'yard',
    rows: [
    '#####################',
    '#S.....L.......#.....',
    '#..............#..h..',
    '#..#####...TT..#.....',
    '#..#####.............',
    '#.........V....####..',
    '#.L............####..',
    '#....PP..............',
    '#S...PP...#####...L..',
    '#.........#####...1..',
    '###..........K.......',
    '#....B.......K.......',
    '#..r....###......Y...',
    '#.......###.....YY...',
    '#..####......V....L..',
    '#..####...........###',
    '#.L.......TT.....#...',
    '#S...............#.6.',
    '#.....#######.......x',
    '#........L...........',
    '#####################',
    ],
  },
  {
    // Factory floor: rows of fuel barrels — a molotov or a stray shot sets
    // off a chain. Machine halls with doors on two sides.
    id: 'zavod',
    name: 'Завод',
    theme: 'warehouse',
    rows: [
    '#####################',
    '#S...#......L.......#',
    '#....#..BB......M...#',
    '#....D..BB..........h',
    '#.L..........####...#',
    '####...####..#..#....',
    '#......#..#..#..2....',
    '#..CC..#..#..........',
    '#..CC..............L.',
    '#S...........BB......',
    '#####..###...BB..####',
    '#.L....#.............',
    '#......#..PP....M..x.',
    '#.f....#..PP.........',
    '#S..........#####....',
    '#...BB......#...#..6.',
    '#...BB...L..#.......#',
    '####........#..L....#',
    '#.....M.............#',
    '#S........CC....#...#',
    '#####################',
    ],
  },
  {
    // Catacombs: tight tunnels and blind corners — close quarters for the
    // knife and the flamethrower.
    id: 'katakomby',
    name: 'Катакомбы',
    theme: 'bunker',
    rows: [
    '#####################',
    '#S.....#......#.....#',
    '#..L...#..h...D..L...',
    '#......#......#......',
    '###..###..##..###..##',
    '#.........K..........',
    '#..AA.....K..........',
    '#.....##.....L..#....',
    '#.....##........#..6.',
    '#S..........######...',
    '#.L.....#............',
    '#.......#.....r..L...',
    '####..###............',
    '#.........######..###',
    '#..D...L.............',
    '#S...........n....M..',
    '#......####..........',
    '###..###..#..###..###',
    '#.....x...#.......2..',
    '#S..............L....',
    '#####################',
    ],
  },
  {
    // Open field: a home trench, a zigzag forward line and one contested trench across the middle.
    id: 'okopy',
    name: 'Окопы',
    theme: 'field',
    rows: [
    '#####################',
    '#S..=..........KK....',
    '#...=..h.............',
    '#...=......==......3.',
    '#...==.....=.........',
    '#....=======...KK....',
    '#S...=.....=.........',
    '#...==.....==...L....',
    '#...=.......=....B...',
    '#.L.=..KK...=..T...5.',
    '#...=.......=========',
    '#S..=.......=........',
    '#...=..KK...=...L....',
    '#...==.....==........',
    '#....=.....=.....B...',
    '#....=======...KK....',
    '#...==.....=.........',
    '#...=......==.....4..',
    '#...=..r.............',
    '#S..=..........KK....',
    '#####################',
    ],
  },
];

const PROP_CHARS: Record<string, PropKind> = {
  C: 'crate', B: 'barrel', K: 'cover', V: 'car', T: 'tires', P: 'pallet',
  D: 'drum', M: 'cabinet', A: 'ammo', t: 'table', c: 'chair',
};
const WEAPON_CHARS: Record<string, WeaponId> = { '1': 'smg', '2': 'shotgun', '3': 'rifle', '4': 'sniper', '5': 'lmg', '6': 'flamer' };
const POWERUP_CHARS: Record<string, PowerupKind> = { h: 'medkit', r: 'armor', x: 'damage', s: 'speed', f: 'rapid', n: 'nv' };

/** Expands the mirrored rows into the full grid. */
export function arenaGrid(info: ArenaInfo): string[] {
  return info.rows.map((r) => {
    if (r.length !== 21) throw new Error(`arena ${info.id}: row must be 21 chars: "${r}"`);
    const left = r.slice(0, 20);
    return left + r[20] + [...left].reverse().join('');
  });
}

export function buildArena(id: string, seed: number, mode: GameMode = 'dm'): MapData {
  const info = ARENAS.find((a) => a.id === id) ?? ARENAS[0];
  const grid = arenaGrid(info);
  const gw = grid[0].length;
  const gh = grid.length;
  const at = (x: number, z: number) => (grid[z] ?? '')[x] ?? '#';
  const centre = (x: number, z: number) => ({ x: (x + 0.5) * CELL, z: (z + 0.5) * CELL });

  const wallCells = new Set<number>();
  const floorCells = new Set<number>();
  const trenchCells = new Set<number>();
  const cells = new Uint8Array(gw * gh);
  for (let z = 0; z < gh; z++) {
    for (let x = 0; x < gw; x++) {
      if (at(x, z) === '#') {
        wallCells.add(z * gw + x);
        cells[z * gw + x] = 2;
      } else {
        floorCells.add(z * gw + x);
        if (at(x, z) === '=') trenchCells.add(z * gw + x);
        cells[z * gw + x] = 1;
      }
    }
  }
  const walls = mergeWallCells(wallCells, gw, gh, CELL);

  const props: PropDef[] = [];
  const pickups: PickupDef[] = [];
  const powerups: PowerupDef[] = [];
  const lamps: LampDef[] = [];
  const bushes: BushDef[] = [];
  const spawns: { x: number; z: number }[] = [];
  const seen = new Uint8Array(gw * gh);

  for (let z = 0; z < gh; z++) {
    for (let x = 0; x < gw; x++) {
      const ch = at(x, z);
      const p = centre(x, z);
      if (ch === 'S') spawns.push(p);
      else if (ch === 'L') lamps.push({ ...p, color: THEME_LAMP[info.theme] });
      else if (ch === 'Y') bushes.push({ ...p, r: 1.4 });
      else if (WEAPON_CHARS[ch]) pickups.push({ id: pickups.length + 1, weapon: WEAPON_CHARS[ch], ...p, room: 0 });
      else if (POWERUP_CHARS[ch]) powerups.push({ id: powerups.length + 1, kind: POWERUP_CHARS[ch], ...p, room: 0 });
      else if (PROP_CHARS[ch] && !seen[z * gw + x]) {
        // Small props: one per cell. Big ones: one per cluster of the letter.
        const kind = PROP_CHARS[ch];
        const def = PROP_TABLE[kind];
        const cluster: [number, number][] = [];
        const stack: [number, number][] = [[x, z]];
        seen[z * gw + x] = 1;
        while (stack.length) {
          const [cx, cz] = stack.pop()!;
          cluster.push([cx, cz]);
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx;
            const nz = cz + dz;
            if (at(nx, nz) === ch && !seen[nz * gw + nx]) {
              seen[nz * gw + nx] = 1;
              stack.push([nx, nz]);
            }
          }
        }
        const add = (px: number, pz: number, vertical: boolean) =>
          props.push({
            id: props.length + 1,
            kind,
            x: px,
            z: pz,
            hw: vertical ? def.hh : def.hw,
            hh: vertical ? def.hw : def.hh,
            explosive: def.explosive,
            fixed: def.fixed,
            hp: def.hp,
            room: 0,
          });
        if (def.hw <= 0.75) {
          for (const [cx, cz] of cluster) add(centre(cx, cz).x, centre(cx, cz).z, false);
        } else {
          const xs = cluster.map((c) => c[0]);
          const zs = cluster.map((c) => c[1]);
          const x0 = Math.min(...xs);
          const x1 = Math.max(...xs);
          const z0 = Math.min(...zs);
          const z1 = Math.max(...zs);
          // A lone long prop in a column of cells stands vertically.
          add(((x0 + x1 + 1) / 2) * CELL, ((z0 + z1 + 1) / 2) * CELL, z1 - z0 > x1 - x0);
        }
      }
    }
  }

  // Floor: merge floor cells into rectangles.
  const floors: FloorRect[] = mergeWallCells(floorCells, gw, gh, CELL).map((b) => ({
    x0: b.cx - b.hw,
    z0: b.cz - b.hh,
    x1: b.cx + b.hw,
    z1: b.cz + b.hh,
    theme: info.theme,
  }));

  const trenches: TrenchDef[] = mergeWallCells(trenchCells, gw, gh, CELL).map((b) => ({
    x0: b.cx - b.hw,
    z0: b.cz - b.hh,
    x1: b.cx + b.hw,
    z1: b.cz + b.hh,
  }));

  const maxX = gw * CELL;
  const maxZ = gh * CELL;
  // One room spanning the arena keeps room-based helpers working.
  const room: RoomDef = {
    index: 0,
    theme: info.theme,
    cx0: 1,
    cz0: 1,
    cx1: gw - 2,
    cz1: gh - 2,
    wx: maxX / 2,
    wz: maxZ / 2,
    minX: CELL,
    minZ: CELL,
    maxX: maxX - CELL,
    maxZ: maxZ - CELL,
    lampX: maxX / 2,
    lampZ: maxZ / 2,
    doorX: 0,
    doorZ: 0,
    doorAxis: 'x',
    hasDoor: false,
  };

  return {
    mode,
    name: info.name,
    seed,
    tile: CELL,
    gridW: gw,
    gridH: gh,
    walls,
    rooms: [room],
    props,
    pickups,
    powerups,
    floors,
    lamps,
    bushes,
    trenches,
    spawns,
    spawnX: spawns[0]?.x ?? maxX / 2,
    spawnZ: spawns[0]?.z ?? maxZ / 2,
    minX: 0,
    minZ: 0,
    maxX,
    maxZ,
    cells,
  };
}
