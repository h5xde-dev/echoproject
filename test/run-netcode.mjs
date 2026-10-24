/**
 * Integration test for the host-authoritative netcode.
 *
 * Runs two full game instances side by side over an in-memory transport and
 * checks that the host stays authoritative, that snapshots reach the client,
 * that client input moves the host-side actor, and that the client's local
 * prediction stays close to the authoritative position.
 *
 *   npm run test:netcode
 */
import { chromium } from 'playwright';

const URL = process.env.NETCODE_URL ?? 'http://127.0.0.1:5173/test/netcode.html';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__net?.ready || window.__net?.error, { timeout: 30000 });

const boot = await page.evaluate(() => ({ error: window.__net.error, code: window.__net.code }));
check('harness boots', !boot.error, boot.error || `room ${boot.code}`);

await page.waitForTimeout(1200);

const topology = await page.evaluate(() => {
  const { gameA, gameB } = window.__net;
  const playersA = [...gameA.sim.actors.values()].filter((a) => a.kind === 'player');
  const playersB = [...gameB.sim.actors.values()].filter((a) => a.kind === 'player');
  return {
    hostPlayers: playersA.length,
    clientPlayers: playersB.length,
    clientLocalId: gameB.localId,
    clientLatestActors: gameB.latestActors.size,
    sameSeed: gameA.map.seed === gameB.map.seed,
    sameWalls: gameA.map.walls.length === gameB.map.walls.length,
  };
});
check('host simulates two players', topology.hostPlayers === 2, `players=${topology.hostPlayers}`);
check('client mirror holds the local player', topology.clientPlayers === 1, `players=${topology.clientPlayers}`);
check(
  'client received snapshots for everyone',
  topology.clientLatestActors >= 2,
  `actors=${topology.clientLatestActors}`,
);
check('both peers share the same map', topology.sameSeed && topology.sameWalls);

// The client sends movement input; the host must move that player's actor.
const before = await page.evaluate(() => {
  const { gameA, gameB } = window.__net;
  const a = gameA.sim.actors.get(gameB.localId);
  return { x: a.x, z: a.z };
});

// Drive the real input path: keyboard -> client packet -> host simulation.
// Injecting packets by hand races with the client's own input loop.
await page.keyboard.down('KeyD');
const moved = await page
  .waitForFunction(
    (start) => {
      const { gameA, gameB } = window.__net;
      const a = gameA.sim.actors.get(gameB.localId);
      return Math.hypot(a.x - start.x, a.z - start.z) > 0.5;
    },
    before,
    { timeout: 30000 },
  )
  .then(() => true)
  .catch(() => false);
await page.keyboard.up('KeyD');

const after = await page.evaluate(() => {
  const { gameA, gameB } = window.__net;
  const a = gameA.sim.actors.get(gameB.localId);
  const mirror = gameB.sim.actors.get(gameB.localId);
  return {
    hostX: a.x,
    hostZ: a.z,
    clientX: mirror.x,
    clientZ: mirror.z,
    acked: gameA.clientInputs.get(String(gameB.localId))?.lastAck ?? -1,
  }
});

check('host applies client input', moved);
check('host acknowledges input sequence', after.acked > 0, `ack=${after.acked}`);

const predictionError = Math.hypot(after.hostX - after.clientX, after.hostZ - after.clientZ);
check(
  'client prediction tracks the host',
  predictionError < 1.5,
  `error ${predictionError.toFixed(2)} units`,
);

// The client fires; the host must spawn bullets and the client must see them.
// Bullets are short-lived, so track the peak count on both peers.
// Bullets are short-lived, so sample the peak count on both peers while the
// real mouse button drives the actual fire path.
await page.evaluate(() => {
  const { gameA, gameB } = window.__net;
  window.__peaks = { host: 0, client: 0 };
  window.__peakTimer = setInterval(() => {
    window.__peaks.host = Math.max(window.__peaks.host, gameA.sim.bullets.length);
    window.__peaks.client = Math.max(window.__peaks.client, gameB.clientBullets.length);
  }, 16);
});

await page.mouse.move(500, 300);
await page.mouse.down();
await page.waitForTimeout(2500);
await page.mouse.up();
await page.waitForTimeout(300);

const fired = await page.evaluate(() => {
  clearInterval(window.__peakTimer);
  const { gameA, gameB } = window.__net;
  return {
    peakHost: window.__peaks.host,
    peakClient: window.__peaks.client,
    hostAmmo: gameA.sim.actors.get(gameB.localId)?.ammo ?? -1,
    hostShots: gameA.sim.actors.get(gameB.localId)?.shotSeq ?? 0,
  };
});
check('host spawns bullets for the client', fired.peakHost > 0 && fired.hostShots > 0, JSON.stringify(fired));
check('client replicates bullets locally', fired.peakClient > 0, `peakClient=${fired.peakClient}`);

const health = await page.evaluate(() => {
  const { gameA } = window.__net;
  const start = gameA.map.rooms[0];
  const inStart = (a) => a.x >= start.minX && a.x <= start.maxX && a.z >= start.minZ && a.z <= start.maxZ;
  const enemies = [...gameA.sim.actors.values()].filter((a) => a.kind === 'enemy');
  return {
    alive: enemies.filter((e) => e.alive).length,
    inStart: enemies.filter((e) => e.alive && inStart(e)).length,
  };
});
// The first room is a safe start; the next room's guards are already posted
// behind the door it opens.
check('start room is safe', health.inStart === 0, `guards in start room=${health.inStart}`);
check('next room is manned when its door opens', health.alive > 0, `alive guards=${health.alive}`);

check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
