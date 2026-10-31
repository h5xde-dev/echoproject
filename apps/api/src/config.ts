import { env, envNum, loadDotEnv, serviceSecret } from '@echo/node-kit/env';

// The API's settings. Bundled into dist/, so a development .env sits one level up.
loadDotEnv(new URL('../.env', import.meta.url).pathname);

export const API = {
  port: envNum('API_PORT', 8090),
  host: env('HOST', '127.0.0.1'),
  dbPath: env('DB_PATH', 'north.db'),
  /** Site origin, for redirects after login. */
  origin: env('ORIGIN', 'http://127.0.0.1:5173'),
  /** Built site, for the server-rendered rating page. */
  distDir: env('DIST_DIR', new URL('../../web/dist', import.meta.url).pathname),
  secret: serviceSecret(),
  yandex: {
    clientId: env('YANDEX_CLIENT_ID'),
    clientSecret: env('YANDEX_CLIENT_SECRET'),
    redirect: env('YANDEX_REDIRECT', 'https://evntary.ru/callback'),
  },
  /** Development only: /auth/dev?name=… logs in without Yandex. */
  devLogin: env('DEV_LOGIN') === '1',
  /** Cookies over HTTPS only (off for local http development). */
  secureCookies: env('SECURE_COOKIES', '1') === '1',
};
