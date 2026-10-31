import type { GameMode, PlayerClass } from '@echo/shared/game/types';
import type { MetaClientMsg, MetaServerMsg, MetaTicketMsg, PublicRoom, RoomOptions } from '@echo/shared/net/meta';
import type { MatchmakingMsg } from '@echo/shared/net/protocol';

// The meta server (WebSocket /meta): the front door to online play. It knows
// who we are from the login cookie (or treats us as a guest) and answers each
// request with a ticket for a seat on a game server. The link is short-lived:
// open, hello, one request, close — except while queued for ranked.

const GUEST_KEY = 'echo.guest';

/**
 * A random id this tab keeps (sessionStorage: it survives a reload, and two
 * tabs are two players), so a guest gets their seat back after a drop.
 */
export function guestId(): string {
  try {
    let id = sessionStorage.getItem(GUEST_KEY);
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem(GUEST_KEY, id);
    }
    return id;
  } catch {
    // No storage: a guest id for this page only.
    return `t${Math.random().toString(36).slice(2, 14)}`;
  }
}

export interface Identity {
  name: string;
  cls: PlayerClass;
  color: number;
}

export function metaUrl(): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/meta`;
}

/** The address of a game server's WebSocket on this site, with the ticket. */
export function gameUrl(t: MetaTicketMsg): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${t.url}?ticket=${encodeURIComponent(t.ticket)}`;
}

export type MetaRequest = { t: 'create'; opts: RoomOptions } | { t: 'join'; code: string } | { t: 'quick'; mode: GameMode } | { t: 'queue' };

/**
 * One request to the meta server: resolves with the ticket. Ranked queue
 * progress goes to `onQueue` meanwhile; `cancel()` leaves the queue.
 */
export class MetaLink {
  private ws: WebSocket | null = null;
  onQueue: ((msg: MatchmakingMsg) => void) | null = null;
  private rejectFn: ((err: Error) => void) | null = null;

  request(who: Identity, req: MetaRequest, timeoutMs = 10_000): Promise<MetaTicketMsg> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(metaUrl());
      this.ws = ws;
      let done = false;
      this.rejectFn = (err) => finish(err);
      const finish = (err: Error | null, ticket?: MetaTicketMsg) => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        ws.close();
        if (this.ws === ws) this.ws = null;
        if (err) reject(err);
        else resolve(ticket!);
      };
      // The queue may take a while; everything else answers at once.
      const timer = window.setTimeout(() => finish(new Error('Сервер не отвечает. Попробуйте ещё раз.')), req.t === 'queue' ? 30 * 60_000 : timeoutMs);
      const send = (m: MetaClientMsg) => ws.send(JSON.stringify(m));
      ws.onopen = () => send({ t: 'hello', guestId: guestId(), name: who.name, cls: who.cls, color: who.color });
      ws.onmessage = (e) => {
        let msg: MetaServerMsg;
        try {
          msg = JSON.parse(String(e.data)) as MetaServerMsg;
        } catch {
          return;
        }
        if (msg.t === 'me') send(req);
        else if (msg.t === 'ticket') finish(null, msg);
        else if (msg.t === 'error') finish(new Error(msg.text));
        else if (msg.t === 'mm') {
          if (msg.state === 'error') finish(new Error(msg.text ?? 'Очередь прервана'));
          else this.onQueue?.(msg);
        }
      };
      ws.onerror = () => finish(new Error('Сервер недоступен. Проверьте сеть и попробуйте ещё раз.'));
      ws.onclose = () => finish(new Error('Связь с сервером прервалась.'));
    });
  }

  /** Leave the ranked queue (or drop a pending request). */
  cancel(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'unqueue' } satisfies MetaClientMsg));
    this.rejectFn?.(new Error('cancelled'));
    this.rejectFn = null;
  }
}

/** Public rooms on the server (for the menu list); empty when it cannot be reached. */
export async function fetchPublicRooms(): Promise<PublicRoom[]> {
  try {
    const res = await fetch('/meta/rooms', { cache: 'no-store' });
    if (!res.ok) return [];
    return ((await res.json()) as { rooms: PublicRoom[] }).rooms ?? [];
  } catch {
    return [];
  }
}

/** The address that drops a friend straight into this room. */
export function inviteLink(code: string): string {
  return `${location.origin}/play?room=${encodeURIComponent(code)}`;
}
