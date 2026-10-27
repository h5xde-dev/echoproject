import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SERVER } from './config';
import { createSession, dropSession, upsertYandexUser, userBySession, type UserRow } from './db';

// Login with Yandex ID (OAuth 2.0 authorization code flow). The browser goes to
// oauth.yandex.ru, comes back to /callback with a code; the code and the client
// secret buy an access token, the token buys the profile. The player then gets
// a session cookie; the token itself is not kept.

const SESSION_COOKIE = 'ne_sid';
const STATE_COOKIE = 'ne_state';
const SESSION_TTL = 60 * 24 * 3600 * 1000;

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${SERVER.secureCookies ? '; Secure' : ''}`;
}

/** The signed-in player for this request, if any. */
export function currentUser(req: IncomingMessage): UserRow | null {
  const token = parseCookies(req)[SESSION_COOKIE];
  return token ? userBySession(token) : null;
}

function redirect(res: ServerResponse, to: string, cookies: string[] = []): void {
  res.writeHead(302, { Location: to, 'Set-Cookie': cookies, 'Cache-Control': 'no-store' });
  res.end();
}

/** Only local paths, so the login cannot be turned into an open redirect. */
function safeNext(next: string | null): string {
  return next && /^\/(?!\/)[\w\-/?=&.%]*$/.test(next) ? next : '/play';
}

function startSession(res: ServerResponse, user: UserRow, next: string): void {
  const token = randomBytes(32).toString('hex');
  createSession(token, user.id, SESSION_TTL);
  redirect(res, next, [cookie(SESSION_COOKIE, token, SESSION_TTL / 1000), cookie(STATE_COOKIE, '', 0)]);
}

/** GET /auth/yandex?next=/play: off to Yandex. */
export function beginYandex(_req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (!SERVER.yandex.clientId) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Вход через Яндекс не настроен');
    return;
  }
  const state = randomBytes(16).toString('hex');
  const next = safeNext(url.searchParams.get('next'));
  const to = new URL('https://oauth.yandex.ru/authorize');
  to.searchParams.set('response_type', 'code');
  to.searchParams.set('client_id', SERVER.yandex.clientId);
  to.searchParams.set('redirect_uri', SERVER.yandex.redirect);
  to.searchParams.set('state', state);
  redirect(res, to.toString(), [cookie(STATE_COOKIE, `${state}|${next}`, 600)]);
}

/** GET /callback?code=…&state=…: back from Yandex. */
export async function yandexCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const [state, next] = (parseCookies(req)[STATE_COOKIE] ?? '').split('|');
  const code = url.searchParams.get('code');
  if (!code || !state || url.searchParams.get('state') !== state) {
    redirect(res, '/play?login=failed', [cookie(STATE_COOKIE, '', 0)]);
    return;
  }
  try {
    const tokenRes = await fetch('https://oauth.yandex.ru/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: SERVER.yandex.clientId,
        client_secret: SERVER.yandex.clientSecret,
      }),
    });
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!token.access_token) throw new Error(`token: ${tokenRes.status}`);
    const infoRes = await fetch('https://login.yandex.ru/info?format=json', {
      headers: { Authorization: `OAuth ${token.access_token}` },
    });
    const info = (await infoRes.json()) as {
      id?: string;
      login?: string;
      display_name?: string;
      real_name?: string;
      default_avatar_id?: string;
      is_avatar_empty?: boolean;
    };
    if (!info.id) throw new Error(`info: ${infoRes.status}`);
    const user = upsertYandexUser({
      yandexId: info.id,
      login: info.login ?? '',
      name: cleanName(info.display_name || info.login || 'оператор'),
      avatar: info.default_avatar_id && !info.is_avatar_empty ? `https://avatars.yandex.net/get-yapic/${info.default_avatar_id}/islands-68` : '',
    });
    startSession(res, user, safeNext(next ?? null));
  } catch (err) {
    console.error('yandex login failed:', err instanceof Error ? err.message : err);
    redirect(res, '/play?login=failed', [cookie(STATE_COOKIE, '', 0)]);
  }
}

/** GET /auth/dev?name=…: local testing without Yandex (DEV_LOGIN=1 only). */
export function devLogin(_req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (!SERVER.devLogin) {
    res.writeHead(404).end();
    return;
  }
  const name = cleanName(url.searchParams.get('name') ?? 'тестер');
  const user = upsertYandexUser({ yandexId: `dev:${name}`, login: name, name, avatar: '' });
  startSession(res, user, safeNext(url.searchParams.get('next')));
}

/** POST /auth/logout. */
export function logout(req: IncomingMessage, res: ServerResponse): void {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) dropSession(token);
  res.writeHead(204, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) }).end();
}

/** In-game call signs: 14 characters, no markup. */
export function cleanName(raw: string): string {
  return raw.replace(/[<>"'`\\\u0000-\u001f]/g, '').trim().slice(0, 14) || 'оператор';
}
