import { callService } from '@echo/node-kit/http';
import type { Ticket } from '@echo/node-kit/ticket';
import { buildArena } from '@echo/shared/game/arenas';
import { CONFIG } from '@echo/shared/game/config';
import { generateMap } from '@echo/shared/game/levelgen';
import { isArena, isCoopMode, isTeamMode } from '@echo/shared/game/modes';
import { NO_ONCE, mergeOnce, type OnceInput } from '@echo/shared/game/once';
import { Sim, type PlayerInput } from '@echo/shared/game/sim';
import type { GameEvent, MapData, PlayerClass } from '@echo/shared/game/types';
import type { RoomOptions } from '@echo/shared/net/meta';
import type { AwardsMsg, ClientMessage, HostMessage, LobbyMsg, RankedMsg } from '@echo/shared/net/protocol';
import { sanitizeInput } from '@echo/shared/net/sanitize';
import { buildSnapshot } from '@echo/shared/net/snapshot';
import { newTally, outcomeFor, statEvent, tallyEvent, type MatchStats, type MatchTally } from '@echo/shared/progress';
import { GAME } from './config';
import { encode, type PlayerConn } from './conn';

// One room on the game server: the authoritative simulation of a match, for
// every mode. What a browser host used to do for a room (warm-up lobby, bots
// once two people are in, the match start, joins and leaves) and what the
// ranked server did (no bots, seats kept across a dropped link, rating) now
// both happen here. Nobody's machine is the authority any more.

/** A dropped player may come back for this long before the seat is given up. */
const REJOIN_GRACE_MS = 30_000;
/** A room nobody is connected to closes after this long. */
const EMPTY_CLOSE_MS = 60_000;
/** A finished ranked match: time for the result screens, then the room closes. */
const RANKED_CLOSE_MS = 15_000;
/** Ticks that may throw in a row before the match is called off. */
const MAX_TICK_ERRORS = 30;
export const MAX_SEATS = 8;
/** A public room: results on screen this long, then the next match starts by itself. */
const REMATCH_MS = 10_000;

const IDLE: PlayerInput = { seq: 0, moveX: 0, moveZ: 0, aim: 0, fire: false, reload: false, interact: false, flashlight: false, slot: -1, dt: CONFIG.tickDt };

interface Seat {
  sub: string;
  userId: number | null;
  name: string;
  cls: PlayerClass | null;
  color: number;
  camo?: string;
  badge?: string;
  playerId: number;
  conn: PlayerConn | null;
  input: PlayerInput;
  once: OnceInput;
  lastSeq: number;
  /** When the link dropped (0: connected). */
  droppedAt: number;
  /** Gave up the seat: out of the match (ranked: rated last). */
  left: boolean;
  ready: boolean;
  /** Score kept from the moment the seat was given up. */
  final: { kills: number; deaths: number } | null;
  tally: MatchTally;
  stats: MatchStats;
  win: boolean | null;
}

export type Phase = 'lobby' | 'live' | 'over';

export class Room {
  readonly createdAt = Date.now();
  phase: Phase;
  sim!: Sim;
  map!: MapData;
  closed = false;
  private seats = new Map<string, Seat>();
  private hostSub = '';
  private tick = 0;
  private startedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private last = performance.now();
  private acc = 0;
  private aloneSince = 0;
  private emptySince = Date.now();
  private overAt = 0;
  private tickErrors = 0;

  constructor(
    readonly code: string,
    readonly opts: RoomOptions,
    readonly ranked: boolean,
    private onClose: (room: Room) => void,
  ) {
    // Ranked and public rooms start at once; a private room opens with a
    // warm-up its host ends.
    this.phase = ranked || opts.public ? 'live' : 'lobby';
    this.newSession();
    this.timer = setInterval(() => this.pump(), 1000 / 120);
  }

  get players(): number {
    let n = 0;
    for (const s of this.seats.values()) if (s.conn) n++;
    return n;
  }

  /** Ranked: whose seats these are (the meta server sends them back here after a drop). */
  get subs(): string[] {
    return [...this.seats.values()].filter((s) => !s.left).map((s) => s.sub);
  }

  get full(): boolean {
    return [...this.seats.values()].filter((s) => !s.left).length >= MAX_SEATS;
  }

  // ------------------------------------------------------------------ seats

  /** A browser with a ticket for this room: a new seat, or back to its old one. */
  admit(conn: PlayerConn): void {
    const t = conn.ticket;
    let seat = this.seats.get(t.sub);
    if (seat?.left) {
      if (this.ranked) {
        conn.close('Вы покинули этот бой');
        return;
      }
      // Back in a casual room after the seat was given up: a fresh one.
      this.seats.delete(t.sub);
      seat = undefined;
    }
    if (!seat) {
      if (this.full) {
        conn.close('Комната заполнена');
        return;
      }
      if (this.ranked && this.phase !== 'live') {
        conn.close('Бой уже окончен');
        return;
      }
      seat = this.newSeat(t);
      this.seats.set(t.sub, seat);
      this.seatActor(seat);
      this.topUpBots();
    }
    // The creator hosts (again, after a reconnect); otherwise the first one in.
    // Public rooms have no host: nobody starts or holds up a match.
    if (!this.ranked && !this.opts.public && (t.host || !this.hostSub)) this.hostSub = t.sub;
    this.attach(seat, conn);
  }

  private newSeat(t: Ticket): Seat {
    return {
      sub: t.sub,
      userId: t.userId,
      name: t.name,
      cls: t.cls,
      color: t.color,
      camo: t.camo,
      badge: t.badge,
      playerId: this.freePlayerId(),
      conn: null,
      input: { ...IDLE },
      once: { ...NO_ONCE },
      lastSeq: 0,
      droppedAt: 0,
      left: false,
      ready: false,
      final: null,
      tally: newTally(),
      stats: {},
      win: null,
    };
  }

  /** The seat's soldier in the current simulation, with its cosmetics. */
  private seatActor(seat: Seat): void {
    const actor = this.sim.addPlayer(`p${seat.playerId}`, seat.name, seat.playerId, seat.cls, seat.color);
    actor.camo = seat.camo;
    actor.badge = seat.badge;
  }

  /** Player ids stay under 1000 (co-op guards start there): the smallest free one. */
  private freePlayerId(): number {
    const used = new Set([...this.seats.values()].map((s) => s.playerId));
    let id = 1;
    while (used.has(id)) id++;
    return id;
  }

  private attach(seat: Seat, conn: PlayerConn): void {
    const old = seat.conn;
    seat.conn = conn;
    seat.droppedAt = 0;
    seat.lastSeq = 0;
    // A second tab (or a reconnect before the old link noticed it was gone):
    // the new link wins, without a "left" for everyone.
    if (old && old !== conn) old.close('Вы вошли в эту комнату в другой вкладке');
    conn.onMessage = (msg) => this.onMessage(seat, msg);
    conn.onClose = () => {
      if (seat.conn !== conn) return;
      seat.conn = null;
      seat.droppedAt = Date.now();
      seat.input = { ...IDLE };
      seat.once = { ...NO_ONCE };
      this.broadcast({ t: 'left', playerId: seat.playerId });
      this.sendLobby();
    };
    conn.send({ t: 'room', code: this.code, mode: this.opts.mode, ranked: this.ranked, host: seat.sub === this.hostSub, public: this.opts.public === true });
    this.welcome(seat);
    this.broadcast({ t: 'joined', playerId: seat.playerId, name: seat.name });
    this.sendLobby();
  }

  private welcome(seat: Seat): void {
    seat.conn?.send({
      t: 'welcome',
      playerId: seat.playerId,
      name: seat.name,
      seed: this.map.seed,
      map: this.map,
      snapshot: this.snapshot(),
      colors: { [String(seat.playerId)]: seat.color },
    });
  }

  private onMessage(seat: Seat, msg: ClientMessage): void {
    switch (msg.t) {
      case 'input': {
        const input = sanitizeInput(msg as unknown as Record<string, unknown>, CONFIG.tickDt);
        // Over UDP packets can come late or twice: the newest steers, every
        // packet's one-shots count once.
        if (input.seq > seat.lastSeq) {
          seat.lastSeq = input.seq;
          seat.input = input;
        }
        mergeOnce(seat.once, input);
        break;
      }
      case 'ping':
        if (typeof msg.id === 'number' && typeof msg.time === 'number') seat.conn?.sendFast({ t: 'ping', id: msg.id, time: msg.time });
        break;
      case 'ready':
        if (this.phase === 'lobby') {
          seat.ready = msg.ready === true;
          this.sendLobby();
        }
        break;
      case 'start':
        if (seat.sub === this.hostSub && !this.ranked && this.phase !== 'live') this.startMatch();
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- session

  /** A fresh map and simulation with everyone seated (warm-up, match start, a rematch). */
  private newSession(): void {
    const { mode } = this.opts;
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.map = isArena(mode) ? buildArena(this.opts.arena, seed, mode) : generateMap(seed);
    if (this.opts.mutators?.length) this.map.mutators = [...this.opts.mutators];
    this.sim = new Sim(this.map);
    if (this.opts.fighters) this.sim.fighters = this.opts.fighters;
    if (this.opts.difficulty) this.sim.difficulty = this.opts.difficulty;
    // Ranked: humans only, always.
    if (this.ranked) this.sim.fighters = Math.max(2, this.seats.size);
    for (const seat of this.seats.values()) {
      if (seat.left) continue;
      seat.tally = newTally();
      seat.stats = {};
      seat.win = null;
      seat.final = null;
      this.seatActor(seat);
    }
    this.topUpBots();
    this.tick = 0;
    this.startedAt = Date.now();
    this.aloneSince = 0;
  }

  /**
   * Bots: never in ranked; in a room only if its creator left them on, and
   * only once two people are in, so someone waiting alone for friends is not
   * dropped into a bot match.
   */
  private topUpBots(): void {
    if (this.ranked) {
      this.sim.botsAllowed = false;
      return;
    }
    let humans = 0;
    for (const a of this.sim.actors.values()) if (a.kind === 'player') humans++;
    // A public room fills with bots from the first player: quick play means a fight now.
    this.sim.botsAllowed = this.opts.bots !== false && humans >= (this.opts.public ? 1 : 2);
    this.sim.fillBots();
  }

  /** Host: end the warm-up (or start again after a match): a new map, everyone gets a new welcome. */
  private startMatch(): void {
    this.phase = 'live';
    this.newSession();
    for (const seat of this.seats.values()) if (!seat.left) this.welcome(seat);
    this.sendLobby();
  }

  private sendLobby(): void {
    if (this.ranked || this.opts.public) return;
    const msg: LobbyMsg = {
      t: 'lobby',
      started: this.phase !== 'lobby',
      players: [...this.seats.values()]
        .filter((s) => !s.left && s.conn)
        .map((s) => ({ id: s.playerId, name: s.name, ready: s.sub === this.hostSub || s.ready, host: s.sub === this.hostSub })),
    };
    this.broadcast(msg);
  }

  // ------------------------------------------------------------------- tick

  /** Fixed 60 Hz steps off a faster timer, catching up after a stall (capped). */
  private pump(): void {
    const now = performance.now();
    this.acc = Math.min(this.acc + (now - this.last) / 1000, CONFIG.tickDt * 6);
    this.last = now;
    while (this.acc >= CONFIG.tickDt && !this.closed) {
      this.acc -= CONFIG.tickDt;
      // A throw here must not take every other room down with it.
      try {
        this.step();
        this.tickErrors = 0;
      } catch (err) {
        if (this.tickErrors++ < 3) console.error(`room ${this.code}: tick failed`, err);
        if (this.tickErrors >= MAX_TICK_ERRORS) {
          console.error(`room ${this.code}: ${MAX_TICK_ERRORS} failed ticks in a row, closing`);
          this.close('Сбой на сервере: матч остановлен. Создайте комнату заново.');
          return;
        }
      }
    }
    this.housekeeping();
  }

  private step(): void {
    const dt = CONFIG.tickDt;
    this.tick++;
    for (const seat of this.seats.values()) {
      const actor = this.sim.actors.get(seat.playerId);
      if (!actor || seat.left) continue;
      actor.lagComp = Math.min(CONFIG.lagCompMax, (seat.input.rttMs ?? 0) / 2000);
      // One-shots apply exactly once, even if no new packet came this tick.
      this.sim.applyInput(actor, { ...seat.input, ...NO_ONCE, ...seat.once });
      seat.once = { ...NO_ONCE };
    }

    this.sim.step(dt);
    for (const event of this.sim.drainEvents()) {
      this.broadcast({ t: 'evt', event });
      if (this.phase === 'live') this.count(event);
    }

    if (this.tick % Math.round(1 / CONFIG.snapshotRate / dt) === 0) {
      // Encoded once for everyone.
      const snap = encode(this.snapshot());
      for (const seat of this.seats.values()) seat.conn?.sendFast(snap);
    }

    if (this.phase === 'live' && this.ranked) this.checkAlone();
    if (this.phase === 'live' && this.sim.matchOver) void this.finish();
  }

  /** Experience and the outcome, per seat, from the match's events. */
  private count(event: GameEvent): void {
    const mode = this.opts.mode;
    let ended = false;
    for (const seat of this.seats.values()) {
      if (seat.left) continue;
      const me = this.sim.actors.get(seat.playerId);
      const team = me?.team ?? -1;
      const hostile = (id: number) => this.hostile(team, id);
      tallyEvent(seat.tally, event, seat.playerId, hostile);
      statEvent(seat.stats, event, seat.playerId, hostile);
      const won = outcomeFor(event, mode, seat.playerId, team);
      if (won !== null) {
        seat.win = won;
        ended = true;
      }
    }
    // Co-op victory and a wiped squad end the match without matchOver.
    if (ended) void this.finish();
  }

  private hostile(team: number, id: number): boolean {
    const mode = this.opts.mode;
    if (isTeamMode(mode)) {
      const other = this.sim.actors.get(id)?.team ?? -1;
      return other < 0 || other !== team;
    }
    if (!isCoopMode(mode)) return true;
    return id >= 1000;
  }

  /** Ranked: everyone else gone for a while, the one left wins. */
  private checkAlone(): void {
    const now = Date.now();
    const present = [...this.seats.values()].filter((s) => !s.left && s.conn);
    if (present.length > 1) {
      this.aloneSince = 0;
      return;
    }
    this.aloneSince ||= now;
    if (now - this.aloneSince > GAME.ranked.aloneSec * 1000) {
      const last = present[0];
      this.sim.matchOver = true;
      const event: GameEvent = { type: 'victory', ownerId: last?.playerId ?? -1, text: 'СОПЕРНИКИ ПОКИНУЛИ БОЙ' };
      this.broadcast({ t: 'evt', event });
      if (last) last.win = true;
    }
  }

  /** Seats given up, empty rooms, finished ranked matches. */
  private housekeeping(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const seat of this.seats.values()) {
      if (!seat.left && seat.droppedAt && now - seat.droppedAt > REJOIN_GRACE_MS) this.giveUp(seat);
    }
    if (this.players > 0) this.emptySince = 0;
    else this.emptySince ||= now;
    if (this.emptySince && now - this.emptySince > EMPTY_CLOSE_MS) this.close('');
    else if (this.ranked && this.phase === 'over' && now - this.overAt > RANKED_CLOSE_MS) this.close('');
    else if (this.opts.public && this.phase === 'over' && now - this.overAt > REMATCH_MS) this.startMatch();
  }

  private giveUp(seat: Seat): void {
    const score = this.sim.scores.get(seat.playerId);
    seat.final = { kills: score?.kills ?? 0, deaths: score?.deaths ?? 0 };
    seat.left = true;
    this.sim.removeActor(seat.playerId);
    if (seat.sub === this.hostSub) this.passHost();
    if (!this.ranked) {
      // Out of a casual room for good: the slot (and player id) is free again.
      if (this.phase !== 'live') this.seats.delete(seat.sub);
      this.topUpBots();
    }
    this.sendLobby();
  }

  /** The host walked out: the longest-seated player still here hosts now. */
  private passHost(): void {
    const next = [...this.seats.values()].find((s) => !s.left && s.conn && s.sub !== this.hostSub);
    this.hostSub = next?.sub ?? '';
    if (next) next.conn?.send({ t: 'room', code: this.code, mode: this.opts.mode, ranked: false, host: true });
  }

  private snapshot() {
    const ack: Record<string, number> = {};
    for (const seat of this.seats.values()) ack[String(seat.playerId)] = seat.lastSeq;
    return buildSnapshot(this.sim, this.tick, ack);
  }

  // ------------------------------------------------------------------ result

  private async finish(): Promise<void> {
    if (this.phase !== 'live') return;
    this.phase = 'over';
    this.overAt = Date.now();

    // Places: kills, then fewer deaths; anyone who walked out shares last place.
    const rows = [...this.seats.values()].map((seat) => {
      const live = this.sim.scores.get(seat.playerId);
      const left = seat.left || (this.ranked && !seat.conn);
      const s = seat.final ?? { kills: live?.kills ?? 0, deaths: live?.deaths ?? 0 };
      return { seat, kills: s.kills, deaths: s.deaths, left, place: 0 };
    });
    const stayed = rows.filter((r) => !r.left).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    let place = 0;
    stayed.forEach((r, i) => {
      const prev = stayed[i - 1];
      if (!prev || prev.kills !== r.kills || prev.deaths !== r.deaths) place = i + 1;
      r.place = place;
    });
    for (const r of rows) if (r.left) r.place = stayed.length + 1;
    // Ranked deathmatch: first place wins. Elsewhere the ending event said who won.
    if (this.ranked) for (const r of rows) r.seat.win = r.place === 1 && !r.left;

    // A last snapshot so the final score is on screen.
    const snap = encode(this.snapshot());
    for (const seat of this.seats.values()) seat.conn?.send(snap);
    if (isCoopMode(this.opts.mode)) {
      const won = rows.some((r) => r.seat.win);
      this.broadcast({ t: 'over', win: won, text: '' });
    }
    const awards = this.awards();
    if (awards.length) this.broadcast({ t: 'awards', awards });

    const signedIn = rows.filter((r) => r.seat.userId !== null);
    if (signedIn.length === 0) return;
    type Row = {
      userId: number;
      before: number;
      after: number;
      gained: number;
      xp: number;
      levelBefore: number;
      levelAfter: number;
      unlocked: string[];
      quests?: { text: string; xp: number }[];
      achievements?: { title: string; xp: number; unlock: string }[];
    };
    let result: { rows: Row[] } = { rows: [] };
    try {
      result = await callService<{ rows: Row[] }>(GAME.apiUrl, '/internal/match', GAME.secret, {
        mode: this.opts.mode,
        arena: isArena(this.opts.mode) ? this.opts.arena : '',
        rated: this.ranked,
        startedAt: this.startedAt,
        mutators: this.opts.mutators ?? [],
        players: signedIn.map((r) => ({ userId: r.seat.userId, place: r.place, kills: r.kills, deaths: r.deaths, left: r.left, win: r.seat.win === true, tally: r.seat.tally, stats: r.seat.stats })),
      });
    } catch (err) {
      console.error(`room ${this.code}: could not save the match`, err instanceof Error ? err.message : err);
      for (const r of signedIn) r.seat.conn?.send({ t: 'bye', text: '' });
      return;
    }
    const byUser = new Map(result.rows.map((r) => [r.userId, r]));
    for (const r of signedIn) {
      const got = byUser.get(r.seat.userId!);
      if (got) {
        r.seat.conn?.send({
          t: 'progress',
          gained: got.gained,
          xp: got.xp,
          before: got.levelBefore,
          after: got.levelAfter,
          unlocked: got.unlocked,
          quests: got.quests ?? [],
          achievements: got.achievements ?? [],
        });
      }
    }
    if (this.ranked) {
      const msg: RankedMsg = {
        t: 'ranked',
        rows: rows
          .map((r) => {
            const got = r.seat.userId !== null ? byUser.get(r.seat.userId) : undefined;
            return { id: r.seat.playerId, name: r.seat.name, place: r.place, kills: r.kills, deaths: r.deaths, before: got?.before ?? 0, after: got?.after ?? 0 };
          })
          .sort((a, b) => a.place - b.place),
      };
      this.broadcast(msg);
      console.log(`room ${this.code} rated: ${msg.rows.map((r) => `${r.name} #${r.place} ${Math.round(r.before)}→${Math.round(r.after)}`).join(', ')}`);
    }
  }

  /** Who stood out this match (people only, at least two of them, something to show). */
  private awards(): AwardsMsg['awards'] {
    const people = [...this.seats.values()].filter((s) => !s.left);
    if (people.length < 2) return [];
    const best = (key: string, title: string, unit: (n: number) => string) => {
      const top = people.reduce<Seat | null>((b, s) => ((s.stats[key] ?? 0) > (b?.stats[key] ?? 0) ? s : b), null);
      const n = top?.stats[key] ?? 0;
      return top && n > 0 ? [{ title, playerId: top.playerId, name: top.name, value: unit(n) }] : [];
    };
    return [
      ...best('kills', 'MVP', (n) => `${n} убийств`),
      ...best('revives', 'АНГЕЛ-ХРАНИТЕЛЬ', (n) => `поднял ${n}`),
      ...best('objectives_any', 'ТАКТИК', (n) => `${n} целей`),
      ...best('backstabs', 'ТИХИЙ КЛИНОК', (n) => `${n} в спину`),
      ...best('powerups', 'СБОРЩИК', (n) => `${n} бонусов`),
    ].slice(0, 4);
  }

  private broadcast(msg: HostMessage): void {
    const text = encode(msg);
    for (const seat of this.seats.values()) seat.conn?.send(text);
  }

  /** Shutting down mid-match: what is running may finish (see main.ts). */
  get busy(): boolean {
    return this.phase === 'live' && this.players > 0;
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const seat of this.seats.values()) {
      const conn = seat.conn;
      seat.conn = null;
      conn?.close(reason);
    }
    this.onClose(this);
  }
}
