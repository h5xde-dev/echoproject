import { CONFIG } from './config';
import type { GameMode, ShopItem, SiegeRole } from './types';
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
    id: 'duel',
    title: 'Дуэль 1v1',
    short: '1V1',
    desc: 'Честная дуэль один на один. Создайте комнату и пригласите друга кодом.',
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
    id: 'ctf',
    title: 'Захват флага',
    short: 'ФЛАГ',
    desc: 'Две базы, два флага. Унесите чужой флаг к себе, пока ваш стоит на месте. Упавший флаг можно вернуть касанием. Три захвата — победа.',
    arena: true,
  },
  {
    id: 'bomb',
    title: 'Закладка бомбы',
    short: 'БОМБА',
    desc: 'Раунды как в CS: синие закладывают бомбу на точку A или B (зажать E), красные защищают и обезвреживают. Без возрождения, закупка в начале раунда. Пять раундов — победа.',
    arena: true,
  },
  {
    id: 'waves',
    title: 'Волны',
    short: 'ВОЛНЫ',
    desc: 'Вместе против волн охраны. Каждая следующая больше и злее; враги идут на шум и свет. Погибшие возвращаются после волны — пока жив хоть кто-то.',
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
    id: 'infect',
    title: 'Заражение',
    short: 'ЗАРАЖЕНИЕ',
    desc: 'Через 10 секунд один из вас заражён: только нож, быстрее и крепче, без фонаря. Убитый человек встаёт заражённым. Люди не возрождаются — продержитесь 3 минуты.',
    arena: true,
  },
  {
    id: 'extract',
    title: 'Эвакуация',
    short: 'ЭВАКУАЦИЯ',
    desc: 'Отряд против охраны. Найдите грузы на карте и донесите до точки эвакуации (груз замедляет, павший его роняет). За 6 минут вынесите хотя бы половину. Охрана подходит волнами.',
    arena: true,
  },
  {
    id: 'vip',
    title: 'Сопровождение VIP',
    short: 'VIP',
    desc: 'Раунды. Атака ведёт VIP (пистолет и броня) к точке, защита устраивает засаду. Довели — очко атаке, VIP убит или время вышло — защите. Стороны меняются, до 4 побед.',
    arena: true,
  },
  {
    id: 'zone',
    title: 'Сужающаяся зона',
    short: 'ЗОНА',
    desc: 'Одна жизнь, каждый сам за себя. На старте нож и пистолет, остальное — с пола. Зона сжимается, снаружи темно и больно. Последний выживший побеждает.',
    arena: true,
  },
  {
    id: 'siege',
    title: 'Осада',
    short: 'ОСАДА',
    desc: '5 на 5. Три линии башен и Трон, посередине река с мостами, между линиями лес: лагеря дезертиров, вышки, спрятанные FPV и грузовик. Линейные ведут крипов и ломают башни, диверсант охотится в лесу, оператор работает дронами и миномётом. За рекой врага слышно только вблизи. Общий банк команды, магазин — B. Сломайте вражеский Трон.',
    arena: true,
  },
  {
    id: 'convoy',
    title: 'Конвой',
    short: 'КОНВОЙ',
    desc: '4 на 4. Синие ведут грузовик по дороге через город: он едет, пока рядом свой и нет врага. Красные держат дорогу и жгут его — у каждого ПТУР (H). Контрольные точки добавляют время. Довезите — или остановите.',
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

/** Every mode, for validating what a browser asks for (meta and game servers). */
export const MODE_IDS: GameMode[] = MODES.map((m) => m.id);

export function modeInfo(mode: GameMode): ModeInfo {
  return MODES.find((m) => m.id === mode) ?? MODES[0];
}

export function isArena(mode: GameMode): boolean {
  return mode !== 'coop';
}

/** Players on one side against guards: co-op levels and waves. */
export function isCoopMode(mode: GameMode): boolean {
  return mode === 'coop' || mode === 'waves' || mode === 'extract';
}

/** Modes fought in two teams. */
export function isTeamMode(mode: GameMode): boolean {
  return mode === 'tdm' || mode === 'ctf' || mode === 'bomb' || mode === 'infect' || mode === 'vip' || mode === 'siege' || mode === 'convoy';
}

/** Modes played in rounds with a freeze, a buy window and money. */
export function isRoundMode(mode: GameMode): boolean {
  return mode === 'comp' || mode === 'bomb';
}

export const TEAM_NAMES = ['СИНИЕ', 'КРАСНЫЕ'] as const;

/** Gun game ladder, weakest first. */
export const GUN_LADDER: WeaponId[] = ['pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'sniper', 'knife'];

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
  { item: 'lmg', name: 'Пулемёт «Рой»', price: 3000 },
  { item: 'silenced', name: 'Пистолет с глушителем', price: 500 },
  { item: 'flamer', name: 'Огнемёт «Пал»', price: 2200 },
  { item: 'armor', name: 'Бронежилет', price: 650 },
  { item: 'grenade', name: 'Осколочная граната', price: 300 },
  { item: 'smoke', name: 'Дымовая граната', price: 300 },
  { item: 'flash', name: 'Светошумовая граната', price: 200 },
  { item: 'molotov', name: 'Коктейль Молотова', price: 400 },
  { item: 'drone', name: 'FPV-дрон', price: 900 },
  { item: 'flare', name: 'Осветительная ракета', price: 200 },
  { item: 'mine', name: 'Противопехотная мина', price: 300 },
];

/** «Осада»: names of the roles. */
export const SIEGE_ROLES: Record<SiegeRole, { name: string; short: string; desc: string }> = {
  line: { name: 'Линейный', short: 'ЛИНИЯ', desc: 'Держит свою линию с крипами, ломает башни, ставит улучшения на свои.' },
  sab: { name: 'Диверсант', short: 'ДИВЕРСАНТ', desc: 'Лес: грузовики (в них ПТУР — H), колючая проволока (N), удары во фланг.' },
  op: { name: 'Оператор', short: 'ОПЕРАТОР', desc: 'FPV-дроны (X) и миномёт (T) по отметкам команды (Z).' },
};

export interface SiegeShopEntry {
  item: ShopItem;
  name: string;
  price: number;
  /** The role it belongs to: everyone else pays CONFIG.siege.offRoleMul. */
  role?: SiegeRole;
  note: string;
  /** Shop section: a gun or gear for yourself, something for the team, a role. */
  group: 'self' | 'team' | 'role';
  /** On sale only from this second of the match (the opening stays a fight of guns). */
  from?: number;
}

/** «Осада»: the team shop. Prices from the design: drones and the mortar the operator's, wire the saboteur's, towers the line's. */
export const SIEGE_SHOP: SiegeShopEntry[] = [
  // For yourself: everyone starts with a pistol; guns bought stay with you from life to life.
  { item: 'rifle', name: 'Винтовка «Вектор»', price: 200, role: 'line', note: 'остаётся после смерти', group: 'self' },
  { item: 'lmg', name: 'Пулемёт «Рой»', price: 260, role: 'line', note: 'остаётся после смерти', group: 'self' },
  { item: 'shotgun', name: 'Дробовик «Кром»', price: 110, role: 'sab', note: 'остаётся после смерти', group: 'self' },
  { item: 'silenced', name: 'Пистолет с глушителем', price: 60, role: 'sab', note: 'остаётся после смерти', group: 'self' },
  { item: 'flamer', name: 'Огнемёт «Пал»', price: 180, role: 'sab', note: 'остаётся после смерти', group: 'self' },
  { item: 'smg', name: 'ПП «Грант»', price: 120, role: 'op', note: 'остаётся после смерти', group: 'self' },
  { item: 'sniper', name: 'Снайперка «Стриж»', price: 300, role: 'op', note: 'остаётся после смерти', group: 'self' },
  { item: 'armor', name: 'Бронежилет', price: 80, note: 'до смерти', group: 'self' },
  { item: 'grenade', name: 'Осколочная граната', price: 40, note: 'G', group: 'self' },
  // For the team.
  { item: 'cw_guns', name: 'Крипы: автоматы', price: 120, role: 'line', note: 'следующая волна с ПП', group: 'team' },
  { item: 'cw_armor', name: 'Крипы: броня', price: 100, role: 'line', note: 'следующая волна в броне', group: 'team' },
  { item: 'cw_more', name: 'Крипы: подкрепление', price: 150, role: 'line', note: '+2 крипа на линию в следующей волне', group: 'team' },
  { item: 'tw_mg', name: 'Башня: пулемёт', price: 200, role: 'line', note: 'ближайшая своя башня', group: 'team' },
  { item: 'tw_flame', name: 'Башня: огнемёт', price: 250, role: 'line', note: 'ближняя, поджигает', group: 'team' },
  { item: 'tw_ew', name: 'Башня: РЭБ', price: 300, role: 'line', note: 'глушит дроны, подсвечивает лес', group: 'team' },
  { item: 'tw_sniper', name: 'Башня: снайпер', price: 230, role: 'line', note: 'далеко и больно, сперва по бойцам', group: 'team' },
  { item: 'tw_aa', name: 'Башня: ПВО', price: 200, role: 'line', note: 'сбивает дроны и мины рядом', group: 'team', from: 60 },
  { item: 'tw_armor', name: 'Башня: броня', price: 260, role: 'line', note: `+${CONFIG.siege.armorHp} прочности, к любому модулю`, group: 'team' },
  { item: 'tw_wire', name: 'Башня: колючий периметр', price: 90, note: 'кольцо проволоки вокруг', group: 'team' },
  { item: 'tw_repair', name: 'Башня: ремонт', price: 160, note: `+${CONFIG.siege.repairHp} ближайшей своей`, group: 'team' },
  { item: 'aa', name: 'Пост ПВО', price: 180, note: 'V: сбивает дроны и мины миномёта', group: 'team', from: 60 },
  { item: 'drone', name: 'FPV-дрон', price: 80, role: 'op', note: 'X, до 2 в запасе', group: 'team', from: 60 },
  { item: 'droneExt', name: 'Батарея дрона +10 с', price: 120, role: 'op', note: '15 → 25 с полёта', group: 'team', from: 60 },
  { item: 'mortar', name: 'Залп миномёта', price: 150, role: 'op', note: 'T, по отметке или дрону', group: 'team', from: 120 },
  { item: 'wire', name: 'Катушка проволоки', price: 40, role: 'sab', note: 'N, до 3 на земле', group: 'team' },
  { item: 'role_line', name: 'Роль: линейный', price: 0, note: 'снаряжение — со следующей жизни', group: 'role' },
  { item: 'role_sab', name: 'Роль: диверсант', price: 0, note: 'снаряжение — со следующей жизни', group: 'role' },
  { item: 'role_op', name: 'Роль: оператор', price: 0, note: 'снаряжение — со следующей жизни', group: 'role' },
];

/** What an item costs this fighter: off-role and repeat purchases cost more. */
export function siegePrice(entry: SiegeShopEntry, role: SiegeRole | undefined, recent: number): number {
  const off = entry.role && entry.role !== role ? CONFIG.siege.offRoleMul : 1;
  return Math.round(entry.price * off * (1 + CONFIG.siege.repeatMul * recent));
}
