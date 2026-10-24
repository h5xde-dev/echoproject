import type { Buffs, FlagState, GameEvent, GameMode, Grenade, GrenadeKind, MapData, PowerupKind, ShopItem, SmokeCloud } from '../game/types';
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
  blind?: number;
  concealed?: boolean;
  team?: number;
  carrying?: number;
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
}

export interface EventMsg {
  t: 'evt';
  event: GameEvent;
}

export interface StartMsg {
  t: 'start';
  seed: number;
  map: MapData;
  snapshot: SnapshotMsg;
}

export interface OverMsg {
  t: 'over';
  win: boolean;
  text: string;
}

export interface HelloMsg {
  t: 'hello';
  name: string;
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

export interface PingMsg {
  t: 'ping';
  id: number;
  time: number;
}

export type HostMessage =
  | SnapshotMsg
  | WelcomeMsg
  | StartMsg
  | OverMsg
  | EventMsg
  | PlayerJoinedMsg
  | PlayerLeftMsg
  | PingMsg;

export type ClientMessage = InputMsg | HelloMsg | PingMsg;

/** Deterministic seed so both peers can reproduce the exact same bullet spread. */
export function shotSeed(actorId: number, shotSeq: number, mapSeed: number): number {
  let h = (actorId * 2654435761) >>> 0;
  h = (h ^ (shotSeq * 40503)) >>> 0;
  h = (h ^ (mapSeed * 2246822519)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h >>> 0;
}
