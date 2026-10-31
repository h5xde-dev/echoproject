import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { callService, handle, HttpError, isService, json, originAllowed, readJson } from '@echo/node-kit/http';
import { onShutdown, parseCookies } from '@echo/node-kit/lifecycle';
import { signTicket } from '@echo/node-kit/ticket';
import { ARENAS } from '@echo/shared/game/arenas';
import type { Difficulty, GameMode, PlayerClass } from '@echo/shared/game/types';
import { cleanMutators, ROOM_CODE_RE, type MetaClientMsg, type MetaServerMsg, type RoomOptions } from '@echo/shared/net/meta';
import { MODE_IDS } from '@echo/shared/game/modes';
import { cleanName } from '@echo/shared/names';
import { RING_COLORS } from '@echo/shared/progress';
import { META } from './config';
import { enqueue, leave, queued, type Waiting } from './matchmaker';
import { createRoom, findRoom, heartbeat, NoCapacity, rankedSeatOf, stats } from './registry';

// North Echo meta server: the front door to online play. A browser says who
// it is (signed in through the API's cookie, or a guest), then opens a room,
// joins one by its code, or queues for ranked; it gets back a ticket for a
// seat on a game server. Game servers report their rooms here by heartbeat.

const CLASSES: PlayerClass[] = ['assault', 'scout', 'medic', 'engineer'];

interface Who {
  sub: string;
  userId: number | null;
  name: string;
  cls: PlayerClass | null;
  color: number;
}

async function accountOf(req: IncomingMessage): Promise<{ id: number; name: string } | null> {
  const token = parseCookies(req.headers.cookie).ne_sid;
  if (!token) return null;
  try {
    const { user } = await callService<{ user: { id: number; name: string } | null }>(META.apiUrl, `/internal/session?token=${encodeURIComponent(token)}`, META.secret);
    return user;
  } catch {
    // API down: play on as a guest rather than not at all.
    return null;
  }
}

function roomOptions(raw: Partial<RoomOptions> | undefined): RoomOptions | null {
  if (!raw || !MODE_IDS.includes(raw.mode as GameMode)) return null;
  const difficulty: Difficulty = raw.difficulty === 'easy' || raw.difficulty === 'hard' ? raw.difficulty : 'normal';
  return {
    mode: raw.mode!,
    arena: ARENAS.some((a) => a.id === raw.arena) ? raw.arena! : ARENAS[0].id,
    fighters: typeof raw.fighters === 'number' ? Math.max(2, Math.min(8, Math.floor(raw.fighters))) : undefined,
    difficulty,
    bots: raw.bots !== false,
    mutators: cleanMutators(raw.mutators),
  };
}

/** One browser on /meta. */
class Client implements Waiting {
  who: Who | null = null;
  private creates: number[] = [];

  constructor(
    private ws: WebSocket,
    private account: { id: number; name: string } | null,
  ) {
    ws.on('message', (data, binary) => {
      if (binary) return;
      let msg: MetaClientMsg;
      try {
        msg = JSON.parse(data.toString()) as MetaClientMsg;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      void this.onMessage(msg).catch((err: unknown) => {
        console.error('meta message failed:', err);
        this.send({ t: 'error', text: 'Сбой на сервере, попробуйте ещё раз' });
      });
    });
    ws.on('close', () => leave(this));
    ws.on('error', () => leave(this));
  }

  get sub(): string {
    return this.who?.sub ?? '';
  }

  send(msg: MetaServerMsg): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private ticket(code: string, url: string, host: boolean, ranked: boolean): void {
    const who = this.who!;
    const ticket = signTicket({ sub: who.sub, userId: who.userId, name: who.name, cls: who.cls, color: who.color, room: code, host, exp: Date.now() + META.ticketMs }, META.secret);
    this.send({ t: 'ticket', code, ticket, url, ranked });
  }

  matched(code: string, url: string): void {
    this.ticket(code, url, false, true);
  }

  drop(text: string): void {
    this.send({ t: 'mm', state: 'error', text });
  }

  private async onMessage(msg: MetaClientMsg): Promise<void> {
    if (msg.t === 'hello') {
      const guestOk = typeof msg.guestId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(msg.guestId);
      if (!this.account && !guestOk) return this.send({ t: 'error', text: 'Обновите страницу' });
      const color = typeof msg.color === 'number' && RING_COLORS.some((c) => c.color === msg.color) ? msg.color : -1;
      this.who = {
        sub: this.account ? `u${this.account.id}` : `g${msg.guestId}`,
        userId: this.account?.id ?? null,
        // Signed in, the call sign is the account's (it shows in the rating).
        name: this.account ? this.account.name : cleanName(typeof msg.name === 'string' ? msg.name : ''),
        cls: CLASSES.includes(msg.cls as PlayerClass) ? msg.cls! : null,
        color,
      };
      return this.send({ t: 'me', signedIn: !!this.account, name: this.who.name });
    }
    if (!this.who) return this.send({ t: 'error', text: 'Нет приветствия' });

    switch (msg.t) {
      case 'create': {
        const now = Date.now();
        this.creates = this.creates.filter((t) => now - t < 60_000);
        if (this.creates.length >= 6) return this.send({ t: 'error', text: 'Слишком много комнат подряд — подождите минуту' });
        this.creates.push(now);
        const opts = roomOptions(msg.opts);
        if (!opts) return this.send({ t: 'error', text: 'Неизвестный режим' });
        try {
          const { code, url } = await createRoom(opts, false);
          return this.ticket(code, url, true, false);
        } catch (err) {
          if (err instanceof NoCapacity) return this.send({ t: 'error', text: 'Игровой сервер недоступен или обновляется — попробуйте через минуту' });
          throw err;
        }
      }
      case 'join': {
        const code = String(msg.code ?? '').trim().toUpperCase();
        if (!ROOM_CODE_RE.test(code) && !/^R[A-Z0-9]{6}$/.test(code)) return this.send({ t: 'error', text: 'Код комнаты — 5 символов' });
        const found = findRoom(code);
        if (!found) return this.send({ t: 'error', text: 'Комната не найдена: проверьте код или попросите друга создать новую' });
        // Ranked rooms take back only their own players.
        if (found.room.ranked && !found.room.subs.includes(this.who.sub)) return this.send({ t: 'error', text: 'Это рейтинговый бой' });
        if (found.room.full) return this.send({ t: 'error', text: 'Комната заполнена' });
        return this.ticket(code, found.instance.url, false, found.room.ranked);
      }
      case 'queue': {
        if (!this.who.userId) return this.send({ t: 'mm', state: 'error', text: 'Рейтинговый бой — только со входом через Яндекс' });
        // Dropped out of a ranked match that is still on: straight back in.
        const seat = rankedSeatOf(this.who.sub);
        if (seat) return this.ticket(seat.room.code, seat.instance.url, false, true);
        return enqueue(this);
      }
      case 'unqueue':
        return leave(this);
      default:
        return;
    }
  }
}

// ---------------------------------------------------------------- HTTP

async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true, service: 'meta', queued: queued(), ...stats() });
  if (req.method === 'GET' && path === '/meta/status') {
    const s = stats();
    // Public numbers for the menu (and the old /api/status shape).
    return json(res, 200, { queued: queued(), matches: s.instances.reduce((n, i) => n + i.rooms, 0), playing: s.instances.reduce((n, i) => n + i.players, 0), online: s.instances.some((i) => !i.draining) });
  }
  if (!path.startsWith('/internal/') || !isService(req, META.secret)) throw new HttpError(404, 'not found');
  if (req.method === 'POST' && path === '/internal/heartbeat') {
    heartbeat(await readJson(req, 256 * 1024));
    return json(res, 200, { ok: true });
  }
  throw new HttpError(404, 'not found');
}

const server = createServer(handle(route));
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path !== '/meta' || (META.origins.length && !originAllowed(req, META.origins))) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  void accountOf(req).then((account) => {
    if (socket.destroyed) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Keepalive: a link that stops answering pings is closed.
      let alive = true;
      ws.on('pong', () => (alive = true));
      const timer = setInterval(() => {
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
      }, 15_000);
      ws.on('close', () => clearInterval(timer));
      new Client(ws, account);
    });
  });
});

server.listen(META.port, META.host, () => console.log(`meta on ${META.host}:${META.port}`));
onShutdown(server, () => {
  for (const ws of wss.clients) ws.close(1012, 'restart');
});
