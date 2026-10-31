/**
 * The three services end to end, without a browser: API, meta and game on
 * spare ports with a throwaway database. Covers a room by code (guest host,
 * signed-in guest, warm-up, the host's start), input validation, a ranked
 * match with a dropped player coming back, rating and experience.
 *
 *   npm run build --workspaces --if-present && npm run test:services
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const root = new URL('..', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'echo-services-'));
const PORTS = { api: 8390, meta: 8391, game: 8392 };
const env = {
  ...process.env,
  NODE_ENV: 'test',
  DEV_LOGIN: '1',
  SECURE_COOKIES: '0',
  SERVICE_SECRET: 'test-secret',
  DB_PATH: join(dir, 'test.db'),
  API_PORT: String(PORTS.api),
  META_PORT: String(PORTS.meta),
  GAME_PORT: String(PORTS.game),
  API_URL: `http://127.0.0.1:${PORTS.api}`,
  META_URL: `http://127.0.0.1:${PORTS.meta}`,
  GAME_INTERNAL_URL: `http://127.0.0.1:${PORTS.game}`,
  RANKED_GATHER: '1',
  RANKED_ALONE: '3',
  RTC_PORT_BEGIN: '40300',
  RTC_PORT_END: '40320',
  DRAIN_SEC: '2',
};

let failures = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const logs = [];
const procs = ['api', 'meta', 'game'].map((s) => {
  const p = spawn('node', [`apps/${s}/dist/main.mjs`], { cwd: root, env });
  for (const st of [p.stdout, p.stderr]) st.on('data', (d) => logs.push(`[${s}] ${d}`.trim()));
  return p;
});

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    await sleep(100);
  }
  throw new Error(`timeout: ${what}`);
}

/** Dev login: the session cookie for a named account. */
async function login(name) {
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/auth/dev?name=${encodeURIComponent(name)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('ne_sid=')).split(';')[0];
}

/** A socket that queues messages so a test can wait for a given type. */
function open(url, cookie) {
  const ws = new WebSocket(url, { headers: cookie ? { cookie } : {} });
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    // A waiting test takes the message; otherwise it waits in the inbox.
    const w = waiters.find((x) => x.pred(m));
    if (w) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    } else {
      inbox.push(m);
    }
  });
  const next = (pred, ms = 8000) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => {
        const j = waiters.indexOf(w);
        if (j >= 0) {
          waiters.splice(j, 1);
          reject(new Error(`no message matching ${pred}`));
        }
      }, ms);
    });
  };
  const ready = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return { ws, next, inbox, ready, send: (m) => ws.send(JSON.stringify(m)), closed: new Promise((r) => ws.on('close', (code) => r(code))) };
}

const meta = (cookie) => open(`ws://127.0.0.1:${PORTS.meta}/meta`, cookie);
const game = (url, ticket) => open(`ws://127.0.0.1:${PORTS.game}${url}?ticket=${encodeURIComponent(ticket)}`);
const input = (seq, extra = {}) => ({ t: 'input', seq, moveX: 0, moveZ: 0, aim: 0, fire: false, reload: false, interact: false, flashlight: false, slot: -1, dt: 1 / 60, ...extra });

try {
  for (const [s, port] of Object.entries(PORTS)) await waitFor(() => fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok), 10000, `${s} up`);
  await waitFor(() => fetch(`http://127.0.0.1:${PORTS.meta}/meta/status`).then((r) => r.json()).then((s) => s.online), 10000, 'game registered with meta');
  check(true, 'api, meta and game are up; the game server registered with meta');

  // ------------------------------------------------------------ room by code
  const hostMeta = meta();
  await hostMeta.ready;
  hostMeta.send({ t: 'hello', guestId: 'guest-host-0001', name: 'Хост', cls: 'medic', color: -1 });
  const me = await hostMeta.next((m) => m.t === 'me');
  check(!me.signedIn && me.name === 'Хост', 'guest hello: playing without an account');
  hostMeta.send({ t: 'create', opts: { mode: 'coop', arena: 'sklad', difficulty: 'normal', bots: true } });
  const hostTicket = await hostMeta.next((m) => m.t === 'ticket');
  check(/^[A-Z2-9]{5}$/.test(hostTicket.code), `room created with code ${hostTicket.code}`);

  const host = game(hostTicket.url, hostTicket.ticket);
  await host.ready;
  const hostRoom = await host.next((m) => m.t === 'room');
  check(hostRoom.host && hostRoom.code === hostTicket.code, 'creator is the room host');
  const hostWelcome = await host.next((m) => m.t === 'welcome');
  check(hostWelcome.map && hostWelcome.playerId === 1, 'host gets the welcome with the map');
  const lobby1 = await host.next((m) => m.t === 'lobby');
  check(lobby1.started === false && lobby1.players.length === 1, 'warm-up lobby with the host');

  const aliceCookie = await login('Алиса');
  const joinMeta = meta(aliceCookie);
  await joinMeta.ready;
  joinMeta.send({ t: 'hello', guestId: 'ignored-when-signed', name: 'не то имя', cls: 'scout', color: 0x3fd6c8 });
  const me2 = await joinMeta.next((m) => m.t === 'me');
  check(me2.signedIn && me2.name === 'Алиса', 'signed-in hello: the account name is used');
  joinMeta.send({ t: 'join', code: hostTicket.code.toLowerCase() });
  const joinTicket = await joinMeta.next((m) => m.t === 'ticket');
  const alice = game(joinTicket.url, joinTicket.ticket);
  await alice.ready;
  const aliceWelcome = await alice.next((m) => m.t === 'welcome');
  check(aliceWelcome.playerId === 2 && aliceWelcome.colors['2'] === 0x3fd6c8, 'second player seated with the chosen ring colour');
  await host.next((m) => m.t === 'joined' && m.playerId === 2);
  check(true, 'host hears the join');

  joinMeta.send({ t: 'join', code: 'ZZZZZ' });
  const bad = await joinMeta.next((m) => m.t === 'error');
  check(/не найдена/.test(bad.text), 'unknown code: a clear error');

  // Input: a cheating stick and NaN must not break the match.
  for (let i = 1; i <= 20; i++) alice.send(input(i, { moveX: 50, moveZ: 'x', aim: null, gait: 'teleport', buy: 'nuke' }));
  const snap = await alice.next((m) => m.t === 'snap' && m.ack['2'] >= 10);
  const a2 = snap.actors.find((a) => a.id === 2);
  check(Number.isFinite(a2.x) && Number.isFinite(a2.z), 'malformed input is cleaned: positions stay finite');

  alice.send({ t: 'ready', ready: true });
  await host.next((m) => m.t === 'lobby' && m.players.some((p) => p.id === 2 && p.ready));
  check(true, 'ready flag reaches the host');
  alice.send({ t: 'start' });
  await sleep(300);
  check(!alice.inbox.some((m) => m.t === 'lobby' && m.started), 'a non-host cannot start the match');
  host.send({ t: 'start' });
  const w2 = await alice.next((m) => m.t === 'welcome');
  const started = await alice.next((m) => m.t === 'lobby' && m.started);
  check(w2.seed !== aliceWelcome.seed && started.started, 'host starts: fresh map and welcome for everyone');

  // Reconnect: the same seat (same player id) within the grace period.
  alice.ws.terminate();
  await host.next((m) => m.t === 'left' && m.playerId === 2);
  joinMeta.send({ t: 'join', code: hostTicket.code });
  const again = await joinMeta.next((m) => m.t === 'ticket');
  const alice2 = game(again.url, again.ticket);
  await alice2.ready;
  const back = await alice2.next((m) => m.t === 'welcome');
  check(back.playerId === 2, 'dropped player comes back to the same seat');
  alice2.ws.close();
  host.ws.close();
  hostMeta.ws.close();
  joinMeta.ws.close();

  // ---------------------------------------------------------------- ranked
  const bobCookie = await login('Боб');
  const guestMeta = meta();
  await guestMeta.ready;
  guestMeta.send({ t: 'hello', guestId: 'guest-rank-0001', name: 'гость' });
  await guestMeta.next((m) => m.t === 'me');
  guestMeta.send({ t: 'queue' });
  const refused = await guestMeta.next((m) => m.t === 'mm' && m.state === 'error');
  check(/Яндекс/.test(refused.text), 'ranked needs an account');
  guestMeta.ws.close();

  const qa = meta(aliceCookie);
  const qb = meta(bobCookie);
  await Promise.all([qa.ready, qb.ready]);
  qa.send({ t: 'hello', guestId: 'x0000000', name: '' });
  qb.send({ t: 'hello', guestId: 'x0000000', name: '' });
  await Promise.all([qa.next((m) => m.t === 'me'), qb.next((m) => m.t === 'me')]);
  qa.send({ t: 'queue' });
  await qa.next((m) => m.t === 'mm' && m.state === 'queue');
  qb.send({ t: 'queue' });
  const [ta, tb] = await Promise.all([qa.next((m) => m.t === 'ticket', 10000), qb.next((m) => m.t === 'ticket', 10000)]);
  check(ta.ranked && ta.code === tb.code, `ranked match found: ${ta.code}`);
  const ra = game(ta.url, ta.ticket);
  const rb = game(tb.url, tb.ticket);
  await Promise.all([ra.ready, rb.ready]);
  const [wa] = await Promise.all([ra.next((m) => m.t === 'welcome'), rb.next((m) => m.t === 'welcome')]);
  const snapR = await ra.next((m) => m.t === 'snap');
  check(snapR.actors.filter((a) => a.kind === 'player').length === 2 && !snapR.actors.some((a) => a.peerId?.startsWith?.('bot')) && wa.map.mode === 'dm', 'ranked deathmatch: two humans, no bots');

  // Bob drops and asks for ranked again: straight back to his match.
  rb.ws.terminate();
  await sleep(200);
  qb.send({ t: 'queue' });
  const tb2 = await qb.next((m) => m.t === 'ticket');
  check(tb2.code === ta.code, 'dropped ranked player is sent back to the same match');
  const rb2 = game(tb2.url, tb2.ticket);
  await rb2.ready;
  await rb2.next((m) => m.t === 'welcome');
  // Now Bob walks out for good: Alice is alone, the match is called and rated.
  rb2.ws.close();
  const result = await ra.next((m) => m.t === 'ranked', 45000);
  const top = result.rows[0];
  check(top.name === 'Алиса' && top.after > top.before, `rated: ${result.rows.map((r) => `${r.name} ${Math.round(r.before)}→${Math.round(r.after)}`).join(', ')}`);
  const prog = await ra.next((m) => m.t === 'progress');
  check(prog.gained > 0, `experience counted by the server: +${prog.gained}`);
  const board = await fetch(`http://127.0.0.1:${PORTS.api}/api/leaderboard`).then((r) => r.json());
  check(board.rows[0]?.name === 'Алиса' && board.rows[0].games === 1, 'leaderboard updated');
  ra.ws.close();
  qa.ws.close();
  qb.ws.close();

  // -------------------------------------------------------------- shutdown
  const gameProc = procs[2];
  gameProc.kill('SIGTERM');
  const code = await new Promise((r) => gameProc.on('exit', r));
  check(code === 0, 'game server drains and exits cleanly on SIGTERM');
} catch (err) {
  console.error(err);
  failures++;
} finally {
  for (const p of procs) p.kill('SIGTERM');
  await sleep(300);
  const errors = logs.filter((l) => /error|failed|TypeError/i.test(l) && !/could not save/.test(l));
  check(errors.length === 0, `no errors in the service logs${errors.length ? `:\n${errors.join('\n')}` : ''}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
