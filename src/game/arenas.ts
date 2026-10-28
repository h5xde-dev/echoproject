import { mergeWallCells, PROP_TABLE, THEME_LAMP } from './levelgen';
import type {
  ArenaDoorDef,
  BushDef,
  CraterDef,
  InteractDef,
  InteractKind,
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
//   h medkit  r armor  x damage  s speed  f rapid fire  n night vision
//   a ammo  g regeneration  i overshield  u stealth  z radar (powerups)
//   G light switch  O ammo crate  + med station (used with E)
//   | door in a wall along z  - door in a wall along x (opened and shut with E)
//   Y bush (no collision; hides whoever keeps quiet in it)
//   = trench (slows you; crouched in it you are hidden, long shots from the open hit less)
//   o shell crater (hides you crouched, like a trench)  W barbed wire (slows, cuts; E or a knife cuts it)

export const CELL = 1.5;

export interface ArenaInfo {
  id: string;
  name: string;
  theme: RoomTheme;
  rows: string[];
}

export const ARENAS: ArenaInfo[] = [
  {
    id: 'duel-yard',
    name: 'Дуэльный двор',
    theme: 'yard',
    rows: [
      '#####################',
      '#S....#.....#....S..#',
      '#.....#.....#.......#',
      '#..Y..#..K..#..Y....#',
      '#.....#.....#.......#',
      '#..####.....####....#',
      '#...................#',
      '#...Y...==...Y......#',
      '#.......==..........#',
      '#..K....==....K.....#',
      '#...................#',
      '#......Y....Y.......#',
      '#....####.....####..#',
      '#.....#.....#.......#',
      '#..Y..#..K..#..Y....#',
      '#.....#.....#.......#',
      '#S....#.....#....S..#',
      '#...................#',
      '#..O.......O........#',
      '#........L..........#',
      '#####################',
    ],
  },
  {
    id: 'duel-trenches',
    name: 'Траншея 1v1',
    theme: 'field',
    rows: [
      '#####################',
      '#S..=......=.....S..#',
      '#...=..K...=..K.....#',
      '#...======.=........#',
      '#..........=........#',
      '#..Y.......=....Y...#',
      '#..Y...o...=....Y...#',
      '#......=====........#',
      '#...................#',
      '#..K......O......K..#',
      '#...................#',
      '#......=====........#',
      '#..Y...o...=....Y...#',
      '#..Y.......=....Y...#',
      '#..........=........#',
      '#...======.=........#',
      '#...=..K...=..K.....#',
      '#S..=......=.....S..#',
      '#...................#',
      '#........L..........#',
      '#####################',
    ],
  },

  {
    id: 'sklad',
    name: 'Склад',
    theme: 'warehouse',
    rows: [
    '#####################',
    '#S........#.........L',
    '#.........#.........#',
    '#..PP.....#....CC...#',
    '#..PP..O..D....CC...h',
    '#...................#',
    '#.L....C..........i.#',
    '#......C.....####....',
    '####......+..#.....1.',
    '#..#.........#.......',
    '#..D....######..K....',
    '#.....L.............L',
    '#S....DD......r......',
    '#.......#####........',
    '#..C....#.......PP...',
    '#..C....#...2.g.PP..x',
    '#.......#...........#',
    '####....#####...L...#',
    '#.................G.#',
    '#.f..C...a....CC....#',
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
    '#..........O...u.#.h.',
    '#..V.....T.......#...',
    '#.....Y..............',
    '#.......####......L..',
    '#..K....#..1.........',
    '#.......#.......V....',
    '#...Y..+......T......',
    '#####....i......#####',
    '#...#..L.....z..#....',
    '#.r.#...........#..x.',
    '#...#....K...Y..#....',
    '#..................L.',
    '#S......T............',
    '#....Y.....#####.....',
    '#..V.......#...#..3..',
    '#......G...#.f.#..Y..',
    '#....L.....#...#.....',
    '#S.............|.....',
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
    '#...#...L...#.O.h...#',
    '#.+.D.....z.M.......#',
    '#...........#...L...#',
    '#####..##########..##',
    '#....n.....#........#',
    '#.L..AA....#..K.....#',
    '#..........#.....1...',
    '#..K.g.....D.........',
    '#####..#####..#######',
    '#...........#.......#',
    '#.r...L...G.#..L..x.#',
    '#S..........D.......#',
    '#####..######..##...#',
    '#..............#....#',
    '#..AA...a.2....#..s..',
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
    '#..Y..u..#.....K..g..',
    '#.YY.....#...........',
    '#....i...#..YY...#..L',
    '####.........YY..#...',
    '#..........1.....#...',
    '#S...L.......O...#.h.',
    '#........####........',
    '#.YY.....#..Y........',
    '#..Y..K..#.YYY...K...',
    '#........#..Y......Y.',
    '#.......L.......Y..YY',
    '####.......Y....YY...',
    '#..r.+....YY.........',
    '#.......G.Y....#..3..',
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
    '#..G.#.tt...#..M..h..',
    '#....#......#........',
    '#.L...u.c...#####..##',
    '#....#......#........',
    '######..#####...L....',
    '#.......#......tt....',
    '#..A....#...........#',
    '#S..L...|.O.2....####',
    '#.......#...........#',
    '######..#####..#.....',
    '#....#......#..#..r..',
    '#.tt.#..L...#..#.....',
    '#....#.......z..#....',
    '#.a..####..##..##..##',
    '#.....M......#......L',
    '#..c......+..#..3....',
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
    '#..#####......i......',
    '#.......G.V....####..',
    '#.L............####..',
    '#....PP..............',
    '#S...PP.g.#####...L..',
    '#.........#####...1..',
    '###..........K.a.....',
    '#....B.......K.......',
    '#..r....###......Y...',
    '#.......###.....YY...',
    '#..####......V....L..',
    '#..####...........###',
    '#.L.......TT.....#...',
    '#S...........+...#.6.',
    '#.....#######...O...x',
    '#........L.|.........',
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
    '#....D..BB..i.....+.h',
    '#.L..........####...#',
    '####...####..#..#....',
    '#......#..#..#..2....',
    '#..CC..#..#..........',
    '#..CC......z.......L.',
    '#S....O......BB......',
    '#####..###...BB..####',
    '#.L....#.............',
    '#......#..PP....M..x.',
    '#.f....#..PP.........',
    '#S..........#####....',
    '#...BB......#...#..6.',
    '#...BB...L..#.......#',
    '####........#..L....#',
    '#.....M.u....G......#',
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
    '#.......O.K.g........',
    '#..AA.....K..........',
    '#.....##.....L..#....',
    '#..a..##........#..6.',
    '#S.......+..######...',
    '#.L.....#............',
    '#.......#.....r..L...',
    '####..###............',
    '#....G....######..###',
    '#..D...L.............',
    '#S...........n....M..',
    '#......####..........',
    '###..###..#..###..###',
    '#...z.x...#.......2..',
    '#S........|.....L....',
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
    '#...=....+.==......3.',
    '#...==.....=.........',
    '#....=======...KK....',
    '#S..g=.....=.........',
    '#...==.....==...L....',
    '#...=.......=....B...',
    '#.L.=..KK...=..T...5.',
    '#...=.......=========',
    '#S..=.......=G.......',
    '#...=..KK...=...L....',
    '#..u==.....==........',
    '#....=.....=.....B...',
    '#...O=======...KK....',
    '#.i.==.....=.........',
    '#...=......==.....4..',
    '#...=..r.............',
    '#S..=..........KK....',
    '#####################',
    ],
  },
  {
    // A trench maze: rear and front lines in zigzags, communication trenches,
    // saps and dead ends, two walled dugouts (door, med post, ammo, light
    // switch), machine-gun nests, and a no-man's land of craters and wire.
    id: 'labirint',
    name: 'Лабиринт',
    theme: 'field',
    rows: [
    '#####################',
    '#...................L',
    '#S.=..#####.=.K...W..',
    '#..=..#+.O#===...oW..',
    '#..===|...#..=5...W..',
    '#...=.#aLG#..=....W..',
    '#.1.=.#####.=====...o',
    '#...=.......=...=....',
    '#..==......i=..u..W..',
    '#S.=........==K...W..',
    '#..=.........=....W.4',
    '#.G======....=....W..',
    '#..==...=...==..o....',
    '#L..=...=====........',
    '#...=.......=.K....o.',
    '#...=.......==.W.....',
    '#SO=====r==h==.W.K..6',
    '#..=.........=.W.....',
    '#..=........==K....g.',
    '#L.=...======........',
    '#..==..=....=....oW..',
    '#...====....==....W..',
    '#...=........=....W.3',
    '#S..=........=K...W..',
    '#..==.......==.z.....',
    '#..=..#####.=...=....',
    '#.2=..#+.O#.=====...o',
    '#..=.=|...#.==....W..',
    '#..==.#aLG#..=5...W..',
    '#...=.#####=.=..o.W..',
    '#S..=.......==K...Wo.',
    '#...................L',
    '#####################',
    ],
  },
];

const PROP_CHARS: Record<string, PropKind> = {
  C: 'crate', B: 'barrel', K: 'cover', V: 'car', T: 'tires', P: 'pallet',
  D: 'drum', M: 'cabinet', A: 'ammo', t: 'table', c: 'chair',
};
const WEAPON_CHARS: Record<string, WeaponId> = { '1': 'smg', '2': 'shotgun', '3': 'rifle', '4': 'sniper', '5': 'lmg', '6': 'flamer' };
const POWERUP_CHARS: Record<string, PowerupKind> = {
  h: 'medkit', r: 'armor', x: 'damage', s: 'speed', f: 'rapid', n: 'nv',
  a: 'ammo', g: 'regen', i: 'overshield', u: 'stealth', z: 'radar',
};
const INTERACT_CHARS: Record<string, InteractKind> = { G: 'switch', O: 'ammo', '+': 'med' };

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
  const interactables: InteractDef[] = [];
  const arenaDoors: ArenaDoorDef[] = [];
  const craters: CraterDef[] = [];
  const seen = new Uint8Array(gw * gh);

  for (let z = 0; z < gh; z++) {
    for (let x = 0; x < gw; x++) {
      const ch = at(x, z);
      const p = centre(x, z);
      if (ch === 'S') spawns.push(p);
      else if (ch === 'L') lamps.push({ ...p, color: THEME_LAMP[info.theme] });
      else if (ch === 'Y') bushes.push({ ...p, r: 1.4 });
      else if (INTERACT_CHARS[ch]) interactables.push({ id: interactables.length + 1, kind: INTERACT_CHARS[ch], ...p });
      else if (ch === '|' || ch === '-') arenaDoors.push({ ...p, vertical: ch === '|' });
      else if (ch === 'o') craters.push({ ...p, r: 1.25 });
      else if (ch === 'W') {
        // Wire follows its run: turned when it runs along z.
        const def = PROP_TABLE.wire;
        const vertical = (at(x, z - 1) === 'W' || at(x, z + 1) === 'W') && at(x - 1, z) !== 'W' && at(x + 1, z) !== 'W';
        props.push({
          id: props.length + 1, kind: 'wire', ...p,
          hw: vertical ? def.hh : def.hw, hh: vertical ? def.hw : def.hh,
          explosive: false, fixed: true, hp: def.hp, room: 0,
        });
      }
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
    interactables,
    arenaDoors,
    craters,
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
