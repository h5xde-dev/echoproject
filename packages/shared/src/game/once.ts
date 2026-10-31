import type { PlayerInput } from './sim';

// One-shot actions (reload, a grenade, a purchase) must apply exactly once even
// when several input packets arrive between two ticks, or none does.

export type OnceInput = Pick<PlayerInput, 'reload' | 'interact' | 'flashlight' | 'slot' | 'grenade' | 'throwDist' | 'grenadeKind' | 'buy' | 'mark' | 'deploy' | 'drone' | 'strike' | 'mine'>;

export const NO_ONCE: OnceInput = {
  reload: false,
  interact: false,
  flashlight: false,
  slot: -1,
  grenade: false,
  throwDist: undefined,
  grenadeKind: undefined,
  buy: '',
  mark: undefined,
  deploy: false,
  drone: false,
  strike: false,
  mine: false,
};

/** Folds a packet's one-shot actions into those not yet applied. */
export function mergeOnce(once: OnceInput, input: PlayerInput): void {
  if (input.reload) once.reload = true;
  if (input.interact) once.interact = true;
  // Two presses before a tick cancel out, as they would have one tick apart.
  if (input.flashlight) once.flashlight = !once.flashlight;
  if (input.slot >= 0) once.slot = input.slot;
  if (input.grenade) {
    once.grenade = true;
    once.throwDist = input.throwDist;
    once.grenadeKind = input.grenadeKind;
  }
  if (input.buy) once.buy = input.buy;
  if (input.mark) once.mark = input.mark;
  if (input.deploy) once.deploy = true;
  if (input.drone) once.drone = true;
  if (input.mine) once.mine = true;
  // The strike lands where the cursor was when T was pressed.
  if (input.strike) {
    once.strike = true;
    once.throwDist = input.throwDist;
  }
}
