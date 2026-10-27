import { existsSync, readFileSync } from 'node:fs';

// Settings from the environment (systemd's EnvironmentFile in production, an
// optional server/.env when developing). Secrets never live in the repo.

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
// Bundled into server-dist/, so the file sits one level up.
loadDotEnv(new URL('../server/.env', import.meta.url).pathname);

const env = (key: string, fallback = ''): string => process.env[key] ?? fallback;

export const SERVER = {
  port: Number(env('PORT', '8095')),
  host: env('HOST', '127.0.0.1'),
  dbPath: env('DB_PATH', 'north.db'),
  /** Site origin, for redirects after login. */
  origin: env('ORIGIN', 'http://127.0.0.1:5173'),
  /** Built site, for the server-rendered rating page. */
  distDir: env('DIST_DIR', new URL('../dist', import.meta.url).pathname),
  yandex: {
    clientId: env('YANDEX_CLIENT_ID'),
    clientSecret: env('YANDEX_CLIENT_SECRET'),
    redirect: env('YANDEX_REDIRECT', 'https://evntary.ru/callback'),
  },
  /** Development only: /auth/dev?name=… logs in without Yandex. */
  devLogin: env('DEV_LOGIN') === '1',
  /** Cookies over HTTPS only (off for local http development). */
  secureCookies: env('SECURE_COOKIES', '1') === '1',
  rtc: {
    portBegin: Number(env('RTC_PORT_BEGIN', '40000')),
    portEnd: Number(env('RTC_PORT_END', '40199')),
  },
  ranked: {
    minPlayers: Number(env('RANKED_MIN', '2')),
    maxPlayers: Number(env('RANKED_MAX', '6')),
    /** Seconds the queue waits for more players once the minimum is there. */
    gatherSec: Number(env('RANKED_GATHER', '20')),
    /** Seconds a player alone in the arena waits before the match is called. */
    aloneSec: Number(env('RANKED_ALONE', '20')),
  },
};
