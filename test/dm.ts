/**
 * Arena modes check. For every arena: spawns and items reachable on the nav
 * grid. For every arena x mode (dm, gun, comp): a bots-only match produces
 * kills, bots keep moving, grenades get thrown, the match ends; gun game
 * climbs the ladder, competitive plays rounds and bots buy gear.
 */
import { ARENAS, buildArena } from '../src/game/arenas';
import { CONFIG } from '../src/game/config';
import { generateMap, pickPowerup } from '../src/game/levelgen';
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

  for (const mode of ['dm', 'gun', 'comp', 'tdm'] as GameMode[]) {
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
// Gait: run / walk / crouch on a quiet arena with a single player.
{
  const s = new Sim(buildArena('sklad', 4242, 'dm'));
  s.fighters = 1;
  const me = s.addPlayer('local', 'тест', 1);
  const dt = CONFIG.tickDt;
  const base = { seq: 0, moveX: 1, moveZ: 0, aim: 0, fire: false, reload: false, interact: false, flashlight: false, slot: -1, dt };
  // Speed at the end of a 1 s run in the open, and footstep noise made meanwhile.
  const trial = (gait: 'run' | 'walk' | 'crouch') => {
    me.x = s.map.spawns[0].x;
    me.z = s.map.spawns[0].z;
    me.vx = me.vz = 0;
    me.stepDist = 0;
    s.drainEvents();
    let steps = 0;
    let stepNoise = 0;
    for (let t = 0; t < 1; t += dt) {
      // Back and forth so walls never stop the soldier.
      const dir = Math.floor(t * 4) % 2 === 0 ? 1 : -1;
      s.applyInput(me, { ...base, moveX: dir, gait });
      s.step(dt);
      for (const n of s.noises) if (n.step && n.ownerId === me.id && s.time - n.time < dt / 2) stepNoise = n.radius;
      for (const e of s.drainEvents()) if (e.type === 'step' && e.ownerId === me.id) steps++;
    }
    return { speed: Math.hypot(me.vx, me.vz), steps, stepNoise };
  };
  const run = trial('run');
  const walk = trial('walk');
  const crouch = trial('crouch');
  check(run.speed > walk.speed * 1.5 && walk.speed > crouch.speed * 1.2, `gait speeds run ${run.speed.toFixed(1)} > walk ${walk.speed.toFixed(1)} > crouch ${crouch.speed.toFixed(1)}`);
  check(run.steps > 0 && run.stepNoise === CONFIG.gait.stepNoise.run, `running is heard: ${run.steps} steps, radius ${run.stepNoise}`);
  check(walk.steps > 0 && walk.stepNoise === CONFIG.gait.stepNoise.walk, `walking is quieter: ${walk.steps} steps, radius ${walk.stepNoise}`);
  check(crouch.steps === 0, `crouching is silent: ${crouch.steps} steps`);

  // Spread: crouched and still < standing still < running.
  const spreadAt = (gait: 'run' | 'walk' | 'crouch', vx: number) => {
    me.gait = gait;
    me.vx = vx;
    me.vz = 0;
    me.recoil = 0;
    return s.spreadMul(me);
  };
  const crouchStill = spreadAt('crouch', 0);
  const still = spreadAt('run', 0);
  const moving = spreadAt('run', CONFIG.player.maxSpeed);
  check(crouchStill < still && still < moving, `spread crouched ${crouchStill.toFixed(2)} < still ${still.toFixed(2)} < running ${moving.toFixed(2)}`);
  me.vx = 0;
  me.recoil = 0.5;
  check(s.spreadMul(me) > still * 1.5, `recoil widens spread: ${s.spreadMul(me).toFixed(2)}`);
}

// Co-op guards ignore each other's footsteps but hear a running player's.
{
  const s = new Sim(generateMap(31337));
  const priv = s as unknown as { populateRoom(i: number): void; updateAi(a: unknown, dt: number): void };
  priv.populateRoom(1);
  const [g1, g2] = [...s.actors.values()].filter((a) => a.kind === 'enemy');
  const p = s.addPlayer('local', 'тест', 1);
  // The player is far away and out of sight; only the noise can alert the guard.
  p.x = -500;
  p.z = -500;
  const hears = (ownerId: number) => {
    g1.ai!.mode = 'idle';
    g1.ai!.awareness = 0;
    s.noises = [{ x: g1.x + 2, z: g1.z, radius: CONFIG.gait.stepNoise.run, time: s.time, ownerId, step: true }];
    priv.updateAi(g1, CONFIG.tickDt);
    return (g1.ai!.mode as string) === 'alert';
  };
  check(!hears(g2.id), "co-op guard ignores another guard's footsteps");
  check(hears(p.id), "co-op guard hears the player's footsteps");
}

// Shootable lamps: a player's bullet breaks one and darkens the spot; a
// guard's bullet flies under it.
{
  const s = new Sim(buildArena('sklad', 5150, 'dm'));
  const lamp = s.map.lamps[0];
  const p = s.addPlayer('local', 'тест', 1);
  const guard = s.addPlayer('probe', 'probe', 1001);
  guard.kind = 'enemy';
  const shootAt = (shooter: typeof p) => {
    s.bullets.push({
      id: `t${shooter.id}`, ownerId: shooter.id, ownerKind: shooter.kind,
      x: lamp.x - 1.5, z: lamp.z, vx: 60, vz: 0, speed: 60,
      damage: 0, damageMul: 1, life: 0.2, weapon: 'pistol', color: 0, range: 0,
    });
    s.drainEvents();
    for (let i = 0; i < 6; i++) s.step(CONFIG.tickDt);
    return s.drainEvents().some((e) => e.type === 'lampBreak');
  };
  p.x = guard.x = -500;
  check(s.isLit(lamp.x, lamp.z), 'lamp lights its spot');
  check(!shootAt(guard) && s.lampAlive[0], "a guard's bullet does not break lamps");
  check(shootAt(p) && !s.lampAlive[0], "a player's bullet breaks the lamp");
  check(!s.map.lamps.some((l, i) => i !== 0 && Math.hypot(l.x - lamp.x, l.z - lamp.z) < 9.5) ? !s.isLit(lamp.x, lamp.z) : true, 'its spot goes dark');
}

// Smoke and flash grenades.
{
  const s = new Sim(buildArena('sklad', 6060, 'dm'));
  const dt = CONFIG.tickDt;
  const p = s.addPlayer('local', 'тест', 1);
  const spawn = s.map.spawns[0];
  const input = { seq: 0, moveX: 0, moveZ: 0, aim: 0, fire: false, reload: false, interact: false, flashlight: false, slot: -1, dt };
  const run = (secs: number) => {
    for (let t = 0; t < secs; t += dt) s.step(dt);
  };
  check(p.smokes === CONFIG.grenade.startUtility && p.flashes === CONFIG.grenade.startUtility, `players start with ${p.smokes} smoke / ${p.flashes} flash`);

  // Smoke: a cloud forms where it lands, blocks sight through it, then clears.
  p.x = spawn.x;
  p.z = spawn.z;
  s.applyInput(p, { ...input, grenade: true, grenadeKind: 'smoke', throwDist: 3 });
  check(p.smokes === CONFIG.grenade.startUtility - 1, 'throwing a smoke uses one up');
  run(CONFIG.smoke.fuse + CONFIG.smoke.grow + 0.1);
  const cloud = s.smokes[0];
  check(!!cloud, 'smoke grenade leaves a cloud');
  if (cloud) {
    check(s.smokeBlocks(cloud.x - 8, cloud.z, cloud.x + 8, cloud.z), 'the cloud blocks a line through it');
    check(!s.smokeBlocks(cloud.x - 8, cloud.z + 8, cloud.x + 8, cloud.z + 8), 'and not a line beside it');
  }
  run(CONFIG.smoke.life);
  check(s.smokes.length === 0, 'the cloud clears after its lifetime');

  // No stock, no throw.
  p.smokes = 0;
  p.grenadeCd = 0;
  const before = s.grenades.length;
  s.applyInput(p, { ...input, grenade: true, grenadeKind: 'smoke' });
  check(s.grenades.length === before, 'no smoke left: nothing is thrown');

  // Flash: worst looking at it up close, mild facing away, none behind a wall.
  const flashAt = (x: number, z: number) => {
    const g = { id: 999, kind: 'flash' as const, ownerId: p.id, x, y: 0.2, z, vx: 0, vy: 0, vz: 0, fuse: 0.001 };
    s.grenades.push(g);
    s.step(dt);
  };
  p.blind = 0;
  p.ang = 0;
  flashAt(p.x + 3, p.z);
  const facing = p.blind;
  p.blind = 0;
  p.ang = Math.PI;
  flashAt(p.x + 3, p.z);
  const away = p.blind;
  check(facing > 2 && away > 0 && away < facing * 0.5, `flash blinds ${facing.toFixed(1)} s facing it, ${away.toFixed(1)} s facing away`);
  p.blind = 0;
  const wall = s.map.walls[0];
  flashAt(wall.cx, wall.cz + wall.hh + 1);
  const otherSide = { x: wall.cx, z: wall.cz - wall.hh - 1 };
  p.x = otherSide.x;
  p.z = otherSide.z;
  p.blind = 0;
  flashAt(wall.cx, wall.cz + wall.hh + 1);
  check(p.blind === 0, 'a wall shields from the flash');
}

// Competitive: smoke and flash are on sale.
{
  const s = new Sim(buildArena('sklad', 7070, 'comp'));
  const p = s.addPlayer('local', 'тест', 1);
  p.money = 10000;
  (s as unknown as { roundAge: number }).roundAge = 0;
  check(p.smokes === 0 && p.flashes === 0, 'competitive: no free smoke / flash');
  check(s.buy(p, 'smoke') && s.buy(p, 'flash') && p.smokes === 1 && p.flashes === 1, 'competitive: smoke and flash can be bought');
}

// Bushes: hide whoever keeps quiet in them.
{
  const dvor = buildArena('dvor', 8080, 'dm');
  check((dvor.bushes?.length ?? 0) >= 10, `Двор has ${dvor.bushes?.length ?? 0} bushes (mirrored)`);
  const yards = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => generateMap(seed * 7919)).filter((m) => m.rooms.some((r) => r.theme === 'yard'));
  check(yards.length > 0 && yards.every((m) => (m.bushes?.length ?? 0) > 0), 'co-op yard rooms grow bushes');

  const s = new Sim(generateMap(4711));
  const priv = s as unknown as { populateRoom(i: number): void; updateAi(a: unknown, dt: number): void };
  priv.populateRoom(1);
  const guard = [...s.actors.values()].find((a) => a.kind === 'enemy')!;
  const p = s.addPlayer('local', 'тест', 1);
  const dt = CONFIG.tickDt;
  const input = { seq: 0, moveX: 0, moveZ: 0, aim: 0, fire: false, reload: false, interact: false, flashlight: false, slot: -1, dt };
  s.map.bushes = [{ x: guard.x + 5, z: guard.z, r: 1.5 }];
  const placeInBush = () => {
    p.x = guard.x + 5;
    p.z = guard.z;
    p.vx = p.vz = 0;
  };
  placeInBush();
  s.applyInput(p, { ...input, gait: 'crouch' });
  placeInBush();
  s.step(dt);
  check(p.concealed, 'crouching in a bush hides you');
  s.applyInput(p, { ...input, gait: 'run', moveX: 1 });
  s.step(dt);
  check(!p.concealed, 'running through a bush does not');
  placeInBush();
  p.revealT = CONFIG.bush.revealAfterShot;
  s.applyInput(p, { ...input, gait: 'crouch' });
  placeInBush();
  s.step(dt);
  check(!p.concealed, 'firing gives you away for a moment');

  // A guard looking straight at the bush, 5 m off, does not notice; 2 m off it does.
  const post = { x: guard.x, z: guard.z };
  const watch = (gap: number, hidden = true) => {
    // The control round lets the guard chase; every round starts at its post.
    guard.x = post.x;
    guard.z = post.z;
    guard.vx = guard.vz = 0;
    p.x = guard.x + gap;
    p.z = guard.z;
    p.concealed = hidden;
    // The control round may end with the guard shooting the player.
    p.alive = true;
    p.hp = p.maxHp;
    guard.ang = 0;
    guard.blind = 0;
    guard.ai!.mode = 'idle';
    guard.ai!.awareness = 0;
    s.time = 30;
    for (let i = 0; i < 60; i++) {
      p.concealed = hidden;
      priv.updateAi(guard, dt);
    }
    return guard.ai!.awareness;
  };
  check(watch(5, false) > 0, 'control: the same guard spots an unhidden player 5 m away');
  check(watch(5) === 0, 'a guard 5 m away does not spot a hidden player');
  check(watch(2) > 0, 'a guard 2 m away does');
}

// Night vision powerup.
{
  const s = new Sim(buildArena('bunker', 9090, 'dm'));
  const p = s.addPlayer('local', 'тест', 1);
  check(s.map.powerups.some((u) => u.kind === 'nv'), 'Бункер has night vision on the map');
  const rolls = Array.from({ length: 1000 }, (_, i) => pickPowerup(i / 1000));
  check(rolls.includes('nv') && rolls.includes('speed'), 'night vision is in the random powerup mix (and speed still is)');
  (s as unknown as { applyPowerup(a: unknown, k: string): boolean }).applyPowerup(p, 'nv');
  check(p.buffs.nv === CONFIG.powerups.nvTime, `night vision lasts ${p.buffs.nv} s`);
  p.x = s.map.spawns[0].x;
  p.z = s.map.spawns[0].z;
  // A direction with a clear line, so the flash reaches the player.
  const world = (s as unknown as { world: { lineOfSight(a: number, b: number, c: number, d: number, s: unknown[]): boolean } }).world;
  const dir = [0, Math.PI / 2, Math.PI, -Math.PI / 2].find((a) => world.lineOfSight(p.x, p.z, p.x + Math.cos(a) * 3, p.z + Math.sin(a) * 3, []))!;
  const flash = () => {
    p.blind = 0;
    p.ang = dir;
    s.grenades.push({ id: 1, kind: 'flash', ownerId: p.id, x: p.x + Math.cos(dir) * 3, y: 0.2, z: p.z + Math.sin(dir) * 3, vx: 0, vy: 0, vz: 0, fuse: 0.001 });
    s.step(CONFIG.tickDt);
    return p.blind;
  };
  const withNv = flash();
  p.buffs.nv = 0;
  const without = flash();
  check(withNv > without * 1.4, `night vision makes a flash worse: ${withNv.toFixed(1)} s vs ${without.toFixed(1)} s`);
}

// Light props break under fire; anchored ones do not.
{
  const s = new Sim(buildArena('sklad', 1212, 'dm'));
  const p = s.addPlayer('local', 'тест', 1);
  p.x = p.z = -500;
  const shootProp = (fixed: boolean) => {
    const prop = s.props.find((q) => q.alive && q.fixed === fixed && !q.explosive)!;
    for (let i = 0; i < 40 && prop.alive; i++) {
      s.bullets.push({
        id: `pp${fixed}${i}`, ownerId: p.id, ownerKind: 'player',
        x: prop.x - 4, z: prop.z, vx: 80, vz: 0, speed: 80,
        damage: 30, damageMul: 1, life: 0.2, weapon: 'rifle', color: 0, range: 0,
      });
      for (let t = 0; t < 6; t++) s.step(CONFIG.tickDt);
    }
    return prop;
  };
  check(!shootProp(false).alive, 'a crate or table breaks under fire');
  check(shootProp(true).alive, 'cars, blocks and cabinets stay as cover');
}

// Team deathmatch.
{
  const s = new Sim(buildArena('sklad', 1313, 'tdm'));
  s.fighters = 8;
  const a = s.addPlayer('local', 'альфа', 1);
  const b = s.addPlayer('c2', 'браво', 2);
  s.fillBots();
  const all = [...s.actors.values()];
  const sizes = [0, 1].map((t) => all.filter((x) => x.team === t).length);
  check(a.team !== b.team, 'two humans are split between the teams');
  check(sizes[0] === 4 && sizes[1] === 4, `8 fighters split 4/4 (got ${sizes.join('/')})`);
  const mid = (s.map.minX + s.map.maxX) / 2;
  check(all.every((x) => (x.team === 0 ? x.x < mid : x.x > mid)), 'each team spawns on its own half');
  const hostile = (s as unknown as { hostileTo(x: unknown, y: unknown): boolean }).hostileTo.bind(s);
  const mate = all.find((x) => x !== a && x.team === a.team)!;
  const foe = all.find((x) => x.team !== a.team)!;
  check(!hostile(a, mate) && hostile(a, foe), 'teammates are not targets, the other side is');

  // A bullet through a teammate does no harm; through an enemy it does.
  const hit = (target: typeof a, hp = target.maxHp) => {
    target.hp = hp;
    target.shield = 0;
    target.armor = 0;
    s.bullets.push({
      id: `ff${target.id}`, ownerId: a.id, ownerKind: 'player',
      x: target.x - 1.5, z: target.z, vx: 80, vz: 0, speed: 80,
      damage: 25, damageMul: 1, life: 0.2, weapon: 'rifle', color: 0, range: 0,
    });
    for (let i = 0; i < 4; i++) s.step(CONFIG.tickDt);
    return hp - target.hp;
  };
  for (const x of all) if (x !== mate && x !== foe) x.x = x.z = -500;
  check(hit(mate) === 0, 'no friendly fire');
  check(hit(foe) > 0, 'enemies take damage');

  s.teamScore = a.team === 0 ? [CONFIG.tdm.scoreLimit - 1, 3] : [3, CONFIG.tdm.scoreLimit - 1];
  s.drainEvents();
  hit(foe, 1);
  const over = s.drainEvents().find((e) => e.type === 'victory');
  check(s.teamScore[a.team] === CONFIG.tdm.scoreLimit, `team score counts kills (${s.teamScore.join(':')})`);
  check(!!over && over.team === a.team, `reaching ${CONFIG.tdm.scoreLimit} wins the match for that team`);
}

out.push(`${failures} failures`);
document.getElementById('out')!.textContent = out.join('\n');
(window as unknown as { __result: string }).__result = out.join('\n');
