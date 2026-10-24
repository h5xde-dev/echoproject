export type WeaponId = 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'sniper';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  short: string;
  /** Damage per projectile before falloff. */
  damage: number;
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
};

export const WEAPON_ORDER: WeaponId[] = ['pistol', 'smg', 'shotgun', 'rifle', 'sniper'];

export function weaponCooldown(def: WeaponDef): number {
  return 60 / def.rpm;
}

export function damageAtRange(def: WeaponDef, distance: number): number {
  if (distance <= def.falloffStart) return def.damage;
  if (distance >= def.falloffEnd) return def.damage * def.falloffEndMul;
  const t = (distance - def.falloffStart) / (def.falloffEnd - def.falloffStart);
  return def.damage * (1 + (def.falloffEndMul - 1) * t);
}
