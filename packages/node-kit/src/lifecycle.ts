import type { Server } from 'node:http';

/**
 * SIGTERM / SIGINT: stop taking new connections, let `drain` finish (it may
 * take a while: the game server lets running matches end), then exit. systemd's
 * TimeoutStopSec is the hard limit above this.
 */
export function onShutdown(server: Server, drain: () => Promise<void> | void = () => undefined): void {
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (stopping) process.exit(1);
      stopping = true;
      console.log(`${sig}: shutting down`);
      server.close();
      Promise.resolve()
        .then(drain)
        .catch((err: unknown) => console.error('drain failed:', err))
        .finally(() => process.exit(0));
    });
  }
}

/** Cookies from a request header. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* a malformed cookie is skipped */
      }
    }
  }
  return out;
}
