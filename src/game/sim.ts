import { Rng } from '../core/rng';
import { clamp, dist, normalize, segCircleHit } from '../core/math';
import { CONFIG, TILE } from './config';
import { updateBullets, type BulletCtx } from './bullets';
import { pickPowerup } from './levelgen';
import { GUN_LADDER, isArena, isCoopMode, isRoundMode, isTeamMode, SHOP, TEAM_NAMES } from './modes';
import { NavGrid } from './nav';
import { PhysicsWorld, resolveCircleBox, type DoorBody } from './physics';
import type {
  Actor,
  AiState,
  BombState,
  Bullet,
  FlagState,
  Gait,
  GameEvent,
  GameMode,
  Grenade,
  GrenadeKind,
  MapData,
  PowerupKind,
  RoomDef,
  ShopItem,
  SimProp,
  SmokeCloud,
  StaticBody,
} from './types';
import { WEAPON_ORDER, WEAPONS, damageAtRange, weaponCooldown, type WeaponId } from './weapons';
import { shotSeed } from '../net/protocol';

// Host-authoritative simulation for every mode:
//   co-op — a chain of rooms; guards spawn when the squad enters, the door
//           opens once the room is clear; downed players respawn somewhere
//           safe behind the front line.
//   dm    — free-for-all on an arena: humans plus bots, everyone hostile,
//           respawns at the safest spawn point, frag and time limits.
//   gun   — like dm, but nobody picks weapons up: kills climb a ladder.
//   comp  — rounds to the last one standing, no respawns within a round,
//           money from kills and round results buys gear (CS-style).
// Picked-up weapons leave the map for good; the dead drop their best gun.
// Movement (moveActor) is shared with the client's prediction, so anything
// it reads (speed buff) is also sent in snapshots.

export interface PlayerInput {
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
  /** Throw a grenade this tick (toward `aim`, `throwDist` metres). */
  grenade?: boolean;
  throwDist?: number;
  /** Competitive: item to buy this tick ('' = none). */
  buy?: ShopItem | '';
  /** Client's measured round trip to the host, for lag compensation. */
  rttMs?: number;
  /** Run unless walking (Shift) or crouching (C). */
  gait?: Gait;
  /** Which grenade `grenade` throws (frag when absent). */
  grenadeKind?: GrenadeKind;
  /** Use key held (E): plant or defuse the bomb. */
  use?: boolean;
  /** Team marker placed this tick (middle mouse / Z), at a ground point. */
  mark?: { x: number; z: number };
}

/** Radius of a smoke cloud of this age: it billows out, then thins away. */
export function smokeRadius(age: number): number {
  const S = CONFIG.smoke;
  const grow = Math.min(1, age / S.grow);
  const fade = Math.min(1, Math.max(0, (S.life - age) / S.fade));
  return S.radius * Math.sqrt(grow) * (0.6 + 0.4 * fade);
}

export interface DoorState {
  room: number;
  body: DoorBody;
  open: boolean;
  openT: number;
}

export interface SimPickup {
  id: number;
  weapon: WeaponId;
  x: number;
  z: number;
  room: number;
  active: boolean;
  respawnT: number;
  /** Dropped by a dead fighter: disappears after this many seconds. */
  life: number;
}

export interface SimPowerup {
  id: number;
  kind: PowerupKind;
  x: number;
  z: number;
  room: number;
  active: boolean;
  respawnT: number;
  /** Dropped by a guard: removed for good once taken. */
  dropped: boolean;
}

export interface Score {
  kills: number;
  deaths: number;
  /** Competitive: rounds won. */
  rounds: number;
}

/** Competitive round state. */
export type RoundPhase = 'freeze' | 'live' | 'end';

const ENEMY_ID_BASE = 1000;
const ENEMY_WEAPONS: WeaponId[] = ['pistol', 'smg', 'rifle'];
const BOT_NAMES = ['Волк', 'Сыч', 'Гюрза', 'Кедр', 'Филин', 'Шатун', 'Ворон', 'Рысь'];
const MAX_CORPSES = 24;

export class Sim {
  readonly map: MapData;
  readonly mode: GameMode;
  readonly world: PhysicsWorld;
  readonly nav: NavGrid;
  readonly actors = new Map<number, Actor>();
  bullets: Bullet[] = [];
  props: SimProp[] = [];
  doors: DoorState[] = [];
  pickups: SimPickup[] = [];
  powerups: SimPowerup[] = [];
  grenades: Grenade[] = [];
  events: GameEvent[] = [];
  smokes: SmokeCloud[] = [];
  /** Ceiling lamps still burning, by index into `map.lamps`. */
  lampAlive: boolean[];
  /** `step` marks footsteps, which only the walker's enemies listen for. */
  noises: { x: number; z: number; radius: number; time: number; ownerId: number; step?: boolean }[] = [];
  readonly scores = new Map<number, Score>();

  roomIndex = 0;
  roomPhase: 'fighting' | 'cleared' | 'done' = 'fighting';
  time = 0;
  /** Deathmatch: seconds left in the match. */
  timeLeft = 0;
  matchOver = false;
  /** Team modes: kills per team. */
  teamScore: [number, number] = [0, 0];
  /** Bomb planting: this round's bomb, the two sites, the site attackers aim for. */
  bomb: BombState | null = null;
  sites: { x: number; z: number }[] = [];
  private bombGoal = 0;
  /** Capture the flag: the flags and the bases they belong on. */
  flags: FlagState[] = [];
  bases: { x: number; z: number }[] = [];
  /** Waves: current wave (0 before the first), its phase and phase clock. */
  wave = 0;
  wavePhase: 'break' | 'fight' = 'break';
  waveT: number = CONFIG.waves.firstBreak;
  bulletSeq = 0;
  /** Arena head count; bots fill the places humans leave free. */
  fighters: number = CONFIG.dm.fighters;
  /** Competitive rounds. */
  round = 0;
  roundPhase: RoundPhase = 'freeze';
  /** Seconds left in the current phase (freeze / live / end). */
  roundT = 0;
  /** Seconds since the round started (buy window). */
  roundAge = 0;

  private rng: Rng;
  private nextActorId = ENEMY_ID_BASE;
  private nextPowerupId = 10_000;
  private nextPickupId = 10_000;
  private nextGrenadeId = 1;
  private spawnedRooms = new Set<number>();
  private corpses: number[] = [];
  private scratch: StaticBody[] = [];
  private scratchProps: StaticBody[] = [];

  constructor(map: MapData) {
    this.map = map;
    this.lampAlive = map.lamps.map(() => true);
    this.mode = map.mode;
    this.world = new PhysicsWorld(map.walls);
    this.rng = new Rng(map.seed ^ 0x5f3759df);
    this.timeLeft = CONFIG.dm.timeLimit;

    for (const p of map.props) {
      this.props.push({
        id: p.id,
        kind: p.kind,
        x: p.x,
        z: p.z,
        vx: 0,
        vz: 0,
        hw: p.hw,
        hh: p.hh,
        hp: p.hp,
        explosive: p.explosive,
        fixed: p.fixed,
        alive: true,
        room: p.room,
        mass: p.explosive ? 0.9 : 1.6,
      });
    }
    // Gun game hands weapons out by kills: no weapons lie around.
    if (this.mode !== 'gun') for (const p of map.pickups) this.pickups.push({ ...p, active: true, respawnT: 0, life: 0 });
    for (const p of map.powerups) this.powerups.push({ ...p, active: true, respawnT: 0, dropped: false });

    const navSolids: StaticBody[] = [...map.walls];
    for (const p of this.props) if (p.fixed) navSolids.push({ cx: p.x, cz: p.z, hw: p.hw, hh: p.hh });

    if (this.mode === 'coop') {
      for (const room of map.rooms) {
        if (!room.hasDoor) continue;
        const body: DoorBody =
          room.doorAxis === 'x'
            ? { cx: room.doorX, cz: room.doorZ, hw: 0.35, hh: TILE / 2, open: false }
            : { cx: room.doorX, cz: room.doorZ, hw: TILE / 2, hh: 0.35, open: false };
        this.doors.push({ room: room.index, body, open: false, openT: 0 });
        this.world.addDoor(body);
        // Guards hold their room: doorways are not on their nav grid.
        navSolids.push(body);
      }
    }
    this.nav = new NavGrid(map.minX, map.minZ, map.maxX, map.maxZ, navSolids, CONFIG.enemy.radius + 0.1);
    if (this.rounds) {
      this.round = 1;
      this.roundPhase = 'freeze';
      this.roundT = CONFIG.comp.freezeTime;
    }
    if (this.mode === 'bomb') {
      // Sites A and B: upper and lower quarter of the defenders' half.
      const w = map.maxX - map.minX;
      const h = map.maxZ - map.minZ;
      // A site must be reachable: from the attackers' start, not a walled-in pocket.
      const from = map.spawns.find((s) => this.sideOf(s.x) === 0) ?? { x: map.spawnX, z: map.spawnZ };
      for (const fz of [0.27, 0.73]) this.sites.push(this.nearestWalkable(map.minX + w * 0.74, map.minZ + h * fz, from));
    }
    if (this.mode === 'ctf') {
      // Each base sits among its team's spawn points.
      for (const team of [0, 1]) {
        const own = map.spawns.filter((s) => this.sideOf(s.x) === team);
        const x = own.reduce((acc, s) => acc + s.x, 0) / Math.max(1, own.length);
        const z = own.reduce((acc, s) => acc + s.z, 0) / Math.max(1, own.length);
        this.bases.push({ x, z });
        this.flags.push({ team, x, z, home: true, carrier: -1, dropT: 0 });
      }
    }
  }

  get arena(): boolean {
    return isArena(this.mode);
  }

  get teams(): boolean {
    return isTeamMode(this.mode);
  }

  /** Comp and bomb: rounds, freeze, buy window, money, no respawn. */
  get rounds(): boolean {
    return isRoundMode(this.mode);
  }

  /**
   * Team for a newcomer: humans are split evenly first (so friends end up
   * facing each other only when they outnumber a side), bots then even out
   * the head count.
   */
  private teamFor(isHuman: boolean): number {
    const count = [0, 0];
    for (const a of this.actors.values()) {
      if (a.team < 0) continue;
      if (!isHuman || a.kind === 'player') count[a.team]++;
    }
    return count[1] < count[0] ? 1 : 0;
  }

  /**
   * The walkable spot closest to a point (spiralling out on a 0.75 m grid),
   * optionally one that can be walked to from `from`.
   */
  private nearestWalkable(x: number, z: number, from?: { x: number; z: number }): { x: number; z: number } {
    for (let r = 0; r < 30; r++) {
      for (let k = 0; k < Math.max(1, r * 8); k++) {
        const a = (k / Math.max(1, r * 8)) * Math.PI * 2;
        const px = x + Math.cos(a) * r * 0.75;
        const pz = z + Math.sin(a) * r * 0.75;
        if (!this.nav.walkable(px, pz)) continue;
        if (from && !this.nav.find(from.x, from.z, px, pz)) continue;
        return { x: px, z: pz };
      }
    }
    return { x, z };
  }

  /** Arena half a spawn point belongs to: teams start on opposite sides. */
  private sideOf(x: number): number {
    return x < (this.map.minX + this.map.maxX) / 2 ? 0 : 1;
  }

  // ---------------------------------------------------------------- actors

  private newActor(id: number, kind: Actor['kind'], name: string, x: number, z: number): Actor {
    const isPlayer = kind === 'player';
    const cfg = isPlayer ? CONFIG.player : CONFIG.enemy;
    return {
      id,
      kind,
      peerId: '',
      name,
      x,
      z,
      vx: 0,
      vz: 0,
      ang: -Math.PI / 2,
      hp: cfg.maxHp,
      maxHp: cfg.maxHp,
      armor: 0,
      radius: cfg.radius,
      speed: cfg.maxSpeed,
      accel: cfg.accel,
      friction: cfg.friction,
      weapon: 'pistol',
      weapons: ['pistol'],
      ammo: WEAPONS.pistol.mag,
      reloading: false,
      reloadT: 0,
      cooldown: 0,
      alive: true,
      flashOn: isPlayer,
      recoil: 0,
      moving: false,
      respawnT: 0,
      shield: 0,
      grenades: isArena(this.mode) ? CONFIG.grenade.startArena : isPlayer ? CONFIG.grenade.startCoop : 0,
      grenadeCd: 0,
      money: CONFIG.comp.startMoney,
      tier: 0,
      tierKills: 0,
      buffs: { damage: 0, speed: 0, rapid: 0, nv: 0 },
      ai: isPlayer ? null : makeAi(),
      slot: 0,
      shotSeq: 0,
      lagComp: 0,
      gait: 'run',
      stepDist: 0,
      // Utility grenades are a player tool; in competitive they are bought.
      smokes: isPlayer && !this.rounds ? CONFIG.grenade.startUtility : 0,
      flashes: isPlayer && !this.rounds ? CONFIG.grenade.startUtility : 0,
      blind: 0,
      concealed: false,
      revealT: 0,
      team: -1,
      carrying: -1,
      using: false,
      useT: 0,
      markCd: 0,
    };
  }

  addPlayer(peerId: string, name: string, id: number): Actor {
    let x = this.map.spawnX + (id === 1 ? -1.6 : 1.6);
    let z = this.map.spawnZ;
    const team = this.teams ? this.teamFor(true) : -1;
    if (this.arena) {
      const s = this.pickSpawn(null, team);
      x = s.x;
      z = s.z;
    } else if (this.actors.size > 0) {
      const s = this.findSafeSpawn(null);
      x = s.x;
      z = s.z;
    }
    const actor = this.newActor(id, 'player', name, x, z);
    actor.peerId = peerId;
    actor.team = team;
    if (this.arena && !this.rounds) actor.shield = CONFIG.dm.spawnShield;
    // Joining a competitive round already under way: wait for the next one.
    if (this.rounds && this.roundPhase !== 'freeze') {
      actor.alive = false;
      actor.respawnT = Infinity;
    }
    this.actors.set(id, actor);
    this.scores.set(id, { kills: 0, deaths: 0, rounds: 0 });
    return actor;
  }

  removeActor(id: number): void {
    const actor = this.actors.get(id);
    if (actor) {
      this.dropFlag(actor);
      this.dropBomb(actor);
    }
    this.actors.delete(id);
    this.scores.delete(id);
  }

  /** Deathmatch: tops the arena up with bots to the configured head count. */
  fillBots(): void {
    // Waves bring their own guards.
    if (!this.arena || this.mode === 'waves') return;
    let humans = 0;
    let bots = 0;
    for (const a of this.actors.values()) {
      if (a.kind === 'player') humans++;
      else bots++;
    }
    const want = Math.max(0, this.fighters - humans);
    while (bots < want) {
      const id = this.nextActorId++;
      const team = this.teams ? this.teamFor(false) : -1;
      const s = this.pickSpawn(null, team);
      const bot = this.newActor(id, 'enemy', BOT_NAMES[(id - ENEMY_ID_BASE) % BOT_NAMES.length], s.x, s.z);
      bot.team = team;
      bot.maxHp = CONFIG.player.maxHp;
      bot.hp = bot.maxHp;
      bot.speed = CONFIG.player.maxSpeed * 0.92;
      bot.flashOn = true;
      this.equip(bot, this.startWeapon(bot));
      bot.ai!.hasLight = true;
      bot.shield = this.rounds ? 0 : CONFIG.dm.spawnShield;
      if (this.rounds && this.roundPhase !== 'freeze') {
        bot.alive = false;
        bot.respawnT = Infinity;
      }
      if (this.rounds && this.roundPhase === 'freeze') this.botShopping(bot);
      this.actors.set(id, bot);
      this.scores.set(id, { kills: 0, deaths: 0, rounds: 0 });
      bots++;
    }
    while (bots > want) {
      const bigger = this.teams ? 1 - this.teamFor(false) : -1;
      const bot = [...this.actors.values()].find((a) => a.kind === 'enemy' && (bigger < 0 || a.team === bigger));
      if (!bot) break;
      this.removeActor(bot.id);
      bots--;
    }
  }

  /** Spawns a room's guards once. */
  private populateRoom(index: number): void {
    if (this.spawnedRooms.has(index)) return;
    this.spawnedRooms.add(index);
    this.spawnEnemies(this.map.rooms[index]);
  }

  private spawnEnemies(room: RoomDef): void {
    // The first room is a safe start.
    if (room.index === 0) return;
    const count = clamp(2 + Math.floor(room.index * 0.8), 2, 6);
    const rng = new Rng(this.map.seed + room.index * 7919);
    const placed: { x: number; z: number }[] = [];

    for (let i = 0; i < count; i++) {
      let x = room.wx;
      let z = room.wz;
      for (let attempt = 0; attempt < 40; attempt++) {
        const tx = rng.range(room.minX + 1.2, room.maxX - 1.2);
        const tz = rng.range(room.minZ + 1.2, room.maxZ - 1.2);
        if (placed.some((p) => dist(p.x, p.z, tx, tz) < 5)) continue;
        if (this.props.some((p) => p.alive && Math.abs(p.x - tx) < p.hw + 0.8 && Math.abs(p.z - tz) < p.hh + 0.8)) continue;
        if (!this.nav.walkable(tx, tz)) continue;
        // Nobody stands right behind the door the squad comes through.
        if (room.hasDoor && dist(room.doorX, room.doorZ, tx, tz) < 8) continue;
        x = tx;
        z = tz;
        break;
      }
      placed.push({ x, z });

      const id = this.nextActorId++;
      const weapon = ENEMY_WEAPONS[Math.min(ENEMY_WEAPONS.length - 1, rng.int(0, Math.floor(room.index / 2)))];
      const hp = Math.round(CONFIG.enemy.maxHp * (1 + room.index * 0.12));
      const actor = this.newActor(id, 'enemy', 'hostile', x, z);
      actor.ang = rng.range(0, Math.PI * 2);
      actor.hp = hp;
      actor.maxHp = hp;
      actor.cooldown = rng.range(0, 0.6);
      actor.ai!.hasLight = rng.next() < 0.4;
      actor.grenades = rng.next() < 0.3 + room.index * 0.05 ? 1 : 0;
      this.equip(actor, weapon);
      this.actors.set(id, actor);
    }
  }

  /** What a fighter spawns with on an arena. */
  private startWeapon(actor: Actor): WeaponId {
    if (this.mode === 'gun') return GUN_LADDER[Math.min(actor.tier, GUN_LADDER.length - 1)];
    if (this.rounds) return 'pistol';
    return actor.kind === 'enemy' ? ENEMY_WEAPONS[this.rng.int(0, ENEMY_WEAPONS.length - 1)] : 'pistol';
  }

  private equip(actor: Actor, weapon: WeaponId): void {
    if (!actor.weapons.includes(weapon)) actor.weapons.push(weapon);
    actor.weapon = weapon;
    actor.ammo = WEAPONS[weapon].mag;
    actor.reloading = false;
    actor.reloadT = 0;
  }

  // ----------------------------------------------------------------- steps

  /** Applies a player input packet to the authoritative actor. */
  applyInput(actor: Actor, input: PlayerInput): void {
    if (!actor.alive) return;

    actor.ang = input.aim;
    actor.gait = input.gait ?? 'run';
    actor.using = !!input.use;
    // Markers go to everyone; clients show them to the marker's allies only.
    if (input.mark && actor.markCd <= 0) {
      actor.markCd = 0.6;
      this.events.push({ type: 'mark', ownerId: actor.id, x: input.mark.x, z: input.mark.z });
    }
    if (input.buy) this.buy(actor, input.buy);
    // Competitive freeze time: look around and shop, but no moving or shooting.
    if (this.frozen) {
      this.moveActor(actor, 0, 0, input.dt);
      return;
    }

    if (input.flashlight) actor.flashOn = !actor.flashOn;

    // Number keys pick among the weapons the actor carries.
    if (input.slot >= 0 && input.slot < WEAPON_ORDER.length) {
      const want = WEAPON_ORDER[input.slot];
      if (want !== actor.weapon && actor.weapons.includes(want)) {
        actor.weapon = want;
        actor.ammo = WEAPONS[want].mag;
        actor.reloading = false;
        actor.reloadT = 0;
        actor.cooldown = Math.max(actor.cooldown, 0.25);
      }
    }

    if (input.reload) this.startReload(actor);
    if (input.grenade) this.throwGrenade(actor, input.aim, input.throwDist ?? 10, input.grenadeKind ?? 'frag');

    if (input.fire && !actor.reloading && actor.cooldown <= 0) {
      this.fireWeapon(actor);
    }

    this.moveActor(actor, input.moveX, input.moveZ, input.dt);
  }

  private startReload(actor: Actor): void {
    const def = WEAPONS[actor.weapon];
    if (actor.reloading || actor.ammo >= def.mag) return;
    actor.reloading = true;
    actor.reloadT = def.reloadTime * (actor.buffs.rapid > 0 ? CONFIG.powerups.rapidMul : 1);
    this.events.push({ type: 'reload', ownerId: actor.id });
  }

  private fireWeapon(actor: Actor): void {
    const def = WEAPONS[actor.weapon];
    if (actor.ammo <= 0) {
      this.startReload(actor);
      return;
    }
    actor.ammo--;
    actor.cooldown = weaponCooldown(def) * (actor.buffs.rapid > 0 ? CONFIG.powerups.rapidMul : 1);
    // Taken before this shot's own kick: the first shot of a burst is clean.
    const spreadMul = this.spreadMul(actor);
    actor.recoil = Math.min(0.5, actor.recoil + def.recoil);
    // Shooting ends spawn protection.
    actor.shield = 0;
    actor.revealT = CONFIG.bush.revealAfterShot;

    const shotSeq = actor.shotSeq++;
    const id = `${actor.id}-${shotSeq}`;
    const baseAng = actor.ang;
    const count = def.pellets;
    const muzzle = 0.9;
    // Both peers derive the exact same spread from this seed.
    const srng = new Rng(shotSeed(actor.id, shotSeq, this.map.seed));

    const pelletDirs: { dx: number; dz: number; speed: number }[] = [];
    const fresh: Bullet[] = [];
    for (let i = 0; i < count; i++) {
      const spread = (srng.next() - 0.5) * 2 * def.spread * spreadMul;
      const ang = baseAng + spread;
      const dirX = Math.cos(ang);
      const dirZ = Math.sin(ang);
      const speed = def.bulletSpeed * (0.97 + srng.next() * 0.06);
      pelletDirs.push({ dx: dirX, dz: dirZ, speed });
      fresh.push(this.makeBullet(actor, count > 1 ? `${id}-${i}` : id, dirX, dirZ, speed, muzzle));
    }
    // Lag compensation: catch the shot up with the time its input spent on
    // the wire, in ordinary ticks so walls and bodies on the way still count.
    for (let t = actor.lagComp; t > 1e-4 && fresh.length; t -= CONFIG.tickDt) {
      this.updateBullets(Math.min(CONFIG.tickDt, t), fresh);
    }
    this.bullets.push(...fresh);

    this.noises.push({ x: actor.x, z: actor.z, radius: def.noise, time: this.time, ownerId: actor.id });
    this.events.push({
      type: 'shot',
      id,
      ownerId: actor.id,
      shotSeq,
      x: actor.x + Math.cos(baseAng) * muzzle,
      z: actor.z + Math.sin(baseAng) * muzzle,
      dirX: Math.cos(baseAng),
      dirZ: Math.sin(baseAng),
      pellets: pelletDirs,
      weapon: actor.weapon,
    });
  }

  private makeBullet(actor: Actor, id: string, dirX: number, dirZ: number, speed: number, muzzle: number): Bullet {
    const def = WEAPONS[actor.weapon];
    return {
      id,
      ownerId: actor.id,
      ownerKind: actor.kind,
      x: actor.x + dirX * muzzle,
      z: actor.z + dirZ * muzzle,
      vx: dirX * speed,
      vz: dirZ * speed,
      speed,
      damage: def.damage,
      damageMul: actor.buffs.damage > 0 ? CONFIG.powerups.damageMul : 1,
      life: 3.0,
      weapon: actor.weapon,
      color: actor.kind === 'player' ? def.color : 0xff7a5c,
      range: 0,
    };
  }

  /** Host-side authoritative tick. */
  step(dt: number): void {
    this.time += dt;

    for (const actor of this.actors.values()) {
      if (!actor.alive) {
        // Competitive: the dead wait for the next round.
        if ((actor.kind === 'player' || this.arena) && !this.rounds) {
          actor.respawnT -= dt;
          if (actor.respawnT <= 0 && !this.matchOver) this.respawn(actor);
        }
        continue;
      }
      if (actor.kind === 'enemy' && !this.frozen) this.updateAi(actor, dt);
      this.updateActorCommon(actor, dt);
      this.updateFootsteps(actor, dt);
      this.updateConcealment(actor);
      this.collectItems(actor);
    }

    this.updateBullets(dt);
    this.updateGrenades(dt);
    this.updateSmokes(dt);
    this.updateProps(dt);
    this.updateItems(dt);
    if (this.mode === 'coop') this.updateRoomProgress();
    else if (this.rounds) this.updateRounds(dt);
    else if (this.mode === 'waves') this.updateWaves(dt);
    else this.updateMatch(dt);
    if (this.mode === 'ctf') this.updateFlags(dt);
    this.noises = this.noises.filter((n) => this.time - n.time < 0.5);
  }

  private updateActorCommon(actor: Actor, dt: number): void {
    actor.cooldown = Math.max(0, actor.cooldown - dt);
    actor.recoil = Math.max(0, actor.recoil - dt * 1.6);
    actor.shield = Math.max(0, actor.shield - dt);
    actor.grenadeCd = Math.max(0, actor.grenadeCd - dt);
    actor.blind = Math.max(0, actor.blind - dt);
    actor.revealT = Math.max(0, actor.revealT - dt);
    actor.markCd = Math.max(0, actor.markCd - dt);
    const b = actor.buffs;
    b.damage = Math.max(0, b.damage - dt);
    b.rapid = Math.max(0, b.rapid - dt);
    b.nv = Math.max(0, b.nv - dt);
    b.speed = Math.max(0, b.speed - dt);
    this.applySpeed(actor);

    if (actor.reloading) {
      actor.reloadT -= dt;
      if (actor.reloadT <= 0) {
        actor.reloading = false;
        actor.ammo = WEAPONS[actor.weapon].mag;
      }
    }
  }

  /**
   * Players' bullets break the lamps they pass under this tick (up to the
   * first wall). The bullet flies on: the lamp hangs overhead.
   */
  private shootLamps(bullets: Bullet[], dt: number): void {
    for (const b of bullets) {
      if (b.ownerKind !== 'player') continue;
      const dirX = b.vx / b.speed;
      const dirZ = b.vz / b.speed;
      let travel = b.speed * dt;
      const wall = this.world.castSegment(b.x, b.z, dirX, dirZ, travel, this.scratch);
      if (wall) travel = wall.t;
      const ex = b.x + dirX * travel;
      const ez = b.z + dirZ * travel;
      this.map.lamps.forEach((l, i) => {
        if (!this.lampAlive[i]) return;
        if (segCircleHit(b.x, b.z, ex, ez, l.x, l.z, CONFIG.lamp.hitRadius) === null) return;
        this.lampAlive[i] = false;
        this.noises.push({ x: l.x, z: l.z, radius: CONFIG.lamp.noise, time: this.time, ownerId: b.ownerId });
        this.events.push({ type: 'lampBreak', id: String(i), x: l.x, z: l.z, ownerId: b.ownerId });
      });
    }
  }

  /** Client: lamp states from a snapshot (indices of broken lamps). */
  syncLamps(broken: number[]): void {
    this.lampAlive = this.map.lamps.map((_, i) => !broken.includes(i));
  }

  /**
   * Where a bot must go for its side's objective, and how close counts as
   * there: the bomb carrier to its site, defenders to a planted bomb, a flag
   * carrier home. Null when it has no such errand.
   */
  private objectiveOf(actor: Actor): { x: number; z: number; reach: number } | null {
    const bomb = this.bomb;
    if (this.mode === 'bomb' && bomb && this.roundPhase === 'live') {
      if (!bomb.planted && bomb.carrier === actor.id) return { ...this.sites[this.bombGoal], reach: CONFIG.bomb.siteRadius * 0.6 };
      if (bomb.planted && actor.team === 1) return { x: bomb.x, z: bomb.z, reach: CONFIG.bomb.defuseReach * 0.7 };
    }
    if (this.mode === 'ctf' && actor.carrying >= 0) return { ...this.bases[actor.team], reach: CONFIG.ctf.touch };
    return null;
  }

  /** Hidden while in a bush and quiet (not running, not just fired). */
  private updateConcealment(actor: Actor): void {
    const inBush = (this.map.bushes ?? []).some((b) => dist(actor.x, actor.z, b.x, b.z) < b.r);
    const quiet = actor.gait !== 'run' || Math.hypot(actor.vx, actor.vz) < 0.4;
    actor.concealed = inBush && quiet && actor.revealT <= 0;
  }

  /** Every few metres a moving soldier makes noise: loud running, quiet walking, none crouched. */
  private updateFootsteps(actor: Actor, dt: number): void {
    const v = Math.hypot(actor.vx, actor.vz);
    if (v < 0.4) return;
    actor.stepDist += v * dt;
    if (actor.stepDist < CONFIG.gait.stepLength) return;
    actor.stepDist = 0;
    const radius = CONFIG.gait.stepNoise[actor.gait];
    if (radius <= 0) return;
    this.noises.push({ x: actor.x, z: actor.z, radius, time: this.time, ownerId: actor.id, step: true });
    this.events.push({ type: 'step', ownerId: actor.id, x: actor.x, z: actor.z });
  }

  /**
   * Player accuracy: steadier standing still and crouched, worse on the run
   * and as recoil builds up during a burst. Multiplies the weapon's spread.
   */
  spreadMul(actor: Actor): number {
    const G = CONFIG.gait;
    const speedFrac = clamp(Math.hypot(actor.vx, actor.vz) / CONFIG.player.maxSpeed, 0, 1);
    return G.spreadStance[actor.gait] * (G.spreadStill + G.spreadMove * speedFrac) * (1 + G.spreadRecoil * actor.recoil);
  }

  /** Max speed from the base value and the speed buff (also used by prediction). */
  applySpeed(actor: Actor): void {
    const base = actor.kind === 'player' ? CONFIG.player.maxSpeed : this.arena ? CONFIG.player.maxSpeed * 0.92 : CONFIG.enemy.maxSpeed;
    actor.speed = base * (actor.buffs.speed > 0 ? CONFIG.powerups.speedMul : 1);
  }

  /**
   * Movement shared by the host and the client-side prediction so both agree.
   * Mutates position and velocity in place.
   */
  moveActor(actor: Actor, moveX: number, moveZ: number, dt: number): void {
    const hasInput = Math.abs(moveX) + Math.abs(moveZ) > 0.01;
    if (hasInput) {
      const speed = actor.speed * CONFIG.gait.speed[actor.gait] * (actor.carrying >= 0 ? CONFIG.ctf.carrySpeed : 1);
      const tvx = moveX * speed;
      const tvz = moveZ * speed;
      const maxDv = actor.accel * dt;
      actor.vx += clamp(tvx - actor.vx, -maxDv, maxDv);
      actor.vz += clamp(tvz - actor.vz, -maxDv, maxDv);
    } else {
      const f = Math.max(0, 1 - actor.friction * dt);
      actor.vx *= f;
      actor.vz *= f;
    }

    const oldX = actor.x;
    const oldZ = actor.z;
    actor.x += actor.vx * dt;
    actor.z += actor.vz * dt;

    this.resolveActorCollision(actor);
    actor.vx = (actor.x - oldX) / dt;
    actor.vz = (actor.z - oldZ) / dt;
    actor.moving = Math.hypot(actor.vx, actor.vz) > 0.4;
  }

  private resolveActorCollision(actor: Actor): void {
    const r = actor.radius;
    for (let pass = 0; pass < 2; pass++) {
      let hit = false;
      const near = this.world.query(actor.x - r, actor.z - r, actor.x + r, actor.z + r, this.scratch);
      for (const b of near) {
        if (resolveCircleBox(actor, r, b.cx, b.cz, b.hw, b.hh)) hit = true;
      }
      for (const d of this.world.doors) {
        if (!d.open && resolveCircleBox(actor, r, d.cx, d.cz, d.hw, d.hh)) hit = true;
      }
      for (const p of this.props) {
        if (!p.alive) continue;
        if (Math.abs(p.x - actor.x) > p.hw + r + 0.2 || Math.abs(p.z - actor.z) > p.hh + r + 0.2) continue;
        if (resolveCircleBox(actor, r, p.x, p.z, p.hw, p.hh)) {
          hit = true;
          if (p.fixed) continue;
          // Kick the prop away from the actor.
          const dx = p.x - actor.x;
          const dz = p.z - actor.z;
          const l = Math.hypot(dx, dz) || 1;
          const push = Math.min(9, Math.hypot(actor.vx, actor.vz) * 0.85);
          p.vx += (dx / l) * push;
          p.vz += (dz / l) * push;
        }
      }
      if (!hit) break;
    }
  }

  // ------------------------------------------------------------------ items

  /** Walking over a weapon or a powerup takes it (if it is any use). */
  private collectItems(actor: Actor): void {
    const R = CONFIG.powerups.pickupRadius;
    const pickupsAllowed = actor.kind === 'player' || this.arena;
    if (!pickupsAllowed) return;
    for (const p of this.pickups) {
      if (!p.active || dist(actor.x, actor.z, p.x, p.z) > R + actor.radius) continue;
      if (this.mode === 'coop' && p.room > this.roomIndex) continue;
      // Walking over a gun you already hold (with a full magazine) leaves it there.
      if (actor.weapons.includes(p.weapon) && actor.weapon === p.weapon && actor.ammo === WEAPONS[p.weapon].mag) continue;
      this.equip(actor, p.weapon);
      // Taken weapons are gone from the map.
      p.active = false;
      this.events.push({ type: 'pickup', ownerId: actor.id, weapon: p.weapon, x: p.x, z: p.z });
    }
    for (const p of this.powerups) {
      if (!p.active || dist(actor.x, actor.z, p.x, p.z) > R + actor.radius) continue;
      if (!this.applyPowerup(actor, p.kind)) continue;
      p.active = false;
      p.respawnT = this.arena ? CONFIG.powerups.dmRespawn : 0;
      this.events.push({ type: 'powerup', ownerId: actor.id, powerup: p.kind, x: p.x, z: p.z });
    }
  }

  private applyPowerup(actor: Actor, kind: PowerupKind): boolean {
    const P = CONFIG.powerups;
    switch (kind) {
      case 'medkit':
        if (actor.hp >= actor.maxHp) return false;
        actor.hp = Math.min(actor.maxHp, actor.hp + P.medkitHeal);
        return true;
      case 'armor':
        if (actor.armor >= P.maxArmor) return false;
        // (bought armor goes through buy())
        actor.armor = Math.min(P.maxArmor, actor.armor + P.armorAmount);
        return true;
      case 'damage':
        actor.buffs.damage = P.damageTime;
        return true;
      case 'speed':
        actor.buffs.speed = P.speedTime;
        return true;
      case 'rapid':
        actor.buffs.rapid = P.rapidTime;
        return true;
      case 'nv':
        actor.buffs.nv = P.nvTime;
        return true;
    }
  }

  private updateItems(dt: number): void {
    // Taken weapons are removed; dropped ones also expire.
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      if (p.life > 0) {
        p.life -= dt;
        if (p.life <= 0) p.active = false;
      }
      if (!p.active) this.pickups.splice(i, 1);
    }
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const p = this.powerups[i];
      if (p.active) continue;
      if (p.dropped || p.respawnT <= 0) {
        // One-off (co-op map items, drops): gone once taken.
        if (p.dropped || !this.arena) this.powerups.splice(i, 1);
        continue;
      }
      p.respawnT -= dt;
      if (p.respawnT <= 0) p.active = true;
    }
  }

  // ---------------------------------------------------------------- bullets

  private updateBullets(dt: number, bullets = this.bullets): void {
    this.shootLamps(bullets, dt);
    const ctx: BulletCtx = {
      world: this.world,
      props: this.props,
      actors: this.actors,
      scratch: this.scratch,
    };
    for (const hit of updateBullets(bullets, ctx, dt)) {
      if (hit.kind === 'static') {
        this.events.push({ type: 'impact', x: hit.x, z: hit.z, y: 1, weapon: hit.bullet.weapon });
      } else if (hit.kind === 'actor') {
        const dmg = damageAtRange(WEAPONS[hit.bullet.weapon], hit.bullet.range) * hit.bullet.damageMul;
        // Co-op and teams: no friendly fire (the bullet still stops on the body).
        const shooter = this.actors.get(hit.bullet.ownerId);
        const friendly =
          (isCoopMode(this.mode) && hit.bullet.ownerKind === hit.actor.kind) ||
          (this.teams && !!shooter && shooter !== hit.actor && shooter.team === hit.actor.team);
        if (!friendly) this.damageActor(hit.actor, dmg, hit.bullet.ownerId);
        this.events.push({
          type: 'impact',
          x: hit.x,
          z: hit.z,
          y: 1,
          weapon: hit.bullet.weapon,
          ownerId: hit.bullet.ownerId,
        });
      } else {
        if (!hit.prop.fixed) hit.prop.hp -= hit.bullet.damage;
        this.events.push({ type: 'impact', x: hit.x, z: hit.z, y: 1, weapon: hit.bullet.weapon });
        if (hit.prop.hp <= 0) {
          if (hit.prop.explosive) {
            this.explode(hit.prop.x, hit.prop.z, 7.5, 70, hit.bullet.ownerId);
          }
          hit.prop.alive = false;
        }
      }
    }
  }

  damageActor(actor: Actor, amount: number, sourceId: number): void {
    if (!actor.alive || actor.shield > 0) return;
    // Armor soaks a share of every hit until it runs out.
    if (actor.armor > 0) {
      const soak = Math.min(actor.armor, amount * CONFIG.powerups.armorAbsorb);
      actor.armor -= soak;
      amount -= soak;
    }
    actor.hp -= amount;
    this.events.push({ type: 'hurt', ownerId: actor.id, by: sourceId, x: actor.x, z: actor.z });
    if (actor.hp > 0) {
      // Being shot makes a guard aware of the shooter at once.
      const src = this.actors.get(sourceId);
      if (actor.ai && src) {
        actor.ai.awareness = 1;
        actor.ai.mode = 'alert';
        actor.ai.lastKnownX = src.x;
        actor.ai.lastKnownZ = src.z;
        actor.ai.timer = 3;
      }
      return;
    }

    actor.hp = 0;
    actor.alive = false;
    actor.vx = 0;
    actor.vz = 0;
    actor.reloading = false;
    this.events.push({ type: 'death', ownerId: actor.id, by: sourceId, x: actor.x, z: actor.z, id: String(actor.id) });

    this.dropWeapon(actor);
    this.dropFlag(actor);
    this.dropBomb(actor);
    if (this.arena) {
      // Competitive: back next round. Waves: players after the wave, guards never.
      actor.respawnT = this.rounds || this.mode === 'waves' ? Infinity : CONFIG.dm.respawnDelay;
      const victim = this.scores.get(actor.id);
      if (victim) victim.deaths++;
      const killer = this.scores.get(sourceId);
      const suicide = sourceId === actor.id;
      if (killer) killer.kills += suicide ? -1 : 1;
      const k = this.actors.get(sourceId);
      if (this.mode === 'tdm' && k && !suicide && k.team >= 0 && k.team !== actor.team) this.teamScore[k.team]++;
      if (k && !suicide) this.rewardKill(k);
      // Waves: fallen guards are bodies, cleared like co-op corpses.
      if (this.mode === 'waves' && actor.kind === 'enemy') {
        this.corpses.push(actor.id);
        while (this.corpses.length > MAX_CORPSES) {
          const id = this.corpses.shift()!;
          this.actors.delete(id);
          this.scores.delete(id);
        }
      }
      return;
    }

    if (actor.kind === 'player') {
      actor.respawnT = CONFIG.respawnDelay;
      return;
    }
    // Co-op guard: the body stays (ragdoll, drops); old bodies are cleared.
    if (this.rng.next() < CONFIG.powerups.dropChance) {
      this.powerups.push({
        id: this.nextPowerupId++,
        kind: pickPowerup(this.rng.next()),
        x: actor.x,
        z: actor.z,
        room: this.roomIndex,
        active: true,
        respawnT: 0,
        dropped: true,
      });
    }
    this.corpses.push(actor.id);
    while (this.corpses.length > MAX_CORPSES) this.actors.delete(this.corpses.shift()!);
  }

  /** The dead drop their best gun (not in gun game; co-op guards sometimes). */
  private dropWeapon(actor: Actor): void {
    if (this.mode === 'gun') return;
    if (actor.weapon === 'pistol') return;
    if (this.mode === 'coop' && (actor.kind === 'player' || this.rng.next() > 0.5)) return;
    this.pickups.push({
      id: this.nextPickupId++,
      weapon: actor.weapon,
      x: actor.x + this.rng.range(-0.6, 0.6),
      z: actor.z + this.rng.range(-0.6, 0.6),
      room: this.roomIndex,
      active: true,
      respawnT: 0,
      life: CONFIG.dropLife,
    });
    actor.weapons = actor.weapons.filter((w) => w !== actor.weapon);
  }

  /** Kill rewards: money in competitive, the next gun in gun game. */
  private rewardKill(killer: Actor): void {
    if (this.rounds) {
      killer.money = Math.min(CONFIG.comp.maxMoney, killer.money + CONFIG.comp.killReward);
    } else if (this.mode === 'gun') {
      killer.tierKills++;
      if (killer.tierKills < CONFIG.gun.killsPerTier) return;
      killer.tierKills = 0;
      killer.tier++;
      if (killer.tier >= GUN_LADDER.length) {
        this.finishMatch(killer.id, `${killer.name} прошёл всю лестницу`);
        return;
      }
      killer.weapons = [];
      this.equip(killer, GUN_LADDER[killer.tier]);
      this.events.push({ type: 'ladder', ownerId: killer.id, weapon: killer.weapon, text: String(killer.tier) });
    }
  }

  explode(x: number, z: number, radius: number, damage: number, sourceId: number): void {
    this.events.push({ type: 'explosion', x, z, y: 1 });
    for (const actor of this.actors.values()) {
      if (!actor.alive) continue;
      const d = dist(actor.x, actor.z, x, z);
      if (d > radius) continue;
      // Walls shield from the blast.
      if (!this.world.lineOfSight(x, z, actor.x, actor.z, this.scratch)) continue;
      const falloff = 1 - d / radius;
      // Teams: your grenade spares your side (but not you).
      const thrower = this.actors.get(sourceId);
      const ally = this.teams && !!thrower && thrower !== actor && thrower.team === actor.team;
      if (!ally) this.damageActor(actor, damage * falloff, sourceId);
      const dir = normalize(actor.x - x, actor.z - z);
      actor.vx += dir.x * 16 * falloff;
      actor.vz += dir.z * 16 * falloff;
    }
    for (const p of this.props) {
      if (!p.alive) continue;
      const d = dist(p.x, p.z, x, z);
      if (d > radius) continue;
      const falloff = 1 - d / radius;
      if (p.explosive) {
        p.hp -= damage * falloff;
        if (p.hp <= 0) {
          p.alive = false;
          this.explode(p.x, p.z, radius, damage, sourceId);
        }
      } else if (!p.fixed) {
        p.hp -= damage * falloff;
        p.vx += (p.x - x) * 2.4;
        p.vz += (p.z - z) * 2.4;
        if (p.hp <= 0) p.alive = false;
      }
    }
  }

  // ----------------------------------------------------------------- props

  private updateProps(dt: number): void {
    for (const p of this.props) {
      if (!p.alive || p.fixed) continue;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      const f = Math.max(0, 1 - 4.5 * dt);
      p.vx *= f;
      p.vz *= f;
      if (Math.abs(p.vx) < 0.02) p.vx = 0;
      if (Math.abs(p.vz) < 0.02) p.vz = 0;

      for (let pass = 0; pass < 2; pass++) {
        const near = this.world.query(p.x - p.hw, p.z - p.hh, p.x + p.hw, p.z + p.hh, this.scratchProps);
        let hit = false;
        for (const b of near) {
          if (resolveCircleBox(p, Math.max(p.hw, p.hh) * 0.8, b.cx, b.cz, b.hw, b.hh)) hit = true;
        }
        for (const d of this.world.doors) {
          if (!d.open && resolveCircleBox(p, Math.max(p.hw, p.hh) * 0.8, d.cx, d.cz, d.hw, d.hh)) hit = true;
        }
        if (!hit) break;
      }
    }
  }

  // ------------------------------------------------------------------- AI

  /** Who this actor fights: co-op guards hunt players, arena bots everyone. */
  private hostileTo(actor: Actor, other: Actor): boolean {
    if (other === actor || !other.alive) return false;
    if (this.teams) return other.team !== actor.team;
    if (this.arena && this.mode !== 'waves') return true;
    return actor.kind === 'enemy' ? other.kind === 'player' : other.kind === 'enemy';
  }

  private updateAi(actor: Actor, dt: number): void {
    const ai = actor.ai;
    if (!ai) return;
    actor.using = false;
    // Flashed: stands still, sees nothing, does not shoot.
    if (actor.blind > 0) {
      ai.awareness = 0;
      this.moveActor(actor, 0, 0, dt);
      return;
    }

    let nearest: Actor | null = null;
    let nearestD = Infinity;
    for (const other of this.actors.values()) {
      if (!this.hostileTo(actor, other)) continue;
      const d = dist(actor.x, actor.z, other.x, other.z);
      // Stick with the current target unless someone is much closer.
      const bias = other.id === ai.targetId ? 0.75 : 1;
      if (d * bias < nearestD) {
        nearestD = d * bias;
        nearest = other;
      }
    }
    if (nearest) nearestD = dist(actor.x, actor.z, nearest.x, nearest.z);
    ai.targetId = nearest ? nearest.id : -1;

    const def = WEAPONS[actor.weapon];
    const P = CONFIG.ai;
    // Perception: the target must be inside the guard's view cone (or right
    // next to them) with a clear line. Light and the target's flashlight
    // extend the range. Seeing only builds awareness; the guard reacts once
    // it is full, so walking into a room is not an instant firefight.
    let inSight = false;
    let detectRange = 0;
    // A target hiding in a bush is only spotted right next to it.
    const hidden = !!nearest && nearest.concealed && nearestD > CONFIG.bush.spotDist;
    if (nearest && !hidden && this.time > P.startGrace) {
      const d = nearestD;
      const lit = this.isLit(nearest.x, nearest.z);
      detectRange = P.darkRange;
      if (nearest.flashOn) detectRange = P.flashRange;
      if (lit) detectRange = Math.max(detectRange, P.litRange);
      const toTarget = Math.atan2(nearest.z - actor.z, nearest.x - actor.x);
      const facing = Math.cos(toTarget - actor.ang);
      const inFov = facing > Math.cos(P.fovHalf) || d < P.nearSense;
      if (d < detectRange && inFov) {
        inSight =
          this.world.lineOfSight(actor.x, actor.z, nearest.x, nearest.z, this.scratch) &&
          !this.smokeBlocks(actor.x, actor.z, nearest.x, nearest.z);
      }
    }

    const alerted = ai.mode === 'alert' || ai.mode === 'chase' || ai.mode === 'attack';
    if (inSight && nearest) {
      const closeness = 1 - nearestD / detectRange;
      const rate = P.awarenessRate * (0.35 + closeness * 1.3) * (alerted ? 2.5 : 1) * (this.arena ? 1.6 : 1);
      ai.awareness = Math.min(1, ai.awareness + rate * dt);
    } else {
      ai.awareness = Math.max(0, ai.awareness - P.awarenessDecay * dt);
    }
    const canSee = inSight && ai.awareness >= 1;

    ai.timer -= dt;
    ai.grenadeT -= dt;
    ai.repathTimer -= dt;
    ai.pathTimer -= dt;
    ai.strafeTimer -= dt;
    ai.fireDelay -= dt;
    ai.reactT = Math.max(0, ai.reactT - dt);
    if (!canSee) {
      ai.sawTarget = false;
      ai.aimT = 0;
    }

    // Half-noticed: turn toward the movement and get suspicious.
    if (inSight && nearest && !canSee && ai.awareness > 0.35 && (ai.mode === 'idle' || ai.mode === 'patrol')) {
      ai.mode = 'alert';
      ai.lastKnownX = nearest.x;
      ai.lastKnownZ = nearest.z;
      ai.timer = 2.5;
    }

    if (canSee && nearest) {
      ai.aimT += dt;
      if (!ai.sawTarget) {
        ai.sawTarget = true;
        ai.reactT = P.reactMin + this.rng.next() * P.reactRand;
      }
      ai.mode = 'attack';
      ai.lastKnownX = nearest.x;
      ai.lastKnownZ = nearest.z;
      ai.targetX = nearest.x;
      ai.targetZ = nearest.z;
      ai.timer = 2.5;
    } else if (ai.mode === 'attack') {
      ai.mode = 'chase';
      ai.timer = 6;
    }

    // React to noise: gunshots from anyone, footsteps only from enemies (guards
    // do not chase each other's steps).
    for (const n of this.noises) {
      if (this.time - n.time > 0.12) continue;
      if (n.ownerId === actor.id) continue;
      if (n.step) {
        const owner = this.actors.get(n.ownerId);
        if (!owner || !this.hostileTo(actor, owner)) continue;
      }
      if (dist(actor.x, actor.z, n.x, n.z) > n.radius) continue;
      if (ai.mode === 'idle' || ai.mode === 'patrol' || ai.mode === 'alert') {
        ai.awareness = Math.max(ai.awareness, 0.6);
        ai.mode = 'alert';
        ai.lastKnownX = n.x;
        ai.lastKnownZ = n.z;
        ai.timer = 4.5;
      }
    }

    let move = { x: 0, z: 0 };
    let wantAng = actor.ang;

    // An objective to carry out (plant, defuse, bring a flag home) wins over
    // hunting noises: with no enemy in sight, patrol straight to it.
    const objective = this.objectiveOf(actor);
    if (objective && !canSee && ai.mode !== 'patrol') {
      ai.mode = 'patrol';
      ai.repathTimer = 0;
    }

    switch (ai.mode) {
      case 'idle':
      case 'patrol':
      case 'reposition': {
        if (ai.repathTimer <= 0 || dist(actor.x, actor.z, ai.targetX, ai.targetZ) < 1.2) {
          // Objectives move (a flag is carried off): replan often in CTF.
          ai.repathTimer = this.mode === 'ctf' || this.mode === 'bomb' ? 1.2 : this.arena ? 6 + this.rng.next() * 4 : 2.4 + this.rng.next() * 2.4;
          const target = this.pickPatrolTarget(actor);
          ai.targetX = target.x;
          ai.targetZ = target.z;
        }
        move = this.steer(actor, ai.targetX, ai.targetZ, 1.2);
        if (move.x !== 0 || move.z !== 0) wantAng = Math.atan2(move.z, move.x);
        break;
      }
      case 'alert': {
        wantAng = Math.atan2(ai.lastKnownZ - actor.z, ai.lastKnownX - actor.x);
        const m = this.steer(actor, ai.lastKnownX, ai.lastKnownZ, 1.5);
        move = { x: m.x * 0.5, z: m.z * 0.5 };
        if (ai.timer <= 0) {
          ai.mode = 'chase';
          ai.timer = 8;
        }
        break;
      }
      case 'chase': {
        move = this.steer(actor, ai.lastKnownX, ai.lastKnownZ, 1.2);
        if (move.x !== 0 || move.z !== 0) wantAng = Math.atan2(move.z, move.x);
        if (ai.timer <= 0 || (move.x === 0 && move.z === 0)) {
          ai.mode = 'patrol';
          ai.timer = 3;
          ai.repathTimer = 0;
        }
        break;
      }
      case 'attack': {
        wantAng = Math.atan2(ai.targetZ - actor.z, ai.targetX - actor.x);
        if (nearest) {
          const ideal = Math.min(16, def.falloffStart * 0.8);
          const d = nearestD;
          if (d > ideal * 1.25) {
            move = this.steer(actor, nearest.x, nearest.z, ideal);
          } else if (d < ideal * 0.55) {
            move = { x: -Math.cos(wantAng), z: -Math.sin(wantAng) };
          } else {
            // Strafe around the target.
            if (ai.strafeTimer <= 0) {
              ai.strafeTimer = 1.1 + this.rng.next() * 1.4;
              ai.strafeDir = this.rng.next() < 0.5 ? 1 : -1;
            }
            move = { x: Math.cos(wantAng + Math.PI / 2) * ai.strafeDir, z: Math.sin(wantAng + Math.PI / 2) * ai.strafeDir };
          }

          if (ai.fireDelay <= 0 && actor.cooldown <= 0 && ai.reactT <= 0) {
            if (actor.ammo > 0) {
              this.enemyShoot(actor, nearest);
              ai.burst--;
              if (ai.burst <= 0) {
                ai.burst = 2 + this.rng.int(0, 2);
                ai.fireDelay = 0.95 + this.rng.next() * 1.1;
              }
            } else {
              this.startReload(actor);
            }
          }
        }
        break;
      }
    }

    // A hidden target near its last known spot: smoke it out with a grenade.
    if (
      actor.grenades > 0 &&
      ai.grenadeT <= 0 &&
      (ai.mode === 'chase' || ai.mode === 'alert') &&
      !canSee
    ) {
      const d = dist(actor.x, actor.z, ai.lastKnownX, ai.lastKnownZ);
      if (d > 5 && d < CONFIG.grenade.maxDist) {
        const ang = Math.atan2(ai.lastKnownZ - actor.z, ai.lastKnownX - actor.x);
        this.throwGrenade(actor, ang, d, 'frag');
        ai.grenadeT = CONFIG.grenade.aiCooldown + this.rng.next() * 4;
      }
    }

    // On the objective with no enemy in sight: stand still and hold use.
    if (this.mode === 'bomb' && objective && !canSee && dist(actor.x, actor.z, objective.x, objective.z) < objective.reach) {
      move = { x: 0, z: 0 };
      actor.using = true;
    }

    // Carrying a flag in a firefight: keep running home while shooting (out of
    // a fight, patrol already heads there).
    if (actor.carrying >= 0 && canSee) {
      const base = this.bases[actor.team];
      const home = this.steer(actor, base.x, base.z, 0.5);
      if (home.x !== 0 || home.z !== 0) {
        move = home;
        if (!canSee) wantAng = Math.atan2(home.z, home.x);
      }
    }

    // Get out of a live grenade's blast.
    for (const g of this.grenades) {
      const d = dist(actor.x, actor.z, g.x, g.z);
      if (d < CONFIG.grenade.radius + 0.5 && g.fuse < 1.6) {
        move = { x: (actor.x - g.x) / (d || 1), z: (actor.z - g.z) / (d || 1) };
        break;
      }
    }

    // Flashlight: on when patrolling or fighting, off when sneaking up.
    actor.flashOn = ai.hasLight && ai.mode !== 'chase' && ai.mode !== 'alert';

    // Jammed against something (a pushed crate, a corner the grid misses):
    // sidestep for a moment and plan the path again.
    if (ai.unstuckT > 0) {
      ai.unstuckT -= dt;
      const side = Math.atan2(move.z, move.x) + (Math.PI / 2) * ai.unstuckDir;
      move = { x: Math.cos(side), z: Math.sin(side) };
    }

    const turnRate = ai.mode === 'attack' ? 7 : 3.4;
    actor.ang = turnTowards(actor.ang, wantAng, turnRate * dt);
    const wantsToMove = move.x !== 0 || move.z !== 0;
    const fromX = actor.x;
    const fromZ = actor.z;
    this.moveActor(actor, move.x, move.z, dt);
    const progress = Math.hypot(actor.x - fromX, actor.z - fromZ) / dt;
    ai.stuckT = wantsToMove && progress < 0.5 ? ai.stuckT + dt : 0;
    if (ai.stuckT > 1.2) {
      ai.stuckT = 0;
      ai.unstuckT = 0.6;
      ai.unstuckDir = this.rng.next() < 0.5 ? 1 : -1;
      ai.path.length = 0;
      ai.pathTimer = 0;
      ai.repathTimer = 0;
    }
  }

  // -------------------------------------------------------------- grenades

  private throwGrenade(actor: Actor, aim: number, distance: number, kind: GrenadeKind): void {
    const G = CONFIG.grenade;
    if (actor.grenadeCd > 0) return;
    if (kind === 'frag') {
      if (actor.grenades <= 0) return;
      actor.grenades--;
    } else if (kind === 'smoke') {
      if (actor.smokes <= 0) return;
      actor.smokes--;
    } else {
      if (actor.flashes <= 0) return;
      actor.flashes--;
    }
    actor.grenadeCd = G.cooldown;
    actor.shield = 0;
    const d = clamp(distance, G.minDist, G.maxDist);
    // Flight time to the floor from hand height, then the speed that covers d.
    const h = 1.4;
    const t = (G.lift + Math.sqrt(G.lift * G.lift + 2 * G.gravity * h)) / G.gravity;
    const v = d / t;
    const g: Grenade = {
      id: this.nextGrenadeId++,
      kind,
      ownerId: actor.id,
      x: actor.x + Math.cos(aim) * 0.6,
      y: h,
      z: actor.z + Math.sin(aim) * 0.6,
      vx: Math.cos(aim) * v + actor.vx * 0.3,
      vy: G.lift,
      vz: Math.sin(aim) * v + actor.vz * 0.3,
      fuse: kind === 'smoke' ? CONFIG.smoke.fuse : kind === 'flash' ? CONFIG.flash.fuse : G.fuse,
    };
    this.grenades.push(g);
    this.noises.push({ x: actor.x, z: actor.z, radius: 8, time: this.time, ownerId: actor.id });
    this.events.push({ type: 'throw', ownerId: actor.id, x: g.x, z: g.z });
  }

  private updateGrenades(dt: number): void {
    const G = CONFIG.grenade;
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.fuse -= dt;
      if (g.fuse <= 0) {
        this.grenades.splice(i, 1);
        if (g.kind === 'smoke') this.popSmoke(g);
        else if (g.kind === 'flash') this.flashBang(g);
        else this.explode(g.x, g.z, G.radius, G.damage, g.ownerId);
        continue;
      }
      g.vy -= G.gravity * dt;
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      g.z += g.vz * dt;
      if (g.y < 0.12) {
        g.y = 0.12;
        g.vy = Math.abs(g.vy) * 0.35;
        g.vx *= 0.6;
        g.vz *= 0.6;
        if (g.vy < 0.6) g.vy = 0;
      }
      // Bounce off walls, closed doors and anchored props (below their tops).
      const r = 0.12;
      const near = this.world.query(g.x - r, g.z - r, g.x + r, g.z + r, this.scratch);
      const bodies: StaticBody[] = [...near];
      for (const d of this.world.doors) if (!d.open) bodies.push(d);
      for (const p of this.props) if (p.alive && p.fixed && g.y < 1.4) bodies.push({ cx: p.x, cz: p.z, hw: p.hw, hh: p.hh });
      for (const b of bodies) {
        const ox = b.hw + r - Math.abs(g.x - b.cx);
        const oz = b.hh + r - Math.abs(g.z - b.cz);
        if (ox <= 0 || oz <= 0) continue;
        if (ox < oz) {
          g.x += ox * Math.sign(g.x - b.cx || 1);
          g.vx = -g.vx * G.bounce;
        } else {
          g.z += oz * Math.sign(g.z - b.cz || 1);
          g.vz = -g.vz * G.bounce;
        }
      }
    }
  }

  private popSmoke(g: Grenade): void {
    this.smokes.push({ id: this.nextGrenadeId++, x: g.x, z: g.z, age: 0 });
    this.noises.push({ x: g.x, z: g.z, radius: 6, time: this.time, ownerId: g.ownerId });
    this.events.push({ type: 'smoke', x: g.x, z: g.z, ownerId: g.ownerId });
  }

  /**
   * Everyone with a clear line to the flash is blinded: longest up close and
   * looking at it, a fraction when it goes off behind them. Guards also lose
   * track of their target.
   */
  private flashBang(g: Grenade): void {
    const F = CONFIG.flash;
    for (const a of this.actors.values()) {
      if (!a.alive) continue;
      const d = dist(a.x, a.z, g.x, g.z);
      if (d > F.radius) continue;
      if (!this.world.lineOfSight(g.x, g.z, a.x, a.z, this.scratch)) continue;
      const facing = Math.cos(Math.atan2(g.z - a.z, g.x - a.x) - a.ang);
      const look = F.behind + (1 - F.behind) * clamp((facing + 0.2) / 1.2, 0, 1);
      const amp = a.buffs.nv > 0 ? CONFIG.powerups.nvBlindMul : 1;
      a.blind = Math.max(a.blind, F.maxBlind * (1 - (d / F.radius) * 0.6) * look * amp);
      if (a.ai) a.ai.awareness = 0;
    }
    this.noises.push({ x: g.x, z: g.z, radius: 22, time: this.time, ownerId: g.ownerId });
    this.events.push({ type: 'flash', x: g.x, z: g.z, ownerId: g.ownerId });
  }

  private updateSmokes(dt: number): void {
    for (const s of this.smokes) s.age += dt;
    this.smokes = this.smokes.filter((s) => s.age < CONFIG.smoke.life);
  }

  /** True when the segment passes through a smoke cloud. */
  smokeBlocks(x0: number, z0: number, x1: number, z1: number): boolean {
    for (const s of this.smokes) {
      if (segCircleHit(x0, z0, x1, z1, s.x, s.z, smokeRadius(s.age) * 0.9) !== null) return true;
    }
    return false;
  }

  /** Client: smoke clouds from a snapshot. */
  syncSmokes(smokes: SmokeCloud[]): void {
    this.smokes = smokes;
  }

  // ------------------------------------------------------------ economy

  /** Competitive buy window: the first seconds of a round. */
  get canBuy(): boolean {
    return this.rounds && this.roundAge < CONFIG.comp.buyTime && this.roundPhase !== 'end';
  }

  get frozen(): boolean {
    return this.rounds && this.roundPhase === 'freeze';
  }

  buy(actor: Actor, item: ShopItem): boolean {
    if (!this.canBuy || !actor.alive) return false;
    const entry = SHOP.find((e) => e.item === item);
    if (!entry || actor.money < entry.price) return false;
    if (item === 'armor') {
      if (actor.armor >= CONFIG.powerups.maxArmor) return false;
      actor.armor = CONFIG.powerups.maxArmor;
    } else if (item === 'grenade') {
      if (actor.grenades >= CONFIG.grenade.max) return false;
      actor.grenades++;
    } else if (item === 'smoke') {
      if (actor.smokes >= CONFIG.grenade.maxUtility) return false;
      actor.smokes++;
    } else if (item === 'flash') {
      if (actor.flashes >= CONFIG.grenade.maxUtility) return false;
      actor.flashes++;
    } else {
      if (actor.weapons.includes(item)) return false;
      this.equip(actor, item);
    }
    actor.money -= entry.price;
    this.events.push({ type: 'buy', ownerId: actor.id, text: item });
    return true;
  }

  /** Bots shop at round start: the best gun they can afford, then extras. */
  private botShopping(bot: Actor): void {
    const rnd = this.rng.next();
    const guns: ShopItem[] = rnd < 0.2 ? ['sniper', 'rifle', 'smg'] : rnd < 0.5 ? ['rifle', 'shotgun', 'smg'] : ['rifle', 'smg', 'shotgun'];
    if (!bot.weapons.some((w) => w !== 'pistol')) {
      for (const g of guns) if (this.buy(bot, g)) break;
    }
    if (bot.money >= 650) this.buy(bot, 'armor');
    if (bot.money >= 300 && this.rng.next() < 0.6) this.buy(bot, 'grenade');
  }

  /**
   * Direction to walk toward a goal: straight when the way is clear,
   * otherwise along a nav-grid path (re-planned when the goal moves).
   */
  private steer(actor: Actor, gx: number, gz: number, arrive: number): { x: number; z: number } {
    const ai = actor.ai!;
    const d = dist(actor.x, actor.z, gx, gz);
    if (d < arrive) return { x: 0, z: 0 };
    // Straight at it only when neither walls nor anchored props are in the way
    // (props are not walls: walking into a car would stall the bot for good).
    if (d < 10 && this.bodyClear(actor, gx, gz) && !this.propInWay(actor, gx, gz)) {
      ai.path.length = 0;
      return { x: (gx - actor.x) / d, z: (gz - actor.z) / d };
    }
    const stale = dist(ai.pathGoalX, ai.pathGoalZ, gx, gz) > 2 || ai.pathIndex >= ai.path.length;
    // An empty path is planned at once: waiting out the timer would leave the
    // bot standing (e.g. right after a straight run that got blocked).
    if (stale && (ai.pathTimer <= 0 || ai.path.length === 0)) {
      // No grid path (the bot squeezed through a gap narrower than the grid's
      // margin): head straight for it; the jam check sidesteps if it bumps.
      ai.path = this.nav.find(actor.x, actor.z, gx, gz) ?? [{ x: gx, z: gz }];
      ai.pathIndex = 0;
      ai.pathGoalX = gx;
      ai.pathGoalZ = gz;
      ai.pathTimer = 0.6 + this.rng.next() * 0.4;
    }
    while (ai.pathIndex < ai.path.length) {
      const wp = ai.path[ai.pathIndex];
      const wd = dist(actor.x, actor.z, wp.x, wp.z);
      if (wd < 0.6) {
        ai.pathIndex++;
        continue;
      }
      return { x: (wp.x - actor.x) / wd, z: (wp.z - actor.z) / wd };
    }
    return { x: 0, z: 0 };
  }

  /** A straight walk is clear for the whole body: centre line and both edges. */
  private bodyClear(actor: Actor, gx: number, gz: number): boolean {
    const d = dist(actor.x, actor.z, gx, gz) || 1;
    const nx = (-(gz - actor.z) / d) * actor.radius;
    const nz = ((gx - actor.x) / d) * actor.radius;
    return (
      this.world.lineOfSight(actor.x, actor.z, gx, gz, this.scratch) &&
      this.world.lineOfSight(actor.x + nx, actor.z + nz, gx + nx, gz + nz, this.scratch) &&
      this.world.lineOfSight(actor.x - nx, actor.z - nz, gx - nx, gz - nz, this.scratch)
    );
  }

  /** An anchored prop on the straight line from the actor to a point (sampled every 0.4 m). */
  private propInWay(actor: Actor, gx: number, gz: number): boolean {
    const d = dist(actor.x, actor.z, gx, gz);
    const steps = Math.ceil(d / 0.4);
    const r = actor.radius;
    for (const p of this.props) {
      if (!p.alive || !p.fixed) continue;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = actor.x + (gx - actor.x) * t;
        const z = actor.z + (gz - actor.z) * t;
        if (Math.abs(x - p.x) < p.hw + r && Math.abs(z - p.z) < p.hh + r) return true;
      }
    }
    return false;
  }

  private pickPatrolTarget(actor: Actor): { x: number; z: number } {
    // Waves: guards sweep toward the squad, a little off target.
    if (this.mode === 'waves') {
      const squad = [...this.actors.values()].filter((a) => a.kind === 'player' && a.alive);
      const p = squad[this.rng.int(0, Math.max(0, squad.length - 1))];
      if (p) return { x: p.x + this.rng.range(-6, 6), z: p.z + this.rng.range(-6, 6) };
    }
    // Bomb: attackers go for the bomb (or escort / guard it), defenders hold
    // the sites until it is planted, then converge on it.
    if (this.mode === 'bomb' && actor.team >= 0) {
      const bomb = this.bomb;
      const jitter = () => ({ x: this.rng.range(-4, 4), z: this.rng.range(-4, 4) });
      if (actor.team === 0) {
        if (!bomb) return this.sites[this.bombGoal];
        if (bomb.carrier === actor.id) return this.sites[this.bombGoal];
        const carrier = this.actors.get(bomb.carrier);
        const at = carrier ?? bomb;
        const j = jitter();
        return bomb.carrier < 0 && !bomb.planted ? { x: bomb.x, z: bomb.z } : { x: at.x + j.x, z: at.z + j.z };
      }
      if (bomb?.planted) return { x: bomb.x, z: bomb.z };
      const site = this.sites[actor.id % 2];
      const j = jitter();
      return { x: site.x + j.x, z: site.z + j.z };
    }
    // Capture the flag: carriers run home, attackers go for the enemy flag,
    // defenders hold their own (and chase whoever took it).
    if (this.mode === 'ctf' && actor.team >= 0) {
      if (actor.carrying >= 0) return this.bases[actor.team];
      const enemyFlag = this.flags[1 - actor.team];
      const ownFlag = this.flags[actor.team];
      if (ownFlag.carrier >= 0 || !ownFlag.home) return { x: ownFlag.x, z: ownFlag.z };
      // Two in three go on the attack; the rest hold the base.
      const attacker = actor.id % 3 !== 0;
      if (attacker && enemyFlag.carrier < 0) return { x: enemyFlag.x, z: enemyFlag.z };
      // A teammate has it: attackers escort the carrier home.
      const carrier = this.actors.get(enemyFlag.carrier);
      if (attacker && carrier) return { x: carrier.x + this.rng.range(-3, 3), z: carrier.z + this.rng.range(-3, 3) };
      const base = this.bases[actor.team];
      return { x: base.x + this.rng.range(-6, 6), z: base.z + this.rng.range(-6, 6) };
    }
    if (this.mode === 'dm' || this.teams) {
      // Roam between items and spawn points; go for health when hurt.
      if (actor.hp < actor.maxHp * 0.5) {
        const heal = this.powerups
          .filter((p) => p.active && (p.kind === 'medkit' || p.kind === 'armor'))
          .sort((a, b) => dist(actor.x, actor.z, a.x, a.z) - dist(actor.x, actor.z, b.x, b.z))[0];
        if (heal) return heal;
      }
      const spots: { x: number; z: number }[] = [
        ...this.pickups.filter((p) => p.active),
        ...this.powerups.filter((p) => p.active),
        ...this.map.spawns,
      ];
      return spots[this.rng.int(0, spots.length - 1)] ?? { x: actor.x, z: actor.z };
    }
    const room = this.roomFor(actor.x, actor.z) ?? this.map.rooms[0];
    for (let i = 0; i < 6; i++) {
      const x = this.rng.range(room.minX + 1.5, room.maxX - 1.5);
      const z = this.rng.range(room.minZ + 1.5, room.maxZ - 1.5);
      if (this.nav.walkable(x, z)) return { x, z };
    }
    return { x: actor.x, z: actor.z };
  }

  private enemyShoot(actor: Actor, target: Actor): void {
    const def = WEAPONS[actor.weapon];
    const ang = Math.atan2(target.z - actor.z, target.x - actor.x);
    // Accuracy settles in over the first second on target.
    const settle = clamp(0.35 + (actor.ai?.aimT ?? 1) * 0.65, 0.35, 1);
    const accuracy = clamp(0.42 - dist(actor.x, actor.z, target.x, target.z) * 0.02, 0.06, 0.36) * settle;
    const spread = def.spread * (1 + (1 - accuracy) * 10);
    const shotSeq = actor.shotSeq++;
    const srng = new Rng(shotSeed(actor.id, shotSeq, this.map.seed));
    const pellets: { dx: number; dz: number; speed: number }[] = [];
    const id = `e${actor.id}-${shotSeq}`;
    for (let i = 0; i < def.pellets; i++) {
      const shotAng = ang + (srng.next() - 0.5) * 2 * spread;
      const dirX = Math.cos(shotAng);
      const dirZ = Math.sin(shotAng);
      pellets.push({ dx: dirX, dz: dirZ, speed: def.bulletSpeed });
      this.bullets.push(this.makeBullet(actor, def.pellets > 1 ? `${id}-${i}` : id, dirX, dirZ, def.bulletSpeed, 0.9));
    }
    actor.ammo--;
    actor.cooldown = weaponCooldown(def) * 1.9 * (actor.buffs.rapid > 0 ? CONFIG.powerups.rapidMul : 1);
    actor.recoil = Math.min(0.5, actor.recoil + def.recoil);
    actor.shield = 0;
    actor.revealT = CONFIG.bush.revealAfterShot;

    this.noises.push({ x: actor.x, z: actor.z, radius: def.noise, time: this.time, ownerId: actor.id });
    this.events.push({
      type: 'shot',
      id,
      ownerId: actor.id,
      shotSeq,
      x: actor.x + pellets[0].dx * 0.9,
      z: actor.z + pellets[0].dz * 0.9,
      dirX: Math.cos(ang),
      dirZ: Math.sin(ang),
      pellets,
      weapon: actor.weapon,
    });
  }

  // ------------------------------------------------------------- spawning

  /** Lowest danger first: far from hostiles and out of their line of sight. */
  private spawnScore(x: number, z: number, self: Actor | null): number {
    let minD = 60;
    let seen = 0;
    for (const a of this.actors.values()) {
      if (!a.alive || a === self) continue;
      const hostile = this.arena || a.kind === 'enemy';
      if (!hostile) continue;
      const d = dist(a.x, a.z, x, z);
      minD = Math.min(minD, d);
      if (d < 30 && this.world.lineOfSight(a.x, a.z, x, z, this.scratch)) seen++;
    }
    return minD - seen * 25;
  }

  /** Deathmatch spawn point: the safest of the arena's spawns. */
  private pickSpawn(self: Actor | null, team = self?.team ?? -1): { x: number; z: number } {
    let spawns = this.map.spawns.length > 0 ? this.map.spawns : [{ x: this.map.spawnX, z: this.map.spawnZ }];
    if (team >= 0) {
      const own = spawns.filter((s) => this.sideOf(s.x) === team);
      if (own.length > 0) spawns = own;
    }
    let best = spawns[0];
    let bestScore = -Infinity;
    for (const s of spawns) {
      const score = this.spawnScore(s.x, s.z, self) + this.rng.next() * 3;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  /**
   * Co-op respawn: next to a living teammate if one is safe, otherwise the
   * safest walkable spot in the current room or the cleared one before it.
   */
  findSafeSpawn(self: Actor | null): { x: number; z: number } {
    const candidates: { x: number; z: number }[] = [];
    for (const a of this.actors.values()) {
      if (a.kind !== 'player' || !a.alive || a === self) continue;
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2;
        candidates.push({ x: a.x + Math.cos(ang) * 2, z: a.z + Math.sin(ang) * 2 });
      }
    }
    // Arenas have no rooms: their spawn points are the fallback.
    if (this.arena) candidates.push(...this.map.spawns);
    const rooms = [this.map.rooms[this.roomIndex], this.map.rooms[this.roomIndex - 1]].filter(Boolean) as RoomDef[];
    for (const room of rooms) {
      for (let x = room.minX + 1.5; x < room.maxX - 1; x += 2.5) {
        for (let z = room.minZ + 1.5; z < room.maxZ - 1; z += 2.5) candidates.push({ x, z });
      }
    }
    let best = { x: this.map.spawnX, z: this.map.spawnZ };
    let bestScore = -Infinity;
    for (const c of candidates) {
      if (!this.nav.walkable(c.x, c.z)) continue;
      if (this.props.some((p) => p.alive && Math.abs(p.x - c.x) < p.hw + 0.7 && Math.abs(p.z - c.z) < p.hh + 0.7)) continue;
      const score = this.spawnScore(c.x, c.z, self);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  private respawn(actor: Actor): void {
    const at = this.arena ? this.pickSpawn(actor) : this.findSafeSpawn(actor);
    actor.alive = true;
    actor.x = at.x;
    actor.z = at.z;
    actor.vx = 0;
    actor.vz = 0;
    actor.armor = 0;
    actor.buffs.damage = actor.buffs.speed = actor.buffs.rapid = actor.buffs.nv = 0;
    actor.carrying = -1;
    if (this.arena) {
      actor.hp = actor.maxHp;
      actor.weapons = this.mode === 'gun' ? [] : ['pistol'];
      this.equip(actor, this.startWeapon(actor));
      actor.grenades = Math.max(actor.grenades, CONFIG.grenade.startArena);
      if (actor.kind === 'player' && !this.rounds) {
        actor.smokes = Math.max(actor.smokes, CONFIG.grenade.startUtility);
        actor.flashes = Math.max(actor.flashes, CONFIG.grenade.startUtility);
      }
      actor.blind = 0;
      actor.shield = this.rounds ? 0 : CONFIG.dm.spawnShield;
      if (actor.ai) Object.assign(actor.ai, makeAi(), { hasLight: true });
    } else {
      actor.hp = actor.maxHp * 0.7;
      actor.ammo = WEAPONS[actor.weapon].mag;
      actor.reloading = false;
      actor.shield = 1.5;
    }
    this.events.push({ type: 'respawn', ownerId: actor.id, x: actor.x, z: actor.z });
  }

  // --------------------------------------------------------------- modes

  roomFor(x: number, z: number): RoomDef | null {
    for (const r of this.map.rooms) {
      if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return r;
    }
    return null;
  }

  private updateRoomProgress(): void {
    if (this.roomPhase === 'done') return;

    // Advance the active room when any living player steps into the next one.
    let deepest = this.roomIndex;
    for (const actor of this.actors.values()) {
      if (actor.kind !== 'player' || !actor.alive) continue;
      const r = this.roomFor(actor.x, actor.z);
      if (r && r.index > deepest) deepest = r.index;
    }

    if (deepest > this.roomIndex) {
      this.roomIndex = deepest;
      this.roomPhase = 'fighting';
      // Normally already done when the door opened; covers skipping a room.
      this.populateRoom(deepest);
      this.events.push({ type: 'roomEnter', text: String(this.roomIndex + 1) });
    }

    // The start room has no guards; give the squad a moment before the door opens.
    if (this.roomIndex === 0 && this.time < 1.5) return;

    let enemies = 0;
    for (const a of this.actors.values()) if (a.kind === 'enemy' && a.alive) enemies++;
    if (this.roomPhase === 'fighting' && enemies === 0) {
      // The door that leaves room N is the one stored on room N+1.
      const nextRoom = this.map.rooms[this.roomIndex + 1];
      const door = this.doors.find((d) => d.room === this.roomIndex + 1);
      if (door) {
        door.open = true;
        door.openT = 0;
        // Collision reads the body flag; without it the door stays solid.
        door.body.open = true;
      }
      // Guards are in place as the door opens, so the squad sees an
      // occupied room instead of soldiers popping in on the threshold.
      if (nextRoom) this.populateRoom(nextRoom.index);
      this.roomPhase = nextRoom ? 'cleared' : 'done';
      this.events.push({ type: 'roomClear', text: String(this.roomIndex + 1) });
      if (!nextRoom) {
        this.events.push({ type: 'victory', text: 'ОБЪЕКТ ЗАЧИЩЕН' });
      }
    }

    for (const d of this.doors) {
      if (d.open && d.openT < 1) d.openT = Math.min(1, d.openT + CONFIG.tickDt * 2.2);
    }
  }

  /** Deathmatch / gun game: clock, frag limit, winner. */
  private updateMatch(dt: number): void {
    if (this.matchOver) return;
    this.timeLeft = Math.max(0, this.timeLeft - dt);
    const leader = this.leader();
    if (this.teams) {
      const [blue, red] = this.teamScore;
      const limit = this.mode === 'ctf' ? CONFIG.ctf.capLimit : CONFIG.tdm.scoreLimit;
      if (blue >= limit || red >= limit || this.timeLeft <= 0) {
        const winner = blue === red ? undefined : blue > red ? 0 : 1;
        const text = winner === undefined ? `Ничья ${blue}:${red}` : `${TEAM_NAMES[winner]} победили ${Math.max(blue, red)}:${Math.min(blue, red)}`;
        this.finishTeamMatch(winner, text);
      }
      return;
    }
    const limitHit = this.mode === 'dm' && leader && leader.score.kills >= CONFIG.dm.fragLimit;
    if (limitHit || this.timeLeft <= 0) {
      this.finishMatch(leader?.id, leader ? `${leader.name} — ${leader.score.kills} фрагов` : 'Ничья');
    }
  }

  /**
   * Capture the flag: touch the enemy flag to take it, bring it to your base
   * while your own flag is home to score. A dropped flag goes home when its
   * team touches it, or on its own after a while.
   */
  private updateFlags(dt: number): void {
    if (this.matchOver) return;
    const C = CONFIG.ctf;
    for (const flag of this.flags) {
      const carrier = this.actors.get(flag.carrier);
      if (carrier) {
        flag.x = carrier.x;
        flag.z = carrier.z;
        // Home with the enemy flag, and ours is standing: a capture.
        const own = this.flags[carrier.team];
        const base = this.bases[carrier.team];
        if (own.home && dist(carrier.x, carrier.z, base.x, base.z) < C.touch * 1.5) {
          this.teamScore[carrier.team]++;
          carrier.carrying = -1;
          this.resetFlag(flag);
          this.events.push({ type: 'flag', text: 'captured', team: flag.team, ownerId: carrier.id });
        }
        continue;
      }
      if (!flag.home) {
        flag.dropT += dt;
        if (flag.dropT >= C.returnTime) {
          this.resetFlag(flag);
          this.events.push({ type: 'flag', text: 'returned', team: flag.team });
          continue;
        }
      }
      for (const a of this.actors.values()) {
        if (!a.alive || a.team < 0 || dist(a.x, a.z, flag.x, flag.z) > C.touch) continue;
        if (a.team === flag.team) {
          if (!flag.home) {
            this.resetFlag(flag);
            this.events.push({ type: 'flag', text: 'returned', team: flag.team, ownerId: a.id });
          }
        } else if (a.carrying < 0) {
          flag.carrier = a.id;
          flag.home = false;
          a.carrying = flag.team;
          this.events.push({ type: 'flag', text: 'taken', team: flag.team, ownerId: a.id });
        }
        break;
      }
    }
  }

  private resetFlag(flag: FlagState): void {
    const base = this.bases[flag.team];
    flag.x = base.x;
    flag.z = base.z;
    flag.home = true;
    flag.carrier = -1;
    flag.dropT = 0;
  }

  /** A carrier going down (or leaving) drops the flag where they stand. */
  private dropFlag(actor: Actor): void {
    if (actor.carrying < 0) return;
    const flag = this.flags[actor.carrying];
    actor.carrying = -1;
    if (!flag) return;
    flag.carrier = -1;
    flag.x = actor.x;
    flag.z = actor.z;
    flag.dropT = 0;
    this.events.push({ type: 'flag', text: 'dropped', team: flag.team, ownerId: actor.id });
  }

  /** Client: flags from a snapshot. */
  syncFlags(flags: FlagState[]): void {
    this.flags = flags;
  }

  /**
   * Waves: a calm break, then a wave of guards that hunt the squad. Clearing
   * it brings the fallen back; losing everyone at once ends the run.
   */
  private updateWaves(dt: number): void {
    if (this.matchOver) return;
    const players = [...this.actors.values()].filter((a) => a.kind === 'player');
    if (this.wavePhase === 'break') {
      this.waveT -= dt;
      if (this.waveT <= 0) {
        this.wave++;
        this.wavePhase = 'fight';
        this.spawnWave();
        this.events.push({ type: 'wave', text: 'start', id: String(this.wave) });
      }
      return;
    }
    if (players.length > 0 && players.every((p) => !p.alive)) {
      this.matchOver = true;
      const held = this.wave - 1;
      this.events.push({ type: 'gameOver', text: `Отряд погиб на волне ${this.wave} · отбито волн: ${held}` });
      return;
    }
    const left = [...this.actors.values()].some((a) => a.kind === 'enemy' && a.alive);
    if (left) return;
    this.wavePhase = 'break';
    this.waveT = CONFIG.waves.breakTime;
    for (const p of players) if (!p.alive) this.revive(p);
    this.events.push({ type: 'wave', text: 'clear', id: String(this.wave) });
  }

  /** Waves: guards enter at the spawn points farthest from the squad. */
  private spawnWave(): void {
    const W = CONFIG.waves;
    const count = Math.min(W.max, W.base + W.perWave * (this.wave - 1));
    const squad = [...this.actors.values()].filter((a) => a.kind === 'player' && a.alive);
    const away = (s: { x: number; z: number }) => Math.min(...squad.map((p) => dist(p.x, p.z, s.x, s.z)), 1e6);
    const spots = [...this.map.spawns].sort((a, b) => away(b) - away(a)).slice(0, Math.max(2, Math.ceil(this.map.spawns.length / 2)));
    const armed = Math.min(ENEMY_WEAPONS.length - 1, Math.floor((this.wave - 1) / 2));
    for (let i = 0; i < count; i++) {
      const at = spots[i % spots.length];
      const id = this.nextActorId++;
      const x = at.x + this.rng.range(-1, 1);
      const z = at.z + this.rng.range(-1, 1);
      const guard = this.newActor(id, 'enemy', BOT_NAMES[(id - ENEMY_ID_BASE) % BOT_NAMES.length], x, z);
      guard.maxHp = guard.hp = Math.round(CONFIG.enemy.maxHp * (1 + W.hpGrowth * (this.wave - 1)));
      this.equip(guard, ENEMY_WEAPONS[this.rng.int(0, armed)]);
      guard.ai!.hasLight = this.rng.next() < 0.5;
      guard.flashOn = guard.ai!.hasLight;
      guard.grenades = this.wave >= 3 && this.rng.next() < 0.3 ? 1 : 0;
      // They come looking: straight for where the squad was last heard.
      const target = squad[this.rng.int(0, Math.max(0, squad.length - 1))];
      if (target) {
        guard.ai!.mode = 'alert';
        guard.ai!.lastKnownX = target.x;
        guard.ai!.lastKnownZ = target.z;
        guard.ai!.timer = 8;
      }
      this.actors.set(id, guard);
      this.scores.set(id, { kills: 0, deaths: 0, rounds: 0 });
    }
  }

  /** Waves: a fallen player stands up again, keeping what they carried. */
  private revive(actor: Actor): void {
    const at = this.findSafeSpawn(actor);
    actor.alive = true;
    actor.x = at.x;
    actor.z = at.z;
    actor.vx = actor.vz = 0;
    actor.hp = actor.maxHp;
    actor.blind = 0;
    actor.ammo = WEAPONS[actor.weapon].mag;
    actor.reloading = false;
    actor.shield = CONFIG.dm.spawnShield;
    actor.respawnT = 0;
    this.events.push({ type: 'respawn', ownerId: actor.id, x: actor.x, z: actor.z });
  }

  private finishTeamMatch(team: number | undefined, text: string): void {
    if (this.matchOver) return;
    this.matchOver = true;
    this.events.push({ type: 'victory', team: team ?? -1, text });
  }

  private finishMatch(winner: number | undefined, text: string): void {
    if (this.matchOver) return;
    this.matchOver = true;
    this.events.push({ type: 'victory', ownerId: winner, text });
  }

  /**
   * Competitive rounds: freeze (shop, no moving) -> live until one fighter
   * is left or time runs out -> short end screen -> next round. Survivors
   * keep their gear; the dead start the next round with a pistol.
   */
  private updateRounds(dt: number): void {
    if (this.matchOver) return;
    const C = CONFIG.comp;
    this.roundT -= dt;
    this.roundAge += dt;
    if (this.roundPhase === 'freeze') {
      if (this.roundT <= 0) {
        this.roundPhase = 'live';
        this.roundT = this.mode === 'bomb' ? CONFIG.bomb.roundTime : C.roundTime;
        if (this.mode === 'bomb') this.handOutBomb();
        this.events.push({ type: 'round', text: 'live' });
      }
      return;
    }
    if (this.roundPhase === 'live' && this.mode === 'bomb') {
      this.updateBomb(dt);
      return;
    }
    if (this.roundPhase === 'live') {
      const alive = [...this.actors.values()].filter((a) => a.alive);
      if (alive.length <= 1 || this.roundT <= 0) {
        // Winner: the last one standing (or, on time, the healthiest survivor).
        const winner = alive.sort((a, b) => b.hp - a.hp)[0];
        for (const a of this.actors.values()) {
          const bonus = a === winner ? C.roundWinBonus : C.roundLossBonus;
          a.money = Math.min(C.maxMoney, a.money + bonus);
        }
        const score = winner ? this.scores.get(winner.id) : undefined;
        if (score) score.rounds++;
        this.roundPhase = 'end';
        this.roundT = C.endDelay;
        this.events.push({ type: 'round', ownerId: winner?.id, text: 'end' });
        const best = this.roundLeader();
        if ((best && best.rounds >= C.roundsToWin) || this.round >= C.maxRounds) {
          this.finishMatch(best?.id, best ? `${best.name} — ${best.rounds} раунд(ов)` : 'Ничья');
        }
      }
      return;
    }
    if (this.roundT <= 0) this.startRound();
  }

  /** Bomb: one attacker (a human if any) starts the round with it. */
  private handOutBomb(): void {
    const attackers = [...this.actors.values()].filter((a) => a.alive && a.team === 0);
    const humans = attackers.filter((a) => a.kind === 'player');
    const pool = humans.length > 0 ? humans : attackers;
    const carrier = pool[this.rng.int(0, Math.max(0, pool.length - 1))];
    this.bombGoal = this.rng.int(0, 1);
    this.bomb = carrier
      ? { x: carrier.x, z: carrier.z, carrier: carrier.id, planted: false, timer: 0, site: -1 }
      : null;
  }

  /**
   * Bomb round: the carrier plants by holding use on a site, defenders
   * defuse by holding use at the bomb. The round ends on a blast, a defuse,
   * a wiped-out side or (before a plant) the clock.
   */
  private updateBomb(dt: number): void {
    const B = CONFIG.bomb;
    const alive = [...this.actors.values()].filter((a) => a.alive);
    const attackers = alive.filter((a) => a.team === 0);
    const defenders = alive.filter((a) => a.team === 1);
    const bomb = this.bomb;
    for (const a of this.actors.values()) if (!a.using || !a.alive) a.useT = 0;

    if (bomb && !bomb.planted) {
      const carrier = this.actors.get(bomb.carrier);
      if (carrier?.alive) {
        bomb.x = carrier.x;
        bomb.z = carrier.z;
        const site = this.sites.findIndex((s) => dist(s.x, s.z, carrier.x, carrier.z) < B.siteRadius);
        const still = Math.hypot(carrier.vx, carrier.vz) < 1;
        if (carrier.using && site >= 0 && still) {
          carrier.useT += dt;
          if (carrier.useT >= B.plantTime) {
            carrier.useT = 0;
            bomb.planted = true;
            bomb.carrier = -1;
            bomb.timer = B.timer;
            bomb.site = site;
            this.noises.push({ x: bomb.x, z: bomb.z, radius: 16, time: this.time, ownerId: carrier.id });
            this.events.push({ type: 'bomb', text: 'planted', ownerId: carrier.id, x: bomb.x, z: bomb.z, id: String(site) });
          }
        } else {
          carrier.useT = 0;
        }
      } else if (bomb.carrier < 0) {
        // Lying on the floor: the first attacker to touch it picks it up.
        const finder = attackers.find((a) => dist(a.x, a.z, bomb.x, bomb.z) < CONFIG.ctf.touch);
        if (finder) {
          bomb.carrier = finder.id;
          this.events.push({ type: 'bomb', text: 'picked', ownerId: finder.id });
        }
      }
    }

    if (bomb?.planted) {
      bomb.timer -= dt;
      for (const d of defenders) {
        if (!d.using || dist(d.x, d.z, bomb.x, bomb.z) > B.defuseReach) continue;
        d.useT += dt;
        if (d.useT >= B.defuseTime) {
          this.events.push({ type: 'bomb', text: 'defused', ownerId: d.id, x: bomb.x, z: bomb.z });
          this.bomb = null;
          this.endTeamRound(1, 'Бомба обезврежена');
          return;
        }
      }
      if (bomb.timer <= 0) {
        this.events.push({ type: 'explosion', x: bomb.x, z: bomb.z, y: 1 });
        this.events.push({ type: 'bomb', text: 'exploded', x: bomb.x, z: bomb.z });
        for (const a of this.actors.values()) {
          if (!a.alive || dist(a.x, a.z, bomb.x, bomb.z) > B.blastRadius) continue;
          a.shield = 0;
          a.armor = 0;
          this.damageActor(a, 9999, a.id);
        }
        this.bomb = null;
        this.endTeamRound(0, 'Бомба взорвалась');
        return;
      }
    }

    if (defenders.length === 0) this.endTeamRound(0, 'Защита уничтожена');
    else if (!bomb?.planted && attackers.length === 0) this.endTeamRound(1, 'Атака уничтожена');
    else if (!bomb?.planted && this.roundT <= 0) this.endTeamRound(1, 'Время вышло — бомба не заложена');
  }

  /** Team round over: score, team money, then the next round or the match. */
  private endTeamRound(winner: number, reason: string): void {
    const C = CONFIG.comp;
    this.teamScore[winner]++;
    for (const a of this.actors.values()) {
      if (a.team < 0) continue;
      const bonus = a.team === winner ? C.roundWinBonus : C.roundLossBonus;
      a.money = Math.min(C.maxMoney, a.money + bonus);
      a.useT = 0;
    }
    this.roundPhase = 'end';
    this.roundT = C.endDelay;
    this.events.push({ type: 'round', team: winner, text: 'end', id: reason });
    const [blue, red] = this.teamScore;
    if (Math.max(blue, red) >= C.roundsToWin || this.round >= C.maxRounds) {
      const best = blue === red ? undefined : blue > red ? 0 : 1;
      this.finishTeamMatch(best, best === undefined ? `Ничья ${blue}:${red}` : `${TEAM_NAMES[best]} победили ${Math.max(blue, red)}:${Math.min(blue, red)}`);
    }
  }

  /** Bomb: a carrier going down drops it where they fall. */
  private dropBomb(actor: Actor): void {
    const bomb = this.bomb;
    if (!bomb || bomb.planted || bomb.carrier !== actor.id) return;
    bomb.carrier = -1;
    bomb.x = actor.x;
    bomb.z = actor.z;
    this.events.push({ type: 'bomb', text: 'dropped', ownerId: actor.id, x: bomb.x, z: bomb.z });
  }

  /** Client: bomb from a snapshot. */
  syncBomb(bomb: BombState | null): void {
    this.bomb = bomb;
  }

  private roundLeader(): { id: number; name: string; rounds: number } | null {
    let best: { id: number; name: string; rounds: number } | null = null;
    for (const [id, s] of this.scores) {
      const a = this.actors.get(id);
      if (a && (!best || s.rounds > best.rounds)) best = { id, name: a.name, rounds: s.rounds };
    }
    return best;
  }

  private startRound(): void {
    this.round++;
    this.roundPhase = 'freeze';
    this.roundT = CONFIG.comp.freezeTime;
    this.roundAge = 0;
    this.bullets = [];
    this.grenades = [];
    this.smokes = [];
    // Spread everyone over the spawn points; survivors keep their kit.
    const spawns = [...this.map.spawns];
    for (let i = spawns.length - 1; i > 0; i--) {
      const j = this.rng.int(0, i);
      [spawns[i], spawns[j]] = [spawns[j], spawns[i]];
    }
    let k = 0;
    // Team rounds: each side starts on its own half.
    const sideK = [0, 0];
    const sides = [0, 1].map((t) => spawns.filter((s) => this.sideOf(s.x) === t));
    this.bomb = null;
    for (const a of this.actors.values()) {
      const own = a.team >= 0 && sides[a.team].length > 0 ? sides[a.team] : null;
      const n = own ? sideK[a.team]++ : k++;
      const pool = own ?? spawns;
      const s = pool[n % pool.length];
      const survived = a.alive;
      a.alive = true;
      a.x = s.x + (n >= pool.length ? 1.2 : 0);
      a.z = s.z;
      a.vx = a.vz = 0;
      a.hp = a.maxHp;
      a.respawnT = 0;
      a.buffs.damage = a.buffs.speed = a.buffs.rapid = a.buffs.nv = 0;
      if (!survived) {
        a.weapons = ['pistol'];
        a.armor = 0;
        a.grenades = 0;
        a.smokes = 0;
        a.flashes = 0;
        this.equip(a, 'pistol');
      } else {
        a.ammo = WEAPONS[a.weapon].mag;
        a.reloading = false;
      }
      if (a.ai) Object.assign(a.ai, makeAi(), { hasLight: true });
    }
    for (const a of this.actors.values()) if (a.ai) this.botShopping(a);
    this.events.push({ type: 'round', text: 'start' });
  }

  leader(): { id: number; name: string; score: Score } | null {
    let best: { id: number; name: string; score: Score } | null = null;
    for (const [id, score] of this.scores) {
      const a = this.actors.get(id);
      if (!a) continue;
      // Gun game ranks by ladder progress first.
      if (this.mode === 'gun' && best) {
        const ba = this.actors.get(best.id)!;
        const pa = a.tier * 10 + a.tierKills;
        const pb = ba.tier * 10 + ba.tierKills;
        if (pa !== pb) {
          if (pa > pb) best = { id, name: a.name, score };
          continue;
        }
      }
      if (!best || score.kills > best.score.kills || (score.kills === best.score.kills && score.deaths < best.score.deaths)) {
        best = { id, name: a.name, score };
      }
    }
    return best;
  }

  isLit(x: number, z: number): boolean {
    return this.map.lamps.some((l, i) => this.lampAlive[i] && dist(x, z, l.x, l.z) < 9.5);
  }

  // ------------------------------------------------------ client mirroring

  /** Applies authoritative prop transforms (used by the client-side mirror). */
  syncProps(states: { id: number; x: number; z: number; alive: boolean }[]): void {
    for (const p of this.props) {
      const s = states.find((x) => x.id === p.id);
      if (!s) continue;
      p.x = s.x;
      p.z = s.z;
      p.alive = s.alive;
      p.vx = 0;
      p.vz = 0;
    }
  }

  /** Applies authoritative door states (used by the client-side mirror). */
  syncDoors(states: { room: number; open: boolean; openT: number }[]): void {
    for (const d of this.doors) {
      const s = states.find((x) => x.room === d.room);
      if (!s) continue;
      d.open = s.open;
      d.openT = s.openT;
      d.body.open = s.open;
    }
  }

  /** Applies authoritative item states (used by the client-side mirror). */
  syncItems(
    pickups: { id: number; weapon: WeaponId; x: number; z: number }[],
    powerups: { id: number; kind: PowerupKind; x: number; z: number; active: boolean }[],
    grenades: Grenade[],
  ): void {
    this.pickups = pickups.map((p) => ({ ...p, room: 0, active: true, respawnT: 0, life: 0 }));
    this.powerups = powerups.map((p) => ({ ...p, room: 0, respawnT: 0, dropped: false }));
    this.grenades = grenades;
  }

  drainEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}

function makeAi(): AiState {
  return {
    mode: 'patrol',
    timer: 0,
    targetX: 0,
    targetZ: 0,
    lastKnownX: 0,
    lastKnownZ: 0,
    repathTimer: 0,
    strafeDir: 1,
    strafeTimer: 0,
    burst: 3,
    fireDelay: 0.8,
    patrolTarget: 0,
    reactT: 0,
    stuckT: 0,
    unstuckT: 0,
    unstuckDir: 1,
    sawTarget: false,
    awareness: 0,
    aimT: 0,
    targetId: -1,
    path: [],
    pathIndex: 0,
    pathGoalX: 0,
    pathGoalZ: 0,
    pathTimer: 0,
    grenadeT: 4,
    hasLight: false,
  };
}

function turnTowards(current: number, target: number, maxDelta: number): number {
  let d = (target - current) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  const step = clamp(d, -maxDelta, maxDelta);
  return current + step;
}
