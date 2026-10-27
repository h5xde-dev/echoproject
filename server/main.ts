import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { beginYandex, cleanName, currentUser, devLogin, logout, yandexCallback } from './auth';
import { SERVER } from './config';
import { PlayerConn } from './conn';
import { leaderboard, rankOf, recentMatches, renameUser, type UserRow } from './db';
import { accept, shutdown, stats } from './matchmaker';

// North Echo game server: Yandex login, the rating API and page, and the
// ranked match WebSocket at /ws. Static files are nginx's job in production
// and Vite's in development.

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function publicUser(u: UserRow) {
  return { id: u.id, name: u.name, avatar: u.avatar, rating: Math.round(u.rating), games: u.games, wins: u.wins, kills: u.kills, deaths: u.deaths, rank: rankOf(u) };
}

function readBody(req: IncomingMessage, limit = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > limit) reject(new Error('too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The rating page with the table already in the HTML, for search engines. */
function ratingPage(res: ServerResponse): void {
  const file = join(SERVER.distDir, 'rating.html');
  if (!existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  const rows = leaderboard(100)
    .map(
      (u, i) =>
        `<tr><td>${i + 1}</td><td>${esc(u.name)}</td><td>${Math.round(u.rating)}</td><td>${u.games}</td><td>${u.wins}</td><td>${u.deaths ? (u.kills / u.deaths).toFixed(2) : u.kills}</td></tr>`,
    )
    .join('');
  const html = readFileSync(file, 'utf8').replace('<!--LEADERBOARD-->', rows);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' });
  res.end(html);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/auth/yandex') return beginYandex(req, res, url);
  if (req.method === 'GET' && path === '/callback') return yandexCallback(req, res, url);
  if (req.method === 'GET' && path === '/auth/dev') return devLogin(req, res, url);
  if (req.method === 'POST' && path === '/auth/logout') return logout(req, res);

  if (req.method === 'GET' && path === '/api/me') {
    const user = currentUser(req);
    return json(res, 200, { user: user ? publicUser(user) : null, yandex: !!SERVER.yandex.clientId });
  }
  if (req.method === 'POST' && path === '/api/me/name') {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: 'login' });
    const body = JSON.parse((await readBody(req)) || '{}') as { name?: string };
    const name = cleanName(body.name ?? '');
    renameUser(user.id, name);
    return json(res, 200, { name });
  }
  if (req.method === 'GET' && path === '/api/leaderboard') {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    return json(res, 200, { rows: leaderboard(limit).map(publicUser) });
  }
  if (req.method === 'GET' && path === '/api/matches') {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: 'login' });
    return json(res, 200, { rows: recentMatches(user.id, 20) });
  }
  if (req.method === 'GET' && path === '/api/status') return json(res, 200, stats());
  if (req.method === 'GET' && (path === '/rating' || path === '/rating/')) return ratingPage(res);

  json(res, 404, { error: 'not found' });
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'server' });
  });
});

// Ranked play needs an account: the WebSocket only opens with a session cookie.
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const user = currentUser(req);
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => accept(new PlayerConn(ws, user)));
});

server.listen(SERVER.port, SERVER.host, () => {
  console.log(`north echo server on ${SERVER.host}:${SERVER.port}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    shutdown();
    server.close();
    process.exit(0);
  });
}
