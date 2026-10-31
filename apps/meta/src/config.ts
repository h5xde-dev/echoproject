import { env, envNum, loadDotEnv, serviceSecret } from '@echo/node-kit/env';

// The meta server's settings. Bundled into dist/, so a development .env sits one level up.
loadDotEnv(new URL('../.env', import.meta.url).pathname);

export const META = {
  port: envNum('META_PORT', 8091),
  host: env('HOST', '127.0.0.1'),
  apiUrl: env('API_URL', 'http://127.0.0.1:8090'),
  secret: serviceSecret(),
  /** Pages allowed to open the WebSocket (empty: any, for development). */
  origins: env('ORIGINS', '').split(',').filter(Boolean),
  /** A game instance that has not reported for this long is gone. */
  staleMs: envNum('GAME_STALE_MS', 10_000),
  /** How long a ticket opens a seat. Reconnecting asks for a new one. */
  ticketMs: envNum('TICKET_SEC', 120) * 1000,
  ranked: {
    minPlayers: envNum('RANKED_MIN', 2),
    maxPlayers: envNum('RANKED_MAX', 6),
    /** Seconds the queue waits for more players once the minimum is there. */
    gatherSec: envNum('RANKED_GATHER', 20),
  },
};
