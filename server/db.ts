import Database from 'better-sqlite3';
import { SERVER } from './config';

// SQLite: players (from Yandex ID), login sessions, and ranked match history.

export const db = new Database(SERVER.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    yandex_id TEXT NOT NULL UNIQUE,
    login TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '',
    rating REAL NOT NULL DEFAULT 1000,
    games INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    kills INTEGER NOT NULL DEFAULT 0,
    deaths INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS users_rating ON users (rating DESC);
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL,
    arena TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS match_players (
    match_id INTEGER NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    place INTEGER NOT NULL,
    kills INTEGER NOT NULL,
    deaths INTEGER NOT NULL,
    left_early INTEGER NOT NULL DEFAULT 0,
    rating_before REAL NOT NULL,
    rating_after REAL NOT NULL,
    PRIMARY KEY (match_id, user_id)
  );
`);

export interface UserRow {
  id: number;
  yandex_id: string;
  login: string;
  name: string;
  avatar: string;
  rating: number;
  games: number;
  wins: number;
  kills: number;
  deaths: number;
}

const q = {
  upsert: db.prepare(`
    INSERT INTO users (yandex_id, login, name, avatar, created_at, seen_at)
    VALUES (@yandexId, @login, @name, @avatar, @now, @now)
    ON CONFLICT (yandex_id) DO UPDATE SET login = @login, avatar = @avatar, seen_at = @now
    RETURNING *`),
  user: db.prepare('SELECT * FROM users WHERE id = ?'),
  session: db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`),
  newSession: db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'),
  dropSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  expire: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  top: db.prepare('SELECT * FROM users WHERE games > 0 ORDER BY rating DESC, wins DESC LIMIT ?'),
  rankOf: db.prepare('SELECT COUNT(*) + 1 AS rank FROM users WHERE games > 0 AND rating > ?'),
  rename: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
  newMatch: db.prepare('INSERT INTO matches (mode, arena, started_at, ended_at) VALUES (?, ?, ?, ?)'),
  matchPlayer: db.prepare(`INSERT INTO match_players (match_id, user_id, place, kills, deaths, left_early, rating_before, rating_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  rate: db.prepare('UPDATE users SET rating = ?, games = games + 1, wins = wins + ?, kills = kills + ?, deaths = deaths + ? WHERE id = ?'),
  recent: db.prepare(`SELECT m.id, m.arena, m.ended_at, p.place, p.kills, p.deaths, p.rating_before, p.rating_after,
      (SELECT COUNT(*) FROM match_players x WHERE x.match_id = m.id) AS players
    FROM match_players p JOIN matches m ON m.id = p.match_id WHERE p.user_id = ? ORDER BY m.id DESC LIMIT ?`),
};

export function upsertYandexUser(u: { yandexId: string; login: string; name: string; avatar: string }): UserRow {
  return q.upsert.get({ ...u, now: Date.now() }) as UserRow;
}

export function userById(id: number): UserRow | null {
  return (q.user.get(id) as UserRow | undefined) ?? null;
}

export function userBySession(token: string): UserRow | null {
  return (q.session.get(token, Date.now()) as UserRow | undefined) ?? null;
}

export function createSession(token: string, userId: number, ttlMs: number): void {
  q.expire.run(Date.now());
  q.newSession.run(token, userId, Date.now() + ttlMs);
}

export function dropSession(token: string): void {
  q.dropSession.run(token);
}

export function renameUser(id: number, name: string): void {
  q.rename.run(name, id);
}

export function leaderboard(limit: number): UserRow[] {
  return q.top.all(limit) as UserRow[];
}

export function rankOf(user: UserRow): number | null {
  return user.games > 0 ? (q.rankOf.get(user.rating) as { rank: number }).rank : null;
}

export function recentMatches(userId: number, limit: number): unknown[] {
  return q.recent.all(userId, limit);
}

export interface MatchResultRow {
  userId: number;
  place: number;
  kills: number;
  deaths: number;
  left: boolean;
  before: number;
  after: number;
}

/** One transaction: the match, every player's line, and their new ratings. */
export const saveMatch = db.transaction((arena: string, startedAt: number, rows: MatchResultRow[]) => {
  const { lastInsertRowid } = q.newMatch.run('dm', arena, startedAt, Date.now());
  for (const r of rows) {
    q.matchPlayer.run(lastInsertRowid, r.userId, r.place, r.kills, r.deaths, r.left ? 1 : 0, r.before, r.after);
    q.rate.run(r.after, r.place === 1 && !r.left ? 1 : 0, r.kills, r.deaths, r.userId);
  }
  return Number(lastInsertRowid);
});
