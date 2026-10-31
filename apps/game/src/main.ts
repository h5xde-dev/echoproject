import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { callService, handle, HttpError, isService, json, originAllowed, readJson } from '@echo/node-kit/http';
import { onShutdown } from '@echo/node-kit/lifecycle';
import { verifyTicket } from '@echo/node-kit/ticket';
import { ARENAS } from '@echo/shared/game/arenas';
import { isArena, MODE_IDS } from '@echo/shared/game/modes';
import type { GameMode } from '@echo/shared/game/types';
import { cleanMutators, type RoomOptions } from '@echo/shared/net/meta';
import { GAME } from './config';
import { PlayerConn } from './conn';
import { MAX_SEATS, Room } from './room';

// North Echo game server: hosts the rooms the meta server places here and
// runs their matches. Browsers come in on the WebSocket with a ticket the
// meta server signed; the meta server hears about this instance's rooms from
// a heartbeat, so it can send players to the right one and stop placing new
// rooms here while it shuts down.

const rooms = new Map<string, Room>();
let draining = false;


function validOptions(raw: Partial<RoomOptions>): RoomOptions {
  if (!MODE_IDS.includes(raw.mode as GameMode)) throw new HttpError(400, 'mode');
  const mode = raw.mode!;
  const arena = isArena(mode) ? (ARENAS.some((a) => a.id === raw.arena) ? raw.arena! : ARENAS[0].id) : '';
  return {
    mode,
    arena,
    fighters: typeof raw.fighters === 'number' ? Math.max(2, Math.min(8, Math.floor(raw.fighters))) : undefined,
    difficulty: raw.difficulty === 'easy' || raw.difficulty === 'hard' ? raw.difficulty : 'normal',
    bots: raw.bots !== false,
    mutators: cleanMutators(raw.mutators),
    public: raw.public === true,
  };
}

function status() {
  return {
    id: GAME.id,
    base: GAME.internalUrl,
    url: GAME.publicPath,
    draining,
    capacity: GAME.maxRooms,
    rooms: [...rooms.values()].map((r) => ({
      code: r.code,
      players: r.players,
      phase: r.phase,
      mode: r.opts.mode,
      arena: r.opts.arena,
      mutators: r.opts.mutators ?? [],
      public: r.opts.public === true,
      max: MAX_SEATS,
      ranked: r.ranked,
      full: r.full,
      subs: r.ranked ? r.subs : [],
    })),
  };
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true, service: 'game', rooms: rooms.size, draining });
  if (!path.startsWith('/internal/') || !isService(req, GAME.secret)) throw new HttpError(404, 'not found');

  if (req.method === 'GET' && path === '/internal/status') return json(res, 200, status());
  if (req.method === 'POST' && path === '/internal/rooms') {
    if (draining) throw new HttpError(503, 'draining');
    if (rooms.size >= GAME.maxRooms) throw new HttpError(503, 'full');
    const body = await readJson<{ code?: string; opts?: Partial<RoomOptions>; ranked?: boolean; subs?: unknown }>(req);
    const code = String(body.code ?? '');
    if (!/^[A-Z0-9]{5,12}$/.test(code) || rooms.has(code)) throw new HttpError(409, 'code');
    const ranked = body.ranked === true;
    const opts = ranked ? { mode: 'dm' as const, arena: ARENAS[Math.floor(Math.random() * ARENAS.length)].id, bots: false } : validOptions(body.opts ?? {});
    const expected = Array.isArray(body.subs) ? body.subs.filter((x): x is string => typeof x === 'string').slice(0, 16) : [];
    const room = new Room(code, opts, ranked, expected, (r) => {
      rooms.delete(r.code);
      console.log(`room ${r.code} closed (${rooms.size} open)`);
      void heartbeat();
    });
    rooms.set(code, room);
    console.log(`room ${code}: ${opts.mode}${opts.arena ? ` · ${opts.arena}` : ''}${ranked ? ' · ranked' : ''} (${rooms.size} open)`);
    return json(res, 200, { code, url: GAME.publicPath, arena: opts.arena });
  }
  throw new HttpError(404, 'not found');
}

const server = createServer(handle(route));

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const refuse = (status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (url.pathname !== GAME.publicPath && url.pathname !== '/game') return refuse('404 Not Found');
  if (GAME.origins.length && !originAllowed(req, GAME.origins)) return refuse('403 Forbidden');
  const ticket = verifyTicket(url.searchParams.get('ticket') ?? '', GAME.secret);
  if (!ticket) return refuse('401 Unauthorized');
  const room = rooms.get(ticket.room);
  if (!room || room.closed) return refuse('410 Gone');
  wss.handleUpgrade(req, socket, head, (ws) => room.admit(new PlayerConn(ws, ticket)));
});

server.listen(GAME.port, GAME.host, () => console.log(`game ${GAME.id} on ${GAME.host}:${GAME.port}, public ${GAME.publicPath}`));

/** Tell the meta server what runs here; it forgets an instance that goes quiet. */
async function heartbeat(): Promise<void> {
  try {
    await callService(GAME.metaUrl, '/internal/heartbeat', GAME.secret, status(), 2000);
  } catch {
    /* meta down or restarting: the next beat tries again */
  }
}
const beat = setInterval(() => void heartbeat(), 3000);
void heartbeat();

/**
 * Shutdown (a deploy): no new rooms; rooms in a warm-up or with nobody left
 * close at once; running matches get up to DRAIN_SEC to finish, then are cut
 * with a message instead of a silent drop.
 */
onShutdown(server, async () => {
  draining = true;
  await heartbeat();
  const deadline = Date.now() + GAME.drainSec * 1000;
  for (;;) {
    for (const r of rooms.values()) if (!r.busy) r.close('Сервер обновляется — через минуту создайте комнату заново');
    if (rooms.size === 0 || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  for (const r of rooms.values()) r.close('Сервер обновляется — матч прерван. Зайдите снова через минуту');
  clearInterval(beat);
  await heartbeat();
});
