import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PlayerClass } from '@echo/shared/game/types';

/**
 * A seat in one room, signed by the meta server and checked by the game
 * server without a database: who (an account or a guest), under what name,
 * with which class and ring colour, and whether they host the room.
 */
export interface Ticket {
  /** Seat owner: `u<userId>` for an account, `g<guestId>` for a guest. */
  sub: string;
  userId: number | null;
  name: string;
  cls: PlayerClass | null;
  color: number;
  /** Signed-in: camouflage and badge from the profile (owned ones only). */
  camo?: string;
  badge?: string;
  room: string;
  host: boolean;
  /** Unix ms after which the ticket no longer opens a seat. */
  exp: number;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export function signTicket(t: Ticket, secret: string): string {
  const body = b64(JSON.stringify(t));
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyTicket(token: string, secret: string, now = Date.now()): Ticket | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Ticket;
    return t.exp > now ? t : null;
  } catch {
    return null;
  }
}
