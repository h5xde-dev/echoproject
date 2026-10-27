import { ARENAS, buildArena } from '../src/game/arenas';
import { CONFIG } from '../src/game/config';
import { NO_ONCE, mergeOnce, type OnceInput } from '../src/game/once';
import { Sim, type PlayerInput } from '../src/game/sim';
import type { PlayerClass } from '../src/game/types';
import type { ClientMessage, HostMessage, RankedMsg } from '../src/net/protocol';
import { buildSnapshot } from '../src/net/snapshot';
import { SERVER } from './config';
import type { PlayerConn } from './conn';
import { saveMatch, userById, type UserRow } from './db';
import { eloUpdate } from './rating';

// A ranked deathmatch hosted by the server: the same simulation the browsers
// run, but nobody's machine is the authority and no bots are added. The match
// ends on the frag limit or the clock; then everyone is rated.

/** A dropped player may come back for this long before the seat is given up. */
const REJOIN_GRACE_MS = 30_000;

export interface Entrant {
  conn: PlayerConn;
  cls: PlayerClass | null;
  color: number;
}

interface Seat {
  playerId: number;
  user: UserRow;
  conn: PlayerConn | null;
  input: PlayerInput;
  once: OnceInput;
  lastSeq: number;
  /** When the link dropped (0: connected). */
  droppedAt: number;
  /** Gave up the seat: out of the match, rated last. */
  left: boolean;
  /** Score kept from the moment the seat was given up. */
  final: { kills: number; deaths: number } | null;
}

const IDLE: PlayerInput = {
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
};

let nextMatchId = 1;

export class RankedMatch {
  readonly id = nextMatchId++;
  readonly arena: string;
  readonly sim: Sim;
  readonly startedAt = Date.now();
  finished = false;
  private seats = new Map<number, Seat>();
  private tick = 0;
  private timer: NodeJS.Timeout | null = null;
  private last = performance.now();
  private acc = 0;
  private aloneSince = 0;

  constructor(
    entrants: Entrant[],
    private onDone: (m: RankedMatch) => void,
  ) {
    this.arena = ARENAS[Math.floor(Math.random() * ARENAS.length)].id;
    const map = buildArena(this.arena, (Math.random() * 0xffffffff) >>> 0, 'dm');
    this.sim = new Sim(map);
    // Ranked: humans only. fillBots() is never called.
    this.sim.fighters = entrants.length;
    let playerId = 1;
    for (const e of entrants) {
      const seat: Seat = {
        playerId: playerId++,
        user: e.conn.user,
        conn: null,
        input: { ...IDLE },
        once: { ...NO_ONCE },
        lastSeq: 0,
        droppedAt: 0,
        left: false,
        final: null,
      };
      this.sim.addPlayer(`u${seat.user.id}`, seat.user.name, seat.playerId, e.cls, e.color);
      this.seats.set(seat.user.id, seat);
    }
    for (const e of entrants) this.attach(this.seats.get(e.conn.user.id)!, e.conn);
    this.timer = setInterval(() => this.pump(), 1000 / 120);
    console.log(`match ${this.id}: ${this.arena}, ${entrants.map((e) => e.conn.user.name).join(', ')}`);
  }

  /** The player has a seat here they have not given up. */
  hasSeat(userId: number): boolean {
    const seat = this.seats.get(userId);
    return !!seat && !seat.left && !this.finished;
  }

  /** Back after a dropped link: same soldier, fresh welcome. */
  rejoin(conn: PlayerConn): boolean {
    const seat = this.seats.get(conn.user.id);
    if (!seat || seat.left || this.finished) return false;
    if (seat.conn && seat.conn !== conn) seat.conn.close();
    this.attach(seat, conn);
    return true;
  }

  private attach(seat: Seat, conn: PlayerConn): void {
    seat.conn = conn;
    seat.droppedAt = 0;
    seat.lastSeq = 0;
    conn.onMessage = (msg) => this.onMessage(seat, msg);
    conn.onClose = () => {
      if (seat.conn !== conn) return;
      seat.conn = null;
      seat.droppedAt = Date.now();
      seat.input = { ...IDLE };
      this.broadcast({ t: 'left', playerId: seat.playerId });
    };
    conn.send({
      t: 'welcome',
      playerId: seat.playerId,
      name: seat.user.name,
      seed: this.sim.map.seed,
      map: this.sim.map,
      snapshot: this.snapshot(),
      colors: {},
    });
    this.broadcast({ t: 'joined', playerId: seat.playerId, name: seat.user.name });
  }

  private onMessage(seat: Seat, msg: ClientMessage): void {
    switch (msg.t) {
      case 'input': {
        // Over UDP packets can come late or twice: the newest steers, every
        // packet's one-shots count once.
        if (msg.seq > seat.lastSeq) {
          seat.lastSeq = msg.seq;
          seat.input = { ...msg, dt: CONFIG.tickDt };
        }
        mergeOnce(seat.once, msg);
        break;
      }
      case 'ping':
        seat.conn?.sendFast({ t: 'ping', id: msg.id, time: msg.time });
        break;
      default:
        break;
    }
  }

  /** Fixed 60 Hz steps off a faster timer, catching up after a stall (capped). */
  private pump(): void {
    const now = performance.now();
    this.acc = Math.min(this.acc + (now - this.last) / 1000, CONFIG.tickDt * 6);
    this.last = now;
    while (this.acc >= CONFIG.tickDt && !this.finished) {
      this.acc -= CONFIG.tickDt;
      this.step();
    }
  }

  private step(): void {
    const dt = CONFIG.tickDt;
    this.tick++;
    const now = Date.now();
    for (const seat of this.seats.values()) {
      const actor = this.sim.actors.get(seat.playerId);
      if (!actor) continue;
      if (!seat.left && seat.droppedAt && now - seat.droppedAt > REJOIN_GRACE_MS) {
        this.giveUp(seat);
        continue;
      }
      actor.lagComp = Math.min(CONFIG.lagCompMax, (seat.input.rttMs ?? 0) / 2000);
      this.sim.applyInput(actor, { ...seat.input, ...NO_ONCE, ...seat.once });
      seat.once = { ...NO_ONCE };
    }

    this.sim.step(dt);
    for (const event of this.sim.drainEvents()) this.broadcast({ t: 'evt', event });

    if (this.tick % Math.round(1 / CONFIG.snapshotRate / dt) === 0) {
      const snap = this.snapshot();
      for (const seat of this.seats.values()) seat.conn?.sendFast(snap);
    }

    // Everyone else gone: no one left to beat.
    const present = [...this.seats.values()].filter((s) => !s.left && s.conn).length;
    if (present <= 1) {
      this.aloneSince ||= now;
      // Alone in the arena for a while: the match is called.
      if (now - this.aloneSince > SERVER.ranked.aloneSec * 1000) {
        const last = [...this.seats.values()].find((s) => !s.left && s.conn);
        this.sim.matchOver = true;
        this.broadcast({ t: 'evt', event: { type: 'victory', ownerId: last?.playerId ?? -1, text: 'СОПЕРНИКИ ПОКИНУЛИ БОЙ' } });
      }
    } else {
      this.aloneSince = 0;
    }

    if (this.sim.matchOver) this.finish();
  }

  private snapshot() {
    const ack: Record<string, number> = {};
    for (const seat of this.seats.values()) ack[String(seat.playerId)] = seat.lastSeq;
    return buildSnapshot(this.sim, this.tick, ack);
  }

  private giveUp(seat: Seat): void {
    const score = this.sim.scores.get(seat.playerId);
    seat.final = { kills: score?.kills ?? 0, deaths: score?.deaths ?? 0 };
    seat.left = true;
    this.sim.removeActor(seat.playerId);
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    // Places: kills, then fewer deaths; anyone who walked out shares last place.
    const rows = [...this.seats.values()].map((seat) => {
      const live = this.sim.scores.get(seat.playerId);
      const left = seat.left || !seat.conn;
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

    // Ratings from the database, not the seat: they may have changed meanwhile.
    const before = rows.map((r) => userById(r.seat.user.id)?.rating ?? r.seat.user.rating);
    const after = eloUpdate(rows.map((r, i) => ({ rating: before[i], place: r.place })));
    try {
      saveMatch(
        this.arena,
        this.startedAt,
        rows.map((r, i) => ({
          userId: r.seat.user.id,
          place: r.place,
          kills: r.kills,
          deaths: r.deaths,
          left: r.left,
          before: before[i],
          after: after[i],
        })),
      );
    } catch (err) {
      console.error(`match ${this.id}: could not save`, err);
    }

    const msg: RankedMsg = {
      t: 'ranked',
      rows: rows
        .map((r, i) => ({ id: r.seat.playerId, name: r.seat.user.name, place: r.place, kills: r.kills, deaths: r.deaths, before: before[i], after: after[i] }))
        .sort((a, b) => a.place - b.place),
    };
    // A last snapshot so the final score is on screen, then the result.
    const snap = this.snapshot();
    for (const seat of this.seats.values()) {
      seat.conn?.send(snap);
      seat.conn?.send(msg);
    }
    console.log(`match ${this.id} over: ${msg.rows.map((r) => `${r.name} #${r.place} ${Math.round(r.before)}→${Math.round(r.after)}`).join(', ')}`);
    this.onDone(this);
  }

  private broadcast(msg: HostMessage): void {
    for (const seat of this.seats.values()) seat.conn?.send(msg);
  }

  /** Server shutdown: end without rating. */
  abort(): void {
    if (this.timer) clearInterval(this.timer);
    this.finished = true;
    for (const seat of this.seats.values()) seat.conn?.close();
  }
}
