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
  open = false;
  private ws: WebSocket;
  private pc: RTCPeerConnection | null = null;
  private fast: RTCDataChannel | null = null;
  private fallbackInput: string | null = null;
  private fallbackInputTimer: number | null = null;
  private handlers: Record<string, Handler[]> = {};
  /** Signalling is handled one message at a time, in order (see onRtc). */
  private rtcChain: Promise<void> = Promise.resolve();
  /** Candidates that came before the offer was applied. */
  private earlyCandidates: RtcMsg[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      this.open = true;
      this.emit('open');
    };
    this.ws.onmessage = (e) => {
      const msg = parse(e.data);
      if (!msg) return;
      if (msg.t === 'rtc') this.rtcChain = this.rtcChain.then(() => this.onRtc(msg as RtcMsg));
      else this.emit('data', msg);
    };
    this.ws.onclose = (e) => {
      const was = this.open;
      this.open = false;
      this.stopFallback();
      this.closeRtc();
      if (was) this.emit('close', e.code);
      else this.emit('error', { type: 'network', message: 'Игровой сервер недоступен или комната закрыта.' });
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
    this.stopFallback();
    this.closeRtc();
    this.ws.close();
  }

  private stopFallback(): void {
    if (this.fallbackInputTimer !== null) window.clearInterval(this.fallbackInputTimer);
    this.fallbackInputTimer = null;
    this.fallbackInput = null;
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
        // Candidates the server sent while the offer was being applied:
        // adding them earlier throws, and the UDP path silently never came up.
        const early = this.earlyCandidates;
        this.earlyCandidates = [];
        for (const c of early) await this.addCandidate(c);
      } else if (msg.candidate) {
        if (this.pc?.remoteDescription) await this.addCandidate(msg);
        else this.earlyCandidates.push(msg);
      }
    } catch {
      /* no UDP path: the WebSocket carries everything */
    }
  }

  private async addCandidate(msg: RtcMsg): Promise<void> {
    try {
      await this.pc?.addIceCandidate({ candidate: msg.candidate!, sdpMid: msg.mid ?? '0' });
    } catch {
      /* one bad candidate: the others may still connect */
    }
  }

  private sendWs(msg: RtcMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private closeRtc(): void {
    this.earlyCandidates = [];
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
