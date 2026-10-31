import type { DataChannelLike } from './net';
import type { ClientMessage, InputMsg, RtcMsg } from '@echo/shared/net/protocol';

// The link to the dedicated server. Two paths:
//  - a WebSocket (TCP): matchmaking, the welcome with the map, game events,
//    and any input that carries a one-shot action (a grenade, a purchase), all
//    of which must arrive;
//  - a WebRTC data channel opened by the server, unordered and without
//    retransmits, so it behaves like UDP: snapshots, steady input and pings.
//    A late snapshot is useless, and waiting for a lost one only adds lag.
// Until the data channel is up (or if UDP is blocked) everything goes over the
// WebSocket, so the game works either way.

type Handler = (...args: never[]) => void;

/** Input with an action that has to be applied once, so it cannot be dropped. */
function hasOneShot(m: InputMsg): boolean {
  return !!(m.reload || m.interact || m.flashlight || m.slot >= 0 || m.grenade || m.buy || m.mark || m.deploy || m.drone);
}

export class ServerLink implements DataChannelLike {
  peer = 'server';
  open = false;
  private ws: WebSocket;
  private pc: RTCPeerConnection | null = null;
  private fast: RTCDataChannel | null = null;
  private fallbackInput: string | null = null;
  private fallbackInputTimer: number | null = null;
  private handlers: Record<string, Handler[]> = {};

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      this.open = true;
      this.emit('open');
    };
    this.ws.onmessage = (e) => {
      const msg = parse(e.data);
      if (!msg) return;
      if (msg.t === 'rtc') void this.onRtc(msg as RtcMsg);
      else this.emit('data', msg);
    };
    this.ws.onclose = () => {
      const was = this.open;
      this.open = false;
      this.closeRtc();
      if (was) this.emit('close');
      else this.emit('error', { type: 'network', message: 'Игровой сервер недоступен.' });
    };
  }

  /** True once snapshots and input travel over the UDP-like channel. */
  get udp(): boolean {
    return this.fast?.readyState === 'open';
  }

  on(event: string, cb: Handler): unknown {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }

  send(data: unknown): void {
    const msg = data as ClientMessage;
    const text = JSON.stringify(msg);
    if (this.udp && (msg.t === 'ping' || (msg.t === 'input' && !hasOneShot(msg)))) {
      try {
        this.fast!.send(text);
        return;
      } catch {
        /* fall back to the WebSocket */
      }
    }
    if (msg.t === 'input' && !hasOneShot(msg)) {
      // VPNs and restrictive networks often stay on WebSocket. Coalesce
      // steady movement updates so TCP cannot queue stale inputs behind them.
      this.fallbackInput = text;
      if (this.fallbackInputTimer === null) {
        this.fallbackInputTimer = window.setInterval(() => this.flushFallbackInput(), 33);
      }
      return;
    }
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
  }

  private flushFallbackInput(): void {
    if (!this.fallbackInput) return;
    if (this.ws.readyState === WebSocket.OPEN && this.ws.bufferedAmount < 128 * 1024) {
      this.ws.send(this.fallbackInput);
      this.fallbackInput = null;
    }
  }

  close(): void {
    this.open = false;
    if (this.fallbackInputTimer !== null) window.clearInterval(this.fallbackInputTimer);
    this.fallbackInputTimer = null;
    this.fallbackInput = null;
    this.closeRtc();
    this.ws.close();
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers[event] ?? []) (cb as (...a: unknown[]) => void)(...args);
  }

  private async onRtc(msg: RtcMsg): Promise<void> {
    if (typeof RTCPeerConnection === 'undefined') return;
    try {
      if (msg.sdp && msg.type === 'offer') {
        this.closeRtc();
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        this.pc = pc;
        pc.ondatachannel = (e) => {
          const ch = e.channel;
          this.fast = ch;
          ch.onmessage = (ev) => {
            const m = parse(ev.data);
            if (m) this.emit('data', m);
          };
        };
        pc.onicecandidate = (e) => {
          if (e.candidate && e.candidate.candidate) this.sendWs({ t: 'rtc', candidate: e.candidate.candidate, mid: e.candidate.sdpMid ?? '0' });
        };
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sendWs({ t: 'rtc', type: 'answer', sdp: pc.localDescription?.sdp ?? answer.sdp ?? '' });
      } else if (msg.candidate && this.pc) {
        await this.pc.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.mid ?? '0' });
      }
    } catch {
      /* no UDP path: the WebSocket carries everything */
    }
  }

  private sendWs(msg: RtcMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private closeRtc(): void {
    this.fast?.close();
    this.pc?.close();
    this.fast = null;
    this.pc = null;
  }
}

function parse(data: unknown): { t?: string } | null {
  if (typeof data !== 'string') return null;
  try {
    const v = JSON.parse(data) as unknown;
    return v && typeof v === 'object' ? (v as { t?: string }) : null;
  } catch {
    return null;
  }
}

/** The game server's WebSocket on this site. */
export function serverUrl(): string {
  const override = new URLSearchParams(location.search).get('server');
  if (override) return override;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}
