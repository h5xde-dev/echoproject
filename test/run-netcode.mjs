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

// Gait travels with the input: holding Shift, the host walks the client's
// soldier and the client's prediction agrees.
await page.keyboard.down('ShiftLeft');
await page.keyboard.down('KeyA');
await page.waitForTimeout(1200);
const walking = await page.evaluate(() => {
  const { gameA, gameB } = window.__net;
  const a = gameA.sim.actors.get(gameB.localId);
  const mirror = gameB.sim.actors.get(gameB.localId);
  return { gait: a.gait, speed: Math.hypot(a.vx, a.vz), error: Math.hypot(a.x - mirror.x, a.z - mirror.z) };
});
await page.keyboard.up('KeyA');
await page.keyboard.up('ShiftLeft');
check(
  'client walk reaches the host',
  walking.gait === 'walk' && walking.speed < 8.2 * 0.6,
  `gait=${walking.gait} speed=${walking.speed.toFixed(2)}`,
);
check('prediction agrees while walking', walking.error < 1.5, `error ${walking.error.toFixed(2)} units`);

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

// The start room's door opens 1.5 s of game time in; headless runs slowly.
await page.waitForFunction(() => window.__net.gameA.sim.time > 1.6, null, { timeout: 30000 });
const health = await page.evaluate(() => {
  const { gameA } = window.__net;
  const start = gameA.map.rooms[0];
  const inStart = (a) => a.x >= start.minX && a.x <= start.maxX && a.z >= start.minZ && a.z <= start.maxZ;
  const enemies = [...gameA.sim.actors.values()].filter((a) => a.kind === 'enemy');
  return {
    spawned: enemies.length,
    inStart: enemies.filter((e) => e.alive && inStart(e)).length,
  };
});
// The first room is a safe start; the next room's guards are already posted
// behind the door it opens.
check('start room is safe', health.inStart === 0, `guards in start room=${health.inStart}`);
// Counted dead or alive: stray shots and barrels may already have hit them.
check('next room is manned when its door opens', health.spawned > 0, `guards spawned=${health.spawned}`);

// Lobby: a hosted room starts as a warm-up; the client says ready, the host
// starts the match on a fresh map with everyone in it.
const lobbyBefore = await page.evaluate(() => {
  const { gameA, gameB } = window.__net;
  const visible = (root) => !document.querySelector(`${root} .panel-lobby`).classList.contains('hidden');
  return { players: gameA.clientNames.size + 1, ready: gameA.lobby?.ready.get(gameB.localId), hostPanel: visible('#hudA'), clientPanel: visible('#hudB') };
});
check(
  'lobby: both see the warm-up lobby, the client not ready yet',
  lobbyBefore.players === 2 && lobbyBefore.ready === false && lobbyBefore.hostPanel && lobbyBefore.clientPanel,
  JSON.stringify(lobbyBefore),
);
await page.evaluate(() => window.__net.gameB.toggleReady());
const readied = await page
  .waitForFunction(() => window.__net.gameA.lobby?.ready.get(window.__net.gameB.localId) === true, null, { timeout: 10000 })
  .then(() => true)
  .catch(() => false);
check('lobby: the client\'s ready reaches the host', readied);
const seedBefore = await page.evaluate(() => window.__net.gameA.map.seed);
await page.evaluate(() => window.__net.gameA.startMatch());
await page
  .waitForFunction((old) => window.__net.gameB.map.seed !== old && window.__net.gameB.latestActors.size > 0, seedBefore, { timeout: 15000 })
  .catch(() => {});
const started = await page.evaluate(() => {
  const { gameA, gameB } = window.__net;
  const hidden = (root) => document.querySelector(`${root} .panel-lobby`).classList.contains('hidden');
  return {
    sameSeed: gameA.map.seed === gameB.map.seed,
    clientInHostSim: gameA.sim.actors.has(gameB.localId),
    lobbiesHidden: hidden('#hudA') && hidden('#hudB'),
  };
});
check('lobby: start moves everyone to a fresh match', started.sameSeed && started.clientInHostSim && started.lobbiesHidden, JSON.stringify(started));

// Team marker: the client's mark goes through the host to both teammates.
await page.evaluate(() => {
  const { gameB } = window.__net;
  const me = gameB.sim.actors.get(gameB.localId);
  gameB.pending.mark = { x: me.x + 3, z: me.z };
});
const marked = await page
  .waitForFunction(() => window.__net.gameA.markBlips.length > 0 && window.__net.gameB.markBlips.length > 0, null, { timeout: 10000 })
  .then(() => true)
  .catch(() => false);
check('team marker reaches the host and comes back to the client', marked);

// One-shot actions in a packet that is followed by another before the host
// ticks are applied once: not lost, not repeated.
const once = await page.evaluate(async () => {
  const { gameA, gameB } = window.__net;
  const id = gameB.localId;
  const actor = gameA.sim.actors.get(id);
  actor.grenades = 2;
  actor.grenadeCd = 0;
  const light = actor.flashOn;
  const base = { t: 'input', seq: 1e6, moveX: 0, moveZ: 0, aim: 0, fire: false, reload: false, interact: false, flashlight: false, slot: -1, dt: 1 / 60 };
  const handlers = gameA.net.hostHandlers;
  handlers.onClientInput({ ...base, seq: 1e6 + 1, grenade: true, throwDist: 6, flashlight: true }, id);
  handlers.onClientInput({ ...base, seq: 1e6 + 2 }, id);
  await new Promise((r) => setTimeout(r, 600));
  return { grenades: actor.grenades, toggled: actor.flashOn !== light };
});
check('one-shot actions apply once even when packets bunch up', once.grenades === 1 && once.toggled, JSON.stringify(once));

// Lag compensation: the client reports its round trip with every input and
// the host fast-forwards that player's shots by half of it.
// The real loopback ping would overwrite it every 1.5 s: stop the pinger.
await page.evaluate(() => {
  const { gameB } = window.__net;
  clearInterval(gameB.net.pingTimer);
  gameB.net.pingTimer = null;
  // Replies to pings already in flight are dropped when nothing waits for them.
  gameB.net.pingSentAt.clear();
  gameB.rttMs = 200;
});
// Headless runs at a few frames per second: wait until the host has both
// received and applied an input carrying the new round trip.
await page
  .waitForFunction(() => {
    const { gameA, gameB } = window.__net;
    return Math.abs((gameA.sim.actors.get(gameB.localId)?.lagComp ?? 0) - 0.1) < 1e-6;
  }, null, { timeout: 15000 })
  .catch(() => {});
const lag = await page.evaluate(() => {
  const { gameA, gameB } = window.__net;
  const sim = gameA.sim;
  const reported = gameA.sim.actors.get(gameB.localId)?.lagComp ?? -1;
  // Fire the host's own soldier from the room centre along the long axis,
  // once without and once with compensation.
  const me = sim.actors.get(gameA.localId);
  const room = gameA.map.rooms[0];
  const shot = (lagComp) => {
    me.x = (room.minX + room.maxX) / 2;
    me.z = (room.minZ + room.maxZ) / 2;
    me.ang = room.maxX - room.minX >= room.maxZ - room.minZ ? 0 : Math.PI / 2;
    me.ammo = 10;
    me.lagComp = lagComp;
    const before = sim.bullets.length;
    sim.fireWeapon(me);
    const b = sim.bullets[before];
    me.lagComp = 0;
    return b ? b.range : 'consumed';
  };
  return { reported, plain: shot(0), compensated: shot(0.1) };
});
check('host derives lag compensation from client RTT', Math.abs(lag.reported - 0.1) < 1e-6, `lagComp=${lag.reported}`);
check('uncompensated shot starts at the muzzle', lag.plain === 0, `range=${lag.plain}`);
check(
  'compensated shot is fast-forwarded ~100 ms',
  lag.compensated === 'consumed' || lag.compensated > 5,
  `range=${lag.compensated}`,
);

// A dropped channel: the client reconnects to the same room by itself.
const oldId = await page.evaluate(() => {
  const { gameA, gameB } = window.__net;
  const id = gameB.localId;
  for (const c of gameA.net.hostClients.values()) c.conn.close();
  return id;
});
await page.waitForFunction(
  (old) => {
    const { gameB } = window.__net;
    return gameB.localId !== old && gameB.latestActors.has(gameB.localId);
  },
  oldId,
  { timeout: 15000 },
).catch(() => {});
const rejoined = await page.evaluate(() => {
  const { gameA, gameB } = window.__net;
  return { id: gameB.localId, hostSees: gameA.sim.actors.has(gameB.localId), over: gameB.gameOver };
});
check(
  'client reconnects after a dropped channel',
  rejoined.id !== oldId && rejoined.hostSees && !rejoined.over,
  JSON.stringify({ oldId, ...rejoined }),
);

// The host leaves for good: the client ends the match with a reason.
await page.evaluate(() => {
  const { gameA } = window.__net;
  const clients = [...gameA.net.hostClients.values()];
  gameA.returnToMenu();
  for (const c of clients) c.conn.close();
});
await page.waitForFunction(() => window.__net.gameB.gameOver, null, { timeout: 20000 }).catch(() => {});
const ended = await page.evaluate(() => ({
  over: window.__net.gameB.gameOver,
  title: document.querySelector('#hudB .gameover-title')?.textContent ?? '',
}));
check('client ends the match when the host is gone', ended.over, JSON.stringify(ended));

check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
