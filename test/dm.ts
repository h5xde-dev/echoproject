/**
 * Arena modes check. For every arena: spawns and items reachable on the nav
 * grid. For every arena x mode (dm, gun, comp): a bots-only match produces
 * kills, bots keep moving, grenades get thrown, the match ends; gun game
 * climbs the ladder, competitive plays rounds and bots buy gear.
 */
import { ARENAS, buildArena } from '../src/game/arenas';
import { CONFIG } from '../src/game/config';
import { Sim } from '../src/game/sim';
import type { GameMode } from '../src/game/types';

const out: string[] = [];
let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  out.push(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};

for (const info of ARENAS) {
  const map = buildArena(info.id, 12345);
  const sim = new Sim(map);
  const from = map.spawns[0];
  const targets = [...map.spawns, ...map.pickups, ...map.powerups];
  const unreachable = targets.filter((t) => !sim.nav.find(from.x, from.z, t.x, t.z));
  check(unreachable.length === 0, `${info.id}: ${targets.length} spawns/items reachable` + (unreachable.length ? ` — unreachable ${JSON.stringify(unreachable.map((t) => [t.x, t.z]))}` : ''));
  if (unreachable.length) console.log(info.id + '\n' + sim.nav.dump());
  check(map.spawns.length >= 6, `${info.id}: ${map.spawns.length} spawn points`);

  for (const mode of ['dm', 'gun', 'comp'] as GameMode[]) {
    const tag = `${info.id}/${mode}`;
    const s = new Sim(buildArena(info.id, 777, mode));
    s.fillBots();
    const last = new Map<number, { x: number; z: number; still: number }>();
    let maxStill = 0;
    let deaths = 0;
    let throws = 0;
    let buys = 0;
    let rounds = 0;
    let ladder = 0;
    let ended = '';
    const dt = CONFIG.tickDt;
    const limit = mode === 'comp' ? 1500 : CONFIG.dm.timeLimit + 2;
    for (let t = 0; t < limit && !ended; t += dt) {
      s.step(dt);
      for (const e of s.drainEvents()) {
        if (e.type === 'death') deaths++;
        if (e.type === 'throw') throws++;
        if (e.type === 'buy') buys++;
        if (e.type === 'round' && e.text === 'end') rounds++;
        if (e.type === 'ladder') ladder = Math.max(ladder, Number(e.text));
        if (e.type === 'victory') ended = e.text ?? '?';
      }
      for (const b of s.actors.values()) {
        const l = last.get(b.id) ?? { x: b.x, z: b.z, still: 0 };
        const moved = Math.hypot(b.x - l.x, b.z - l.z) > 0.05;
        const busy = b.ai?.mode === 'attack' || s.frozen || s.roundPhase === 'end';
        l.still = b.alive && !moved && !busy ? l.still + dt : 0;
        maxStill = Math.max(maxStill, l.still);
        l.x = b.x;
        l.z = b.z;
        last.set(b.id, l);
      }
    }
    check(deaths >= 8, `${tag}: ${deaths} deaths`);
    check(!!ended, `${tag}: match ended — ${ended || 'no'}`);
    check(maxStill < 9, `${tag}: longest idle bot ${maxStill.toFixed(1)} s`);
    check(throws > 0, `${tag}: ${throws} grenades thrown`);
    if (mode === 'gun') check(ladder >= 2, `${tag}: best ladder tier ${ladder + 1}`);
    if (mode === 'comp') {
      check(rounds >= CONFIG.comp.roundsToWin, `${tag}: ${rounds} rounds played`);
      check(buys > 0, `${tag}: ${buys} purchases`);
    }
    if (mode !== 'gun') check(true, `${tag}: pickups left on map ${s.pickups.length}`);
  }
}
out.push(`${failures} failures`);
document.getElementById('out')!.textContent = out.join('\n');
(window as unknown as { __result: string }).__result = out.join('\n');
