import { MUTATORS, type Difficulty, type GameMode, type Mutator, type PlayerClass } from '../game/types';
import type { MatchmakingMsg } from './protocol';

// The browser and the meta server (WebSocket /meta): who I am, open a room,
// join one by code, queue for ranked. The answer is a ticket for a seat on a
// game server; the game itself then runs over that server's own link
// (protocol.ts).

/** What a new room plays. */
export interface RoomOptions {
  mode: GameMode;
  arena: string;
  /** Arena modes: fighters bots fill up to. */
  fighters?: number;
  difficulty?: Difficulty;
  /** Bots in the room at all (they join once two people are in). */
  bots?: boolean;
  /** Match-wide rule changes (see Mutator). */
  mutators?: Mutator[];
}

/** Only known mutators, each once. */
export function cleanMutators(raw: unknown): Mutator[] {
  return Array.isArray(raw) ? MUTATORS.filter((m) => raw.includes(m)) : [];
}

export interface MetaHelloMsg {
  t: 'hello';
  /** Random id this browser keeps for playing without an account. */
  guestId: string;
  name: string;
  cls?: PlayerClass;
  color?: number;
}

export interface MetaCreateMsg {
  t: 'create';
  opts: RoomOptions;
}

export interface MetaJoinMsg {
  t: 'join';
  code: string;
}

/** Ranked queue: join or leave. */
export interface MetaQueueMsg {
  t: 'queue' | 'unqueue';
}

export type MetaClientMsg = MetaHelloMsg | MetaCreateMsg | MetaJoinMsg | MetaQueueMsg;

/** After the hello: signed in or a guest. */
export interface MetaMeMsg {
  t: 'me';
  signedIn: boolean;
  name: string;
}

/** A seat: open `url` (a WebSocket path on this site) with this ticket. */
export interface MetaTicketMsg {
  t: 'ticket';
  code: string;
  ticket: string;
  url: string;
  ranked: boolean;
}

export interface MetaErrorMsg {
  t: 'error';
  text: string;
}

export type MetaServerMsg = MetaMeMsg | MetaTicketMsg | MetaErrorMsg | MatchmakingMsg;

/** Room codes: five characters without look-alikes (0/O, 1/I). */
export const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
