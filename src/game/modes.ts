import type { GameMode, ShopItem } from './types';
import type { WeaponId } from './weapons';

// Mode descriptions shared by the menu, the HUD and the simulation.

export interface ModeInfo {
  id: GameMode;
  title: string;
  short: string;
  desc: string;
  /** Played on an arena (otherwise a generated co-op level). */
  arena: boolean;
}

export const MODES: ModeInfo[] = [
  {
    id: 'coop',
    title: 'Кооператив',
    short: 'КООП',
    desc: 'Зачистка объекта комната за комнатой. Двери открываются, когда в комнате никого не осталось.',
    arena: false,
  },
  {
    id: 'dm',
    title: 'Deathmatch',
    short: 'DM',
    desc: 'Каждый сам за себя. Оружие и бонусы лежат на арене, убитые роняют стволы.',
    arena: true,
  },
  {
    id: 'tdm',
    title: 'Командный бой',
    short: 'КОМАНДЫ',
    desc: 'Синие против красных, игроки делятся поровну, боты добирают составы. Своих не ранить, обзор союзников общий. Первая команда с 30 фрагами побеждает.',
    arena: true,
  },
  {
    id: 'gun',
    title: 'Гонка вооружений',
    short: 'ГОНКА',
    desc: 'Оружие не валяется: два убийства — и выдают следующее. Кто первым пройдёт всю лестницу, тот победил.',
    arena: true,
  },
  {
    id: 'comp',
    title: 'Соревнование',
    short: 'СОРЕВН.',
    desc: 'Раунды до последнего выжившего. На старте только пистолет — закупайтесь на заработанное (B).',
    arena: true,
  },
];

export function modeInfo(mode: GameMode): ModeInfo {
  return MODES.find((m) => m.id === mode) ?? MODES[0];
}

export function isArena(mode: GameMode): boolean {
  return mode !== 'coop';
}

/** Modes fought in two teams. */
export function isTeamMode(mode: GameMode): boolean {
  return mode === 'tdm';
}

export const TEAM_NAMES = ['СИНИЕ', 'КРАСНЫЕ'] as const;

/** Gun game ladder, weakest first. */
export const GUN_LADDER: WeaponId[] = ['pistol', 'smg', 'shotgun', 'rifle', 'sniper'];

export interface ShopEntry {
  item: ShopItem;
  name: string;
  price: number;
}

export const SHOP: ShopEntry[] = [
  { item: 'smg', name: 'ПП «Грант»', price: 1200 },
  { item: 'shotgun', name: 'Дробовик «Кром»', price: 1100 },
  { item: 'rifle', name: 'Винтовка «Вектор»', price: 2700 },
  { item: 'sniper', name: 'Снайперка «Стриж»', price: 4200 },
  { item: 'armor', name: 'Бронежилет', price: 650 },
  { item: 'grenade', name: 'Осколочная граната', price: 300 },
  { item: 'smoke', name: 'Дымовая граната', price: 300 },
  { item: 'flash', name: 'Светошумовая граната', price: 200 },
];
