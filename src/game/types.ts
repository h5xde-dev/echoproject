import type { WeaponId } from './weapons';

/**
 * coop — campaign rooms; dm — free-for-all; gun — gun game (kills climb a
 * weapon ladder); comp — competitive rounds with a CS-style economy.
 */
export type GameMode = 'coop' | 'dm' | 'gun' | 'comp';

export interface StaticBody {
  cx: number;
  cz: number;
  hw: number;
  hh: number;
}

/** Visual and dressing style of a room (or a whole arena). */
export type RoomTheme = 'warehouse' | 'office' | 'yard' | 'bunker';

export interface RoomDef {
  index: number;
  theme: RoomTheme;
  /** Grid cell bounds (inclusive). */
  cx0: number;
  cz0: number;
  cx1: number;
  cz1: number;
  /** World-space centre. */
  wx: number;
  wz: number;
  /** World-space inner bounds. */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Lamp position. */
  lampX: number;
  lampZ: number;
  /** Doorway that leads into this room (world centre of the gap). */
  doorX: number;
  doorZ: number;
  /** Axis the doorway pierces. */
  doorAxis: 'x' | 'z';
  hasDoor: boolean;
}

export type PropKind =
  | 'crate'
  | 'barrel'
  | 'table'
  | 'chair'
  | 'cover'
  | 'car'
  | 'pallet'
  | 'drum'
  | 'cabinet'
  | 'tires'
  | 'ammo';

export interface SimProp {
  id: number;
  kind: PropKind;
  x: number;
  z: number;
  vx: number;
  vz: number;
  hw: number;
  hh: number;
  hp: number;
  explosive: boolean;
  /** Anchored props (concrete barriers, cars): never pushed, never destroyed. */
  fixed: boolean;
  alive: boolean;
  room: number;
  mass: number;
}

export interface PropDef {
  id: number;
  kind: PropKind;
  /** World position of the prop centre. */
  x: number;
  z: number;
  hw: number;
  hh: number;
  explosive: boolean;
  fixed: boolean;
  hp: number;
  room: number;
}

export interface PickupDef {
  id: number;
  weapon: WeaponId;
  x: number;
  z: number;
  room: number;
}

export type PowerupKind = 'medkit' | 'armor' | 'damage' | 'speed' | 'rapid';

export interface PowerupDef {
  id: number;
  kind: PowerupKind;
  x: number;
  z: number;
  room: number;
}

/** A floor area to draw (rooms, doorways, arena floor), with its style. */
export interface FloorRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  theme: RoomTheme;
}

export interface LampDef {
  x: number;
  z: number;
  color: number;
}

export interface MapData {
  mode: GameMode;
  /** Display name (arenas) or empty for generated levels. */
  name: string;
  seed: number;
  tile: number;
  gridW: number;
  gridH: number;
  walls: StaticBody[];
  rooms: RoomDef[];
  props: PropDef[];
  pickups: PickupDef[];
  powerups: PowerupDef[];
  floors: FloorRect[];
  lamps: LampDef[];
  /** Deathmatch spawn points (empty for co-op levels). */
  spawns: { x: number; z: number }[];
  spawnX: number;
  spawnZ: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Grids for the minimap: 1 = floor, 2 = wall. */
  cells: Uint8Array;
}

export type ActorKind = 'player' | 'enemy';

export interface AiState {
  mode: 'idle' | 'patrol' | 'alert' | 'chase' | 'attack' | 'reposition';
  timer: number;
  targetX: number;
  targetZ: number;
  lastKnownX: number;
  lastKnownZ: number;
  repathTimer: number;
  strafeDir: number;
  strafeTimer: number;
  burst: number;
  fireDelay: number;
  patrolTarget: number;
  /** Reaction time before the AI opens fire after first spotting a target. */
  reactT: number;
  sawTarget: boolean;
  /** 0..1 build-up toward spotting the target; spotted at 1. */
  awareness: number;
  /** Seconds the current target has been tracked; sharpens aim. */
  aimT: number;
  /** Seconds until the AI may throw another grenade. */
  grenadeT: number;
  /** Carries a flashlight (co-op guards: some do; arena bots: all). */
  hasLight: boolean;
  /** Current target actor id (-1 = none). */
  targetId: number;
  /** Navigation path (world points) and the index of the next waypoint. */
  path: { x: number; z: number }[];
  pathIndex: number;
  pathGoalX: number;
  pathGoalZ: number;
  /** Seconds until the path may be re-planned. */
  pathTimer: number;
}

/** Seconds left on each timed buff (0 = inactive). */
export interface Buffs {
  damage: number;
  speed: number;
  rapid: number;
}

export interface Actor {
  id: number;
  kind: ActorKind;
  peerId: string;
  name: string;
  x: number;
  z: number;
  vx: number;
  vz: number;
  ang: number;
  hp: number;
  maxHp: number;
  armor: number;
  radius: number;
  speed: number;
  accel: number;
  friction: number;
  weapon: WeaponId;
  /** Weapons the actor carries (number keys pick among these). */
  weapons: WeaponId[];
  ammo: number;
  reloading: boolean;
  reloadT: number;
  cooldown: number;
  alive: boolean;
  flashOn: boolean;
  recoil: number;
  moving: boolean;
  respawnT: number;
  /** Seconds of spawn protection left (no damage taken). */
  shield: number;
  grenades: number;
  grenadeCd: number;
  /** Competitive: money. Gun game: unused. */
  money: number;
  /** Gun game: ladder tier and kills made on it. */
  tier: number;
  tierKills: number;
  buffs: Buffs;
  ai: AiState | null;
  slot: number;
  /** Monotonic counter of shots fired, used to seed the shared spread RNG. */
  shotSeq: number;
  /**
   * Seconds the host fast-forwards this player's new bullets: the input
   * reached it that late, so the shot is placed where it would be by now.
   */
  lagComp: number;
}

export interface Bullet {
  id: string;
  ownerId: number;
  ownerKind: ActorKind;
  x: number;
  z: number;
  vx: number;
  vz: number;
  speed: number;
  damage: number;
  /** Damage multiplier of the shooter at the moment of firing (buffs). */
  damageMul: number;
  life: number;
  weapon: WeaponId;
  color: number;
  range: number;
}

export interface Grenade {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  fuse: number;
}

/** Things for sale in competitive mode. */
export type ShopItem = 'smg' | 'shotgun' | 'rifle' | 'sniper' | 'armor' | 'grenade';

export interface NoiseEvent {
  x: number;
  z: number;
  radius: number;
  time: number;
}

export interface GameEvent {
  type:
    | 'shot'
    | 'impact'
    | 'explosion'
    | 'death'
    | 'hurt'
    | 'reload'
    | 'pickup'
    | 'powerup'
    | 'respawn'
    | 'throw'
    | 'buy'
    | 'round'
    | 'ladder'
    | 'roomClear'
    | 'roomEnter'
    | 'gameOver'
    | 'victory';
  x?: number;
  z?: number;
  y?: number;
  id?: string;
  ownerId?: number;
  /** hurt/death: id of the actor who dealt the damage. */
  by?: number;
  shotSeq?: number;
  weapon?: WeaponId;
  powerup?: PowerupKind;
  /** Exact per-pellet directions so the client can reproduce the spread. */
  pellets?: { dx: number; dz: number; speed: number }[];
  dirX?: number;
  dirZ?: number;
  text?: string;
}
