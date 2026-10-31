import { env, envNum, loadDotEnv, serviceSecret } from '@echo/node-kit/env';

// The game server's settings. Bundled into dist/, so a development .env sits one level up.
loadDotEnv(new URL('../.env', import.meta.url).pathname);

export const GAME = {
  port: envNum('GAME_PORT', 8092),
  host: env('HOST', '127.0.0.1'),
  /** This instance's name in the meta server's registry. */
  id: env('GAME_ID', 'game-1'),
  /** Where browsers reach this instance's WebSocket on the site (nginx location). */
  publicPath: env('GAME_PUBLIC_PATH', '/game'),
  /** Where the meta server reaches this instance's /internal endpoints. */
  internalUrl: env('GAME_INTERNAL_URL', 'http://127.0.0.1:8092'),
  metaUrl: env('META_URL', 'http://127.0.0.1:8091'),
  apiUrl: env('API_URL', 'http://127.0.0.1:8090'),
  secret: serviceSecret(),
  /** Pages allowed to open the WebSocket (empty: any, for development). */
  origins: env('ORIGINS', '').split(',').filter(Boolean),
  maxRooms: envNum('MAX_ROOMS', 40),
  /** On shutdown: how long running matches may go on before they are cut. */
  drainSec: envNum('DRAIN_SEC', 120),
  rtc: {
    portBegin: envNum('RTC_PORT_BEGIN', 40000),
    portEnd: envNum('RTC_PORT_END', 40199),
    stun: env('RTC_STUN', 'stun:stun.l.google.com:19302'),
  },
  ranked: {
    /** Seconds a player alone in the arena waits before the match is called. */
    aloneSec: envNum('RANKED_ALONE', 20),
  },
};
