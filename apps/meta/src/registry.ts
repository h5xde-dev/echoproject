import { randomInt } from 'node:crypto';
import { callService } from '@echo/node-kit/http';
import type { RoomOptions } from '@echo/shared/net/meta';
import { ROOM_CODE_CHARS } from '@echo/shared/net/meta';
import { META } from './config';

// Game instances and their rooms, as their heartbeats report them. The game
// servers are the truth: a restarted meta server rebuilds all of this from the
// next round of heartbeats.

export interface RoomInfo {
  code: string;
  players: number;
  phase: string;
  mode: string;
  ranked: boolean;
  full: boolean;
  /** Ranked: whose seats (so a dropped player is sent back to their match). */
  subs: string[];
}

interface Instance {
  id: string;
  /** Internal address the meta server calls (from the heartbeat's source). */
  base: string;
  /** Public WebSocket path for browsers. */
  url: string;
  draining: boolean;
  capacity: number;
  rooms: RoomInfo[];
  seenAt: number;
}

const instances = new Map<string, Instance>();
/** Rooms created since the instance last reported (so they can be joined at once). */
const pending = new Map<string, { instance: string; at: number; info: RoomInfo }>();

export function heartbeat(body: Partial<Instance>): void {
  if (typeof body.id !== 'string' || typeof body.url !== 'string' || typeof body.base !== 'string') return;
  const rooms = Array.isArray(body.rooms) ? body.rooms : [];
  instances.set(body.id, {
    id: body.id,
    base: body.base,
    url: body.url,
    draining: body.draining === true,
    capacity: Number(body.capacity) || 0,
    rooms,
    seenAt: Date.now(),
  });
  for (const r of rooms) pending.delete(r.code);
}

function live(): Instance[] {
  const now = Date.now();
  return [...instances.values()].filter((i) => now - i.seenAt < META.staleMs);
}

export function findRoom(code: string): { instance: Instance; room: RoomInfo } | null {
  for (const instance of live()) {
    const room = instance.rooms.find((r) => r.code === code);
    if (room) return { instance, room };
  }
  const p = pending.get(code);
  if (p && Date.now() - p.at < META.staleMs) {
    const instance = live().find((i) => i.id === p.instance);
    if (instance) return { instance, room: p.info };
  }
  return null;
}

/** The ranked match this player still has a seat in, if any. */
export function rankedSeatOf(sub: string): { instance: Instance; room: RoomInfo } | null {
  for (const instance of live()) {
    const room = instance.rooms.find((r) => r.ranked && r.phase === 'live' && r.subs.includes(sub));
    if (room) return { instance, room };
  }
  // Created moments ago, before its instance reported it.
  for (const [code, p] of pending) {
    if (!p.info.ranked || !p.info.subs.includes(sub) || Date.now() - p.at >= META.staleMs) continue;
    const found = findRoom(code);
    if (found) return found;
  }
  return null;
}

function newCode(ranked: boolean): string {
  for (;;) {
    let code = ranked ? 'R' : '';
    const len = ranked ? 7 : 5;
    while (code.length < len) code += ROOM_CODE_CHARS[randomInt(ROOM_CODE_CHARS.length)];
    if (!findRoom(code)) return code;
  }
}

export class NoCapacity extends Error {}

/** Opens a room on the least busy instance that takes new rooms. */
export async function createRoom(opts: RoomOptions | null, ranked: boolean, subs: string[] = []): Promise<{ code: string; url: string }> {
  const candidates = live()
    .filter((i) => !i.draining && i.rooms.length < i.capacity)
    .sort((a, b) => a.rooms.length - b.rooms.length);
  for (const instance of candidates) {
    const code = newCode(ranked);
    try {
      await callService(instance.base, '/internal/rooms', META.secret, { code, opts, ranked });
      const info: RoomInfo = { code, players: 0, phase: ranked ? 'live' : 'lobby', mode: opts?.mode ?? 'dm', ranked, full: false, subs };
      pending.set(code, { instance: instance.id, at: Date.now(), info });
      return { code, url: instance.url };
    } catch (err) {
      console.warn(`instance ${instance.id}: room not created:`, err instanceof Error ? err.message : err);
    }
  }
  throw new NoCapacity();
}

export function stats() {
  const list = live();
  return {
    instances: list.map((i) => ({ id: i.id, url: i.url, draining: i.draining, rooms: i.rooms.length, players: i.rooms.reduce((n, r) => n + r.players, 0) })),
  };
}
