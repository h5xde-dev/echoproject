import type {
  AwardsMsg,
  ByeMsg,
  ClientMessage,
  EventMsg,
  HostMessage,
  LobbyMsg,
  OverMsg,
  PlayerJoinedMsg,
  PlayerLeftMsg,
  ProgressMsg,
  RankedMsg,
  RoomMsg,
  SnapshotMsg,
  WelcomeMsg,
} from '@echo/shared/net/protocol';
import { ServerLink } from './serverLink';

// The link to a game server: every online match (rooms, co-op, ranked) is run
// by the server, and this browser is one of its clients. See serverLink.ts for
// the transport (WebSocket plus a UDP-like data channel).

export interface NetClientHandlers {
  onRoom(msg: RoomMsg): void;
  onWelcome(msg: WelcomeMsg): void;
  onSnapshot(msg: SnapshotMsg): void;
  onEvent(msg: EventMsg): void;
  onOver(msg: OverMsg): void;
  onJoined(msg: PlayerJoinedMsg): void;
  onLeft(msg: PlayerLeftMsg): void;
  onLobby(msg: LobbyMsg): void;
  onRanked(msg: RankedMsg): void;
  onProgress(msg: ProgressMsg): void;
  onAwards(msg: AwardsMsg): void;
  /** The server closed our seat on purpose (room closed, update, another tab): no reconnect. */
  onBye(msg: ByeMsg): void;
  onLatency(ms: number): void;
  /** The link dropped without us leaving: worth reconnecting. */
  onDisconnected(): void;
}

/** What `send` needs from a link: the server one, or an in-memory one in tests. */
export interface DataChannelLike {
  open: boolean;
  on(event: 'open', cb: () => void): unknown;
  on(event: 'data', cb: (data: unknown) => void): unknown;
  on(event: 'close', cb: (code?: number) => void): unknown;
  on(event: 'error', cb: (err: { type?: string; message?: string }) => void): unknown;
  send(data: unknown): void;
  close(): void;
}

export class Net {
  /** Overridable so the netcode can be exercised without a real server. */
  static linkFactory: (url: string) => DataChannelLike = (url) => new ServerLink(url);

  private conn: DataChannelLike | null = null;
  private handlers: NetClientHandlers | null = null;
  private pingTimer: number | null = null;
  private pingSeq = 0;
  private pingSentAt = new Map<number, number>();
  private lastSnapTick = -1;
  /** The server said goodbye: the close that follows is not a drop. */
  private bye = false;

  /** Connects to the game server at `url` (ticket included); resolves once the link is open. */
  connect(url: string, handlers: NetClientHandlers): Promise<void> {
    this.disconnect();
    this.handlers = handlers;
    this.lastSnapTick = -1;
    this.bye = false;

    return new Promise((resolve, reject) => {
      const conn = Net.linkFactory(url);
      this.conn = conn;
      let opened = false;
      conn.on('open', () => {
        opened = true;
        this.startPinging();
        resolve();
      });
      conn.on('data', (raw) => this.onData(raw));
      conn.on('close', (code) => {
        if (this.conn !== conn) return;
        // 4000: closed on purpose by the server (it sent a bye with the reason).
        if (opened && !this.bye && code !== 4000) handlers.onDisconnected();
        this.stopPinging();
      });
      conn.on('error', (err) => {
        if (this.conn !== conn || opened) return;
        reject(new Error(err.message ?? 'Игровой сервер недоступен.'));
      });
    });
  }

  /** True when snapshots and input travel over the UDP-like channel. */
  get udp(): boolean {
    return this.conn instanceof ServerLink && this.conn.udp;
  }

  get connected(): boolean {
    return !!this.conn?.open;
  }

  private onData(raw: unknown): void {
    const msg = raw as HostMessage;
    const h = this.handlers;
    if (!msg || typeof msg !== 'object' || !h) return;
    switch (msg.t) {
      case 'room':
        h.onRoom(msg);
        break;
      case 'welcome':
        this.lastSnapTick = msg.snapshot.tick - 1;
        h.onWelcome(msg);
        break;
      case 'snap':
        // A welcome restarts the tick count; otherwise only newer snapshots count.
        if (msg.tick <= this.lastSnapTick) break;
        this.lastSnapTick = msg.tick;
        h.onSnapshot(msg);
        break;
      case 'evt':
        h.onEvent(msg);
        break;
      case 'over':
        h.onOver(msg);
        break;
      case 'joined':
        h.onJoined(msg);
        break;
      case 'left':
        h.onLeft(msg);
        break;
      case 'lobby':
        h.onLobby(msg);
        break;
      case 'ranked':
        h.onRanked(msg);
        break;
      case 'progress':
        h.onProgress(msg);
        break;
      case 'awards':
        h.onAwards(msg);
        break;
      case 'bye':
        this.bye = true;
        h.onBye(msg);
        break;
      case 'ping': {
        const sent = this.pingSentAt.get(msg.id);
        if (sent !== undefined) {
          h.onLatency(Math.round(performance.now() - sent));
          this.pingSentAt.delete(msg.id);
        }
        break;
      }
      default:
        break;
    }
  }

  send(msg: ClientMessage): void {
    if (!this.conn?.open) return;
    try {
      this.conn.send(msg);
    } catch {
      /* ignore transient send failures */
    }
  }

  private startPinging(): void {
    this.stopPinging();
    this.pingTimer = window.setInterval(() => {
      const id = ++this.pingSeq;
      this.pingSentAt.set(id, performance.now());
      if (this.pingSentAt.size > 20) {
        const oldest = this.pingSentAt.keys().next().value;
        if (oldest !== undefined) this.pingSentAt.delete(oldest);
      }
      this.send({ t: 'ping', id, time: Date.now() });
    }, 1500);
  }

  private stopPinging(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pingSentAt.clear();
  }

  disconnect(): void {
    this.stopPinging();
    // Cleared before closing, so the close that follows is recognised as ours.
    const conn = this.conn;
    this.conn = null;
    this.handlers = null;
    conn?.close();
  }
}
