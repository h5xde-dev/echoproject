import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** A request the client got wrong: answered with its status, not logged as a crash. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** The body as text, at most `limit` bytes: a bigger one is cut off with 413. */
export function readBody(req: IncomingMessage, limit = 16 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The body as a JSON object; malformed JSON is the client's fault (400). */
export async function readJson<T = Record<string, unknown>>(req: IncomingMessage, limit?: number): Promise<T> {
  const text = await readBody(req, limit);
  if (!text) return {} as T;
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object') throw new Error('not an object');
    return v as T;
  } catch {
    throw new HttpError(400, 'bad json');
  }
}

export const SERVICE_HEADER = 'x-service-key';

/** Service-to-service calls carry the shared secret; compared in constant time. */
export function isService(req: IncomingMessage, secret: string): boolean {
  const got = Buffer.from(String(req.headers[SERVICE_HEADER] ?? ''));
  const want = Buffer.from(secret);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Wraps a router: client errors get their status, anything else a logged 500. */
export function handle(route: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    Promise.resolve()
      .then(() => route(req, res, url))
      .catch((err: unknown) => {
        if (err instanceof HttpError) {
          if (!res.headersSent) json(res, err.status, { error: err.message });
          return;
        }
        console.error(`${req.method} ${url.pathname}:`, err);
        if (!res.headersSent) json(res, 500, { error: 'server' });
      });
  };
}

/** A call to another service on this machine, with the shared secret. */
export async function callService<T>(base: string, path: string, secret: string, body?: unknown, timeoutMs = 5000): Promise<T> {
  const res = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', [SERVICE_HEADER]: secret },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

/** Same-site check for WebSocket upgrades: a page elsewhere cannot use the visitor's cookies. */
export function originAllowed(req: IncomingMessage, allowed: string[]): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser (tests, tools)
  return allowed.includes(origin);
}
