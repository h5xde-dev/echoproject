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
  /**
   * Public (quick play, the room list): starts at once without a host, bots
   * fill it from the first player on and leave as people come, and a new
   * match follows each one by itself.
   */
  public?: boolean;
}

/** A public room as the room list shows it. */
export interface PublicRoom {
  code: string;
  mode: GameMode;
  arena: string;
  players: number;
  max: number;
  phase: string;
  mutators: Mutator[];
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

/** Quick play: any public room of this mode with a free seat, or a new one. */
export interface MetaQuickMsg {
  t: 'quick';
  mode: GameMode;
  /** The week's playlist plays with its mutators. */
  mutators?: Mutator[];
}

/** Ranked queue: join or leave. */
export interface MetaQueueMsg {
  t: 'queue' | 'unqueue';
}

export type MetaClientMsg = MetaHelloMsg | MetaCreateMsg | MetaJoinMsg | MetaQuickMsg | MetaQueueMsg;

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
