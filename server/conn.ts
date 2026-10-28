import nodeDataChannel from 'node-datachannel';
import type { WebSocket } from 'ws';
import type { ClientMessage, HostMessage, RtcMsg } from '../src/net/protocol';
import { SERVER } from './config';
import type { UserRow } from './db';

// One player's link: the WebSocket it came in on, plus a WebRTC data channel
// the server opens to it, unordered with no retransmits (UDP semantics). The
// fast path carries snapshots out and steady input / pings in; everything that
// must arrive goes over the WebSocket. See src/net/serverLink.ts for the
// browser side.

const { PeerConnection } = nodeDataChannel;
type Pc = InstanceType<typeof nodeDataChannel.PeerConnection>;
type Dc = ReturnType<Pc['createDataChannel']>;

let nextConnId = 1;

/** Numbers to 3 decimals on the wire: snapshots shrink by about a third. */
export function encode(msg: HostMessage): string {
  return JSON.stringify(msg, compact);
}

function compact(_key: string, v: unknown): unknown {
  return typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v;
}

export class PlayerConn {
  readonly id = nextConnId++;
  onMessage: ((msg: ClientMessage) => void) | null = null;
  onClose: (() => void) | null = null;
  closed = false;
  private pc: Pc | null = null;
  private dc: Dc | null = null;

  constructor(
    private ws: WebSocket,
    readonly user: UserRow,
  ) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = parse(data.toString());
      if (!msg) return;
      if (msg.t === 'rtc') this.onRtc(msg as RtcMsg);
      else this.onMessage?.(msg as ClientMessage);
    });
    ws.on('close', () => this.shutdown());
    ws.on('error', () => this.shutdown());
    this.openFastPath();
  }

  get udp(): boolean {
    return !!this.dc?.isOpen();
  }

  /** Must arrive: the WebSocket. */
  send(msg: HostMessage | string): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(typeof msg === 'string' ? msg : encode(msg));
  }

  /** Latest-wins traffic: the data channel when it is up, otherwise the WebSocket. */
  sendFast(msg: HostMessage | string): void {
    if (this.closed) return;
    const text = typeof msg === 'string' ? msg : encode(msg);
    if (this.dc?.isOpen() && text.length < this.dc.maxMessageSize()) {
      try {
        if (this.dc.sendMessage(text)) return;
      } catch {
        /* fall through */
      }
    }
    // Snapshots are latest-wins. Do not let a slow VPN client build an
    // unbounded TCP queue of obsolete frames behind the current one.
    if (this.ws.readyState === this.ws.OPEN && this.ws.bufferedAmount < 128 * 1024) this.ws.send(text);
  }

  close(): void {
    this.ws.close();
    this.shutdown();
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.dc?.close();
      this.pc?.close();
    } catch {
      /* already gone */
    }
    this.dc = null;
    this.pc = null;
    this.onClose?.();
  }

  private openFastPath(): void {
    try {
      const pc = new PeerConnection(`p${this.id}`, {
        iceServers: ['stun:stun.l.google.com:19302'],
        portRangeBegin: SERVER.rtc.portBegin,
        portRangeEnd: SERVER.rtc.portEnd,
      });
      this.pc = pc;
      pc.onLocalDescription((sdp, type) => this.send({ t: 'rtc', sdp, type }));
      pc.onLocalCandidate((candidate, mid) => this.send({ t: 'rtc', candidate, mid }));
      const dc = pc.createDataChannel('fast', { unordered: true, maxRetransmits: 0 });
      this.dc = dc;
      dc.onMessage((data) => {
        if (typeof data !== 'string') return;
        const msg = parse(data);
        // Only steady input and pings are expected here.
        if (msg && (msg.t === 'input' || msg.t === 'ping')) this.onMessage?.(msg as ClientMessage);
      });
    } catch (err) {
      console.warn('rtc unavailable:', err instanceof Error ? err.message : err);
      this.pc = null;
      this.dc = null;
    }
  }

  private onRtc(msg: RtcMsg): void {
    if (!this.pc) return;
    try {
      if (msg.sdp && msg.type === 'answer') this.pc.setRemoteDescription(msg.sdp, 'answer');
      else if (msg.candidate) this.pc.addRemoteCandidate(msg.candidate, msg.mid ?? '0');
    } catch {
      /* a bad candidate: the WebSocket still works */
    }
  }
}

function parse(text: string): { t?: string } | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as { t?: string }) : null;
  } catch {
    return null;
  }
}
