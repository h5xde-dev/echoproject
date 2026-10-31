/**
 * Frame-time profile of a running dev server: plays a bots-only match, makes
 * the mid-game things happen (supply drop, flare, mine, mortar, drone, fire),
 * and reports slow frames with the methods that ate the time.
 *
 *   PERF_URL=http://127.0.0.1:5173 node tools/perf.mjs [arena] [mode] [seconds]
 */
import { chromium } from 'playwright';

const base = process.env.PERF_URL ?? 'http://127.0.0.1:5173';
const [arena = 'labirint', mode = 'dm', secs = '40'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
const throttle = Number(process.env.PERF_CPU ?? 1);
if (throttle > 1) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
}
await page.goto(`${base}/play`);
await page.waitForFunction(() => !document.querySelector('#btn-solo').disabled, null, { timeout: 120000 });
await page.click(`.mode-card[data-mode="${mode}"]`);
if (mode !== 'coop') await page.click(`.arena-btn[data-arena="${arena}"]`);
await page.evaluate(() => {
  // Time every method of the hot objects; per frame, keep the slow ones.
  const g = window.echo.game;
  const stats = { frames: [], current: new Map() };
  window.__perf = stats;
  const wrap = (obj, label) => {
    const proto = Object.getPrototypeOf(obj);
    for (const name of Object.getOwnPropertyNames(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || typeof d.value !== 'function' || name === 'constructor') continue;
      const fn = d.value;
      obj[name] = function (...args) {
        const t = performance.now();
        try {
          return fn.apply(this, args);
        } finally {
          const k = `${label}.${name}`;
          stats.current.set(k, (stats.current.get(k) ?? 0) + performance.now() - t);
        }
      };
    }
  };
  window.__wrap = wrap;
  // The loop itself: how long each frame's JavaScript takes.
  const loop = g.loop;
  g.loop = (now) => {
    const t = performance.now();
    loop(now);
    stats.work = performance.now() - t;
  };
  wrap(g.renderer, 'renderer');
  wrap(g.hud, 'hud');
  let last = performance.now();
  const frame = () => {
    const now = performance.now();
    const dt = now - last;
    last = now;
    const np = g.renderer.renderer.info.programs.length;
    if (np !== stats.np) { stats.np = np; stats.progAt = stats.progAt ?? []; stats.progAt.push(`${(performance.now() / 1000).toFixed(1)}s:${np}`); }
    if (g.inSession) {
      const top = [...stats.current].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v.toFixed(1)}`);
      stats.frames.push({ dt, top, work: stats.work ?? 0 });
    }
    stats.current.clear();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
});
await page.click('#btn-solo');
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const g = window.echo.game;
  window.__wrap(g.sim, 'sim');
  window.__perf.frames.length = 0;
  window.__programs0 = g.renderer.renderer.info.programs.map((x) => x.name + ':' + x.cacheKey.length + ':' + [...x.cacheKey].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0));
});
const T = Number(secs) * 1000;
const t0 = Date.now();
let did = new Set();
while (Date.now() - t0 < T) {
  const t = (Date.now() - t0) / 1000;
  await page.mouse.move(800 + Math.sin(t) * 400, 450 + Math.cos(t * 0.7) * 250);
  const act = async (key, fn) => {
    if (did.has(key)) return;
    did.add(key);
    await page.evaluate(fn);
    console.log(`t=${t.toFixed(1)} ${key}`);
  };
  if (t > 3) await act('drop', () => { window.echo.game.sim.dropTimer = 0; });
  if (t > 6) await act('flare', () => { const g = window.echo.game; const me = g.sim.actors.get(g.localId); me.flares = 1; g.pending.grenade = true; g.nadeKind = 'flare'; });
  if (t > 9) await act('mine', () => { const g = window.echo.game; const me = g.sim.actors.get(g.localId); me.mines = 1; g.pending.mine = true; });
  if (t > 12) await act('strike', () => { const g = window.echo.game; const me = g.sim.actors.get(g.localId); me.strikes = 1; g.pending.strike = true; });
  if (t > 15) await act('molotov', () => { const g = window.echo.game; const me = g.sim.actors.get(g.localId); me.molotovs = 1; g.pending.grenade = true; g.nadeKind = 'molotov'; });
  if (t > 18) await act('drone', () => { const g = window.echo.game; const me = g.sim.actors.get(g.localId); me.drones = 1; g.pending.drone = true; });
  if (t > 21) await act('powerups', () => { const g = window.echo.game; for (const k of ['ammo', 'regen', 'overshield', 'stealth', 'radar', 'nv']) g.sim.powerups.push({ id: 5000 + Math.random() * 1e6 | 0, kind: k, x: g.sim.actors.get(g.localId).x + Math.random() * 4, z: g.sim.actors.get(g.localId).z + 3, room: 0, active: true, respawnT: 20, dropped: true }); });
  if (t > 24) await act('frag', () => { const g = window.echo.game; const me = g.sim.actors.get(g.localId); me.grenades = 1; g.pending.grenade = true; g.nadeKind = 'frag'; });
  await page.waitForTimeout(250);
}
const progs = await page.evaluate(() => {
  const now = window.echo.game.renderer.renderer.info.programs;
  const before = new Set(window.__programs0);
  const R = window.echo.game.renderer;
  const added = new Set(now.filter((x) => !before.has(x.name + ':' + x.cacheKey.length + ':' + [...x.cacheKey].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0))));
  const who = [];
  for (const root of [R.scene, R.overlay, R.maskScene]) root.traverse((o) => {
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of ms) { const pr = R.renderer.properties.get(m).currentProgram; if (pr && added.has(pr)) who.push(`${o.type} ${o.geometry?.type} ${m.type} side${m.side} vc${m.vertexColors} map${!!m.map} transp${m.transparent} flat${m.flatShading}`); }
  });
  return { who: [...new Set(who)], at: window.__perf.progAt, before: before.size, after: now.length, added: now.map((x) => x.name + ':' + x.cacheKey.length + ':' + [...x.cacheKey].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)).filter((k) => !before.has(k)) };
});
console.log('new-program users:', progs.who.join(' || '));
console.log('program count over time:', progs.at.join(' '));
console.log(`shader programs: ${progs.before} at start, ${progs.after} after; compiled mid-game:\n  ${progs.added.join('\n  ')}`);
const res = await page.evaluate(() => window.__perf.frames);
await browser.close();
const dts = res.map((f) => f.dt).sort((a, b) => a - b);
const pct = (p) => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))].toFixed(1);
console.log(`${res.length} frames, median ${pct(0.5)} ms, p95 ${pct(0.95)}, p99 ${pct(0.99)}, max ${dts.at(-1).toFixed(1)}`);
const works = res.map((f) => f.work).sort((a, b) => a - b);
console.log(`JS per frame: median ${works[works.length >> 1].toFixed(1)} ms, p95 ${works[Math.floor(works.length * 0.95)].toFixed(1)}, max ${works.at(-1).toFixed(1)}`);
const agg = new Map();
for (const f of res) for (const e of f.top) { const [k, v] = e.split(' '); agg.set(k, (agg.get(k) ?? 0) + Number(v)); }
console.log('top total:', [...agg].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${(v / res.length).toFixed(2)}`).join(' | '));
const slow = res.map((f, i) => ({ ...f, i })).filter((f) => f.dt > 50);
console.log(`${slow.length} frames over 50 ms`);
for (const f of slow.slice(0, 25)) console.log(`#${f.i} ${f.dt.toFixed(0)} ms (js ${f.work.toFixed(0)}): ${f.top.join(' | ')}`);
