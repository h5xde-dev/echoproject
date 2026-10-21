import Peer, { type PeerOptions } from 'peerjs';
import { makeRoomCode } from '../core/rng';
import type {
  ClientMessage,
  EventMsg,
  HostMessage,
  InputMsg,
  OverMsg,
  PlayerJoinedMsg,
  PlayerLeftMsg,
  SnapshotMsg,
  WelcomeMsg,
} from './protocol';

export interface HostClient {
  playerId: number;
  name: string;
  conn: DataChannelLike;
  ready: boolean;
}

export interface NetHostHandlers {
  onClientInput(input: InputMsg, playerId: number): void;
  onClientHello(name: string, playerId: number): void;
  onClientLeave(playerId: number): void;
  onStatus(text: string): void;
  onError(text: string): void;
}

export interface NetClientHandlers {
  onWelcome(msg: WelcomeMsg): void;
  onSnapshot(msg: SnapshotMsg): void;
  onEvent(msg: EventMsg): void;
  onStart(msg: Extract<HostMessage, { t: 'start' }>): void;
  onOver(msg: OverMsg): void;
  onJoined(msg: PlayerJoinedMsg): void;
  onLeft(msg: PlayerLeftMsg): void;
  onStatus(text: string): void;
  onError(text: string): void;
  onLatency(ms: number): void;
}

export interface IceServerEntry {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * Optional self-hosted PeerServer: `?signal=host:port` or a full URL.
 * Without it the public PeerJS cloud server is used.
 */
function peerOptions(): PeerOptions {
  const params = new URLSearchParams(location.search);
  const options: PeerOptions = {};

  const raw = params.get('signal');
  if (raw) {
    try {
      const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
      options.host = url.hostname;
      options.port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
      options.path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
      options.secure = url.protocol === 'https:';
    } catch {
      /* fall back to the cloud server */
    }
  }

  // Extra ICE servers (TURN) as JSON: ?ice=[{"urls":"turn:host:3478","username":"u","credential":"p"}]
  const ice = params.get('ice');
  if (ice) {
    try {
      const parsed = JSON.parse(ice) as IceServerEntry[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        options.config = { iceServers: parsed };
      }
    } catch {
      /* invalid ICE config is ignored */
    }
  }

  return options;
}

/** Minimal surface of a PeerJS data channel used by this module. */
export interface DataChannelLike {
  peer: string;
  open: boolean;
  on(event: 'open', cb: () => void): unknown;
  on(event: 'data', cb: (data: unknown) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  on(event: 'error', cb: (err: { type?: string; message?: string }) => void): unknown;
  send(data: unknown): void;
  close(): void;
}

/** Minimal surface of a PeerJS peer used by this module. */
export interface PeerLike {
  on(event: 'open', cb: (id: string) => void): unknown;
  on(event: 'error', cb: (err: { type?: string; message?: string }) => void): unknown;
  on(event: 'connection', cb: (conn: DataChannelLike) => void): unknown;
  connect(id: string, options?: { reliable?: boolean; serialization?: string }): DataChannelLike;
  destroy(): void;
}

export type PeerFactory = (id?: string) => PeerLike;

export class Net {
  /** Overridable so the netcode can be exercised without a real WebRTC stack. */
  static peerFactory: PeerFactory = (id) =>
    (id === undefined ? new Peer(peerOptions()) : new Peer(id, peerOptions())) as unknown as PeerLike;

  mode: 'offline' | 'host' | 'client' = 'offline';
  code = '';
  myPeerId = '';
  /** Human-readable connection trace, surfaced in the UI and useful for debugging. */
  debug = '';

  private peer: PeerLike | null = null;
  private conn: DataChannelLike | null = null;
  private hostHandlers: NetHostHandlers | null = null;
  private clientHandlers: NetClientHandlers | null = null;
  private hostClients = new Map<string, HostClient>();
  private nextPlayerId = 2;
  private pingTimer: number | null = null;
  private pingSeq = 0;
  private pingSentAt = new Map<number, number>();

  // ------------------------------------------------------------- hosting

  host(handlers: NetHostHandlers): Promise<string> {
    this.mode = 'host';
    this.hostHandlers = handlers;

    return new Promise((resolve, reject) => {
      const attempt = (code: string) => {
        const peer = Net.peerFactory(code);
        this.peer = peer;

        peer.on('open', (id) => {
          this.code = id;
          this.myPeerId = id;
          this.debug = `peer open: ${id}`;
          handlers.onStatus(`Комната ${id} открыта`);
          resolve(id);
        });

        peer.on('connection', (conn) => {
          const playerId = this.nextPlayerId++;
          this.hostClients.set(conn.peer, { playerId, name: 'оператор', conn, ready: false });
          conn.on('open', () => {
            this.debug = `host: client connected (${conn.peer})`;
            handlers.onStatus('Клиент подключается...');
          });
          conn.on('data', (raw) => this.onHostData(raw, conn));
          conn.on('close', () => {
            const c = this.hostClients.get(conn.peer);
            if (c) {
              this.hostClients.delete(conn.peer);
              handlers.onClientLeave(c.playerId);
            }
          });
          conn.on('error', () => {
            /* closed connections are reported through 'close' */
          });
        });

        peer.on('error', (err) => {
          this.debug = `peer error: ${err.type} ${err.message ?? ''}`;
          if (err.type === 'unavailable-id') {
            peer.destroy();
            attempt(makeRoomCode());
            return;
          }
          handlers.onError(describePeerError(err));
          reject(err);
        });
      };

      attempt(makeRoomCode());
    });
  }

  private onHostData(raw: unknown, conn: DataChannelLike): void {
    const msg = raw as ClientMessage;
    if (!msg || typeof msg !== 'object') return;
    let client = this.hostClients.get(conn.peer);
    if (!client) {
      const playerId = this.nextPlayerId++;
      client = { playerId, name: 'оператор', conn, ready: false };
      this.hostClients.set(conn.peer, client);
    }

    switch (msg.t) {
      case 'hello':
        client.name = msg.name.slice(0, 14) || 'оператор';
        client.ready = true;
        this.hostHandlers?.onClientHello(client.name, client.playerId);
        break;
      case 'input':
        this.hostHandlers?.onClientInput(msg, client.playerId);
        break;
      case 'ping': {
        conn.send({ t: 'ping', id: msg.id, time: msg.time } as HostMessage);
        break;
      }
    }
  }

  broadcast(msg: HostMessage): void {
    for (const c of this.hostClients.values()) {
      if (c.conn.open) {
        try {
          c.conn.send(msg);
        } catch {
          /* the connection died mid-send; 'close' will clean it up */
        }
      }
    }
  }

  sendTo(playerId: number, msg: HostMessage): void {
    for (const c of this.hostClients.values()) {
      if (c.playerId === playerId && c.conn.open) {
        try {
          c.conn.send(msg);
        } catch {
          /* the connection died mid-send */
        }
      }
    }
  }

  hostClientCount(): number {
    return this.hostClients.size;
  }

  hostClientsInfo(): { playerId: number; name: string }[] {
    return [...this.hostClients.values()].map((c) => ({ playerId: c.playerId, name: c.name }));
  }

  // ------------------------------------------------------------- joining

  join(code: string, handlers: NetClientHandlers): Promise<void> {
    this.mode = 'client';
    this.clientHandlers = handlers;
    this.code = code.toUpperCase();

    return new Promise((resolve, reject) => {
      const peer = Net.peerFactory();
      this.peer = peer;

      peer.on('open', (id) => {
        this.myPeerId = id;
        this.debug = `client peer open: ${id}, connecting to ${this.code}`;
        const conn = peer.connect(this.code, { reliable: true, serialization: 'json' });
        this.conn = conn;

        conn.on('open', () => {
          this.debug = `channel open with ${conn.peer}`;
          handlers.onStatus('Соединение установлено');
          this.startPinging();
          resolve();
        });

        conn.on('data', (raw) => this.onClientData(raw));

        conn.on('close', () => {
          this.debug = `channel closed (${conn.peer})`;
          handlers.onStatus('Соединение закрыто');
          handlers.onError('Соединение разорвано');
        });

        conn.on('error', (err) => {
          this.debug = `channel error: ${err.type ?? ''} ${err.message ?? ''}`;
          handlers.onError(describePeerError(err));
        });
      });

      peer.on('error', (err) => {
        this.debug = `client peer error: ${err.type} ${err.message ?? ''}`;
        handlers.onError(describePeerError(err));
        reject(err);
      });

      setTimeout(() => {
        if (!this.conn?.open) {
          handlers.onError('Не удалось подключиться. Проверьте код комнаты.');
          reject(new Error('timeout'));
        }
      }, 12000);
    });
  }

  private onClientData(raw: unknown): void {
    const msg = raw as HostMessage;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'welcome':
        this.clientHandlers?.onWelcome(msg);
        break;
      case 'snap':
        this.clientHandlers?.onSnapshot(msg);
        break;
      case 'evt':
        this.clientHandlers?.onEvent(msg);
        break;
      case 'start':
        this.clientHandlers?.onStart(msg);
        break;
      case 'over':
        this.clientHandlers?.onOver(msg);
        break;
      case 'joined':
        this.clientHandlers?.onJoined(msg);
        break;
      case 'left':
        this.clientHandlers?.onLeft(msg);
        break;
      case 'ping': {
        const sent = this.pingSentAt.get(msg.id);
        if (sent !== undefined) {
          this.clientHandlers?.onLatency(Math.round(performance.now() - sent));
          this.pingSentAt.delete(msg.id);
        }
        break;
      }
    }
  }

  send(msg: ClientMessage): void {
    if (this.conn?.open) {
      try {
        this.conn.send(msg);
      } catch {
        /* ignore transient send failures */
      }
    }
  }

  private startPinging(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
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

  disconnect(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.conn?.close();
    this.peer?.destroy();
    this.conn = null;
    this.peer = null;
    this.hostClients.clear();
    this.mode = 'offline';
  }
}

function describePeerError(err: { type?: string; message?: string }): string {
  switch (err.type) {
    case 'peer-unavailable':
      return 'Комната не найдена. Проверьте код.';
    case 'network':
      return 'Ошибка сети. Проверьте подключение.';
    case 'server-error':
      return 'Сигнальный сервер недоступен.';
    case 'browser-incompatible':
      return 'Браузер не поддерживает WebRTC.';
    case 'unavailable-id':
      return 'Этот код уже занят, выберите другой.';
    default:
      return err.message ?? 'Неизвестная ошибка соединения.';
  }
}
