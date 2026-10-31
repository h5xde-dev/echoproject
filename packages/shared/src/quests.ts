import type { GameMode, Mutator } from './game/types';
import type { MatchStats } from './progress';

// Daily and weekly quests, achievements and the cosmetics they unlock. The
// API counts them from the stats the game server reports after each match
// (signed-in players only); the browser only shows them.

export type QuestPeriod = 'daily' | 'weekly';

export interface QuestDef {
  id: string;
  text: string;
  /** Stat key the quest counts (see MatchStats; the API adds matches, win, play_<mode>, win_<mode>). */
  stat: string;
  goal: number;
  xp: number;
}

export const DAILY_QUESTS: QuestDef[] = [
  { id: 'd_play3', text: 'Сыграть 3 матча онлайн', stat: 'matches', goal: 3, xp: 150 },
  { id: 'd_win1', text: 'Выиграть матч', stat: 'win', goal: 1, xp: 150 },
  { id: 'd_kill15', text: '15 убийств', stat: 'kills', goal: 15, xp: 150 },
  { id: 'd_knife3', text: '3 убийства ножом', stat: 'kills_melee', goal: 3, xp: 200 },
  { id: 'd_frag3', text: '3 убийства гранатой', stat: 'kills_frag', goal: 3, xp: 200 },
  { id: 'd_revive3', text: 'Поднять 3 союзников', stat: 'revives', goal: 3, xp: 200 },
  { id: 'd_powerup8', text: 'Подобрать 8 бонусов', stat: 'powerups', goal: 8, xp: 120 },
  { id: 'd_drop2', text: 'Вскрыть 2 сброса', stat: 'drops', goal: 2, xp: 180 },
  { id: 'd_coop', text: 'Сыграть в кооператив или волны', stat: 'play_coopish', goal: 1, xp: 120 },
  { id: 'd_infect', text: 'Сыграть в «Заражение»', stat: 'play_infect', goal: 1, xp: 150 },
  { id: 'd_extract', text: 'Вынести 2 груза в «Эвакуации»', stat: 'cargo', goal: 2, xp: 200 },
  { id: 'd_zone', text: 'Сыграть в «Сужающуюся зону»', stat: 'play_zone', goal: 1, xp: 150 },
  { id: 'd_streak', text: 'Серия из 3 убийств', stat: 'streak3', goal: 1, xp: 150 },
  { id: 'd_objective', text: 'Выполнить 2 цели (флаг, бомба, терминал, VIP)', stat: 'objectives_all', goal: 2, xp: 200 },
];

export const WEEKLY_QUESTS: QuestDef[] = [
  { id: 'w_play15', text: 'Сыграть 15 матчей онлайн', stat: 'matches', goal: 15, xp: 600 },
  { id: 'w_win8', text: 'Выиграть 8 матчей', stat: 'win', goal: 8, xp: 700 },
  { id: 'w_kill100', text: '100 убийств', stat: 'kills', goal: 100, xp: 700 },
  { id: 'w_backstab5', text: '5 ударов в спину', stat: 'backstabs', goal: 5, xp: 600 },
  { id: 'w_drone5', text: '5 убийств FPV-дроном', stat: 'kills_drone', goal: 5, xp: 600 },
  { id: 'w_revive15', text: 'Поднять 15 союзников', stat: 'revives', goal: 15, xp: 600 },
  { id: 'w_modes4', text: 'Победить в «Заражении», «Эвакуации», VIP или «Зоне» 3 раза', stat: 'win_new', goal: 3, xp: 700 },
  { id: 'w_cargo10', text: 'Вынести 10 грузов', stat: 'cargo', goal: 10, xp: 700 },
];

export type CosmeticKind = 'camo' | 'badge';

export interface CamoDef {
  id: string;
  name: string;
  /** Colours laid over the uniform, part by part. */
  colors: number[];
}

export interface BadgeDef {
  id: string;
  name: string;
  /** A single character shown next to the name. */
  glyph: string;
  color: number;
}

export const CAMOS: CamoDef[] = [
  { id: 'forest', name: 'Лес', colors: [0x3b4a2a, 0x5b6b3a, 0x2a3320] },
  { id: 'urban', name: 'Город', colors: [0x6b6f75, 0x3a3d42, 0x9a9ea4] },
  { id: 'desert', name: 'Пустыня', colors: [0xb59b6a, 0x8a7046, 0xd2bf90] },
  { id: 'night', name: 'Ночь', colors: [0x1b2233, 0x2c3650, 0x111522] },
  { id: 'arctic', name: 'Арктика', colors: [0xdfe6ee, 0xa9b4c2, 0xf4f7fa] },
  { id: 'crimson', name: 'Багрянец', colors: [0x6a1420, 0x3a0b12, 0x9a2232] },
  { id: 'gold', name: 'Золото', colors: [0xc89b2a, 0x8a6a14, 0xf0c850] },
];

export const BADGES: BadgeDef[] = [
  { id: 'blade', name: 'Клинок', glyph: '†', color: 0xd8dde4 },
  { id: 'medic', name: 'Ангел', glyph: '✚', color: 0x5dff8a },
  { id: 'skull', name: 'Череп', glyph: '☠', color: 0xff5a6a },
  { id: 'bolt', name: 'Молния', glyph: 'ϟ', color: 0xffd23a },
  { id: 'star', name: 'Звезда', glyph: '★', color: 0x6fbaff },
  { id: 'crown', name: 'Корона', glyph: '♛', color: 0xffd23a },
  { id: 'eye', name: 'Око', glyph: '◉', color: 0x3fd6c8 },
];

export interface AchievementDef {
  id: string;
  title: string;
  desc: string;
  /** Lifetime stat (summed over all matches) and the value that earns it. */
  stat: string;
  goal: number;
  xp: number;
  unlock?: { kind: CosmeticKind; id: string };
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'a_first_win', title: 'Первая победа', desc: 'Выиграть матч онлайн', stat: 'win', goal: 1, xp: 200, unlock: { kind: 'camo', id: 'forest' } },
  { id: 'a_veteran', title: 'Ветеран', desc: '50 матчей онлайн', stat: 'matches', goal: 50, xp: 1000, unlock: { kind: 'camo', id: 'urban' } },
  { id: 'a_hunter', title: 'Охотник', desc: '250 убийств', stat: 'kills', goal: 250, xp: 1000, unlock: { kind: 'badge', id: 'skull' } },
  { id: 'a_blade', title: 'Тихий клинок', desc: '25 ударов в спину', stat: 'backstabs', goal: 25, xp: 800, unlock: { kind: 'badge', id: 'blade' } },
  { id: 'a_angel', title: 'Ангел-хранитель', desc: 'Поднять 50 союзников', stat: 'revives', goal: 50, xp: 800, unlock: { kind: 'badge', id: 'medic' } },
  { id: 'a_pilot', title: 'Пилот', desc: '20 убийств FPV-дроном', stat: 'kills_drone', goal: 20, xp: 800, unlock: { kind: 'badge', id: 'bolt' } },
  { id: 'a_survivor', title: 'Выживший', desc: '10 побед в «Заражении» или «Зоне»', stat: 'win_survival', goal: 10, xp: 800, unlock: { kind: 'camo', id: 'night' } },
  { id: 'a_courier', title: 'Курьер', desc: 'Вынести 30 грузов', stat: 'cargo', goal: 30, xp: 800, unlock: { kind: 'camo', id: 'desert' } },
  { id: 'a_bodyguard', title: 'Телохранитель', desc: '10 раундов VIP доведён до точки', stat: 'vip_escaped', goal: 10, xp: 800, unlock: { kind: 'camo', id: 'arctic' } },
  { id: 'a_streak', title: 'Неудержимый', desc: '10 серий из 5 убийств', stat: 'streak5', goal: 10, xp: 1000, unlock: { kind: 'camo', id: 'crimson' } },
  { id: 'a_questor', title: 'Исполнитель', desc: 'Выполнить 30 заданий', stat: 'quests', goal: 30, xp: 1500, unlock: { kind: 'badge', id: 'star' } },
  { id: 'a_champion', title: 'Чемпион', desc: '100 побед', stat: 'win', goal: 100, xp: 3000, unlock: { kind: 'camo', id: 'gold' } },
  { id: 'a_legend', title: 'Легенда', desc: '1000 убийств', stat: 'kills', goal: 1000, xp: 3000, unlock: { kind: 'badge', id: 'crown' } },
  { id: 'a_eye', title: 'Зоркий', desc: '100 критических попаданий снайперкой', stat: 'crits', goal: 100, xp: 1000, unlock: { kind: 'badge', id: 'eye' } },
];

const NEW_MODES: GameMode[] = ['infect', 'extract', 'vip', 'zone'];

/**
 * The stats a match adds, with the derived keys quests read: the match itself,
 * the win, the mode, and groupings (melee kills, any objective, the new modes).
 */
export function matchStatsFor(stats: MatchStats, mode: GameMode, win: boolean): MatchStats {
  const s: MatchStats = { ...stats, matches: 1 };
  s[`play_${mode}`] = 1;
  if (mode === 'coop' || mode === 'waves') s.play_coopish = 1;
  s.kills_melee = (stats.kills_knife ?? 0) + (stats.kills_backstab ?? 0);
  s.objectives_all = (stats.objectives ?? 0) + (stats.captures ?? 0) + (stats.plants ?? 0) + (stats.defuses ?? 0) + (stats.vip_escaped ?? 0);
  if (win) {
    s.win = 1;
    s[`win_${mode}`] = 1;
    if (NEW_MODES.includes(mode)) s.win_new = 1;
    if (mode === 'infect' || mode === 'zone') s.win_survival = 1;
  }
  return s;
}

/** Period key in Moscow time (the players' day): 2026-11-01, or 2026-W44 for the week. */
export function periodKey(period: QuestPeriod, now = Date.now()): string {
  const d = new Date(now + 3 * 3600_000);
  if (period === 'daily') return d.toISOString().slice(0, 10);
  // ISO week: Thursday decides the year.
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thursday.getTime() - yearStart.getTime()) / 86400_000 - 3 + ((yearStart.getUTCDay() + 6) % 7)) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Milliseconds until the period turns over (midnight / Monday, Moscow time). */
export function periodEndsIn(period: QuestPeriod, now = Date.now()): number {
  const d = new Date(now + 3 * 3600_000);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  const toMidnight = midnight - d.getTime();
  if (period === 'daily') return toMidnight;
  const day = (d.getUTCDay() + 6) % 7;
  return toMidnight + (6 - day) * 86400_000;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Three quests of the period for this player: the same all day (week), different for each player. */
export function questsFor(period: QuestPeriod, userId: number, now = Date.now()): QuestDef[] {
  const pool = period === 'daily' ? DAILY_QUESTS : WEEKLY_QUESTS;
  const key = periodKey(period, now);
  return [...pool].sort((a, b) => hash(`${key}:${userId}:${a.id}`) - hash(`${key}:${userId}:${b.id}`)).slice(0, 3);
}

export const camoById = (id: string | undefined) => CAMOS.find((c) => c.id === id);
export const badgeById = (id: string | undefined) => BADGES.find((b) => b.id === id);

// ---------------------------------------------------------------- week's playlist

/** A featured combination of the week: a mode with mutators, with bonus experience. */
export interface Playlist {
  id: string;
  title: string;
  desc: string;
  mode: GameMode;
  mutators: Mutator[];
}

export const PLAYLISTS: Playlist[] = [
  { id: 'night_knives', title: 'Ночь ножей', desc: 'Deathmatch: лампы погашены, у всех только ножи', mode: 'dm', mutators: ['night', 'knives'] },
  { id: 'double_infect', title: 'Злая зараза', desc: 'Заражение с двойным уроном', mode: 'infect', mutators: ['double'] },
  { id: 'fast_zone', title: 'Быстрая зона', desc: 'Сужающаяся зона: все бегают на 20% быстрее', mode: 'zone', mutators: ['fast'] },
  { id: 'dark_extract', title: 'Эвакуация во тьме', desc: 'Эвакуация ночью: лампы погашены', mode: 'extract', mutators: ['night'] },
  { id: 'blind_vip', title: 'VIP без фонарей', desc: 'Сопровождение VIP: фонари не работают', mode: 'vip', mutators: ['noflash'] },
  { id: 'rush_tdm', title: 'Штурм', desc: 'Командный бой: двойной урон и скорость', mode: 'tdm', mutators: ['double', 'fast'] },
];

/** Experience for a match of the week's playlist. */
export const WEEKLY_XP_BONUS = 1.5;

/** This week's playlist (Moscow time, changes on Monday). */
export function weeklyPlaylist(now = Date.now()): Playlist {
  const key = periodKey('weekly', now);
  const [year, week] = key.split('-W').map(Number);
  return PLAYLISTS[(year * 53 + week) % PLAYLISTS.length];
}

/** Is this the week's playlist: same mode, same mutators. */
export function isWeekly(mode: string, mutators: readonly string[] | undefined, now = Date.now()): boolean {
  const p = weeklyPlaylist(now);
  const m = [...(mutators ?? [])].sort().join(',');
  return p.mode === mode && [...p.mutators].sort().join(',') === m;
}
