/**
 * Progress between matches: experience, levels and what they unlock (ring
 * colours). Kept in localStorage on this device; without storage it simply
 * starts over each session.
 */
export interface Progress {
  xp: number;
  matches: number;
  kills: number;
  wins: number;
}

/** What the local player did in one match. */
export interface MatchTally {
  kills: number;
  /** Flag captures, bomb plants and defuses, hacked terminals, defused charges. */
  objectives: number;
  revives: number;
  rooms: number;
  waves: number;
}

/** Soldier ring colours and the level that unlocks each. */
export const RING_COLORS: { color: number; level: number; name: string }[] = [
  { color: 0x3fd6c8, level: 1, name: 'Бирюза' },
  { color: 0xffb545, level: 2, name: 'Янтарь' },
  { color: 0x8fb6ff, level: 3, name: 'Лёд' },
  { color: 0xb48cff, level: 4, name: 'Аметист' },
  { color: 0x7dff9e, level: 6, name: 'Лайм' },
  { color: 0xff6a8a, level: 8, name: 'Коралл' },
  { color: 0xf2f4f7, level: 10, name: 'Сталь' },
  { color: 0xffd23a, level: 12, name: 'Золото' },
];

const KEY = 'echo.progress';

export function loadProgress(): Progress {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Progress>;
    const n = (v: unknown) => (typeof v === 'number' && v >= 0 ? Math.floor(v) : 0);
    return { xp: n(p.xp), matches: n(p.matches), kills: n(p.kills), wins: n(p.wins) };
  } catch {
    return { xp: 0, matches: 0, kills: 0, wins: 0 };
  }
}

export function saveProgress(p: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* no storage: progress lasts this session only */
  }
}

/** Experience a level takes: 400 for the first, 200 more for each after. */
function levelCost(level: number): number {
  return 400 + 200 * (level - 1);
}

/** Level for an amount of experience, and progress into the next one. */
export function levelOf(xp: number): { level: number; into: number; need: number } {
  let level = 1;
  let left = xp;
  while (left >= levelCost(level)) {
    left -= levelCost(level);
    level++;
  }
  return { level, into: left, need: levelCost(level) };
}

/** Experience earned in a match. */
export function matchXp(t: MatchTally, win: boolean): number {
  return 50 + t.kills * 20 + t.objectives * 100 + t.revives * 40 + t.rooms * 40 + t.waves * 50 + (win ? 200 : 0);
}

/** Banks a finished match; returns what changed for the game-over screen. */
export function addMatch(t: MatchTally, win: boolean): { gained: number; before: number; after: number; unlocked: string[] } {
  const p = loadProgress();
  const gained = matchXp(t, win);
  const before = levelOf(p.xp).level;
  p.xp += gained;
  p.matches++;
  p.kills += t.kills;
  if (win) p.wins++;
  saveProgress(p);
  const after = levelOf(p.xp).level;
  const unlocked = RING_COLORS.filter((c) => c.level > before && c.level <= after).map((c) => c.name);
  return { gained, before, after, unlocked };
}
