export type WeaponId = 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'sniper' | 'lmg' | 'silenced' | 'knife' | 'flamer';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  short: string;
  /** Damage per projectile before falloff. */
  damage: number;
  /** Chance for a precision critical hit. */
  criticalChance?: number;
  /** Critical damage multiplier. */
  criticalMul?: number;
  /** Rounds per minute. */
  rpm: number;
  mag: number;
  reloadTime: number;
  /** Cone half-angle in radians. */
  spread: number;
  /** Projectiles per trigger pull. */
  pellets: number;
  /** Muzzle velocity, world units per second. */
  bulletSpeed: number;
  /** Distance at which damage starts to fall off. */
  falloffStart: number;
  /** Distance at which damage reaches `falloffEndMul`. */
  falloffEnd: number;
  falloffEndMul: number;
  auto: boolean;
  /** Recoil kick applied to the aim angle, radians. */
  recoil: number;
  /** Camera/shake impulse. */
  shake: number;
  /** Loudness radius for AI hearing, world units. */
  noise: number;
  /** Camera shake / flash size multiplier. */
  flashSize: number;
  color: number;
  /** Silenced: no shot marker for those who cannot see the shooter. */
  silenced?: boolean;
  /** Melee: no bullet; hits whoever is in reach in front (see CONFIG.knife). */
  melee?: boolean;
  /** Movement speed factor while it is in hand (heavy guns slow you). */
  moveMul?: number;
  /** Flamethrower: short-lived flames that set whoever they touch alight. */
  flame?: boolean;
  /** Projectiles burn out after this many metres (default: they fly until they hit). */
  reach?: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: {
    id: 'pistol',
    name: 'Пистолет M9',
    short: 'M9',
    damage: 24,
    rpm: 320,
    mag: 12,
    reloadTime: 1.25,
    spread: 0.022,
    pellets: 1,
    bulletSpeed: 78,
    falloffStart: 26,
    falloffEnd: 46,
    falloffEndMul: 0.6,
    auto: false,
    recoil: 0.022,
    shake: 0.1,
    noise: 26,
    flashSize: 0.85,
    color: 0xffe0a0,
  },
  smg: {
    id: 'smg',
    name: 'ПП «Грант»',
    short: 'ПП',
    damage: 17,
    rpm: 760,
    mag: 32,
    reloadTime: 1.7,
    spread: 0.052,
    pellets: 1,
    bulletSpeed: 66,
    falloffStart: 16,
    falloffEnd: 32,
    falloffEndMul: 0.45,
    auto: true,
    recoil: 0.016,
    shake: 0.07,
    noise: 22,
    flashSize: 0.8,
    color: 0xbfe8ff,
  },
  shotgun: {
    id: 'shotgun',
    name: 'Дробовик «Кром»',
    short: 'Дроб.',
    damage: 14,
    rpm: 72,
    mag: 6,
    reloadTime: 2.1,
    spread: 0.12,
    pellets: 9,
    bulletSpeed: 56,
    falloffStart: 9,
    falloffEnd: 22,
    falloffEndMul: 0.25,
    auto: false,
    recoil: 0.075,
    shake: 0.32,
    noise: 30,
    flashSize: 1.6,
    color: 0xffc890,
  },
  rifle: {
    id: 'rifle',
    name: 'Винтовка «Вектор»',
    short: 'Винт.',
    damage: 36,
    rpm: 210,
    mag: 20,
    reloadTime: 1.9,
    spread: 0.026,
    pellets: 1,
    bulletSpeed: 118,
    falloffStart: 22,
    falloffEnd: 48,
    falloffEndMul: 0.6,
    auto: false,
    recoil: 0.05,
    shake: 0.22,
    noise: 38,
    flashSize: 1.25,
    color: 0xfff4d0,
  },
  sniper: {
    id: 'sniper',
    criticalChance: 0.22,
    criticalMul: 1.75,
    name: 'Снайперка «Стриж»',
    short: 'Снайп.',
    damage: 110,
    rpm: 42,
    mag: 5,
    reloadTime: 2.4,
    spread: 0.004,
    pellets: 1,
    bulletSpeed: 190,
    falloffStart: 70,
    falloffEnd: 120,
    falloffEndMul: 1,
    auto: false,
    recoil: 0.11,
    shake: 0.5,
    noise: 60,
    flashSize: 1.8,
    color: 0xdff0ff,
  },
  lmg: {
    id: 'lmg',
    name: 'Пулемёт «Рой»',
    short: 'Пулем.',
    damage: 21,
    rpm: 560,
    mag: 60,
    reloadTime: 3.6,
    spread: 0.085,
    pellets: 1,
    bulletSpeed: 100,
    falloffStart: 20,
    falloffEnd: 45,
    falloffEndMul: 0.6,
    auto: true,
    recoil: 0.03,
    shake: 0.22,
    noise: 40,
    flashSize: 1.2,
    color: 0xffe6b0,
    moveMul: 0.82,
  },
  silenced: {
    id: 'silenced',
    name: 'Пистолет с глушителем',
    short: 'Глуш.',
    damage: 22,
    rpm: 280,
    mag: 12,
    reloadTime: 1.35,
    spread: 0.024,
    pellets: 1,
    bulletSpeed: 72,
    falloffStart: 18,
    falloffEnd: 36,
    falloffEndMul: 0.55,
    auto: false,
    recoil: 0.018,
    shake: 0.05,
    noise: 4,
    flashSize: 0.25,
    color: 0xc8d0d8,
    silenced: true,
  },
  knife: {
    id: 'knife',
    name: 'Нож',
    short: 'Нож',
    damage: 90,
    rpm: 115,
    mag: 1,
    reloadTime: 0,
    spread: 0,
    pellets: 0,
    bulletSpeed: 0,
    falloffStart: 0,
    falloffEnd: 1,
    falloffEndMul: 1,
    auto: false,
    recoil: 0,
    shake: 0.08,
    noise: 2,
    flashSize: 0,
    color: 0xffffff,
    melee: true,
    // Light in the hand: you close the distance faster.
    moveMul: 1.1,
  },
  flamer: {
    id: 'flamer',
    name: 'Огнемёт «Пал»',
    short: 'Огнем.',
    damage: 3.2,
    rpm: 600,
    mag: 100,
    reloadTime: 3.2,
    spread: 0.16,
    pellets: 3,
    bulletSpeed: 22,
    falloffStart: 4,
    falloffEnd: 8.5,
    falloffEndMul: 0.5,
    auto: true,
    recoil: 0.004,
    shake: 0.04,
    noise: 18,
    flashSize: 0.55,
    color: 0xff8a2a,
    moveMul: 0.9,
    flame: true,
    reach: 8.5,
  },
};

export const WEAPON_ORDER: WeaponId[] = ['pistol', 'smg', 'shotgun', 'rifle', 'sniper', 'lmg', 'silenced', 'knife', 'flamer'];

/** Guns that can lie on the floor as pickups. */
export const PICKUP_WEAPONS: WeaponId[] = ['smg', 'shotgun', 'rifle', 'sniper', 'lmg', 'silenced', 'flamer'];

export function weaponCooldown(def: WeaponDef): number {
  return 60 / def.rpm;
}

/** How long a projectile of this weapon lives before it burns out. */
export function projectileLife(def: WeaponDef, speed: number): number {
  return def.reach ? def.reach / speed : 3.0;
}

export function damageAtRange(def: WeaponDef, distance: number): number {
  if (distance <= def.falloffStart) return def.damage;
  if (distance >= def.falloffEnd) return def.damage * def.falloffEndMul;
  const t = (distance - def.falloffStart) / (def.falloffEnd - def.falloffStart);
  return def.damage * (1 + (def.falloffEndMul - 1) * t);
}
