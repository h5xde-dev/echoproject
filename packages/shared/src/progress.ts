/**
 * Progress rules shared by the browser (guests, solo) and the servers (signed-in
 * players): experience per match, levels, and what levels unlock.
 */
import { isArena, isTeamMode } from './game/modes';
import type { GameEvent, GameMode } from './game/types';

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

/** Experience a level takes: 400 for the first, 200 more for each after. */
export function levelCost(level: number): number {
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

/** Empty tally for a new match. */
export function newTally(): MatchTally {
  return { kills: 0, objectives: 0, revives: 0, rooms: 0, waves: 0 };
}

/**
 * Counts one game event into a player's tally. The same rules run in the
 * browser (solo, guests) and on the game server (signed-in players), so the
 * experience a match gives does not depend on who counts it.
 * `hostile(id)` says whether soldier `id` is an enemy of `playerId`.
 */
export function tallyEvent(t: MatchTally, e: GameEvent, playerId: number, hostile: (id: number) => boolean): void {
  switch (e.type) {
    case 'death':
      if (e.by === playerId && e.ownerId !== playerId && hostile(e.ownerId ?? -1)) t.kills++;
      break;
    case 'roomClear':
      t.rooms++;
      break;
    case 'objective':
      if ((e.text === 'hacked' || e.text === 'defused') && e.ownerId === playerId) t.objectives++;
      break;
    case 'revive':
      if (e.by === playerId) t.revives++;
      break;
    case 'bomb':
      if ((e.text === 'planted' || e.text === 'defused') && e.ownerId === playerId) t.objectives++;
      break;
    case 'flag':
      if (e.text === 'captured' && e.ownerId === playerId) t.objectives++;
      break;
    case 'wave':
      if (e.text === 'clear') t.waves++;
      break;
    default:
      break;
  }
}

/**
 * Did this player win, by the event that ended the match? `team` is the
 * player's team (-1 outside team modes). Null: the event does not end a match.
 */
export function outcomeFor(e: GameEvent, mode: GameMode, playerId: number, team: number): boolean | null {
  if (e.type === 'gameOver') return false;
  if (e.type !== 'victory') return null;
  if (isTeamMode(mode)) return e.team === team;
  if (isArena(mode)) return e.ownerId === playerId;
  return true;
}

/**
 * What a player did in a match, in more detail than the tally: what quests and
 * achievements count. Keys: kills, deaths, kills_<cause> (a weapon id, knife,
 * backstab, frag, mine, drone, mortar, fire…), backstabs, crits, revives,
 * objectives, captures, plants, defuses, rooms, waves, powerups, drops,
 * streak3, streak5, throws. The server adds win and play_<mode>.
 */
export type MatchStats = Record<string, number>;

const bump = (s: MatchStats, key: string, n = 1) => {
  s[key] = (s[key] ?? 0) + n;
};

/** Counts one game event into a player's stats (same `hostile` rule as tallyEvent). */
export function statEvent(s: MatchStats, e: GameEvent, playerId: number, hostile: (id: number) => boolean): void {
  switch (e.type) {
    case 'death':
      if (e.ownerId === playerId) bump(s, 'deaths');
      else if (e.by === playerId && hostile(e.ownerId ?? -1)) {
        bump(s, 'kills');
        if (e.cause) bump(s, `kills_${e.cause}`);
        if (e.text === 'critical') bump(s, 'crits');
      }
      break;
    case 'stab':
      if (e.ownerId === playerId && e.text === 'backstab') bump(s, 'backstabs');
      break;
    case 'revive':
      if (e.by === playerId) bump(s, 'revives');
      break;
    case 'objective':
      if ((e.text === 'hacked' || e.text === 'defused') && e.ownerId === playerId) bump(s, 'objectives');
      break;
    case 'bomb':
      if (e.ownerId === playerId && e.text === 'planted') bump(s, 'plants');
      if (e.ownerId === playerId && e.text === 'defused') bump(s, 'defuses');
      break;
    case 'flag':
      if (e.text === 'captured' && e.ownerId === playerId) bump(s, 'captures');
      break;
    case 'roomClear':
      bump(s, 'rooms');
      break;
    case 'wave':
      if (e.text === 'clear') bump(s, 'waves');
      break;
    case 'powerup':
      if (e.ownerId === playerId) bump(s, 'powerups');
      break;
    case 'drop':
      if (e.id === 'opened' && e.ownerId === playerId) bump(s, 'drops');
      break;
    case 'streak':
      if (e.ownerId === playerId) bump(s, Number(e.id) >= 5 ? 'streak5' : 'streak3');
      break;
    case 'throw':
      if (e.ownerId === playerId) bump(s, 'throws');
      break;
    default:
      break;
  }
}

/** Stats from the network: known shape only, small whole numbers. */
export function cleanStats(raw: unknown): MatchStats {
  const out: MatchStats = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9_]{1,32}$/.test(k) || typeof v !== 'number' || !Number.isFinite(v)) continue;
    out[k] = Math.max(0, Math.min(1000, Math.floor(v)));
    if (Object.keys(out).length >= 64) break;
  }
  return out;
}
