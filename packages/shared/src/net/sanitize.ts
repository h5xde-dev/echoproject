import { SHOP } from '../game/modes';
import type { PlayerInput } from '../game/sim';
import type { Gait, GrenadeKind, ShopItem } from '../game/types';

// Input from a browser, made safe before the simulation sees it: a client
// cannot move faster than the stick allows, feed NaN into positions, or buy
// what is not for sale. Whatever is malformed falls back to "nothing pressed".

const GAITS: Gait[] = ['run', 'walk', 'crouch'];
const NADES: GrenadeKind[] = ['frag', 'smoke', 'flash', 'molotov', 'flare'];
const ITEMS = new Set<string>(SHOP.map((s) => s.item));

const fin = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const bool = (v: unknown): boolean => v === true;

export function sanitizeInput(raw: Record<string, unknown>, dt: number): PlayerInput {
  let mx = clamp(fin(raw.moveX), -1, 1);
  let mz = clamp(fin(raw.moveZ), -1, 1);
  // The stick's length is at most 1: diagonals are not faster.
  const len = Math.hypot(mx, mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }
  const out: PlayerInput = {
    seq: Math.max(0, Math.floor(fin(raw.seq))),
    moveX: mx,
    moveZ: mz,
    aim: fin(raw.aim) % (Math.PI * 2),
    fire: bool(raw.fire),
    reload: bool(raw.reload),
    interact: bool(raw.interact),
    flashlight: bool(raw.flashlight),
    slot: clamp(Math.floor(fin(raw.slot, -1)), -1, 9),
    dt,
    rttMs: clamp(fin(raw.rttMs), 0, 2000),
    gait: GAITS.includes(raw.gait as Gait) ? (raw.gait as Gait) : 'run',
    use: bool(raw.use),
    grenade: bool(raw.grenade),
    deploy: bool(raw.deploy),
    drone: bool(raw.drone),
    strike: bool(raw.strike),
    mine: bool(raw.mine),
    buy: typeof raw.buy === 'string' && ITEMS.has(raw.buy) ? (raw.buy as ShopItem) : '',
  };
  if (raw.throwDist !== undefined) out.throwDist = clamp(fin(raw.throwDist, 10), 0, 40);
  if (NADES.includes(raw.grenadeKind as GrenadeKind)) out.grenadeKind = raw.grenadeKind as GrenadeKind;
  const mark = raw.mark as { x?: unknown; z?: unknown } | undefined;
  if (mark && typeof mark === 'object') {
    const x = fin(mark.x, NaN);
    const z = fin(mark.z, NaN);
    if (Number.isFinite(x) && Number.isFinite(z) && Math.abs(x) < 1e4 && Math.abs(z) < 1e4) out.mark = { x, z };
  }
  return out;
}
