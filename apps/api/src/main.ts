import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { handle, HttpError, isService, json, readJson } from '@echo/node-kit/http';
import { onShutdown } from '@echo/node-kit/lifecycle';
import { CONFIG } from '@echo/shared/game/config';
import { levelOf, matchXp, RING_COLORS, type MatchTally } from '@echo/shared/progress';
import { beginYandex, cleanName, currentUser, devLogin, logout, yandexCallback } from './auth';
import { API } from './config';
import { db, expireSessions, importProgress, leaderboard, rankOf, recentMatches, renameUser, saveMatch, saveSettings, userById, userBySession, type UserRow } from './db';
import { eloUpdate } from './rating';

// North Echo API: Yandex login, the account (profile, settings, experience),
// the rating table and page, match history. The only service that touches the
// database; the meta and game servers call /internal/* with the service key.

function publicUser(u: UserRow) {
  const lvl = levelOf(u.xp);
  return {
    id: u.id,
    name: u.name,
    avatar: u.avatar,
    rating: Math.round(u.rating),
    games: u.games,
    wins: u.wins,
    kills: u.kills,
    deaths: u.deaths,
    rank: rankOf(u),
    xp: u.xp,
    matches: u.matches,
    level: lvl.level,
    settings: parseSettings(u.settings),
  };
}

// ---------------------------------------------------------------- profile settings

interface ProfileSettings {
  cls?: string;
  color?: number;
  difficulty?: string;
  roomBots?: boolean;
}

const CLASSES = ['assault', 'scout', 'medic', 'engineer'];
const DIFFICULTIES = Object.keys(CONFIG.difficulty);

function parseSettings(text: string): ProfileSettings {
  try {
    return cleanSettings(JSON.parse(text) as Record<string, unknown>, Infinity);
  } catch {
    return {};
  }
}

/** Only known keys with valid values; a ring colour only if the level unlocks it. */
function cleanSettings(raw: Record<string, unknown>, xp: number): ProfileSettings {
  const out: ProfileSettings = {};
  if (typeof raw.cls === 'string' && CLASSES.includes(raw.cls)) out.cls = raw.cls;
  if (typeof raw.difficulty === 'string' && DIFFICULTIES.includes(raw.difficulty)) out.difficulty = raw.difficulty;
  if (typeof raw.roomBots === 'boolean') out.roomBots = raw.roomBots;
  if (typeof raw.color === 'number') {
    const ring = RING_COLORS.find((c) => c.color === raw.color);
    if (raw.color === -1 || (ring && ring.level <= levelOf(xp).level)) out.color = raw.color;
  }
  return out;
}

// ---------------------------------------------------------------- rating page

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The rating page with the table already in the HTML, for search engines. */
function ratingPage(res: ServerResponse): void {
  const file = join(API.distDir, 'rating.html');
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

// ---------------------------------------------------------------- internal

interface MatchReport {
  mode: string;
  arena: string;
  rated: boolean;
  startedAt: number;
  players: { userId: number; place: number; kills: number; deaths: number; left: boolean; win: boolean; tally: MatchTally }[];
}

const num = (v: unknown, max = 1e6) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0);

/** A finished match from the game server: ratings (ranked), experience (everyone signed in). */
function recordMatch(report: MatchReport) {
  const players = (Array.isArray(report.players) ? report.players : [])
    .map((p) => ({ p, user: userById(num(p.userId)) }))
    .filter((x): x is { p: MatchReport['players'][number]; user: UserRow } => x.user !== null);
  if (players.length === 0) return { rows: [] };
  const rated = report.rated === true && players.length >= 2;
  const before = players.map((x) => x.user.rating);
  const after = rated ? eloUpdate(players.map((x, i) => ({ rating: before[i], place: num(x.p.place, 64) || 1 }))) : before;
  const rows = players.map((x, i) => {
    const t = x.p.tally ?? ({} as MatchTally);
    const tally: MatchTally = { kills: num(t.kills, 500), objectives: num(t.objectives, 100), revives: num(t.revives, 100), rooms: num(t.rooms, 20), waves: num(t.waves, 200) };
    const win = x.p.win === true;
    return {
      userId: x.user.id,
      place: num(x.p.place, 64),
      kills: num(x.p.kills, 500),
      deaths: num(x.p.deaths, 500),
      left: x.p.left === true,
      win,
      before: before[i],
      after: after[i],
      // Walking out of a match earns nothing.
      xp: x.p.left ? 0 : matchXp(tally, win),
    };
  });
  saveMatch(String(report.mode).slice(0, 16), String(report.arena).slice(0, 32), rated, num(report.startedAt, 4e12) || Date.now(), rows);
  return {
    rows: rows.map((r, i) => {
      const xpBefore = players[i].user.xp;
      const lvlBefore = levelOf(xpBefore).level;
      const lvlAfter = levelOf(xpBefore + r.xp).level;
      return {
        userId: r.userId,
        before: r.before,
        after: r.after,
        gained: r.xp,
        xp: xpBefore + r.xp,
        levelBefore: lvlBefore,
        levelAfter: lvlAfter,
        unlocked: RING_COLORS.filter((c) => c.level > lvlBefore && c.level <= lvlAfter).map((c) => c.name),
      };
    }),
  };
}

// ---------------------------------------------------------------- routes

function needUser(req: IncomingMessage): UserRow {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'login');
  return user;
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path.startsWith('/internal/')) {
    if (!isService(req, API.secret)) throw new HttpError(403, 'forbidden');
    if (method === 'GET' && path === '/internal/session') {
      const user = userBySession(url.searchParams.get('token') ?? '');
      return json(res, 200, { user: user ? { id: user.id, name: user.name, rating: Math.round(user.rating), settings: parseSettings(user.settings) } : null });
    }
    if (method === 'POST' && path === '/internal/match') return json(res, 200, recordMatch(await readJson<MatchReport>(req, 64 * 1024)));
    throw new HttpError(404, 'not found');
  }

  if (method === 'GET' && path === '/healthz') {
    db.prepare('SELECT 1').get();
    return json(res, 200, { ok: true, service: 'api' });
  }
  if (method === 'GET' && path === '/auth/yandex') return beginYandex(req, res, url);
  if (method === 'GET' && path === '/callback') return yandexCallback(req, res, url);
  if (method === 'GET' && path === '/auth/dev') return devLogin(req, res, url);
  if (method === 'POST' && path === '/auth/logout') return logout(req, res);

  if (method === 'GET' && path === '/api/me') {
    const user = currentUser(req);
    return json(res, 200, { user: user ? publicUser(user) : null, yandex: !!API.yandex.clientId });
  }
  if (method === 'POST' && path === '/api/me/name') {
    const user = needUser(req);
    const body = await readJson<{ name?: unknown }>(req);
    const name = cleanName(typeof body.name === 'string' ? body.name : '');
    renameUser(user.id, name);
    return json(res, 200, { name });
  }
  if (method === 'PUT' && path === '/api/me/settings') {
    const user = needUser(req);
    const settings = cleanSettings(await readJson(req), user.xp);
    saveSettings(user.id, settings);
    return json(res, 200, { settings });
  }
  if (method === 'POST' && path === '/api/me/progress/import') {
    // The experience a guest earned in this browser, once per account, capped:
    // it was counted by the browser and cannot be trusted beyond that.
    const user = needUser(req);
    const body = await readJson<{ xp?: unknown; matches?: unknown }>(req);
    const ok = importProgress(user.id, num(body.xp, 20_000), num(body.matches, 1000));
    return json(res, 200, { imported: ok, user: publicUser(userById(user.id)!) });
  }
  if (method === 'GET' && path === '/api/leaderboard') {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    return json(res, 200, { rows: leaderboard(limit).map(publicUser) });
  }
  if (method === 'GET' && path === '/api/matches') {
    const user = needUser(req);
    return json(res, 200, { rows: recentMatches(user.id, 20) });
  }
  if (method === 'GET' && (path === '/rating' || path === '/rating/')) return ratingPage(res);

  throw new HttpError(404, 'not found');
}

const server = createServer(handle(route));
server.listen(API.port, API.host, () => console.log(`api on ${API.host}:${API.port}`));

const sweeper = setInterval(() => expireSessions(), 3600_000);
sweeper.unref();
onShutdown(server, () => {
  clearInterval(sweeper);
  db.close();
});
