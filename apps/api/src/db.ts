import Database from 'better-sqlite3';
import { API } from './config';

// SQLite, owned by the API alone: players (from Yandex ID), login sessions,
// match history, ratings, experience and profile settings. The meta and game
// servers reach it only through the API's /internal endpoints.

export const db = new Database(API.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 3000');

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

// Schema changes after the first release, applied once each (PRAGMA user_version).
const MIGRATIONS: string[] = [
  // 1: experience and profile on the account; unrated matches in the history.
  `ALTER TABLE users ADD COLUMN xp INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE users ADD COLUMN matches INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE users ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE users ADD COLUMN progress_imported INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE matches ADD COLUMN rated INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE match_players ADD COLUMN xp INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE match_players ADD COLUMN win INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX IF NOT EXISTS match_players_user ON match_players (user_id, match_id DESC);
   CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);`,
  // 2: lifetime stats (achievements), quest progress, unlocked cosmetics.
  `CREATE TABLE user_stats (
     user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     key TEXT NOT NULL,
     value INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (user_id, key)
   );
   CREATE TABLE quest_progress (
     user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     period_key TEXT NOT NULL,
     quest_id TEXT NOT NULL,
     progress INTEGER NOT NULL DEFAULT 0,
     done_at INTEGER,
     PRIMARY KEY (user_id, period_key, quest_id)
   );
   CREATE TABLE unlocks (
     user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     item_id TEXT NOT NULL,
     at INTEGER NOT NULL,
     PRIMARY KEY (user_id, kind, item_id)
   );`,
];
const version = db.pragma('user_version', { simple: true }) as number;
for (let v = version; v < MIGRATIONS.length; v++) {
  db.transaction(() => {
    db.exec(MIGRATIONS[v]);
    db.pragma(`user_version = ${v + 1}`);
  })();
  console.log(`db: migrated to version ${v + 1}`);
}

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
  xp: number;
  matches: number;
  settings: string;
  progress_imported: number;
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
  setSettings: db.prepare('UPDATE users SET settings = ? WHERE id = ?'),
  importProgress: db.prepare('UPDATE users SET xp = xp + ?, matches = matches + ?, progress_imported = 1 WHERE id = ? AND progress_imported = 0'),
  newMatch: db.prepare('INSERT INTO matches (mode, arena, rated, started_at, ended_at) VALUES (?, ?, ?, ?, ?)'),
  matchPlayer: db.prepare(`INSERT INTO match_players (match_id, user_id, place, kills, deaths, left_early, rating_before, rating_after, xp, win)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  rate: db.prepare('UPDATE users SET rating = ?, games = games + 1, wins = wins + ?, kills = kills + ?, deaths = deaths + ? WHERE id = ?'),
  addXp: db.prepare('UPDATE users SET xp = xp + ?, matches = matches + 1 WHERE id = ?'),
  recent: db.prepare(`SELECT m.id, m.mode, m.arena, m.rated, m.ended_at, p.place, p.kills, p.deaths, p.rating_before, p.rating_after, p.xp, p.win,
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
  q.newSession.run(token, userId, Date.now() + ttlMs);
}

export function dropSession(token: string): void {
  q.dropSession.run(token);
}

/** Expired logins, cleared hourly (main.ts) rather than only when someone logs in. */
export function expireSessions(): number {
  return q.expire.run(Date.now()).changes;
}

export function renameUser(id: number, name: string): void {
  q.rename.run(name, id);
}

export function saveSettings(id: number, settings: object): void {
  q.setSettings.run(JSON.stringify(settings), id);
}

/** A guest's progress from this browser, added to the account once. False if it already was. */
export function importProgress(id: number, xp: number, matches: number): boolean {
  return q.importProgress.run(xp, matches, id).changes > 0;
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
  win: boolean;
  before: number;
  after: number;
  xp: number;
}

/** One transaction: the match, every player's line, ratings (if rated) and experience. */
export const saveMatch = db.transaction((mode: string, arena: string, rated: boolean, startedAt: number, rows: MatchResultRow[]) => {
  const { lastInsertRowid } = q.newMatch.run(mode, arena, rated ? 1 : 0, startedAt, Date.now());
  for (const r of rows) {
    q.matchPlayer.run(lastInsertRowid, r.userId, r.place, r.kills, r.deaths, r.left ? 1 : 0, r.before, r.after, r.xp, r.win ? 1 : 0);
    if (rated) q.rate.run(r.after, r.win && !r.left ? 1 : 0, r.kills, r.deaths, r.userId);
    q.addXp.run(r.xp, r.userId);
  }
  return Number(lastInsertRowid);
});

// ---------------------------------------------------------------- quests, achievements, cosmetics

const qx = {
  stats: db.prepare('SELECT key, value FROM user_stats WHERE user_id = ?'),
  addStat: db.prepare(`INSERT INTO user_stats (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT (user_id, key) DO UPDATE SET value = value + excluded.value`),
  quests: db.prepare('SELECT quest_id, progress, done_at FROM quest_progress WHERE user_id = ? AND period_key = ?'),
  addQuest: db.prepare(`INSERT INTO quest_progress (user_id, period_key, quest_id, progress) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, period_key, quest_id) DO UPDATE SET progress = progress + excluded.progress`),
  doneQuest: db.prepare('UPDATE quest_progress SET done_at = ? WHERE user_id = ? AND period_key = ? AND quest_id = ? AND done_at IS NULL'),
  unlocks: db.prepare('SELECT kind, item_id FROM unlocks WHERE user_id = ?'),
  unlock: db.prepare('INSERT OR IGNORE INTO unlocks (user_id, kind, item_id, at) VALUES (?, ?, ?, ?)'),
  giveXp: db.prepare('UPDATE users SET xp = xp + ? WHERE id = ?'),
};

export function lifetimeStats(userId: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of qx.stats.all(userId) as { key: string; value: number }[]) out[r.key] = r.value;
  return out;
}

export function addLifetimeStats(userId: number, stats: Record<string, number>): void {
  for (const [k, v] of Object.entries(stats)) if (v > 0) qx.addStat.run(userId, k, v);
}

export function questRows(userId: number, periodKey: string): Map<string, { progress: number; done: boolean }> {
  const out = new Map<string, { progress: number; done: boolean }>();
  for (const r of qx.quests.all(userId, periodKey) as { quest_id: string; progress: number; done_at: number | null }[]) {
    out.set(r.quest_id, { progress: r.progress, done: r.done_at !== null });
  }
  return out;
}

export function addQuestProgress(userId: number, periodKey: string, questId: string, n: number): void {
  qx.addQuest.run(userId, periodKey, questId, n);
}

/** Marks a quest done; false if it already was (rewards only once). */
export function markQuestDone(userId: number, periodKey: string, questId: string): boolean {
  return qx.doneQuest.run(Date.now(), userId, periodKey, questId).changes > 0;
}

/** Cosmetics a player owns, and achievements earned (kind 'ach'). */
export function unlocksOf(userId: number): { camos: string[]; badges: string[]; achievements: string[] } {
  const out = { camos: [] as string[], badges: [] as string[], achievements: [] as string[] };
  for (const r of qx.unlocks.all(userId) as { kind: string; item_id: string }[]) {
    if (r.kind === 'camo') out.camos.push(r.item_id);
    else if (r.kind === 'badge') out.badges.push(r.item_id);
    else if (r.kind === 'ach') out.achievements.push(r.item_id);
  }
  return out;
}

/** True when it is new for this player. */
export function unlock(userId: number, kind: string, itemId: string): boolean {
  return qx.unlock.run(userId, kind, itemId, Date.now()).changes > 0;
}

export function giveXp(userId: number, xp: number): void {
  qx.giveXp.run(xp, userId);
}
