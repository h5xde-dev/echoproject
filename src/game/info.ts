import { CONFIG } from './config';
import type { InteractKind, PlayerClass, PowerupKind } from './types';

// Player-facing descriptions for the menu's help panel and class card. The
// numbers come from CONFIG, so the text follows the balance.

const P = CONFIG.powerups;
const C = CONFIG.classes;

export interface ClassInfo {
  name: string;
  role: string;
  perks: string[];
}

export const CLASS_INFO: Record<PlayerClass, ClassInfo> = {
  assault: {
    name: 'Штурмовик',
    role: 'Прорыв и огневой контакт',
    perks: [`+${C.assault.extraFrags} осколочная граната`, `перезарядка на ${Math.round((1 - C.assault.reloadMul) * 100)}% быстрее`],
  },
  scout: {
    name: 'Разведчик',
    role: 'Тихий заход с фланга',
    perks: [
      `шаги вдвое тише`,
      `присед быстрее`,
      'ночное зрение на старте',
      'осветительная ракета на старте',
    ],
  },
  medic: {
    name: 'Медик',
    role: 'Держит отряд на ногах',
    perks: [`поднимает раненых в ${C.medic.reviveMul} раза быстрее`, `лечит союзников рядом (${C.medic.healRadius} м, ${C.medic.healRate} hp/с)`],
  },
  engineer: {
    name: 'Инженер',
    role: 'Укрепления и техника',
    perks: [
      `переносной щит — V (${C.engineer.shieldHp} hp)`,
      'FPV-дрон-камикадзе — X',
      `${CONFIG.mine.perEngineer} мины — N`,
    ],
  },
};

export const POWERUP_INFO: Record<PowerupKind, { name: string; desc: string }> = {
  medkit: { name: 'Аптечка', desc: `+${P.medkitHeal} здоровья` },
  armor: { name: 'Броня', desc: `+${P.armorAmount} брони, гасит ${Math.round(P.armorAbsorb * 100)}% урона` },
  damage: { name: 'Урон', desc: `урон ×${P.damageMul} на ${P.damageTime} с` },
  speed: { name: 'Скорость', desc: `бег ×${P.speedMul} на ${P.speedTime} с` },
  rapid: { name: 'Темп', desc: `стрельба и перезарядка быстрее на ${P.rapidTime} с` },
  nv: { name: 'ПНВ', desc: `видно в темноте без фонаря ${P.nvTime} с` },
  ammo: { name: 'Боеприпасы', desc: 'полный магазин и по гранате' },
  regen: { name: 'Регенерация', desc: `+${P.regenRate} hp/с ${P.regenTime} с, вне перестрелки` },
  overshield: { name: 'Сверхщит', desc: `+${P.overshield} защиты поверх брони, тает за 15 с` },
  stealth: { name: 'Маскировка', desc: `${P.stealthTime} с не видно, пока не бежишь и не стреляешь` },
  radar: { name: 'Радар', desc: `${P.radarTime} с враги на миникарте` },
};

export const OBJECT_INFO: { name: string; key: string; desc: string }[] = [
  { name: 'Рубильник', key: 'E', desc: `гасит или включает лампы в ${CONFIG.interact.switchRadius} м — устройте засаду в темноте` },
  { name: 'Ящик патронов', key: 'E', desc: `полный магазин и гранаты, перезаряжается ${CONFIG.interact.ammoCd} с` },
  { name: 'Медпункт', key: 'зажать E', desc: `${CONFIG.interact.medRate} hp/с, запас ${CONFIG.interact.medCharge} hp, медленно восполняется` },
  { name: 'Дверь', key: 'E', desc: 'открыть и закрыть; закрытая держит пули и закрывает обзор' },
  { name: 'Сброс снаряжения', key: `зажать E ${CONFIG.drop.openTime} с`, desc: 'ящик на парашюте раз в минуту: топовый ствол и два бонуса; урон сбивает вскрытие' },
  { name: 'Колючая проволока', key: `зажать E ${CONFIG.wire.cutTime} с / нож`, desc: `замедляет вдвое и ранит; пули пролетают` },
  { name: 'Окопы и воронки', key: 'C', desc: 'пригнувшегося в них не видно; издалека снаружи пули бьют слабее' },
  { name: 'Осветительная ракета', key: 'Q → G', desc: `${CONFIG.flare.life} с освещает ${CONFIG.flare.radius} м: скрыться нельзя ни в кусте, ни в окопе` },
  { name: 'Мина', key: 'N', desc: `взрывается под врагом (${CONFIG.mine.damage} урона); врагам видна только вблизи; можно расстрелять` },
  { name: 'Серия 3 убийств', key: '—', desc: `радар на ${P.radarTime} с` },
  { name: 'Серия 5 убийств', key: 'T', desc: `миномёт: ${CONFIG.streak.shells} мины по курсору через ${CONFIG.streak.strikeDelay} с свиста` },
];

export const INTERACT_LABEL: Record<InteractKind, string> = { switch: 'Рубильник', ammo: 'Ящик патронов', med: 'Медпункт' };

export const CONTROLS: [string, string][] = [
  ['W A S D', 'движение'],
  ['Мышь', 'прицел'],
  ['ЛКМ', 'огонь (нож — удар)'],
  ['Shift', 'шаг: тише, точнее'],
  ['C', 'присед: тихо, точно, прячет в окопе'],
  ['R', 'перезарядка'],
  ['1–9', 'оружие (в магазине — покупка)'],
  ['F', 'фонарь: видно дальше, но видно и вас'],
  ['G', 'бросить гранату'],
  ['Q', 'сменить вид гранаты'],
  ['E', 'использовать: рубильник, ящик, дверь, медпункт, сброс, проволока; поднять раненого'],
  ['V', 'инженер: щит'],
  ['X', 'FPV-дрон; в полёте ЛКМ — подрыв'],
  ['N', 'поставить мину'],
  ['T', 'миномётный удар (серия из 5)'],
  ['Z / колёсико', 'метка для союзников'],
  ['B', 'магазин (раунды, «Волны»)'],
  ['Tab', 'счёт'],
  ['Esc', 'пауза'],
];
