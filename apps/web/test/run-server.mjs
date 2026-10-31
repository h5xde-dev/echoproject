/**
 * Ranked play end to end in real browsers: two players sign in (dev login),
 * queue on the meta server, get a game-server match without bots over the
 * UDP-like channel, and are rated when one walks out.
 *
 *   RANKED_GATHER=1 RANKED_ALONE=2 npm run dev:services   (fresh DB_PATH)
 *   npm run dev
 *   SERVER_TEST_URL=http://127.0.0.1:5173 npm run test:server
 */
import { chromium } from 'playwright';

const BASE = process.env.SERVER_TEST_URL ?? 'http://127.0.0.1:5173';
let failures = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
async function player(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(`${BASE}/auth/dev?name=${encodeURIComponent(name)}&next=/play`);
  await page.waitForFunction(() => !document.querySelector('#btn-ranked').disabled && !document.querySelector('.account-user').classList.contains('hidden'), null, { timeout: 120000 });
  return { ctx, page };
}

const a = await player('Альфа');
const b = await player('Браво');
check((await a.page.textContent('.account-name')) === 'Альфа', 'signed in: the account shows in the menu');

await a.page.click('#btn-ranked');
await a.page.waitForFunction(() => /1 \/ 2/.test(document.querySelector('.ranked-count').textContent), null, { timeout: 15000 });
check(true, 'first player waits in the queue (1 / 2)');
await b.page.click('#btn-ranked');

for (const p of [a, b]) await p.page.waitForFunction(() => document.querySelector('#menu').classList.contains('hidden'), null, { timeout: 30000 });
check(true, 'the second player starts the match for both');

const state = (p) =>
  p.page.evaluate(() => {
    const g = window.echo.game;
    return { actors: [...g.sim.actors.keys()], latest: [...g.latestActors.values()].map((x) => ({ id: x.id, kind: x.kind, x: x.x })), udp: g.net.udp, mode: g.matchMode, local: g.localId };
  });
let sa = await state(a);
check(sa.mode === 'dm', `server match is a deathmatch (${sa.mode})`);
await a.page.waitForFunction(() => window.echo.game.latestActors.size === 2, null, { timeout: 15000 });
sa = await state(a);
check(sa.latest.length === 2 && sa.latest.every((x) => x.kind === 'player'), `no bots: ${sa.latest.length} soldiers, all players`);
await a.page.waitForFunction(() => window.echo.game.net.udp, null, { timeout: 20000 }).catch(() => undefined);
sa = await state(a);
check(sa.udp, 'snapshots and input run over the unreliable data channel');

// B moves: A sees it through the server.
const bId = (await state(b)).local;
const before = (await state(a)).latest.find((x) => x.id === bId).x;
await b.page.keyboard.down('KeyD');
await a.page.waitForFunction(([id, x0]) => Math.abs(window.echo.game.latestActors.get(id).x - x0) > 1, [bId, before], { timeout: 30000 }).catch(() => undefined);
await b.page.keyboard.up('KeyD');
const after = (await state(a)).latest.find((x) => x.id === bId).x;
check(Math.abs(after - before) > 1, `the other player's moves arrive (${before.toFixed(1)} → ${after.toFixed(1)})`);

// B walks out: A is alone, the match is called and rated.
await b.ctx.close();
await a.page.waitForFunction(() => !!document.querySelector('.gameover-rating')?.textContent, null, { timeout: 30000 }).catch(() => undefined);
const line = await a.page.evaluate(() => document.querySelector('.gameover-rating')?.textContent ?? '');
check(/РЕЙТИНГ 1000 → 10\d\d/.test(line), `the one who stayed is rated up: "${line}"`);
const board = await a.page.evaluate(() => fetch('/api/leaderboard').then((r) => r.json()));
const names = board.rows.map((r) => `${r.name}:${r.rating}`);
check(board.rows.length >= 2 && board.rows[0].rating > 1000 && board.rows.some((r) => r.rating < 1000), `rating table updated (${names.join(', ')})`);

const page = await (await browser.newContext()).newPage();
await page.goto(`${BASE}/`);
check((await page.title()).includes('North Echo'), 'landing page is up');

await browser.close();
for (const e of errors) console.log(`page error: ${e}`);
console.log(`${failures + errors.length} failures`);
process.exit(failures + errors.length > 0 ? 1 : 0);
