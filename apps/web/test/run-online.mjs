/**
 * Online rooms end to end in real browsers: one guest opens a room on the game
 * server, a second guest joins by its code. Checks that the joiner gets the
 * game (no black screen), that both see each other move through the server,
 * that the joiner's prediction agrees with the server, that only the host
 * starts the match, and that a dropped link comes back to the same soldier.
 *
 *   npm run dev:services
 *   npm run dev
 *   ONLINE_URL=http://127.0.0.1:5173 npm run test:online
 */
import { chromium } from 'playwright';

const BASE = process.env.ONLINE_URL ?? 'http://127.0.0.1:5173';
let failures = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: (process.env.ONLINE_GL ?? '--enable-gpu,--ignore-gpu-blocklist').split(',').filter(Boolean) });
const errors = [];
async function player(name) {
  // Small and without shadows: two 3D pages on a software renderer are slow enough.
  const ctx = await browser.newContext({ viewport: { width: 800, height: 450 } });
  await ctx.addInitScript(() => localStorage.setItem('echo.settings', JSON.stringify({ quality: 'low', volume: 0, roomBots: false })));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|favicon|net::/.test(m.text())) errors.push(`${name}: ${m.text()}`);
  });
  await page.goto(`${BASE}/play`);
  await page.waitForFunction(() => !document.querySelector('#btn-host').disabled, null, { timeout: 120000, polling: 250 });
  await page.fill('#player-name', name);
  return { ctx, page };
}
/** Polled from here: a page in the background may not run its animation frames. */
async function inGame(p, ms = 90000) {
  const until = Date.now() + ms;
  const t0 = Date.now();
  while (Date.now() < until) {
    const ok = await p.page.evaluate(() => document.querySelector('#menu').classList.contains('hidden') && !document.querySelector('#hud').classList.contains('hidden'));
    if (ok) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('not in the game');
}

try {
  const a = await player('Альфа');
  const b = await player('Браво');

  // A deathmatch room without bots: nobody shoots the joiner while a slow
  // software renderer loads the map.
  await a.page.click('.mode-card[data-mode="dm"]');
  await a.page.click('#btn-host');
  await inGame(a);
  const code = await a.page.evaluate(() => window.echo.game.roomCode);
  check(/^[A-Z2-9]{5}$/.test(code), `room opened on the server: ${code}`);
  check(await a.page.evaluate(() => window.echo.game.isHost && !document.querySelector('.panel-lobby').classList.contains('hidden')), 'the creator hosts the warm-up lobby');

  await b.page.fill('#room-code', code);
  await b.page.click('#btn-join');
  const took = await inGame(b).catch(async (e) => {
    console.log('debug b:', await b.page.evaluate(() => { const g = window.echo.game; return JSON.stringify({ err: document.querySelector('.menu-error')?.textContent, got: g.gotWelcome, conn: g.net.connected, code: g.roomCode, running: g.running, menu: document.querySelector('#menu').className, hud: document.querySelector('#hud').className, join: document.querySelector('#btn-join').innerText }); }));
    throw e;
  });
  console.log(`(joiner in the game after ${took} ms)`);
  const bState = await b.page.evaluate(() => ({ id: window.echo.game.localId, actors: window.echo.game.latestActors.size, running: window.echo.game.inSession }));
  check(bState.id === 2 && bState.actors === 2 && bState.running, 'the joiner is in the game with the map and both soldiers, no bots (no black screen)');
  await a.page.waitForFunction(() => /Браво/.test(document.querySelector('.lobby-list').textContent), null, { timeout: 5000, polling: 250 });
  check(true, 'the host sees the joiner in the lobby');

  // The joiner moves; the host sees it through the server; prediction agrees.
  const pos = () => a.page.evaluate(() => {
    const p = window.echo.game.latestActors.get(2);
    return { x: p.x, z: p.z };
  });
  const p0 = await pos();
  // The keyboard belongs to the game once no text field has focus.
  await b.page.evaluate(() => document.activeElement?.blur());
  await b.page.bringToFront();
  let moved = 0;
  // Whichever way is open from the spawn point.
  for (const key of ['KeyD', 'KeyS', 'KeyA', 'KeyW']) {
    await b.page.keyboard.down(key);
    // Held long enough for a slow software renderer to run its ticks.
    await b.page.waitForTimeout(3000);
    await b.page.keyboard.up(key);
    await b.page.waitForTimeout(400);
    const p1 = await pos();
    moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    if (moved > 0.5) break;
  }
  const keys = await b.page.evaluate(async () => {
    let frames = 0;
    const count = () => {
      frames++;
      if (frames < 1000) requestAnimationFrame(count);
    };
    requestAnimationFrame(count);
    await new Promise((r) => setTimeout(r, 2000));
    return `${window.echo.game.input.enabled}, ${frames / 2} fps, visible ${document.visibilityState}`;
  });
  check(moved > 0.5, `the host sees the joiner move (${moved.toFixed(1)} m; input enabled: ${keys})`);
  const gap = await b.page.evaluate(() => {
    const g = window.echo.game;
    const me = g.sim.actors.get(g.localId);
    const srv = g.latestActors.get(g.localId);
    return Math.hypot(me.x - srv.x, me.z - srv.z);
  });
  check(gap < 0.5, `prediction agrees with the server (gap ${gap.toFixed(2)} m)`);

  // Controls «по прицелу» (the default): W runs toward the cursor. Tried in four
  // directions, since a wall may stand on one side of the spawn. The camera leads
  // toward the cursor, so the heading drifts a little as the soldier runs.
  const me = () => b.page.evaluate(() => {
    const g = window.echo.game;
    const a = g.latestActors.get(g.localId);
    return { x: a.x, z: a.z, controls: g.controls, screen: g.renderer.project(a.x, 0, a.z) };
  });
  let best = { along: 0, across: 0, dir: '' };
  for (const [name, ux, uz] of [['right', 1, 0], ['down', 0, 1], ['left', -1, 0], ['up', 0, -1]]) {
    const p0 = await me();
    await b.page.mouse.move(p0.screen.x + ux * 220, p0.screen.y + uz * 220);
    await b.page.keyboard.down('KeyW');
    await b.page.waitForTimeout(700);
    await b.page.keyboard.up('KeyW');
    await b.page.waitForTimeout(300);
    const p1 = await me();
    const along = (p1.x - p0.x) * ux + (p1.z - p0.z) * uz;
    const across = Math.abs((p1.x - p0.x) * -uz + (p1.z - p0.z) * ux);
    if (along > best.along) best = { along, across, dir: name };
    if (along > 1) break;
  }
  check(best.along > 1 && best.across < best.along, `controls by the aim: W runs toward the cursor (${best.dir}: ${best.along.toFixed(1)} m along, ${best.across.toFixed(1)} m across)`);

  // Only the host starts the match.
  const seed0 = await b.page.evaluate(() => window.echo.game.map.seed);
  await b.page.evaluate(() => window.echo.game.net.send({ t: 'start' }));
  await b.page.waitForTimeout(500);
  check((await b.page.evaluate(() => window.echo.game.map.seed)) === seed0, 'a guest cannot start the match');
  await a.page.click('.lobby-action');
  await b.page.waitForFunction((s) => window.echo.game.map.seed !== s, seed0, { timeout: 5000, polling: 250 });
  check(await b.page.evaluate(() => document.querySelector('.panel-lobby').classList.contains('hidden')), 'the host starts: a new map for everyone, the lobby closes');

  // A dropped link: back to the same soldier.
  await b.page.evaluate(() => window.echo.game.net['conn'].ws.close());
  await b.page.waitForTimeout(300);
  await b.page.waitForFunction(() => window.echo.game.net.connected && window.echo.game.localId === 2, null, { timeout: 30000, polling: 250 }).catch(async (e) => {
    console.log('debug reconnect:', await b.page.evaluate(() => { const g = window.echo.game; return JSON.stringify({ id: g.localId, conn: g.net.connected, rec: g.reconnecting, status: document.querySelector('.status-line').textContent, over: document.querySelector('.gameover').className, title: document.querySelector('.gameover-title').textContent }); }));
    throw e;
  });
  check(true, 'after a dropped link the joiner is back as the same soldier');

  // An invite link drops a friend straight into the room.
  const d = await player('Дельта');
  await d.page.goto(`${BASE}/play?room=${code}`);
  await inGame(d);
  check((await d.page.evaluate(() => window.echo.game.roomCode)) === code, 'an invite link /play?room=CODE joins that room');

  // Quick play: a public room with bots, and it shows in the open-room list.
  const e = await player('Эхо');
  await e.page.click('.mode-card[data-mode="dm"]');
  await e.page.click('#btn-quick');
  await inGame(e);
  const q = await e.page.evaluate(() => ({ code: window.echo.game.roomCode, pub: window.echo.game.roomPublic, bots: [...window.echo.game.latestActors.values()].filter((a) => a.kind === 'enemy').length }));
  check(q.pub && q.bots > 0, `quick play: a public room with bots right away (${q.code}, ${q.bots} bots)`);
  const f = await player('Фокстрот');
  await f.page.waitForFunction((c) => [...document.querySelectorAll('.open-room')].length > 0 && document.querySelector('.open-rooms-list').textContent.length > 0, q.code, { timeout: 15000, polling: 500 });
  check(true, 'the menu lists open rooms');

  // A wrong code: a clear message, back in the menu.
  const c = await player('Чарли');
  await c.page.fill('#room-code', 'ZZZZZ');
  await c.page.click('#btn-join');
  await c.page.waitForSelector('.menu-error', { timeout: 10000, polling: 250 });
  check(/не найдена/.test(await c.page.textContent('.menu-error')), 'a wrong code says so');
} catch (err) {
  console.error(err);
  failures++;
}

await browser.close();
for (const e of errors) console.log(`page error: ${e}`);
console.log(`${failures + errors.length} failures`);
process.exit(failures + errors.length > 0 ? 1 : 0);
