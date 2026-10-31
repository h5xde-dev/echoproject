import type { BombState, Buffs, Drone, EnemyRole, FireZone, FlagState, Flare, GameEvent, GameMode, Grenade, GrenadeKind, MapData, PlayerClass, PowerupKind, PropKind, RoomObjective, ShopItem, SmokeCloud, StrikeShell, SupplyDrop } from '../game/types';
import type { WeaponId } from '../game/weapons';

export interface ActorState {
  id: number;
  kind: 'player' | 'enemy';
  peerId: string;
  name: string;
  x: number;
  z: number;
  ang: number;
  hp: number;
  maxHp: number;
  armor: number;
  alive: boolean;
  weapon: WeaponId;
  weapons: WeaponId[];
  buffs: Buffs;
  shield: number;
  grenades: number;
  money: number;
  tier: number;
  tierKills: number;
  ammo: number;
  reloading: boolean;
  flashOn: boolean;
  slot: number;
  smokes?: number;
  flashes?: number;
  molotovs?: number;
  /** On fire: drawn in flames. */
  burning?: boolean;
  blind?: number;
  concealed?: boolean;
  team?: number;
  carrying?: number;
  /** Bomb: seconds the use key has been held (plant / defuse progress). */
  useT?: number;
  /** Crouched: drawn lower for everyone. */
  crouched?: boolean;
  /** Co-op: knocked down, bleed-out clock, revive progress. */
  downed?: boolean;
  downT?: number;
  reviveT?: number;
  /** Guard type (drawn differently) and a sniper's laser when on target. */
  role?: EnemyRole;
  aiming?: boolean;
  cls?: PlayerClass | null;
  shieldUsed?: boolean;
  color?: number;
  /** FPV drones carried; the drone being flown (-1 / absent: none). */
  drones?: number;
  piloting?: number;
  /** Kill streak, mortar strikes ready, mines and flares carried, E-hold progress. */
  streak?: number;
  strikes?: number;
  mines?: number;
  flares?: number;
  hold?: number;
}

export interface BulletState {
  id: string;
  x: number;
  z: number;
  vx: number;
  vz: number;
  color: number;
}

export interface PropState {
  id: number;
  x: number;
  z: number;
  alive: boolean;
  hp?: number;
  /** Shape, only for props placed mid-match (an engineer's shield). */
  kind?: PropKind;
  hw?: number;
  hh?: number;
  /** Mines: who laid it (allies see it, enemies only up close). */
  owner?: number;
}

export interface PickupState {
  id: number;
  weapon: WeaponId;
  x: number;
  z: number;
}

export interface WaveState {
  n: number;
  phase: 'break' | 'fight';
  t: number;
  left: number;
  /** The shop is open (the break). */
  canBuy?: boolean;
}

export interface RoundState {
  n: number;
  phase: 'freeze' | 'live' | 'end';
  /** Seconds left in the phase. */
  t: number;
  canBuy: boolean;
}

export interface PowerupState {
  id: number;
  kind: PowerupKind;
  x: number;
  z: number;
  active: boolean;
}

export interface DoorState {
  room: number;
  open: boolean;
  openT: number;
}

export interface SnapshotMsg {
  t: 'snap';
  tick: number;
  time: number;
  room: number;
  phase: 'fighting' | 'cleared' | 'done';
  actors: ActorState[];
  bullets: BulletState[];
  props: PropState[];
  doors: DoorState[];
  pickups: PickupState[];
  powerups: PowerupState[];
  grenades: Grenade[];
  /** Indices of shot-out lamps. */
  lampsOut?: number[];
  smokes?: SmokeCloud[];
  fires?: FireZone[];
  drones?: Drone[];
  /** Switches, ammo crates, med stations: what changes. */
  inter?: { id: number; on: boolean; charge: number; cd: number }[];
  supply?: SupplyDrop[];
  shells?: StrikeShell[];
  flares?: Flare[];
  mode: GameMode;
  /** Arena scoreboard: [actor id, kills, deaths, rounds won]. */
  scores: [number, number, number, number][];
  round: RoundState | null;
  timeLeft: number;
  /** Team modes: kills per team. */
  teamScore?: [number, number];
  /** Waves: current wave, phase, seconds left in a break, guards left. */
  wave?: WaveState;
  /** Capture the flag: both flags and their bases. */
  flags?: FlagState[];
  bases?: { x: number; z: number }[];
  /** Co-op room tasks. */
  objectives?: RoomObjective[];
  /** Bomb planting: the bomb (null between rounds) and sites A, B. */
  bomb?: BombState | null;
  /** Bomb: which team attacks (swaps at halftime). */
  attackTeam?: number;
  sites?: { x: number; z: number }[];
  /** playerId -> last processed input sequence. */
  ack: Record<string, number>;
}

export interface WelcomeMsg {
  t: 'welcome';
  playerId: number;
  name: string;
  seed: number;
  map: MapData;
  snapshot: SnapshotMsg;
  /** Player id -> display colour. */
  colors: Record<string, number>;
}

export interface InputMsg {
  t: 'input';
  seq: number;
  moveX: number;
  moveZ: number;
  aim: number;
  fire: boolean;
  reload: boolean;
  interact: boolean;
  flashlight: boolean;
  slot: number;
  dt: number;
  grenade?: boolean;
  throwDist?: number;
  buy?: ShopItem | '';
  rttMs?: number;
  grenadeKind?: GrenadeKind;
  use?: boolean;
  mark?: { x: number; z: number };
  deploy?: boolean;
  drone?: boolean;
  strike?: boolean;
  mine?: boolean;
}

export interface EventMsg {
  t: 'evt';
  event: GameEvent;
}

/** Room host: end the warm-up and start the match (or start another after one ends). */
export interface StartMsg {
  t: 'start';
}

/** The room this connection is in, sent before the welcome. */
export interface RoomMsg {
  t: 'room';
  code: string;
  mode: GameMode;
  ranked: boolean;
  /** This player starts the match. */
  host: boolean;
  /** Public room: no host, the next match starts by itself. */
  public?: boolean;
}

/** A signed-in player's experience after a match (the server counted it). */
export interface ProgressMsg {
  t: 'progress';
  gained: number;
  xp: number;
  before: number;
  after: number;
  unlocked: string[];
}

/** The server closes the room (empty, shut down for an update...): why. */
export interface ByeMsg {
  t: 'bye';
  text: string;
}

export interface OverMsg {
  t: 'over';
  win: boolean;
  text: string;
}

export interface HelloMsg {
  t: 'hello';
  name: string;
  cls?: PlayerClass;
  /** Unlocked ring colour the player picked. */
  color?: number;
}

export interface PlayerJoinedMsg {
  t: 'joined';
  playerId: number;
  name: string;
}

export interface PlayerLeftMsg {
  t: 'left';
  playerId: number;
}

/** Hosted room before the match: who is in and who is ready. */
export interface LobbyMsg {
  t: 'lobby';
  players: { id: number; name: string; ready: boolean; host: boolean }[];
  /** The host has started the match (the warm-up is over). */
  started: boolean;
}

export interface ReadyMsg {
  t: 'ready';
  ready: boolean;
}

export interface PingMsg {
  t: 'ping';
  id: number;
  time: number;
}

/** Ranked matchmaking on the server: waiting in the queue, or a match is starting. */
export interface MatchmakingMsg {
  t: 'mm';
  state: 'queue' | 'found' | 'error';
  /** Players waiting, and how many a match needs. */
  players?: number;
  need?: number;
  /** Seconds until a match starts with whoever is there (-1: not yet). */
  startIn?: number;
  text?: string;
}

/** Ranked match result: rating before and after for everyone who played. */
export interface RankedMsg {
  t: 'ranked';
  rows: { id: number; name: string; place: number; kills: number; deaths: number; before: number; after: number }[];
}

/** WebRTC signalling for the server's unreliable channel (both directions). */
export interface RtcMsg {
  t: 'rtc';
  sdp?: string;
  type?: string;
  candidate?: string;
  mid?: string;
}

export type HostMessage =
  | MatchmakingMsg
  | RankedMsg
  | RoomMsg
  | ProgressMsg
  | ByeMsg
  | RtcMsg
  | SnapshotMsg
  | WelcomeMsg
  | OverMsg
  | EventMsg
  | PlayerJoinedMsg
  | PlayerLeftMsg
  | LobbyMsg
  | PingMsg;

export type ClientMessage = InputMsg | HelloMsg | ReadyMsg | PingMsg | RtcMsg | StartMsg;

/** Deterministic seed so both peers can reproduce the exact same bullet spread. */
export function shotSeed(actorId: number, shotSeq: number, mapSeed: number): number {
  let h = (actorId * 2654435761) >>> 0;
  h = (h ^ (shotSeq * 40503)) >>> 0;
  h = (h ^ (mapSeed * 2246822519)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h >>> 0;
}
