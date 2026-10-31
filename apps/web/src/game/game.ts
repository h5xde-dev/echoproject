import { GameAudio } from '../core/audio';
import { Input } from '../core/input';
import { clamp } from '@echo/shared/core/math';
import { Net, type NetClientHandlers } from '../net/net';
import { buildSnapshot, roundStateOf, scoreRows, waveStateOf } from '@echo/shared/net/snapshot';
import type { ActorState, EventMsg, HostMessage, LobbyMsg, MatchmakingMsg, RankedMsg, RoundState, SnapshotMsg, WaveState, WelcomeMsg } from '@echo/shared/net/protocol';
import { POWERUP_COLOR, Renderer } from '../render/renderer';
import { buildArena } from '@echo/shared/game/arenas';
import { POWERUP_INFO } from '@echo/shared/game/info';
import { updateBullets, type BulletActor, type BulletCtx } from '@echo/shared/game/bullets';
import { CONFIG, COLORS } from '@echo/shared/game/config';
import { generateMap } from '@echo/shared/game/levelgen';
import { GUN_LADDER, isArena, isCoopMode, isTeamMode, modeInfo, SHOP, TEAM_NAMES } from '@echo/shared/game/modes';
import { NO_ONCE, mergeOnce, type OnceInput } from '@echo/shared/game/once';
import { ARENA_DOOR_BASE, Sim, type PlayerInput } from '@echo/shared/game/sim';
import type { Buffs, Bullet, Difficulty, Drone, EnemyRole, Gait, PlayerClass, GameEvent, GameMode as MatchMode, GrenadeKind, Interactable, MapData, PowerupKind, ShopItem } from '@echo/shared/game/types';
import { projectileLife, WEAPON_ORDER, WEAPONS, type WeaponId } from '@echo/shared/game/weapons';
import type { Hud, HudPlate, HudScore } from '../ui/hud';
import { addMatch, levelOf, loadProgress, type MatchTally } from '../ui/progress';
import { newTally, tallyEvent } from '@echo/shared/progress';

export type GameMode = 'solo' | 'host' | 'client';

export interface MatchOptions {
  mode?: MatchMode;
  /** Arena id (see arenas.ts). */
  arena?: string;
  /** Arena head count including humans (bots fill the rest). */
  fighters?: number;
  difficulty?: Difficulty;
  /** Network room: bots fill the arena (once two or more players are in). Default on. */
  bots?: boolean;
}

export interface DisplayActor {
  id: number;
  kind: 'player' | 'enemy';
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
  smokes: number;
  flashes: number;
  molotovs: number;
  burning: boolean;
  blind: number;
  concealed: boolean;
  team: number;
  carrying: number;
  useT: number;
  crouched: boolean;
  downed: boolean;
  downT: number;
  reviveT: number;
  role: EnemyRole;
  aiming: boolean;
  cls: PlayerClass | null;
  shieldUsed: boolean;
  color: number;
  drones: number;
  piloting: number;
  streak: number;
  strikes: number;
  mines: number;
  flares: number;
  hold: number;
  isLocal: boolean;
  moving: boolean;
}

interface PendingInput {
  seq: number;
  input: PlayerInput;
}

interface SnapFrame {
  time: number;
  actors: Map<number, ActorState>;
}

const PLAYER_COLORS = [COLORS.player, COLORS.player2, 0x8fb6ff, 0xff7ad9];
/** Guard types read at a glance: heavies dark red, snipers orange, scouts violet. */
const ROLE_COLORS: Record<EnemyRole, number> = { grunt: COLORS.enemy, heavy: 0x9a1420, sniper: 0xff8a2a, scout: 0x9a7aff, boss: 0xffd23a };
/** Team modes: blue and red, for humans and bots alike. */
const TEAM_COLORS = [0x4aa8ff, 0xff5a4a];

const POWERUP_TEXT: Record<PowerupKind, string> = {
  medkit: 'Аптечка +' + CONFIG.powerups.medkitHeal,
  armor: 'Броня +' + CONFIG.powerups.armorAmount,
  damage: 'Усиленный урон',
  speed: 'Скорость',
  rapid: 'Скорострельность',
  nv: 'Ночное зрение',
  ammo: 'Боеприпасы',
  regen: 'Регенерация',
  overshield: 'Сверхщит +' + CONFIG.powerups.overshield,
  stealth: 'Маскировка',
  radar: 'Радар: враги на карте',
  drone: 'FPV-дрон +1 — запуск на X',
};

/** Error below this is smoothed out; above it the player snaps (teleport). */
const SNAP_DISTANCE = 2.5;

export class Game {
  readonly renderer: Renderer;
  readonly input = new Input();
  readonly audio = new GameAudio();
  readonly net = new Net();

  mode: GameMode = 'solo';
  matchMode: MatchMode = 'coop';
  isAuthority = true;
  localId = 1;
  localName = 'оператор';
  map!: MapData;
  sim!: Sim;
  roomCode = '';

  private hud: Hud;
  private running = false;
  /** The pause overlay is up: the world is frozen. */
  private paused = false;
  private lastTime = 0;
  private accumulator = 0;
  private tick = 0;
  private inputSeq = 0;
  private arena = 'sklad';

  private display = new Map<number, DisplayActor>();
  private clientBullets: Bullet[] = [];
  private latestActors = new Map<number, ActorState>();
  private snapBuffer: SnapFrame[] = [];
  private pendingInputs: PendingInput[] = [];
  private clientInputs = new Map<string, { input: PlayerInput; once: OnceInput; lastAck: number }>();
  /** This player's class (set from the menu before a game starts). */
  playerClass: PlayerClass = 'assault';
  /** Host: each client's class, kept for a match restart from the lobby. */
  private clientClasses = new Map<number, PlayerClass | null>();
  private clientColors = new Map<number, number>();
  /** This player's ring colour (an unlocked one; -1 the default). */
  playerColor = -1;
  /** What the local player did this match, for experience at the end. */
  private tally: MatchTally = { kills: 0, objectives: 0, revives: 0, rooms: 0, waves: 0 };
  /** Client: last measured round trip to the host (ms). */
  private rttMs = 0;
  /** Client: the room code joined, reused to reconnect. */
  private joinCode = '';
  private reconnecting = false;
  private clientNames = new Map<number, string>();
  private frameMove = { x: 0, z: 0 };
  /** Shift walks, C crouches (crouch wins when both are held). */
  private frameGait: Gait = 'run';
  /** Grenade G throws; Q cycles through the kinds. */
  private nadeKind: GrenadeKind = 'frag';
  private frameAim = 0;
  private frameFire = false;
  private pending = {
    reload: false,
    interact: false,
    flashlight: false,
    slot: -1,
    grenade: false,
    buy: '' as ShopItem | '',
    mark: null as { x: number; z: number } | null,
    deploy: false,
    drone: false,
    strike: false,
    mine: false,
  };
  /** Minimap: recent noises of unseen enemies and team markers (ms timestamps). */
  private noiseBlips: { x: number; z: number; at: number }[] = [];
  private markBlips: { x: number; z: number; at: number }[] = [];
  private frameThrow = 10;
  /** Client: when the last snapshot's drones arrived (they are drawn a little ahead). */
  private droneSyncAt = 0;
  private droneBuzzT = 0;
  private buyOpen = false;
  private gameOver = false;
  /** Host of a room: the warm-up lobby (null for solo games and clients). */
  private lobby: { started: boolean; ready: Map<number, boolean> } | null = null;
  private matchOpts: MatchOptions = {};
  private lastFootstep = 0;
  private enemyCount = 0;
  private scores: [number, number, number, number][] = [];
  private timeLeft = 0;
  /** Client: team kills from the last snapshot. */
  private teamScore: [number, number] = [0, 0];
  /** Spectating after death: who killed us and when (ms). */
  private spectate: { killer: number; at: number } | null = null;
  /** Client: wave state from the last snapshot. */
  private wave: WaveState | null = null;
  private roundState: RoundState | null = null;

  // Interpolation state.
  /** Authority: positions at the previous fixed tick, for render blending. */
  private prevTick = new Map<number, { x: number; z: number; ang: number }>();
  /** Client: estimated (host time - local time), smoothed. */
  private clockOffset = 0;
  private clockReady = false;
  private renderTime = 0;
  /** Client: local player's position at the previous prediction tick. */
  private mirrorPrev = { x: 0, z: 0 };
  /** Client: visual offset left by a reconciliation correction; decays. */
  private correction = { x: 0, z: 0 };

  constructor(container: HTMLElement, hud: Hud, opts: { shadows?: boolean } = {}) {
    this.hud = hud;
    this.renderer = new Renderer(container, opts);
    this.input.attach(container);
  }

  // ------------------------------------------------------------- lifecycle

  startSolo(name: string, opts: MatchOptions = {}): void {
    this.mode = 'solo';
    this.isAuthority = true;
    this.localName = name;
    this.localId = 1;
    this.beginAuthoritySession(opts);
  }

  async startHost(name: string, opts: MatchOptions = {}): Promise<string> {
    this.mode = 'host';
    this.isAuthority = true;
    this.localName = name;
    this.localId = 1;
    this.matchOpts = opts;
    // A hosted room starts as a warm-up with a lobby; the host starts the match.
    this.lobby = { started: false, ready: new Map() };
    this.beginAuthoritySession(opts);
    this.broadcastLobby();

    this.roomCode = await this.net.host({
      onClientInput: (input, playerId) => {
        const state = this.clientInputs.get(String(playerId));
        if (state) {
          // Continuous state from the newest packet; one-shot actions from
          // every packet, so none is lost when several arrive between ticks.
          state.input = input;
          state.lastAck = input.seq;
          mergeOnce(state.once, input);
        }
      },
      onClientHello: (name, playerId, cls, color) => this.onClientHello(name, playerId, cls, color),
      onClientLeave: (playerId) => this.onClientLeave(playerId),
      onClientReady: (playerId, ready) => {
        if (!this.lobby || this.lobby.started) return;
        this.lobby.ready.set(playerId, ready);
        this.broadcastLobby();
      },
      onStatus: (text) => this.hud.setStatus(text),
      onError: (text) => this.hud.setError(text),
    });
    this.hud.setStatus(`Комната ${this.roomCode} — ждём напарника`);
    return this.roomCode;
  }

  async startClient(name: string, code: string): Promise<void> {
    this.mode = 'client';
    this.isAuthority = false;
    this.ranked = false;
    this.localName = name;
    this.joinCode = code;
    await this.connectToHost();
  }

  /**
   * Ranked: queue on the dedicated server, which hosts the match itself (no
   * bots) and rates everyone at the end. `onQueue` hears the queue progress;
   * `onMatchStart` fires with the first welcome.
   */
  async startRanked(name: string): Promise<void> {
    this.mode = 'client';
    this.isAuthority = false;
    this.ranked = true;
    this.localName = name;
    this.joinCode = '';
    await this.connectToHost();
  }

  /** Playing a ranked match on the server. */
  ranked = false;
  onQueue: ((msg: MatchmakingMsg) => void) | null = null;
  onMatchStart: (() => void) | null = null;

  private onRanked(msg: RankedMsg): void {
    const me = msg.rows.find((r) => r.id === this.localId);
    if (!me) return;
    const d = Math.round(me.after - me.before);
    this.hud.showRating(`РЕЙТИНГ ${Math.round(me.before)} → ${Math.round(me.after)} (${d >= 0 ? '+' : ''}${d}) · МЕСТО ${me.place} ИЗ ${msg.rows.length}`);
  }

  private async connectToHost(): Promise<void> {
    const join = this.ranked ? (h: NetClientHandlers) => this.net.joinServer(h) : (h: NetClientHandlers) => this.net.join(this.joinCode, h);
    await join({
      onMatchmaking: (msg) => this.onQueue?.(msg),
      onRanked: (msg) => this.onRanked(msg),
      onWelcome: (msg) => this.onWelcome(msg),
      onSnapshot: (msg) => this.onSnapshot(msg),
      onEvent: (msg) => this.onEvent(msg),
      onStart: () => undefined,
      // Co-op outcome is shared; deathmatch outcome comes per player from the victory event.
      onOver: (msg) => {
        if (this.matchMode === 'coop') this.endGame(msg.win, msg.text);
      },
      onJoined: (msg) => {
        this.clientNames.set(msg.playerId, msg.name);
        this.hud.message(`${msg.name} в эфире`, 'info');
      },
      onLeft: (msg) => {
        this.clientNames.delete(msg.playerId);
        this.hud.message('Оператор вышел из эфира', 'warn');
      },
      onStatus: (text) => this.hud.setStatus(text),
      onError: (text) => this.hud.setError(text),
      onLatency: (ms) => {
        this.rttMs = ms;
        this.hud.setLatency(ms, this.ranked ? (this.net.udp ? 'UDP' : 'TCP') : '');
      },
      onDisconnected: () => void this.recoverConnection(),
      onLobby: (msg) => this.showLobby(msg),
    });

    this.net.send({ t: 'hello', name: this.localName, cls: this.playerClass, color: this.playerColor });
  }

  /**
   * The channel to the host dropped. Try the same room code a few times (the
   * host greets us as a fresh player); if the room is gone, end the match
   * with a clear reason instead of leaving a frozen screen.
   */
  private async recoverConnection(): Promise<void> {
    if (this.reconnecting || !this.running || this.gameOver) return;
    this.reconnecting = true;
    for (let attempt = 1; attempt <= 3 && this.running; attempt++) {
      this.hud.setStatus(`Связь с хостом потеряна — переподключение (${attempt}/3)…`);
      this.net.disconnect();
      try {
        await this.connectToHost();
        this.reconnecting = false;
        return;
      } catch {
        await new Promise((r) => window.setTimeout(r, 1500));
      }
    }
    this.reconnecting = false;
    if (this.running) this.endGame(false, 'Хост вышел из игры или пропала сеть.', 'СВЯЗЬ ПОТЕРЯНА');
  }

  /** Forgets everything mirrored from a host session. */
  private resetClientState(): void {
    this.clientBullets = [];
    this.latestActors.clear();
    this.snapBuffer = [];
    this.pendingInputs = [];
    this.clockReady = false;
  }

  private beginAuthoritySession(opts: MatchOptions): void {
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.matchMode = opts.mode ?? 'coop';
    this.arena = opts.arena ?? 'sklad';
    this.map = isArena(this.matchMode) ? buildArena(this.arena, seed, this.matchMode) : generateMap(seed);
    this.sim = new Sim(this.map);
    if (opts.fighters) this.sim.fighters = opts.fighters;
    if (opts.difficulty) this.sim.difficulty = opts.difficulty;
    this.sim.addPlayer('local', this.localName, this.localId, this.playerClass, this.playerColor);
    this.tally = newTally();
    this.topUpBots();
    this.setupWorld();
    this.startLoop();
  }

  private setupWorld(): void {
    this.renderer.buildMap(this.map);
    this.renderer.setHostility((id) => this.isHostile(id));
    this.hud.setRooms(this.map.rooms.length);
    this.hud.setMode(this.matchMode, this.map.name, modeInfo(this.matchMode).title);
    this.hud.onBuy = (item) => {
      this.pending.buy = item;
    };
  }

  /** Starts the render/simulation loop exactly once. */
  private startLoop(): void {
    this.running = true;
    this.paused = false;
    // The keyboard belongs to the game only while a session is running; in
    // the menu the text fields need it.
    this.input.enabled = true;
    this.lastTime = performance.now();
    if (this.loopHandle === null) {
      this.loopHandle = requestAnimationFrame(this.loop);
    }
  }

  private loopHandle: number | null = null;

  /** Whose soldiers the fog of war hides from this player. */
  private isHostile(id: number): boolean {
    if (id === this.localId) return false;
    if (isTeamMode(this.matchMode)) {
      const other = this.display.get(id)?.team ?? -1;
      return other < 0 || other !== this.localTeam();
    }
    if (!isCoopMode(this.matchMode)) return true;
    return id >= 1000;
  }

  private localTeam(): number {
    return this.display.get(this.localId)?.team ?? this.sim.actors.get(this.localId)?.team ?? -1;
  }

  // ------------------------------------------------------------------ host

  /**
   * Arena bots. Solo: always. A network room: only if the host left them on,
   * and only once at least two players are in — a host waiting alone for
   * friends does not get a bot match started under them.
   */
  private topUpBots(): void {
    let humans = 0;
    for (const a of this.sim.actors.values()) if (a.kind === 'player') humans++;
    this.sim.botsAllowed = this.mode !== 'host' || (this.matchOpts.bots !== false && humans >= 2);
    this.sim.fillBots();
  }

  private onClientHello(name: string, playerId: number, cls: PlayerClass | null, color: number): void {
    this.clientClasses.set(playerId, cls);
    this.clientColors.set(playerId, color);
    this.sim.addPlayer(`c${playerId}`, name, playerId, cls, color);
    this.topUpBots();
    this.clientNames.set(playerId, name);
    this.clientInputs.set(String(playerId), {
      input: {
        seq: 0,
        moveX: 0,
        moveZ: 0,
        aim: 0,
        fire: false,
        reload: false,
        interact: false,
        flashlight: false,
        slot: -1,
        dt: CONFIG.tickDt,
      },
      once: { ...NO_ONCE },
      lastAck: 0,
    });

    this.sendWelcome(playerId, name);

    const joined: HostMessage = { t: 'joined', playerId, name };
    this.net.broadcast(joined);
    this.hud.message(`${name} подключился`, 'good');
    if (this.lobby && !this.lobby.started) {
      this.lobby.ready.set(playerId, false);
      this.broadcastLobby();
    }
  }

  private sendWelcome(playerId: number, name: string): void {
    const welcome: WelcomeMsg = {
      t: 'welcome',
      playerId,
      name,
      seed: this.map.seed,
      map: this.map,
      snapshot: this.buildSnapshot(),
      // The ring colour the player picked, not a slot colour.
      colors: { [String(playerId)]: this.clientColors.get(playerId) ?? PLAYER_COLORS[(playerId - 1) % PLAYER_COLORS.length] },
    };
    this.net.sendTo(playerId, welcome);
  }

  // ------------------------------------------------------------------ lobby

  /** Host: everyone in the room and who is ready, to all and to our own HUD. */
  private broadcastLobby(): void {
    if (!this.lobby) return;
    const msg: LobbyMsg = {
      t: 'lobby',
      started: this.lobby.started,
      players: [
        { id: this.localId, name: this.localName, ready: true, host: true },
        ...[...this.clientNames].map(([id, name]) => ({ id, name, ready: this.lobby!.ready.get(id) ?? false, host: false })),
      ],
    };
    this.net.broadcast(msg);
    this.showLobby(msg);
  }

  private showLobby(msg: LobbyMsg): void {
    const me = msg.players.find((p) => p.id === this.localId);
    this.localReady = me?.ready ?? false;
    this.hud.showLobby(msg.started ? null : msg.players, this.isAuthority, this.localReady);
  }

  /** Client: our ready flag as the host last confirmed it. */
  private localReady = false;

  get isHost(): boolean {
    return this.mode === 'host';
  }

  /** Client: tell the host we are (not) ready. */
  toggleReady(): void {
    if (!this.isAuthority) this.net.send({ t: 'ready', ready: !this.localReady });
  }

  /**
   * Host: end the warm-up. The match starts over on a fresh map with
   * everyone now in the room; each client gets a new welcome.
   */
  startMatch(): void {
    if (!this.isAuthority || !this.lobby || this.lobby.started) return;
    this.lobby.started = true;
    this.gameOver = false;
    this.hud.hideGameOver();
    this.prevTick.clear();
    this.beginAuthoritySession(this.matchOpts);
    for (const [id, name] of this.clientNames) {
      this.sim.addPlayer(`c${id}`, name, id, this.clientClasses.get(id) ?? null, this.clientColors.get(id) ?? -1);
    }
    this.topUpBots();
    for (const [id, name] of this.clientNames) this.sendWelcome(id, name);
    this.broadcastLobby();
    this.hud.banner('МАТЧ НАЧАЛСЯ', '');
  }

  private onClientLeave(playerId: number): void {
    this.sim.removeActor(playerId);
    this.topUpBots();
    this.clientNames.delete(playerId);
    this.lobby?.ready.delete(playerId);
    this.broadcastLobby();
    this.clientInputs.delete(String(playerId));
    this.net.broadcast({ t: 'left', playerId });
    this.hud.message('Оператор отключился', 'warn');
  }

  private buildSnapshot(): SnapshotMsg {
    const ack: Record<string, number> = {};
    for (const [key, state] of this.clientInputs) ack[key] = state.lastAck;
    return buildSnapshot(this.sim, this.tick, ack);
  }

  private scoreRows(): [number, number, number, number][] {
    return scoreRows(this.sim);
  }

  /** Waves: progress (host: from the sim; client: from snapshots). */
  private waveState(): WaveState | null {
    if (this.matchMode !== 'waves') return null;
    return this.isAuthority ? waveStateOf(this.sim) : this.wave;
  }

  /** Competitive round info (host: from the sim; client: from snapshots). */
  private localRoundState(): RoundState | null {
    return this.isAuthority ? roundStateOf(this.sim) : this.roundState;
  }

  // ---------------------------------------------------------------- client

  private onWelcome(msg: WelcomeMsg): void {
    // A welcome after a reconnect (or a match start) begins a new mirror of the host.
    this.resetClientState();
    this.gameOver = false;
    this.hud.hideGameOver();
    this.map = msg.map;
    this.matchMode = msg.map.mode ?? 'coop';
    this.localId = msg.playerId;
    this.sim = new Sim(this.map);
    const me = msg.snapshot.actors.find((a) => a.id === msg.playerId);
    // The class changes the predicted speed (scout crouch), so the mirror needs it.
    const actor = this.sim.addPlayer('local', this.localName, msg.playerId, me?.cls ?? null);
    if (me) {
      actor.x = me.x;
      actor.z = me.z;
      actor.weapon = me.weapon;
    }
    this.mirrorPrev = { x: actor.x, z: actor.z };
    this.setupWorld();
    this.startLoop();
    this.onSnapshot(msg.snapshot);
    this.hud.message(this.ranked ? 'Рейтинговый бой: боты отключены' : 'Соединение установлено', 'good');
    this.onMatchStart?.();
  }

  private onSnapshot(msg: SnapshotMsg): void {
    this.latestActors.clear();
    for (const a of msg.actors) this.latestActors.set(a.id, a);

    // Clock: estimate host time as local time + offset. The offset follows
    // new samples slowly, so jittery packets do not make remote players jump.
    const nowSec = performance.now() / 1000;
    const sample = msg.time - nowSec;
    if (!this.clockReady) {
      this.clockOffset = sample;
      this.clockReady = true;
      this.renderTime = msg.time - CONFIG.interpDelayMs / 1000;
    } else if (Math.abs(sample - this.clockOffset) > 0.5) {
      this.clockOffset = sample; // big stall or tab switch: resync
    } else {
      // Packets that arrive late only pull the clock back gently.
      this.clockOffset += (sample - this.clockOffset) * (sample > this.clockOffset ? 0.12 : 0.04);
    }

    const frame: SnapFrame = { time: msg.time, actors: new Map() };
    for (const a of msg.actors) frame.actors.set(a.id, a);
    this.snapBuffer.push(frame);
    if (this.snapBuffer.length > 40) this.snapBuffer.shift();

    this.sim.syncProps(msg.props);
    this.sim.syncDoors(msg.doors);
    this.sim.syncLamps(msg.lampsOut ?? []);
    this.sim.syncSmokes(msg.smokes ?? []);
    this.sim.syncFires(msg.fires ?? []);
    this.sim.syncDrones(msg.drones ?? []);
    this.sim.syncWorldExtras(msg.inter ?? [], msg.supply ?? [], msg.shells ?? [], msg.flares ?? []);
    this.droneSyncAt = performance.now();
    if (msg.flags) this.sim.syncFlags(msg.flags);
    if (msg.bases) this.sim.bases = msg.bases;
    if (msg.bomb !== undefined) this.sim.syncBomb(msg.bomb);
    if (msg.attackTeam !== undefined) this.sim.sidesSwapped = msg.attackTeam === 1;
    if (msg.objectives) this.sim.syncObjectives(msg.objectives);
    if (msg.sites) this.sim.sites = msg.sites;
    this.renderer.syncLamps(this.sim.lampAlive);
    this.sim.syncItems(msg.pickups ?? [], msg.powerups ?? [], msg.grenades ?? []);
    this.roundState = msg.round ?? null;
    this.sim.roomIndex = msg.room;
    this.sim.roomPhase = msg.phase;
    this.scores = msg.scores ?? [];
    this.timeLeft = msg.timeLeft ?? 0;
    this.teamScore = msg.teamScore ?? [0, 0];
    this.wave = msg.wave ?? null;

    // Reconcile the locally predicted player: rewind to the host state,
    // replay unacknowledged input, and keep the visual jump as a decaying
    // correction offset instead of snapping.
    const local = msg.actors.find((a) => a.id === this.localId);
    const mirror = this.sim.actors.get(this.localId);
    if (local && mirror) {
      const beforeX = mirror.x;
      const beforeZ = mirror.z;
      const acked = msg.ack[String(this.localId)] ?? 0;
      this.pendingInputs = this.pendingInputs.filter((p) => p.seq > acked);
      mirror.x = local.x;
      mirror.z = local.z;
      mirror.vx = 0;
      mirror.vz = 0;
      mirror.alive = local.alive;
      mirror.buffs = { ...local.buffs };
      // Carrying a flag or crawling downed slows you: prediction has to know.
      mirror.carrying = local.carrying ?? -1;
      mirror.downed = local.downed ?? false;
      // So does the gun in hand (knife faster, flamer slower) and the class.
      mirror.weapon = local.weapon;
      if (local.cls !== undefined) mirror.cls = local.cls;
      this.sim.applySpeed(mirror);
      const flying = (local.piloting ?? -1) >= 0;
      for (const p of this.pendingInputs) {
        mirror.gait = p.input.gait ?? 'run';
        this.sim.moveActor(mirror, flying ? 0 : p.input.moveX, flying ? 0 : p.input.moveZ, p.input.dt);
      }
      const ex = beforeX - mirror.x;
      const ez = beforeZ - mirror.z;
      if (Math.hypot(ex, ez) < SNAP_DISTANCE) {
        // Shift both blend endpoints, so the drawn position does not move
        // this frame; the correction then fades out over a few frames.
        this.correction.x += ex;
        this.correction.z += ez;
        this.mirrorPrev.x -= ex;
        this.mirrorPrev.z -= ez;
      } else {
        this.correction.x = 0;
        this.correction.z = 0;
        this.mirrorPrev = { x: mirror.x, z: mirror.z };
      }
    }

    // Bullets that no longer exist on the host are dropped locally.
    const alive = new Set(msg.bullets.map((b) => b.id));
    this.clientBullets = this.clientBullets.filter((b) => alive.has(b.id));
  }

  private onEvent(msg: EventMsg): void {
    this.applyEvent(msg.event);
  }

  // ---------------------------------------------------------------- events

  private nameOf(id: number | undefined): string {
    if (id === undefined) return '';
    if (id === this.localId) return 'вы';
    const d = this.display.get(id) ?? this.sim.actors.get(id);
    return d?.name ?? '';
  }

  private applyEvent(event: GameEvent): void {
    // Experience for this match: the same rules the game server uses.
    tallyEvent(this.tally, event, this.localId, (id) => this.isHostile(id));
    switch (event.type) {
      case 'shot': {
        const weapon = event.weapon ?? 'pistol';
        const def = WEAPONS[weapon];
        const owner = event.ownerId ?? 0;
        const isLocalPlayer = owner === this.localId;
        const size = def.flashSize;
        this.renderer.muzzleFlash(event.x ?? 0, event.z ?? 0, event.dirX ?? 0, event.dirZ ?? 0, size);
        // A silenced shot leaves no marker for those who cannot see the shooter.
        if (!def.silenced) {
          this.renderer.shotFrom(owner, event.x ?? 0, event.z ?? 0);
          this.noteNoise(owner, event.x ?? 0, event.z ?? 0);
        }
        this.soundAt(event.x ?? 0, event.z ?? 0, (dist) => (def.flame ? this.audio.flame(dist) : this.audio.shot(size, dist)));
        if (isLocalPlayer) {
          this.renderer.shake(def.shake);
          this.hud.kick(0.25 + def.shake * 0.5);
        }
        this.renderer.ensureActor(owner, this.colorFor(owner), this.isPlayerId(owner)).triggerFlash();
        if (!this.isAuthority) this.spawnClientBullets(event);
        break;
      }
      case 'smoke':
        this.renderer.smokePop(event.x ?? 0, event.z ?? 0);
        this.soundAt(event.x ?? 0, event.z ?? 0, (d) => this.audio.smokePop(d));
        break;
      case 'fire':
        this.renderer.fireBurst(event.x ?? 0, event.z ?? 0);
        this.soundAt(event.x ?? 0, event.z ?? 0, (d) => this.audio.fireBurst(d));
        break;
      case 'flash':
        this.renderer.flashBang(event.x ?? 0, event.z ?? 0);
        this.soundAt(event.x ?? 0, event.z ?? 0, (d) => this.audio.flashBang(d));
        break;
      case 'lampBreak':
        this.renderer.breakLamp(Number(event.id));
        if (this.isAuthority) this.renderer.syncLamps(this.sim.lampAlive);
        this.soundAt(event.x ?? 0, event.z ?? 0, (d) => this.audio.glass(d));
        break;
      case 'step': {
        // Own steps are played from local input (no network delay).
        const owner = event.ownerId ?? 0;
        if (owner === this.localId) break;
        this.renderer.stepFrom(owner, event.x ?? 0, event.z ?? 0);
        this.noteNoise(owner, event.x ?? 0, event.z ?? 0);
        this.soundAt(event.x ?? 0, event.z ?? 0, (d) => {
          if (d < 16) this.audio.step(0.9 * (1 - d / 16));
        });
        break;
      }
      case 'impact':
        this.renderer.impact(event.x ?? 0, event.z ?? 0);
        this.soundAt(event.x ?? 0, event.z ?? 0, () => this.audio.impact());
        break;
      case 'explosion':
        this.renderer.explosion(event.x ?? 0, event.z ?? 0);
        this.renderer.blastRagdolls(event.x ?? 0, event.z ?? 0);
        this.soundAt(event.x ?? 0, event.z ?? 0, () => this.audio.explosion());
        this.renderer.shake(1.1);
        break;
      case 'hurt': {
        this.renderer.blood(event.x ?? 0, event.z ?? 0);
        this.audio.hurt();
        if (event.by === this.localId && event.ownerId !== this.localId) this.hud.hitMarker(false);
        if (event.ownerId === this.localId) {
          this.renderer.shake(0.35);
          const self = this.localDisplay();
          const src = event.by !== undefined ? this.display.get(event.by) : undefined;
          if (self && src && src.id !== self.id) {
            // Top-down camera: screen x = world x, screen y (down) = world z.
            this.hud.damageFrom(Math.atan2(src.z - self.z, src.x - self.x));
          }
        }
        break;
      }
      case 'death': {
        this.renderer.blood(event.x ?? 0, event.z ?? 0);
        // Throw the body away from whoever (or whatever) dealt the blow.
        const victim = event.ownerId !== undefined ? this.display.get(event.ownerId) : undefined;
        const killer = event.by !== undefined ? this.display.get(event.by) : undefined;
        if (victim && killer && killer.id !== victim.id) {
          const weapon = WEAPONS[killer.weapon];
          const power = 2.5 + weapon.damage * 0.06;
          this.renderer
            .ensureActor(victim.id, this.colorFor(victim.id), victim.kind === 'player')
            .setDeathImpulse(victim.x - killer.x, victim.z - killer.z, Math.min(7, power));
        }
        this.soundAt(event.x ?? 0, event.z ?? 0, () => this.audio.death());
        // Our own death: watch the killer for a moment, then an ally.
        if (event.ownerId === this.localId) this.spectate = { killer: event.by ?? -1, at: performance.now() };
        if (event.by === this.localId && event.ownerId !== this.localId) {
          this.hud.hitMarker(true);
        }
        if (isArena(this.matchMode)) {
          const by = event.by === event.ownerId ? '' : this.nameOf(event.by);
          this.hud.killFeed(by, this.nameOf(event.ownerId), event.by === this.localId, event.ownerId === this.localId, event.weapon ?? 'pistol', event.text === 'critical');
        } else if (event.by === this.localId && event.ownerId !== this.localId) {
          this.hud.message('Противник нейтрализован', 'good');
        } else if (event.ownerId === this.localId) {
          this.hud.message('Вы ранены — эвакуация на безопасную точку', 'warn');
        }
        break;
      }
      case 'throw':
        this.audio.pickup();
        break;
      case 'buy':
        if (event.ownerId === this.localId) {
          this.audio.pickup();
          this.hud.message(`Куплено: ${SHOP.find((e) => e.item === event.text)?.name ?? ''}`, 'good');
        }
        break;
      case 'ladder':
        if (event.ownerId === this.localId) {
          this.audio.powerup();
          this.hud.banner(`${WEAPONS[event.weapon ?? 'pistol'].name.toUpperCase()}`, `Ступень ${Number(event.text) + 1} из ${GUN_LADDER.length}`);
        } else {
          this.hud.message(`${this.nameOf(event.ownerId)}: ${WEAPONS[event.weapon ?? 'pistol'].name}`, 'warn');
        }
        break;
      case 'round': {
        const st = this.localRoundState();
        if (event.text === 'start') {
          this.renderer.resetCamera();
          this.hud.banner(`РАУНД ${st?.n ?? ''}`, 'Закупка — B');
        } else if (event.text === 'live') {
          this.buyOpen = false;
          this.hud.banner('В БОЙ', '');
        } else if (event.text === 'swap') {
          const attack = this.localTeam() === this.sim.attackTeam;
          this.hud.banner('СМЕНА СТОРОН', attack ? 'Теперь вы в атаке' : 'Теперь вы в защите');
        } else if (event.text === 'end' && event.team !== undefined) {
          // Team rounds (bomb): which side took it, and why.
          const ours = event.team === this.localTeam();
          this.hud.banner(ours ? 'РАУНД ЗА НАМИ' : `РАУНД: ${TEAM_NAMES[event.team]}`, event.id ?? '');
          if (ours) this.audio.powerup();
        } else if (event.text === 'end') {
          const me = event.ownerId === this.localId;
          this.hud.banner(me ? 'РАУНД ЗА ВАМИ' : event.ownerId !== undefined ? `РАУНД: ${this.nameOf(event.ownerId).toUpperCase()}` : 'НИЧЬЯ', '');
          if (me) this.audio.powerup();
        }
        break;
      }
      case 'respawn':
        if (event.ownerId === this.localId) {
          this.renderer.resetCamera();
          this.audio.pickup();
        }
        break;
      case 'reload':
        if (event.ownerId === this.localId || this.localActorPosition(event.x ?? 0, event.z ?? 0) < 12) {
          this.soundAt(event.x ?? 0, event.z ?? 0, () => this.audio.reload());
        }
        break;
      case 'pickup':
        if (event.ownerId === this.localId) {
          this.audio.pickup();
          this.hud.message(`Получено: ${WEAPONS[event.weapon ?? 'pistol'].name}`, 'good');
        }
        break;
      case 'powerup':
        this.renderer.powerupTaken(event.x ?? 0, event.z ?? 0, event.powerup ?? 'medkit');
        if (event.ownerId === this.localId) {
          this.audio.powerup();
          const kind = event.powerup ?? 'medkit';
          this.hud.message(POWERUP_TEXT[kind], 'good');
          // Hard to miss: the name in the middle of the screen for a moment.
          this.hud.pickupToast(POWERUP_INFO[kind].name, POWERUP_INFO[kind].desc, POWERUP_COLOR[kind]);
        }
        break;
      case 'roomClear':
        this.audio.door();
        this.hud.message(event.text === '1' ? 'Выдвигайтесь — дверь открыта' : 'Комната зачищена — дверь открыта', 'good');
        break;
      case 'roomEnter':
        this.hud.message(`Комната ${event.text}`, 'warn');
        break;
      case 'stab':
        this.soundAt(event.x ?? 0, event.z ?? 0, (d) => {
          if (d < 12) this.audio.tone(900, 300, 0.08, 0.08 * (1 - d / 12), 'sawtooth');
        });
        break;
      case 'drone':
        if (event.id === 'launch') {
          this.soundAt(event.x ?? 0, event.z ?? 0, (d) => this.audio.buzz(d, 1.6));
          if (event.ownerId === this.localId) this.hud.message('Дрон в воздухе · ЛКМ или X — подрыв', 'good');
        } else {
          this.soundAt(event.x ?? 0, event.z ?? 0, () => this.audio.impact());
          this.renderer.impact(event.x ?? 0, event.z ?? 0);
          if (event.ownerId === this.localId) this.hud.message('Связь с дроном потеряна', 'warn');
        }
        break;
      case 'interact':
        this.onInteractEvent(event);
        break;
      case 'drop':
        this.onDropEvent(event);
        break;
      case 'streak':
        this.onStreakEvent(event);
        break;
      case 'strike':
        if (event.id === 'call') {
          this.renderer.markAt(event.x ?? 0, event.z ?? 0);
          this.markBlips.push({ x: event.x ?? 0, z: event.z ?? 0, at: performance.now() });
          this.soundAt(event.x ?? 0, event.z ?? 0, (d) => this.audio.whistle(d));
          this.hud.message(event.ownerId === this.localId ? 'Миномёт: залп пошёл' : 'ВОЗДУХ! Миномётный обстрел', event.ownerId === this.localId ? 'good' : 'warn');
        }
        break;
      case 'mine':
        if (event.id === 'place') {
          this.soundAt(event.x ?? 0, event.z ?? 0, (d) => this.audio.click(d));
          if (event.ownerId === this.localId) this.hud.message('Мина установлена', 'good');
        } else if (event.id === 'click') {
          this.soundAt(event.x ?? 0, event.z ?? 0, (d) => this.audio.click(d * 0.5));
        }
        break;
      case 'wire':
        if (event.id === 'cut') {
          this.soundAt(event.x ?? 0, event.z ?? 0, (d) => this.audio.click(d));
          if (event.ownerId === this.localId) this.hud.message('Проволока перерезана', 'good');
        } else if (event.ownerId === this.localId) {
          this.renderer.shake(0.25);
        }
        break;
      case 'flare':
        this.soundAt(event.x ?? 0, event.z ?? 0, (d) => this.audio.hiss(d));
        break;
      case 'deploy':
        this.soundAt(event.x ?? 0, event.z ?? 0, () => this.audio.door());
        if (event.ownerId === this.localId) this.hud.message('Щит установлен', 'good');
        break;
      case 'mark': {
        // Our own side's markers only.
        const owner = event.ownerId ?? -1;
        if (owner !== this.localId && this.isHostile(owner)) break;
        this.renderer.markAt(event.x ?? 0, event.z ?? 0);
        this.markBlips.push({ x: event.x ?? 0, z: event.z ?? 0, at: performance.now() });
        this.audio.tone(1300, 1700, 0.12, 0.05, 'triangle');
        break;
      }
      case 'objective': {
        const lines: Record<string, [string, 'good' | 'warn']> = {
          alarm: ['Терминал поднял тревогу — охрана идёт сюда', 'warn'],
          hacked: ['Терминал взломан', 'good'],
          defused: ['Заряд обезврежен', 'good'],
          blown: ['Заряд взорвался', 'warn'],
        };
        const [text, kind] = lines[event.text ?? ''] ?? ['', 'info'];
        if (text) this.hud.message(text, kind as 'good' | 'warn');
        if (event.text === 'hacked' || event.text === 'defused') {
          this.audio.powerup();
        }
        break;
      }
      case 'down': {
        const mine = event.ownerId === this.localId;
        this.hud.message(mine ? 'Вы ранены — союзник может поднять вас (E)' : `${this.nameOf(event.ownerId)} ранен — поднимите (зажать E)`, 'warn');
        break;
      }
      case 'revive':
        this.hud.message(event.ownerId === this.localId ? 'Вас подняли' : `${this.nameOf(event.ownerId)} снова в строю`, 'good');
        this.soundAt(event.x ?? 0, event.z ?? 0, () => this.audio.powerup());
        break;
      case 'bomb': {
        const who = event.ownerId === this.localId ? 'Вы' : this.nameOf(event.ownerId ?? 0);
        const site = event.id === '1' ? 'B' : 'A';
        if (event.text === 'planted') {
          this.hud.banner(`БОМБА НА ${site}`, `${CONFIG.bomb.timer} секунд`);
          this.soundAt(event.x ?? 0, event.z ?? 0, (d) => this.audio.flashBang(d + 20));
        } else if (event.text === 'defused') {
          this.hud.message(`${who}: бомба обезврежена`, this.localTeam() === this.sim.defendTeam ? 'good' : 'warn');
        } else if (event.text === 'dropped') {
          this.hud.message('Бомба упала', this.localTeam() === this.sim.attackTeam ? 'warn' : 'good');
        } else if (event.text === 'picked') {
          this.hud.message(`${who}: бомба подобрана`, 'info');
        }
        break;
      }
      case 'flag': {
        const ours = event.team === this.localTeam();
        const who = event.ownerId === this.localId ? 'Вы' : this.nameOf(event.ownerId ?? 0);
        const whose = ours ? 'наш' : 'их';
        const lines: Record<string, string> = {
          taken: `${who}: ${whose} флаг унесён`,
          dropped: `${whose[0].toUpperCase() + whose.slice(1)} флаг брошен`,
          returned: `${whose[0].toUpperCase() + whose.slice(1)} флаг возвращён на базу`,
          captured: `${who} — захват!`,
        };
        const text = lines[event.text ?? ''] ?? '';
        if (event.text === 'captured') {
          // The flag that was captured belongs to the losing side.
          this.hud.banner(ours ? 'ФЛАГ ПОТЕРЯН' : 'ЗАХВАТ', text);
          this.audio.powerup();
        } else {
          // Ours taken: bad. Ours dropped or returned: their carrier failed, good.
          // Theirs: the mirror image.
          const good = event.text === 'taken' ? !ours : ours;
          this.hud.message(text, good ? 'good' : 'warn');
        }
        break;
      }
      case 'wave':
        if (event.text === 'start') {
          this.hud.banner(`ВОЛНА ${event.id ?? ''}`, 'Они идут на шум и свет');
        } else if (event.text === 'clear') {
          this.hud.banner('ВОЛНА ОТБИТА', `Передышка ${CONFIG.waves.breakTime} с · магазин — B · павшие возвращаются`);
          this.audio.powerup();
        } else if (event.text === 'boss') {
          this.hud.banner(`ВОЛНА ${event.id ?? ''} — КОМЕНДАНТ`, 'Тяжёлая броня, много здоровья');
        }
        break;
      case 'gameOver':
        this.endGame(false, event.text ?? '', 'ОТРЯД ПОГИБ');
        break;
      case 'victory':
        if (isTeamMode(this.matchMode)) {
          const win = event.team === this.localTeam();
          this.endGame(win, event.text ?? '', win ? 'ПОБЕДА' : event.team === -1 ? 'НИЧЬЯ' : 'ПОРАЖЕНИЕ');
        } else if (isArena(this.matchMode)) {
          const win = event.ownerId === this.localId;
          this.endGame(win, event.text ?? '', win ? 'ПОБЕДА' : 'МАТЧ ОКОНЧЕН');
        } else {
          this.endGame(true, event.text ?? 'ОБЪЕКТ ЗАЧИЩЕН');
        }
        break;
    }
  }

  private spawnClientBullets(event: GameEvent): void {
    const owner = event.ownerId ?? 0;
    const weapon = event.weapon ?? 'pistol';
    const def = WEAPONS[weapon];
    const list = event.pellets ?? [];
    const count = list.length;
    for (let i = 0; i < count; i++) {
      const p = list[i];
      // Bullet ids must match the host exactly, otherwise the snapshot
      // reconciliation drops the local replica right after it is created.
      const baseId = event.id ?? `c${owner}-${this.clientBullets.length}`;
      this.clientBullets.push({
        id: count > 1 ? `${baseId}-${i}` : baseId,
        ownerId: owner,
        ownerKind: owner >= 1000 ? 'enemy' : 'player',
        x: (event.x ?? 0) + p.dx * 0.4,
        z: (event.z ?? 0) + p.dz * 0.4,
        vx: p.dx * p.speed,
        vz: p.dz * p.speed,
        speed: p.speed,
        damage: def.damage,
        damageMul: 1,
        life: projectileLife(def, p.speed),
        weapon,
        color: owner >= 1000 ? 0xff7a5c : def.color,
        range: 0,
      });
    }
  }

  private endGame(win: boolean, text: string, title?: string): void {
    if (this.gameOver) return;
    this.gameOver = true;
    // Bank the match: experience, level, anything it unlocked.
    const got = addMatch(this.tally, win);
    const lvl = levelOf(loadProgress().xp);
    const up = got.after > got.before ? ` · НОВЫЙ УРОВЕНЬ ${got.after}!` : '';
    const unlocked = got.unlocked.length > 0 ? ` · ОТКРЫТ ЦВЕТ: ${got.unlocked.join(', ').toUpperCase()}` : '';
    const progress = `+${got.gained} ОПЫТА · УРОВЕНЬ ${lvl.level} (${lvl.into}/${lvl.need})${up}${unlocked}`;
    this.hud.showGameOver(win, text, title, isArena(this.matchMode) ? this.scoreTable() : null, progress);
    if (this.isAuthority) this.net.broadcast({ t: 'over', win, text });
  }

  // ------------------------------------------------------------- pause & exit

  /** True while the pause overlay is up. */
  get isPaused(): boolean {
    return this.paused;
  }

  /** True when there is a session to leave. */
  get inSession(): boolean {
    return this.running;
  }

  /** Freeze the simulation and show the pause overlay. */
  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.input.enabled = false;
    this.hud.showPause();
  }

  /** Resume from the pause overlay. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.input.enabled = true;
    this.hud.hidePause();
    this.lastTime = performance.now();
  }

  /**
   * Leave the session and hand the player back to the menu.
   *
   * The net connection is closed, the simulation is dropped and the keyboard
   * is released — otherwise the menu fields would lose characters to the
   * game.
   */
  returnToMenu(): void {
    this.paused = false;
    this.running = false;
    this.input.enabled = false;
    this.net.disconnect();
    this.hud.hidePause();
    this.hud.hideGameOver();
    this.display.clear();
    this.resetClientState();
    this.clientInputs.clear();
    this.clientNames.clear();
    this.buyOpen = false;
    this.roomCode = '';
    this.lobby = null;
    this.hud.showLobby(null, false, false);
  }

  // ------------------------------------------------------------------ loop

  private loop = (now: number): void => {
    this.loopHandle = requestAnimationFrame(this.loop);
    if (!this.running) {
      this.lastTime = now;
      return;
    }

    const raw = (now - this.lastTime) / 1000;
    const dt = Math.min(0.1, raw);
    this.lastTime = now;
    this.watchFrameRate(raw);

    // While paused the world is frozen: the player reads the menu instead of
    // dying in it. The frame is still drawn.
    if (!this.paused) {
      this.sampleInput();
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= CONFIG.tickDt && steps < 5) {
        this.accumulator -= CONFIG.tickDt;
        this.safeStep();
        steps++;
      }
      if (steps === 5) this.accumulator = 0;

      this.updateDisplay(dt);
    }
    // Solo arenas: only your own sight. Co-op and teams: your ally's too.
    const shared = isCoopMode(this.matchMode) || isTeamMode(this.matchMode);
    this.renderer.update(dt, this.playerLights(), shared ? 2 : 1, this.beams());
    this.renderer.render();
    this.updateHud();
    this.updateFootsteps(dt);
    this.hud.tick(dt);
    this.input.endFrame();
  };

  /** Too slow for too long: told once per stage (see main.ts, which lowers quality). */
  onSlowFrames: (() => void) | null = null;
  private slowWindow: number[] = [];
  private slowCooldown = 0;

  /**
   * Average frame time over the last two seconds of play. Tab switches and
   * pauses are not counted; after a report it waits before judging again, so
   * the new settings get a fair try.
   */
  private watchFrameRate(raw: number): void {
    if (!this.running || this.paused || document.visibilityState !== 'visible' || raw > 0.25) {
      this.slowWindow.length = 0;
      return;
    }
    this.slowCooldown = Math.max(0, this.slowCooldown - raw);
    this.slowWindow.push(raw);
    if (this.slowWindow.length > 120) this.slowWindow.shift();
    if (this.slowWindow.length < 120 || this.slowCooldown > 0) return;
    const avg = this.slowWindow.reduce((a, b) => a + b, 0) / this.slowWindow.length;
    if (avg > 1 / 42) {
      this.slowWindow.length = 0;
      this.slowCooldown = 6;
      this.onSlowFrames?.();
    }
  }

  private tickErrors = 0;

  /**
   * One tick, fenced: a bug in one corner of the simulation must cost that
   * tick, not the match (an exception here used to stop every tick after it).
   */
  private safeStep(): void {
    try {
      this.fixedStep(CONFIG.tickDt);
    } catch (err) {
      if (this.tickErrors++ < 5) console.error('tick failed', err);
    }
  }

  private sampleInput(): void {
    const move = this.input.moveVector();
    this.frameMove.x = move.x;
    this.frameMove.z = move.z;
    const keys = this.input.keys;
    this.frameGait = keys.has('KeyC') ? 'crouch' : keys.has('ShiftLeft') || keys.has('ShiftRight') ? 'walk' : 'run';
    this.frameFire = this.input.mouseDown && !this.buyOpen;

    if (this.input.consume('reload')) this.pending.reload = true;
    if (this.input.consume('interact')) this.pending.interact = true;
    if (this.input.consume('flashlight')) this.pending.flashlight = true;
    if (this.input.consume('grenade')) this.pending.grenade = true;
    if (this.input.consume('nade')) this.nadeKind = this.nextNadeKind();
    if (this.input.consume('deploy')) this.pending.deploy = true;
    if (this.input.consume('drone')) this.pending.drone = true;
    if (this.input.consume('strike')) this.pending.strike = true;
    if (this.input.consume('mine')) this.pending.mine = true;
    if (this.input.consume('mark')) {
      const g = this.renderer.screenToGround(this.input.mouseX, this.input.mouseY);
      this.pending.mark = { x: g.x, z: g.z };
    }

    // Competitive shop: B toggles it during the buy window; while open,
    // number keys buy instead of switching weapons.
    const round = this.localRoundState();
    // Comp / bomb: the buy window of a round; waves: the break between waves.
    const canBuy = (!!round?.canBuy || !!this.waveState()?.canBuy) && !!this.localDisplay()?.alive;
    if (this.input.consume('buy') && canBuy) this.buyOpen = !this.buyOpen;
    if (!canBuy) this.buyOpen = false;
    for (let i = 0; i < SHOP.length; i++) {
      if (!this.input.consume(`slot${i + 1}` as never)) continue;
      if (this.buyOpen) this.pending.buy = SHOP[i].item;
      else if (i < WEAPON_ORDER.length) this.pending.slot = i;
    }
    this.hud.showBuyMenu(this.buyOpen, this.localDisplay()?.money ?? 0, round?.canBuy ? round : null, this.waveState()?.t ?? 0);
    this.hud.showScores(this.input.keys.has('Tab'));

    this.renderer.setPointer(this.input.mouseX, this.input.mouseY);
    const self = this.localDisplay();
    if (self) {
      const ground = this.renderer.screenToGround(this.input.mouseX, this.input.mouseY);
      const drone = this.localDrone();
      this.renderer.setLookAhead(!drone);
      if (drone) {
        // Flying: the nose points from the screen centre toward the cursor. Measured
        // against the drone itself it would flip each time the drone caught up with
        // the cursor, since the camera follows it; near the centre the heading holds.
        const rect = this.renderer.viewRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        if (Math.hypot(this.input.mouseX - cx, this.input.mouseY - cy) > Math.min(rect.width, rect.height) * 0.06) {
          const centre = this.renderer.screenToGround(cx, cy);
          this.frameAim = Math.atan2(ground.z - centre.z, ground.x - centre.x);
        }
      } else {
        this.frameAim = Math.atan2(ground.z - self.z, ground.x - self.x);
      }
      this.frameThrow = Math.hypot(ground.z - self.z, ground.x - self.x);
    }
  }

  private buildInput(): PlayerInput {
    const input: PlayerInput = {
      seq: ++this.inputSeq,
      moveX: this.frameMove.x,
      moveZ: this.frameMove.z,
      aim: this.frameAim,
      fire: this.frameFire,
      reload: this.pending.reload,
      interact: this.pending.interact,
      flashlight: this.pending.flashlight,
      slot: this.pending.slot,
      dt: CONFIG.tickDt,
      grenade: this.pending.grenade,
      throwDist: this.frameThrow,
      buy: this.pending.buy,
      rttMs: this.mode === 'client' ? this.rttMs : undefined,
      gait: this.frameGait,
      grenadeKind: this.nadeKind,
      // Held, not pressed: planting and defusing take seconds.
      use: this.input.keys.has('KeyE'),
      mark: this.pending.mark ?? undefined,
      deploy: this.pending.deploy,
      drone: this.pending.drone,
      strike: this.pending.strike,
      mine: this.pending.mine,
    };
    this.pending.strike = false;
    this.pending.mine = false;
    this.pending.mark = null;
    this.pending.deploy = false;
    this.pending.drone = false;
    this.pending.reload = false;
    this.pending.interact = false;
    this.pending.flashlight = false;
    this.pending.slot = -1;
    this.pending.grenade = false;
    this.pending.buy = '';
    return input;
  }

  private fixedStep(dt: number): void {
    const input = this.buildInput();
    this.tick++;

    if (this.isAuthority) {
      // Remember where everyone was, so frames between ticks can blend.
      for (const a of this.sim.actors.values()) {
        const p = this.prevTick.get(a.id);
        if (p) {
          p.x = a.x;
          p.z = a.z;
          p.ang = a.ang;
        } else {
          this.prevTick.set(a.id, { x: a.x, z: a.z, ang: a.ang });
        }
      }

      const local = this.sim.actors.get(this.localId);
      if (local) this.sim.applyInput(local, input);

      for (const [key, state] of this.clientInputs) {
        const actor = this.sim.actors.get(Number(key));
        if (!actor) continue;
        // One-way delay of this client's input, capped so a bad link cannot
        // shoot far ahead of what everyone else sees.
        actor.lagComp = Math.min(CONFIG.lagCompMax, (state.input.rttMs ?? 0) / 2000);
        // One-shots apply exactly once, even if no new packet came this tick.
        this.sim.applyInput(actor, { ...state.input, ...NO_ONCE, ...state.once });
        state.once = { ...NO_ONCE };
      }

      this.sim.step(dt);
      this.drainSimEvents();

      // The host has no ping of its own; show the worst one its clients report.
      if (this.tick % 60 === 0 && this.clientInputs.size > 0) {
        let worst = 0;
        for (const state of this.clientInputs.values()) worst = Math.max(worst, state.input.rttMs ?? 0);
        this.hud.setLatency(worst);
      }

      if (this.tick % Math.round(1 / CONFIG.snapshotRate / CONFIG.tickDt) === 0) {
        this.net.broadcast(this.buildSnapshot());
      }
    } else {
      const mirror = this.sim.actors.get(this.localId);
      if (mirror) {
        this.mirrorPrev.x = mirror.x;
        this.mirrorPrev.z = mirror.z;
        mirror.gait = input.gait ?? 'run';
        // The pilot stands still while the drone flies.
        const flying = (this.latestActors.get(this.localId)?.piloting ?? -1) >= 0;
        if (!flying) mirror.ang = input.aim;
        if (mirror.alive) this.sim.moveActor(mirror, flying ? 0 : input.moveX, flying ? 0 : input.moveZ, dt);
      }
      this.pendingInputs.push({ seq: input.seq, input });
      if (this.pendingInputs.length > 240) this.pendingInputs.shift();
      this.net.send({ t: 'input', ...input });

      this.simulateClientBullets(dt);
    }
  }

  private drainSimEvents(): void {
    const events = this.sim.drainEvents();
    for (const event of events) {
      this.applyEvent(event);
      this.net.broadcast({ t: 'evt', event });
    }
  }

  private simulateClientBullets(dt: number): void {
    const actors = new Map<number, BulletActor>();
    for (const st of this.latestActors.values()) {
      actors.set(st.id, {
        id: st.id,
        x: st.x,
        z: st.z,
        radius: st.kind === 'player' ? CONFIG.player.radius : CONFIG.enemy.radius,
        alive: st.alive,
      });
    }
    const ctx: BulletCtx = {
      world: this.sim.world,
      props: this.sim.props,
      actors,
      scratch: [],
      drones: this.sim.drones,
    };
    for (const hit of updateBullets(this.clientBullets, ctx, dt)) {
      if (hit.kind === 'static') {
        this.renderer.impact(hit.x, hit.z);
        this.soundAt(hit.x, hit.z, () => this.audio.impact());
      } else if (hit.kind === 'actor') {
        this.renderer.blood(hit.x, hit.z);
      }
    }
  }

  // --------------------------------------------------------------- display

  private updateDisplay(dt: number): void {
    // Fraction of the way to the next fixed tick: frames between ticks blend.
    const alpha = clamp(this.accumulator / CONFIG.tickDt, 0, 1);

    if (this.isAuthority) {
      this.display.clear();
      for (const a of this.sim.actors.values()) {
        const prev = this.prevTick.get(a.id);
        // Teleports (spawns) are not blended.
        const blend = prev && Math.hypot(prev.x - a.x, prev.z - a.z) < 3;
        const isLocal = a.id === this.localId;
        this.display.set(a.id, {
          id: a.id,
          kind: a.kind,
          name: a.name,
          x: blend ? prev!.x + (a.x - prev!.x) * alpha : a.x,
          z: blend ? prev!.z + (a.z - prev!.z) * alpha : a.z,
          // The local aim is shown as it is right now, not as of the last tick.
          ang: isLocal && a.piloting < 0 ? this.frameAim : blend ? prev!.ang + shortestAngle(prev!.ang, a.ang) * alpha : a.ang,
          hp: a.hp,
          maxHp: a.maxHp,
          armor: a.armor,
          alive: a.alive,
          weapon: a.weapon,
          weapons: a.weapons,
          buffs: a.buffs,
          shield: a.shield,
          grenades: a.grenades,
          money: a.money,
          tier: a.tier,
          tierKills: a.tierKills,
          ammo: a.ammo,
          reloading: a.reloading,
          flashOn: a.flashOn,
          slot: a.slot,
          smokes: a.smokes,
          flashes: a.flashes,
          molotovs: a.molotovs,
          burning: a.burnT > 0,
          blind: a.blind,
          concealed: a.concealed,
          team: a.team,
          carrying: a.carrying,
          useT: a.useT,
          // The local player's own stance is known now, not a tick later.
          crouched: isLocal ? this.frameGait === 'crouch' : a.gait === 'crouch',
          downed: a.downed,
          downT: a.downT,
          reviveT: a.reviveT,
          role: a.role,
          aiming: a.role === 'sniper' && a.ai?.mode === 'attack',
          cls: a.cls,
          shieldUsed: a.shieldUsed,
          color: a.color,
          drones: a.drones,
          streak: a.streak,
          strikes: a.strikes,
          mines: a.mines,
          flares: a.flares,
          hold: a.holdT,
          piloting: a.piloting,
          isLocal,
          moving: a.moving,
        });
      }
      for (const id of this.prevTick.keys()) if (!this.sim.actors.has(id)) this.prevTick.delete(id);
    } else {
      this.interpolate(dt, alpha);
    }

    for (const d of this.display.values()) {
      const visual = this.renderer.ensureActor(d.id, this.colorFor(d.id), d.kind === 'player');
      visual.concealed = d.concealed;
      visual.update(d, dt);
      if (d.burning && d.alive) this.renderer.burnOn(d.id, d.x, d.z, dt);
    }
    // Actors gone from the simulation (left, cleared bodies) leave the scene.
    this.renderer.pruneActors(this.display);

    // Bullets advance between ticks too.
    const ahead = this.accumulator;
    const src = this.isAuthority ? this.sim.bullets : this.clientBullets;
    this.renderer.syncTracers(
      src.map((b) => ({ x: b.x + b.vx * ahead, z: b.z + b.vz * ahead, vx: b.vx, vz: b.vz, color: b.color, flame: WEAPONS[b.weapon].flame })),
    );
    this.renderer.syncProps(this.sim.props.map((p) => ({ id: p.id, x: p.x, z: p.z, alive: p.alive, hp: p.hp, kind: p.kind, hw: p.hw, hh: p.hh })));
    this.renderer.syncDoors(this.sim.doors.map((d) => ({ room: d.room, open: d.open, openT: d.openT })));
    this.renderer.syncItems(this.sim.pickups, this.sim.powerups);
    this.renderer.syncGrenades(this.sim.grenades, this.isAuthority ? this.accumulator : 0);
    this.renderer.setSmokes(this.sim.smokes);
    this.renderer.setFires(this.sim.fires, dt);
    this.renderer.syncInteractables(this.sim.interactables);
    this.renderer.syncWorldExtras(this.sim.drops, this.sim.shells, this.sim.flares, dt);
    this.renderer.setHiddenProps(this.hiddenMines());
    const drones = this.droneViews();
    this.renderer.syncDrones(drones, dt);
    // The buzz: a short whine from every drone in the air, panned to where it is.
    this.droneBuzzT -= dt;
    if (this.droneBuzzT <= 0 && drones.length > 0) {
      this.droneBuzzT = 0.12;
      for (const d of drones) if (!d.down) this.soundAt(d.x, d.z, (dist) => this.audio.buzz(dist));
    }
    // A carried flag follows its carrier as drawn (smooth), not the last snapshot.
    const flags = this.sim.flags.map((f) => {
      const d = f.carrier >= 0 ? this.display.get(f.carrier) : undefined;
      return d ? { ...f, x: d.x, z: d.z } : f;
    });
    this.renderer.syncFlags(flags, this.sim.bases);
    // The bomb: shown lying or planted; carried, only to the carrier's side.
    const bomb = this.sim.bomb;
    const carrier = bomb && bomb.carrier >= 0 ? this.display.get(bomb.carrier) : undefined;
    const shownBomb = !bomb ? null : carrier ? (this.isHostile(carrier.id) ? null : { ...bomb, x: carrier.x, z: carrier.z }) : bomb;
    this.renderer.syncBomb(shownBomb, this.sim.sites);
    // Snipers on target: a red laser (drawn above the dark — the warning).
    const lasers: { x: number; z: number; ang: number }[] = [];
    for (const d of this.display.values()) if (d.alive && d.aiming && this.isHostile(d.id)) lasers.push({ x: d.x, z: d.z, ang: d.ang });
    this.renderer.syncLasers(lasers);
    // Room tasks of the current room (and the next, once its door is open).
    this.renderer.syncObjectives(this.sim.objectives.filter((o) => !o.done && o.room <= this.sim.roomIndex + 1));
  }

  /**
   * Client view: remote actors are drawn `interpDelay` in the past, blended
   * between the two snapshots around that time (briefly extrapolated if the
   * next one is late). The local player is the prediction, blended between
   * prediction ticks plus a decaying correction offset.
   */
  private interpolate(dt: number, alpha: number): void {
    if (this.snapBuffer.length === 0) return;
    const nowSec = performance.now() / 1000;
    const target = nowSec + this.clockOffset - CONFIG.interpDelayMs / 1000;
    // Advance smoothly; never go backwards, catch up gradually.
    this.renderTime = Math.max(this.renderTime + dt * 0.5, Math.min(this.renderTime + dt * 1.5, target));
    if (Math.abs(this.renderTime - target) > 0.3) this.renderTime = target;
    const t = this.renderTime;

    const buf = this.snapBuffer;
    let older = buf[0];
    let newer = buf[0];
    for (let i = buf.length - 1; i > 0; i--) {
      if (buf[i - 1].time <= t) {
        older = buf[i - 1];
        newer = buf[i];
        break;
      }
    }
    let k: number;
    if (t >= buf[buf.length - 1].time && buf.length >= 2) {
      // Late snapshot: extrapolate along the last motion, at most 100 ms.
      older = buf[buf.length - 2];
      newer = buf[buf.length - 1];
      const span = newer.time - older.time;
      k = span > 1e-6 ? 1 + Math.min(0.1, t - newer.time) / span : 1;
    } else {
      const span = newer.time - older.time;
      k = span > 1e-6 ? clamp((t - older.time) / span, 0, 1) : 1;
    }

    const decay = Math.exp(-12 * dt);
    this.correction.x *= decay;
    this.correction.z *= decay;

    this.display.clear();
    for (const [id, b] of newer.actors) {
      const a = older.actors.get(id) ?? b;
      // No blending across deaths/respawns (teleports).
      const jump = a.alive !== b.alive || Math.hypot(a.x - b.x, a.z - b.z) > 4;
      const kk = jump ? 1 : k;
      const d: DisplayActor = {
        id,
        kind: b.kind,
        name: b.name,
        x: a.x + (b.x - a.x) * kk,
        z: a.z + (b.z - a.z) * kk,
        ang: a.ang + shortestAngle(a.ang, b.ang) * Math.min(1, kk),
        hp: b.hp,
        maxHp: b.maxHp,
        armor: b.armor ?? 0,
        alive: b.alive,
        weapon: b.weapon,
        weapons: b.weapons ?? [b.weapon],
        buffs: b.buffs ?? { damage: 0, speed: 0, rapid: 0, nv: 0 },
        shield: b.shield ?? 0,
        grenades: b.grenades ?? 0,
        money: b.money ?? 0,
        tier: b.tier ?? 0,
        tierKills: b.tierKills ?? 0,
        ammo: b.ammo,
        reloading: b.reloading,
        flashOn: b.flashOn,
        slot: b.slot,
        smokes: b.smokes ?? 0,
        flashes: b.flashes ?? 0,
        molotovs: b.molotovs ?? 0,
        burning: b.burning ?? false,
        blind: b.blind ?? 0,
        concealed: b.concealed ?? false,
        team: b.team ?? -1,
        carrying: b.carrying ?? -1,
        useT: b.useT ?? 0,
        crouched: b.id === this.localId ? this.frameGait === 'crouch' : (b.crouched ?? false),
        downed: b.downed ?? false,
        downT: b.downT ?? 0,
        reviveT: b.reviveT ?? 0,
        role: b.role ?? 'grunt',
        aiming: b.aiming ?? false,
        cls: b.cls ?? null,
        shieldUsed: b.shieldUsed ?? false,
        color: b.color ?? -1,
        drones: b.drones ?? 0,
        streak: b.streak ?? 0,
        strikes: b.strikes ?? 0,
        mines: b.mines ?? 0,
        flares: b.flares ?? 0,
        hold: b.hold ?? 0,
        piloting: b.piloting ?? -1,
        isLocal: id === this.localId,
        moving: false,
      };
      if (d.isLocal) {
        const mirror = this.sim.actors.get(this.localId);
        const latest = this.latestActors.get(this.localId);
        if (mirror) {
          d.x = this.mirrorPrev.x + (mirror.x - this.mirrorPrev.x) * alpha + this.correction.x;
          d.z = this.mirrorPrev.z + (mirror.z - this.mirrorPrev.z) * alpha + this.correction.z;
        }
        const flying = (latest?.piloting ?? -1) >= 0;
        if (!flying) d.ang = this.frameAim;
        // Own stats: newest values, not the interpolation-delayed ones.
        if (latest) {
          d.hp = latest.hp;
          d.alive = latest.alive;
          d.ammo = latest.ammo;
          d.reloading = latest.reloading;
          d.weapon = latest.weapon;
          d.flashOn = latest.flashOn;
          d.money = latest.money ?? 0;
          d.grenades = latest.grenades ?? 0;
        }
      }
      this.display.set(id, d);
    }
  }

  private isPlayerId(id: number): boolean {
    return id < 1000;
  }

  private colorFor(id: number): number {
    if (isTeamMode(this.matchMode)) {
      const team = this.display.get(id)?.team ?? -1;
      if (team >= 0) return TEAM_COLORS[team];
    }
    if (id >= 1000) return ROLE_COLORS[this.display.get(id)?.role ?? 'grunt'];
    const chosen = this.display.get(id)?.color ?? -1;
    if (chosen >= 0) return chosen;
    return PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length];
  }

  private localDisplay(): DisplayActor | null {
    return this.display.get(this.localId) ?? null;
  }

  /** Drones as drawn: carried forward from the last tick / snapshot. */
  private droneViews(): (Drone & { y: number })[] {
    const ahead = this.isAuthority ? this.accumulator : Math.min(0.12, (performance.now() - this.droneSyncAt) / 1000);
    const D = CONFIG.drone;
    return this.sim.drones.map((d) => ({
      ...d,
      x: d.x + d.vx * ahead,
      z: d.z + d.vz * ahead,
      y: d.down ? Math.max(0.1, 1.6 * (1 - d.downT / D.fallTime)) : 1.6,
    }));
  }

  /** The drone the local player is flying, as drawn. */
  private localDrone(): (Drone & { y: number }) | null {
    const self = this.localDisplay();
    if (!self || self.piloting < 0) return null;
    return this.droneViews().find((d) => d.id === self.piloting && !d.down) ?? null;
  }

  /**
   * While dead: the killer for the first seconds (lit up even in the dark),
   * then a living ally. Null when alive or with no one to watch.
   */
  private spectateTarget(self: DisplayActor | null): DisplayActor | null {
    if (!self || self.alive || !this.spectate) {
      this.spectate = self && !self.alive ? this.spectate : null;
      this.renderer.forceReveal(-1);
      return null;
    }
    const since = (performance.now() - this.spectate.at) / 1000;
    const killer = this.display.get(this.spectate.killer);
    if (since < 2.5 && killer?.alive && killer.id !== this.localId) {
      this.renderer.forceReveal(killer.id);
      return killer;
    }
    this.renderer.forceReveal(-1);
    for (const d of this.display.values()) {
      if (d.id !== this.localId && d.alive && !this.isHostile(d.id) && d.kind === 'player') return d;
    }
    for (const d of this.display.values()) {
      if (d.id !== this.localId && d.alive && !this.isHostile(d.id)) return d;
    }
    return null;
  }

  /** Co-op: what a downed player, or someone next to one, should do. */
  private downedPrompt(self: DisplayActor | null): string {
    if (!self?.alive) return '';
    const drone = this.localDrone();
    if (drone) return `ДРОН · ${Math.ceil(drone.battery)} С · ${Math.round(Math.hypot(drone.vx, drone.vz) * 3.6)} КМ/Ч · ЛКМ — ПОДРЫВ`;
    const D = CONFIG.down;
    if (self.downed) {
      return self.reviveT > 0
        ? `ВАС ПОДНИМАЮТ · ${Math.round((self.reviveT / D.reviveTime) * 100)}%`
        : `ВЫ РАНЕНЫ · ЖДИТЕ ПОМОЩИ · ${Math.ceil(self.downT)} С`;
    }
    for (const d of this.display.values()) {
      if (d.id === this.localId || !d.alive || !d.downed || this.isHostile(d.id)) continue;
      if (Math.hypot(d.x - self.x, d.z - self.z) > D.reach + 1) continue;
      return d.reviveT > 0 ? `ПОДНИМАЕТЕ · ${Math.round((d.reviveT / D.reviveTime) * 100)}%` : `ЗАЖМИТЕ E — ПОДНЯТЬ ${d.name.toUpperCase()}`;
    }
    const near = this.nearUsePrompt(self);
    if (near) return near;
    const O = CONFIG.objectives;
    for (const o of this.sim.objectives) {
      if (o.done || o.room !== this.sim.roomIndex || Math.hypot(o.x - self.x, o.z - self.z) > O.reach + 0.5) continue;
      const need = o.kind === 'hack' ? O.hackTime : O.defuseTime;
      const what = o.kind === 'hack' ? 'ВЗЛОМ' : 'РАЗМИНИРОВАНИЕ';
      return o.progress > 0 ? `${what} · ${Math.round((o.progress / need) * 100)}%` : `ЗАЖМИТЕ E — ${what}`;
    }
    return '';
  }

  /** Minimap noise radar: an unseen enemy's shot or step leaves a blip. */
  private noteNoise(owner: number, x: number, z: number): void {
    if (!this.isHostile(owner) || this.renderer.isRevealed(owner)) return;
    this.noiseBlips.push({ x, z, at: performance.now() });
    if (this.noiseBlips.length > 40) this.noiseBlips.shift();
  }

  /** Enemy mines are invisible unless you are almost on them. */
  private hiddenMines(): Set<number> {
    const out = new Set<number>();
    const self = this.localDisplay();
    for (const p of this.sim.props) {
      if (p.kind !== 'mine' || !p.alive) continue;
      const owner = p.ownerId ?? -1;
      if (owner === this.localId || !this.isHostile(owner)) continue;
      if (self && Math.hypot(p.x - self.x, p.z - self.z) < CONFIG.mine.seenAt) continue;
      out.add(p.id);
    }
    return out;
  }

  /** What E does here: an object, a supply crate, a door, barbed wire. */
  private nearUsePrompt(self: DisplayActor): string {
    const I = CONFIG.interact;
    const hold = self.hold;
    for (const d of this.sim.drops) {
      if (d.landT > 0 || Math.hypot(d.x - self.x, d.z - self.z) > CONFIG.drop.reach + 0.3) continue;
      return hold > 0 ? `ВСКРЫТИЕ ЯЩИКА · ${Math.min(100, Math.round((hold / CONFIG.drop.openTime) * 100))}%` : 'ЗАЖМИТЕ E — ВСКРЫТЬ СБРОС';
    }
    let best: Interactable | null = null;
    let bestD: number = I.reach;
    for (const o of this.sim.interactables) {
      const d = Math.hypot(o.x - self.x, o.z - self.z);
      if (d < bestD) {
        best = o;
        bestD = d;
      }
    }
    const door = this.sim.doors.find((d) => d.room >= ARENA_DOOR_BASE && Math.hypot(d.body.cx - self.x, d.body.cz - self.z) < I.doorReach);
    if (door && (!best || Math.hypot(door.body.cx - self.x, door.body.cz - self.z) < bestD)) return door.open ? 'E — ЗАКРЫТЬ ДВЕРЬ' : 'E — ОТКРЫТЬ ДВЕРЬ';
    if (best) {
      if (best.kind === 'switch') return best.cd > 0 ? 'РУБИЛЬНИК…' : best.on ? 'E — ВЫКЛЮЧИТЬ СВЕТ' : 'E — ВКЛЮЧИТЬ СВЕТ';
      if (best.kind === 'ammo') return best.cd > 0 ? `ЯЩИК ПАТРОНОВ · ${Math.ceil(best.cd)} С` : 'E — ПОПОЛНИТЬ ПАТРОНЫ';
      return best.charge < 1 ? 'МЕДПУНКТ ПУСТ' : `ЗАЖМИТЕ E — ЛЕЧЕНИЕ · ЗАПАС ${Math.round(best.charge)}`;
    }
    if (hold > 0) return `РЕЖЕМ ПРОВОЛОКУ · ${Math.min(100, Math.round((hold / CONFIG.wire.cutTime) * 100))}%`;
    const wire = this.sim.props.find((p) => p.alive && p.kind === 'wire' && Math.abs(self.x - p.x) < p.hw + 0.7 && Math.abs(self.z - p.z) < p.hh + 0.7);
    if (wire) return 'ЗАЖМИТЕ E — РЕЗАТЬ ПРОВОЛОКУ';
    return '';
  }

  private onInteractEvent(event: GameEvent): void {
    const x = event.x ?? 0;
    const z = event.z ?? 0;
    const mine = event.ownerId === this.localId;
    if (event.id === 'switch') {
      this.soundAt(x, z, (d) => this.audio.click(d));
      if (mine) this.hud.message(event.text === 'on' ? 'Свет включён' : 'Свет выключен — зона во тьме', 'info');
    } else if (event.id === 'ammo') {
      this.soundAt(x, z, () => this.audio.reload());
      if (mine) this.hud.message('Боезапас пополнен', 'good');
    } else if (event.id === 'med') {
      if (mine) this.audio.tone(660, 880, 0.12, 0.04, 'triangle');
    } else if (event.id === 'door') {
      this.soundAt(x, z, (d) => d < 25 && this.audio.door());
    }
  }

  private onDropEvent(event: GameEvent): void {
    const x = event.x ?? 0;
    const z = event.z ?? 0;
    if (event.id === 'incoming') {
      this.audio.plane();
      this.hud.banner('СБРОС СНАРЯЖЕНИЯ', 'ящик отмечен на карте');
      this.markBlips.push({ x, z, at: performance.now() });
    } else if (event.id === 'landed') {
      this.soundAt(x, z, () => this.audio.impact());
      this.renderer.impact(x, z);
    } else if (event.id === 'opened') {
      if (event.ownerId === this.localId) {
        this.audio.powerup();
        const gun = event.weapon ? WEAPONS[event.weapon]?.name : event.text === 'drones' ? '+2 FPV-дрона (X)' : undefined;
        this.hud.message(`Сброс вскрыт${gun ? `: ${gun}` : ''} и бонусы`, 'good');
      } else {
        const who = this.display.get(event.ownerId ?? -1)?.name ?? 'кто-то';
        this.hud.message(`${who} забрал сброс`, 'info');
      }
    }
  }

  private onStreakEvent(event: GameEvent): void {
    const n = Number(event.id ?? 0);
    if (event.ownerId === this.localId) {
      this.audio.powerup();
      if (n === CONFIG.streak.radarAt) this.hud.banner(`СЕРИЯ ${n}`, 'радар: враги на карте');
      else this.hud.banner(`СЕРИЯ ${n}`, 'миномётный удар готов — T по курсору');
    } else {
      const who = this.display.get(event.ownerId ?? -1)?.name;
      if (who && n >= CONFIG.streak.strikeAt) this.hud.message(`${who}: серия ${n}`, 'warn');
    }
  }

  /** Next grenade kind the player carries, after the selected one (Q). */
  private nextNadeKind(): GrenadeKind {
    const self = this.localDisplay();
    const order: GrenadeKind[] = ['frag', 'smoke', 'flash', 'molotov', 'flare'];
    const carried: Record<GrenadeKind, number> = self
      ? { frag: self.grenades, smoke: self.smokes, flash: self.flashes, molotov: self.molotovs, flare: self.flares }
      : { frag: 0, smoke: 0, flash: 0, molotov: 0, flare: 0 };
    const count = (k: GrenadeKind) => carried[k];
    const start = order.indexOf(this.nadeKind);
    for (let step = 1; step <= order.length; step++) {
      const k = order[(start + step) % order.length];
      if (count(k) > 0) return k;
    }
    return order[(start + 1) % order.length];
  }

  /** Current spread multiplier of the local player, for the crosshair. */
  private localSpread(): number {
    const actor = this.sim.actors.get(this.localId);
    return actor ? this.sim.spreadMul(actor) : 1;
  }

  /**
   * Plays a sound from a world point: `play` gets the distance to the
   * listener and the sound comes from that side of the screen.
   */
  private soundAt(x: number, z: number, play: (dist: number) => void): void {
    const self = this.localDisplay();
    const dist = self ? Math.hypot(self.x - x, self.z - z) : 0;
    // Pure direction, not loudness (distance already sets that); right next
    // to you a sound is centred.
    const pan = self && dist > 1.5 ? ((x - self.x) / dist) * 0.85 : 0;
    this.audio.from(pan, () => play(dist));
  }

  private localActorPosition(x: number, z: number): number {
    const self = this.localDisplay();
    if (!self) return 0;
    return Math.hypot(self.x - x, self.z - z);
  }

  /**
   * Flashlights to draw (local first: the renderer pairs spotlights by
   * index). In deathmatch only the local player's sight counts as vision.
   */
  private playerLights(): { x: number; z: number; ang: number; flashOn: boolean; alive: boolean; nv: boolean; blind: number }[] {
    const out: { id: number; x: number; z: number; ang: number; flashOn: boolean; alive: boolean; nv: boolean; blind: number }[] = [];
    const team = this.localTeam();
    for (const d of this.display.values()) {
      if (d.kind !== 'player') continue;
      // Team modes: the other side's humans are not your eyes.
      if (isTeamMode(this.matchMode) && d.team !== team) continue;
      // A pilot sees through the drone's camera (its own small lamp on).
      const eye = d.piloting >= 0 ? this.sim.drones.find((x) => x.id === d.piloting && !x.down) : undefined;
      if (eye) {
        const view = this.droneViews().find((x) => x.id === eye.id)!;
        out.push({ id: d.id, x: view.x, z: view.z, ang: d.isLocal ? this.frameAim : eye.ang, flashOn: true, alive: d.alive, nv: d.buffs.nv > 0, blind: d.blind });
        continue;
      }
      out.push({ id: d.id, x: d.x, z: d.z, ang: d.ang, flashOn: d.flashOn, alive: d.alive, nv: d.buffs.nv > 0, blind: d.blind });
    }
    out.sort((a, b) => (a.id === this.localId ? 0 : 1) - (b.id === this.localId ? 0 : 1));
    return out.slice(0, 2);
  }

  /**
   * Flashlight beams of hostile soldiers: drawn above the fog of war, so a
   * lit flashlight gives its owner away even when the body is hidden.
   */
  private beams(): { x: number; z: number; ang: number }[] {
    const out: { x: number; z: number; ang: number }[] = [];
    for (const d of this.display.values()) {
      if (d.alive && d.flashOn && this.isHostile(d.id)) out.push({ x: d.x, z: d.z, ang: d.ang });
    }
    return out;
  }

  // ------------------------------------------------------------------- hud

  private updateFootsteps(dt: number): void {
    const self = this.localDisplay();
    const moving = self && this.frameMove.x * this.frameMove.x + this.frameMove.z * this.frameMove.z > 0.01;
    if (!self || !self.alive || !moving || this.frameGait === 'crouch') {
      this.lastFootstep = 0;
      return;
    }
    this.lastFootstep -= dt;
    if (this.lastFootstep <= 0) {
      const walking = this.frameGait === 'walk';
      this.audio.step(walking ? 0.4 : 1);
      this.lastFootstep = (self.buffs.speed > 0 ? 0.32 : 0.42) * (walking ? 1.5 : 1);
    }
  }

  private scoreTable(): HudScore[] {
    const rows = this.isAuthority ? this.scoreRows() : this.scores;
    return rows
      .map(([id, kills, deaths, rounds]) => ({
        name: id === this.localId ? `${this.nameOf(id) === 'вы' ? this.localName : this.nameOf(id)} (вы)` : this.nameOf(id),
        kills,
        deaths,
        rounds: rounds ?? 0,
        tier: this.tierOf(id),
        isLocal: id === this.localId,
        isBot: id >= 1000,
        team: this.display.get(id)?.team ?? -1,
      }))
      .sort((a, b) =>
        isTeamMode(this.matchMode) && a.team !== b.team
          ? a.team - b.team
          : this.matchMode === 'comp'
          ? b.rounds - a.rounds || b.kills - a.kills
          : this.matchMode === 'gun'
            ? b.tier - a.tier || b.kills - a.kills
            : b.kills - a.kills || a.deaths - b.deaths,
      );
  }

  private tierOf(id: number): number {
    const a = this.display.get(id);
    return a ? a.tier * 10 + a.tierKills : 0;
  }

  private updateHud(): void {
    const self = this.localDisplay();
    const watched = this.spectateTarget(self);
    const cameraTarget = watched ?? this.localDrone() ?? self ?? { x: this.map.spawnX, z: this.map.spawnZ };
    this.renderer.setCameraTarget(cameraTarget.x, cameraTarget.z);
    this.hud.setSpectating(
      watched && watched.id !== this.localId
        ? `${watched.id === this.spectate?.killer ? 'ВАС УБИЛ' : 'НАБЛЮДЕНИЕ'}: ${watched.name.toUpperCase()}`
        : this.downedPrompt(self),
    );

    if (!self) return;

    this.renderer.setNightVision(self.alive && self.buffs.nv > 0);

    const def = WEAPONS[self.weapon];
    const players = [...this.display.values()]
      .filter(
        (d) =>
          d.kind === 'player' &&
          (isCoopMode(this.matchMode) || d.isLocal || (isTeamMode(this.matchMode) && d.team === this.localTeam())),
      )
      .map((d) => ({
        name: d.isLocal ? `${d.name} (вы)` : d.name,
        hp: d.hp,
        maxHp: d.maxHp,
        alive: d.alive,
        isLocal: d.isLocal,
        color: this.colorFor(d.id),
      }));

    let enemiesLeft = 0;
    for (const d of this.display.values()) if (d.kind === 'enemy' && d.alive) enemiesLeft++;
    this.enemyCount = enemiesLeft;

    const respawnIn = !self.alive ? this.sim.actors.get(this.localId)?.respawnT ?? 0 : 0;
    const scores = isArena(this.matchMode) ? this.scoreTable() : [];
    this.hud.update({
      hp: self.hp,
      maxHp: self.maxHp,
      armor: self.armor,
      alive: self.alive,
      weapon: self.weapon,
      weapons: self.weapons,
      ammo: self.ammo,
      mag: def.mag,
      reloading: self.reloading,
      room: this.sim.roomIndex,
      rooms: this.map.rooms.length,
      phase: this.sim.roomPhase,
      players,
      enemiesLeft,
      flashOn: self.flashOn,
      gait: this.frameGait,
      spread: this.localSpread(),
      buffs: self.buffs,
      shield: self.shield,
      respawnIn: this.isAuthority && Number.isFinite(respawnIn) ? respawnIn : 0,
      timeLeft: this.isAuthority ? this.sim.timeLeft : this.timeLeft,
      scores,
      grenades: self.grenades,
      smokes: self.smokes,
      flashes: self.flashes,
      molotovs: self.molotovs,
      nadeKind: this.nadeKind,
      team: this.localTeam(),
      teamScore: this.isAuthority ? this.sim.teamScore : this.teamScore,
      wave: this.waveState(),
      task: this.sim.objectives.find((o) => o.room === this.sim.roomIndex && !o.done) ?? null,
      flags: this.sim.flags,
      carrying: self.carrying,
      bomb: this.sim.bomb,
      useT: self.useT,
      bombCarrier: this.sim.bomb?.carrier === this.localId,
      attackTeam: this.sim.attackTeam,
      cls: self.cls,
      shieldReady: self.cls === 'engineer' && !self.shieldUsed,
      drones: self.drones,
      flares: self.flares,
      mines: self.mines,
      strikes: self.strikes,
      streak: self.streak,
      blind: self.blind,
      money: self.money,
      tier: self.tier,
      tierKills: self.tierKills,
      round: this.localRoundState(),
      modeTitle: modeInfo(this.matchMode).title,
    });

    // Fog of war applies to the minimap too: only hostiles that are seen,
    // unless a radar (powerup or kill streak) is running.
    const radar = (self.buffs.radar ?? 0) > 0;
    const known = [...this.display.values()]
      .filter((d) => !this.isHostile(d.id) || this.renderer.isRevealed(d.id) || (radar && d.alive))
      .map((d) => ({ ...d, ally: !this.isHostile(d.id) }));
    const now = performance.now();
    this.noiseBlips = this.noiseBlips.filter((b) => now - b.at < 1500);
    this.markBlips = this.markBlips.filter((b) => now - b.at < 4000);
    this.hud.drawMinimap(this.map, known, this.localId, this.matchMode === 'coop' ? this.map.rooms[this.sim.roomIndex] : undefined, {
      noise: this.noiseBlips.map((b) => ({ x: b.x, z: b.z, life: 1 - (now - b.at) / 1500 })),
      marks: this.markBlips.map((b) => ({ x: b.x, z: b.z, life: 1 - (now - b.at) / 4000 })),
    });
    this.updatePlates();
  }

  private updatePlates(): void {
    const plates: HudPlate[] = [];
    for (const d of this.display.values()) {
      if (!d.alive) continue;
      const hostile = this.isHostile(d.id);
      if (hostile && !this.renderer.isRevealed(d.id)) continue;
      const p = this.renderer.project(d.x, 2.55, d.z);
      if (!p.visible) continue;
      plates.push({
        id: d.id,
        x: p.x,
        y: p.y,
        // Arena bots and players have names worth showing.
        name: d.kind === 'enemy' && this.matchMode === 'coop' ? '' : d.name,
        hpRatio: d.hp / d.maxHp,
        armorRatio: d.armor / CONFIG.powerups.maxArmor,
        kind: d.isLocal ? 'self' : hostile ? 'enemy' : 'ally',
      });
    }
    // Powerups near the player: what lies there, before walking over it.
    const me = this.display.get(this.localId);
    if (me?.alive) {
      for (const pu of this.sim.powerups) {
        if (!pu.active || Math.hypot(pu.x - me.x, pu.z - me.z) > 11) continue;
        const p = this.renderer.project(pu.x, 1.45, pu.z);
        if (!p.visible) continue;
        plates.push({ id: -1 - pu.id, x: p.x, y: p.y, name: POWERUP_INFO[pu.kind].name, hpRatio: 0, armorRatio: 0, kind: 'item', color: POWERUP_COLOR[pu.kind] });
      }
    }
    this.hud.updatePlates(plates);
  }

  get enemiesLeft(): number {
    return this.enemyCount;
  }
}

function shortestAngle(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** The parts of an input that happen once per press, not every tick. */
