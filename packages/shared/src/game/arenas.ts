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
//   & tower  ^ throne  * truck spot («Осада»; «Конвой»: the truck's start)
//   ~ deep water (blocks the way, not shots)  H bridge  % ford (shallow, slow)
//   ! neutral camp  $ outpost to take  ? hidden FPV cache («Осада» forest)

export const CELL = 1.5;

export interface ArenaInfo {
  id: string;
  name: string;
  theme: RoomTheme;
  rows: string[];
  /**
   * false: `rows` are the whole map as drawn (small duel arenas), not the
   * left half plus centre to be mirrored.
   */
  mirror?: boolean;
  /**
   * «Конвой»: the truck's road as cells of the left half, from the start to
   * the centre column; the mirror finishes it to the other end.
   */
  route?: [number, number][];
}

export const ARENAS: ArenaInfo[] = [
  {
    id: 'duel-yard',
    name: 'Дуэльный двор',
    theme: 'yard',
    // Drawn whole: a compact arena for one on one.
    mirror: false,
    rows: [
      '#####################',
      '#S....#.....#....S..#',
      '#.....#..z..#.......#',
      '#..Y..#..K..#..Y....#',
      '#.....#.....#.......#',
      '#..####.....####....#',
      '#...i...........i...#',
      '#...Y...==...Y......#',
      '#.......==..........#',
      '#..K....==....K.....#',
      '#..g......+......g..#',
      '#......Y....Y.......#',
      '#....####.....####..#',
      '#.....#..u..#.......#',
      '#..Y..#..K..#..Y....#',
      '#.....#.....#.......#',
      '#S....#.....#....S..#',
      '#....a.........a....#',
      '#..O.......O........#',
      '#....G...L..........#',
      '#####################',
    ],
  },
  {
    id: 'duel-trenches',
    name: 'Траншея 1v1',
    theme: 'field',
    // Drawn whole: a compact arena for one on one.
    mirror: false,
    rows: [
      '#####################',
      '#S..=......=.....S..#',
      '#...=..K...=..K.....#',
      '#...======.=........#',
      '#..a.......=...z....#',
      '#..Y.......=....Y...#',
      '#..Y...o...=....Y...#',
      '#......=====........#',
      '#..i......+......i..#',
      '#..K......O......K..#',
      '#...g...........g...#',
      '#......=====........#',
      '#..Y...o...=....Y...#',
      '#..Y.......=....Y...#',
      '#..a.......=...u....#',
      '#...======.=........#',
      '#...=..K...=..K.....#',
      '#S..=......=.....S..#',
      '#........WWW........#',
      '#.....G..L..........#',
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

/**
 * «Осада»: the one map of the mode, the biggest of them all (83 × 49 cells).
 * Blue holds the left, red the right. Three lanes — top, middle, bottom — with
 * two towers a side each run from base to base; a river runs down the middle,
 * crossed by a bridge on every lane and a ford in each forest. The forests
 * between the lanes hold the truck's spots, neutral camps, outposts to take
 * and FPV drones hidden in the undergrowth.
 */
export const SIEGE_ARENA: ArenaInfo = {
  id: 'osada',
  name: 'Осада',
  theme: 'forest',
  rows: [
    '##########################################',
    '#..........L.K..........L...........K..~~~',
    '#..........................o...........HHH',
    '#...L..............&...........&.......HHH',
    '#..............o..................o....HHH',
    '#........................K..........L..~~~',
    '#........#####..##########..#######..##~~~',
    '#........#..............L..............~~~',
    '#.S......#.##....Y............Y......?.~~~',
    '#........#..........##..o.Y......Y.....~~~',
    '#........#.Y....!...##............##...~~~',
    '#........#...Y......##......Y.....##.Y.~~~',
    '#.....S..#..L.....Y......*..........Y..~~~',
    '#.....................Y......Y.o.......%%%',
    '#.............##........Y.......Y...K..%%%',
    '#........#....##...Y.......###.......Y.~~~',
    '#.S......#.Y...........Y...###.....Y...~~~',
    '#........#........o.....$..............~~~',
    '#....L...#..?..Y......O..............Y.~~~',
    '#........#..........Y.....Y...*........~~~',
    '#.+...S..#......Y......................~~~',
    '#........###..#########..########..####~~~',
    '#.....K.......K.............L......K...~~~',
    '#......................o...............HHH',
    '#...^..L...........&...........&.......HHH',
    '#................................o.....HHH',
    '#.....K.....L.............K.......o..L.~~~',
    '#........####..#########..########..###~~~',
    '#.O...S..#.............................~~~',
    '#........#.Y...........##......Y....?..~~~',
    '#....L...#......Y...L........##........~~~',
    '#........#...!.....Y.....Y...##......Y.~~~',
    '#.S......#............*..........Y.....~~~',
    '#........#.......##.................Y..~~~',
    '#...........Y....##....Y...Y...o...Y...%%%',
    '#.............L..##.................K..%%%',
    '#.....S..#.##........o.......Y.......Y.~~~',
    '#........#.##..Y........Y........###...~~~',
    '#........#..........Y......!.....###...~~~',
    '#........#Y...o..............Y.........~~~',
    '#.S......#.?......O...Y.........*....Y.~~~',
    '#........#......Y.........Y...L...Y....~~~',
    '#........######..#########..#######..##~~~',
    '#........................K........o.L..~~~',
    '#...........................o..........HHH',
    '#...L..............&...........&.......HHH',
    '#...............o......................HHH',
    '#..........L.K..........L...........K..~~~',
    '##########################################',
  ],
};

/**
 * «Конвой»: a town on a winding road. Blue escorts the truck from the left
 * end to the right; red holds the right and tries to stop or burn it.
 */
export const CONVOY_ARENA: ArenaInfo = {
  id: 'konvoy',
  name: 'Конвой',
  theme: 'yard',
  rows: [
    '###############################',
    '#..............................',
    '#.######............Y......####',
    '#.######..C....K...........####',
    '#.######.......................',
    '#.######........Y..............',
    '#..............................',
    '#..............................',
    '#...Y.........L.......L........',
    '#....####.o....#######.....###.',
    '#....####......#######.....###.',
    '#....####......#######.....###.',
    '#.S.O...K......#######.....###.',
    '#S....L........###.###....Y###.',
    '#..........................###.',
    '#S.*..........C.....K.Y....###.',
    '#..........................###.',
    '#S.............###.###.....###.',
    '#.S.V....K.....#######.....###.',
    '#...+..........#######.....###.',
    '#.......###....#######....K....',
    '#.....Y.###....#######.....K...',
    '#..L....###Y..........L.....L..',
    '#.......###..==....V...........',
    '#.......#.#..==................',
    '#.#########..==...o............',
    '#.#########.....######....C....',
    '#.#########.....######.......Y.',
    '#.######.....Y..######.........',
    '#..............................',
    '###############################',
  ],
  route: [[3, 15], [12, 15], [12, 6], [24, 6], [24, 24], [30, 24]],
};

const PROP_CHARS: Record<string, PropKind> = {
  C: 'crate', B: 'barrel', K: 'cover', V: 'car', T: 'tires', P: 'pallet',
  D: 'drum', M: 'cabinet', A: 'ammo', t: 'table', c: 'chair',
};
const WEAPON_CHARS: Record<string, WeaponId> = { '1': 'smg', '2': 'shotgun', '3': 'rifle', '4': 'sniper', '5': 'lmg', '6': 'flamer' };
const POWERUP_CHARS: Record<string, PowerupKind> = {
  h: 'medkit', r: 'armor', x: 'damage', s: 'speed', f: 'rapid', n: 'nv',
  a: 'ammo', g: 'regen', i: 'overshield', u: 'stealth', z: 'radar', q: 'drone',
};
const INTERACT_CHARS: Record<string, InteractKind> = { G: 'switch', O: 'ammo', '+': 'med' };

/** Expands the mirrored rows into the full grid. */
export function arenaGrid(info: ArenaInfo): string[] {
  return info.rows.map((r) => {
    if (r.length !== info.rows[0].length) throw new Error(`arena ${info.id}: rows must be one length: "${r}"`);
    if (info.mirror === false) return r;
    // The left half, then the centre column (the row's last cell).
    const half = r.length - 1;
    const left = r.slice(0, half);
    return left + r[half] + [...left].reverse().join('');
  });
}

export function buildArena(id: string, seed: number, mode: GameMode = 'dm'): MapData {
  const info = mode === 'siege' ? SIEGE_ARENA : mode === 'convoy' ? CONVOY_ARENA : ARENAS.find((a) => a.id === id) ?? ARENAS[0];
  const grid = arenaGrid(info);
  const gw = grid[0].length;
  const gh = grid.length;
  const at = (x: number, z: number) => (grid[z] ?? '')[x] ?? '#';
  const centre = (x: number, z: number) => ({ x: (x + 0.5) * CELL, z: (z + 0.5) * CELL });

  const wallCells = new Set<number>();
  const floorCells = new Set<number>();
  const trenchCells = new Set<number>();
  const waterCells = new Set<number>();
  const bridgeCells = new Set<number>();
  const fordCells = new Set<number>();
  const cells = new Uint8Array(gw * gh);
  for (let z = 0; z < gh; z++) {
    for (let x = 0; x < gw; x++) {
      const ch = at(x, z);
      if (ch === '#') {
        wallCells.add(z * gw + x);
        cells[z * gw + x] = 2;
      } else if (ch === '~') {
        waterCells.add(z * gw + x);
        cells[z * gw + x] = 3;
      } else {
        floorCells.add(z * gw + x);
        if (ch === '=') trenchCells.add(z * gw + x);
        if (ch === 'H') bridgeCells.add(z * gw + x);
        if (ch === '%') fordCells.add(z * gw + x);
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
  const truckSpots: { x: number; z: number }[] = [];
  const camps: { x: number; z: number }[] = [];
  const outposts: { x: number; z: number }[] = [];
  const caches: { x: number; z: number }[] = [];
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
      else if (ch === '*') truckSpots.push(p);
      else if (ch === '!') camps.push(p);
      else if (ch === '?') caches.push(p);
      else if (ch === '$') {
        outposts.push(p);
        const def = PROP_TABLE.outpost;
        props.push({ id: props.length + 1, kind: 'outpost', ...p, hw: def.hw, hh: def.hh, explosive: false, fixed: true, hp: def.hp, room: 0 });
      }
      else if (ch === '&' || ch === '^') {
        const kind: PropKind = ch === '&' ? 'tower' : 'throne';
        const def = PROP_TABLE[kind];
        props.push({ id: props.length + 1, kind, ...p, hw: def.hw, hh: def.hh, explosive: false, fixed: true, hp: def.hp, room: 0 });
      }
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

  const rects = (set: Set<number>): TrenchDef[] =>
    mergeWallCells(set, gw, gh, CELL).map((b) => ({ x0: b.cx - b.hw, z0: b.cz - b.hh, x1: b.cx + b.hw, z1: b.cz + b.hh }));
  const trenches = rects(trenchCells);
  const water = waterCells.size ? mergeWallCells(waterCells, gw, gh, CELL) : undefined;

  // «Конвой»: the road from the left half's cells, mirrored to the far end.
  let route: { x: number; z: number }[] | undefined;
  if (info.route) {
    const half = info.route.map(([x, z]) => centre(x, z));
    const back = info.route
      .slice(0, -1)
      .reverse()
      .map(([x, z]) => centre(gw - 1 - x, z));
    route = [...half, ...back];
  }

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
    truckSpots: truckSpots.length ? truckSpots : undefined,
    water,
    bridges: bridgeCells.size ? rects(bridgeCells) : undefined,
    fords: fordCells.size ? rects(fordCells) : undefined,
    camps: camps.length ? camps : undefined,
    outposts: outposts.length ? outposts : undefined,
    caches: caches.length ? caches : undefined,
    route,
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
