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
import { WEAPON_ORDER, WEAPONS, type WeaponId } from '../src/game/weapons';
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

  for (const mode of ['dm', 'gun', 'comp', 'tdm', 'ctf', 'bomb'] as GameMode[]) {
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
    let flagsTaken = 0;
    let escaped = 0;
    let plants = 0;
    let attackWins = 0;
    let attacking = 0;
    let defenceWins = 0;
    let bombEnds = 0;
    let ended = '';
    const dt = CONFIG.tickDt;
    const limit = mode === 'comp' || mode === 'bomb' ? 1500 : CONFIG.dm.timeLimit + 2;
    for (let t = 0; t < limit && !ended; t += dt) {
      s.step(dt);
      for (const e of s.drainEvents()) {
        if (e.type === 'death') deaths++;
        if (e.type === 'throw') throws++;
        if (e.type === 'buy') buys++;
        if (e.type === 'round' && e.text === 'end') rounds++;
        if (e.type === 'ladder') ladder = Math.max(ladder, Number(e.text));
        if (e.type === 'victory') ended = e.text ?? '?';
        if (e.type === 'flag' && e.text === 'taken') flagsTaken++;
        if (e.type === 'bomb' && e.text === 'planted') plants++;
        // Events come in order: a round end is scored before any halftime swap.
        if (mode === 'bomb' && e.type === 'round' && e.text === 'swap') attacking = 1 - attacking;
        if (mode === 'bomb' && e.type === 'round' && e.text === 'end' && e.team !== undefined) {
          if (e.team === attacking) attackWins++;
          else defenceWins++;
        }
        if (e.type === 'bomb' && (e.text === 'exploded' || e.text === 'defused')) bombEnds++;
      }
      for (const b of s.actors.values()) {
        if (b.alive && (b.x < s.map.minX || b.x > s.map.maxX || b.z < s.map.minZ || b.z > s.map.maxZ)) escaped++;
        const l = last.get(b.id) ?? { x: b.x, z: b.z, still: 0 };
        const moved = Math.hypot(b.x - l.x, b.z - l.z) > 0.05;
        // Planting or defusing is standing still on purpose.
      const busy = b.ai?.mode === 'attack' || s.frozen || s.roundPhase === 'end' || b.using;
        l.still = b.alive && !moved && !busy ? l.still + dt : 0;
        maxStill = Math.max(maxStill, l.still);
        l.x = b.x;
        l.z = b.z;
        last.set(b.id, l);
      }
    }
    // Bomb rounds can end in a defuse with nobody down: one death a round will do.
    check(deaths >= (mode === 'bomb' ? rounds : 8), `${tag}: ${deaths} deaths`);
    check(!!ended, `${tag}: match ended — ${ended || 'no'}`);
    check(maxStill < 9, `${tag}: longest idle bot ${maxStill.toFixed(1)} s`);
    check(escaped === 0, `${tag}: nobody pushed out of the map (${escaped} ticks outside)`);
    check(throws > 0, `${tag}: ${throws} grenades thrown`);
    if (mode === 'gun') check(ladder >= 2, `${tag}: best ladder tier ${ladder + 1}`);
    if (mode === 'bomb') check(plants > 0, `${tag}: ${plants} plants, ${bombEnds} blasts/defuses, ${rounds} rounds, attack ${attackWins} : ${defenceWins} defence`);
    if (mode === 'ctf') check(flagsTaken > 0, `${tag}: bots took a flag ${flagsTaken} times, score ${s.teamScore.join(':')}`);
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
  const forests = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => generateMap(seed * 104729)).filter((m) => m.rooms.some((r) => r.theme === 'forest'));
  const inForest = (m: (typeof forests)[number]) =>
    (m.bushes ?? []).filter((b) => m.rooms.some((r) => r.theme === 'forest' && b.x > r.minX && b.x < r.maxX && b.z > r.minZ && b.z < r.maxZ)).length;
  check(forests.length > 0 && forests.every((m) => inForest(m) >= 4), `co-op forest rooms are thick with bushes (${forests.map(inForest).join(', ')})`);

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
      // Perception at this distance only: the guard may not patrol closer.
      guard.x = post.x;
      guard.z = post.z;
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

// Waves.
{
  const s = new Sim(buildArena('sklad', 1414, 'waves'));
  const a = s.addPlayer('local', 'альфа', 1);
  const b = s.addPlayer('c2', 'браво', 2);
  s.fillBots();
  const dt = CONFIG.tickDt;
  const guards = () => [...s.actors.values()].filter((x) => x.kind === 'enemy' && x.alive);
  check(guards().length === 0, 'waves: no bots before the first wave');
  for (let t = 0; t < CONFIG.waves.firstBreak + 0.1; t += dt) s.step(dt);
  check(s.wave === 1 && guards().length === CONFIG.waves.base, `wave 1 brings ${guards().length} guards`);
  const hostile = (s as unknown as { hostileTo(x: unknown, y: unknown): boolean }).hostileTo.bind(s);
  const [g1, g2] = guards();
  check(hostile(g1, a) && !hostile(g1, g2) && !hostile(a, b), 'guards hunt players, not each other; players are allies');
  // Health without the guard type's own factor: what the wave itself gives.
  const baseHp = (g: { maxHp: number; role: string }) => g.maxHp / (g.role === 'grunt' ? 1 : CONFIG.roles[g.role as 'heavy'].hp);
  const hp1 = baseHp(g1);

  // One player down, the rest of the wave cleared: the fallen one is back.
  b.hp = 1;
  b.shield = 0;
  (s as unknown as { damageActor(x: unknown, d: number, by: number): void }).damageActor(b, 50, g1.id);
  check(b.alive && b.downed, 'a player can go down mid-wave');
  for (const g of guards()) (s as unknown as { damageActor(x: unknown, d: number, by: number): void }).damageActor(g, 999, a.id);
  s.step(dt);
  check(s.wavePhase === 'break' && b.alive && !b.downed, 'clearing the wave gets the downed back up');
  for (let t = 0; t < CONFIG.waves.breakTime + 0.1; t += dt) s.step(dt);
  const w2 = guards();
  check(s.wave === 2 && w2.length === CONFIG.waves.base + CONFIG.waves.perWave && baseHp(w2[0]) > hp1, `wave 2: ${w2.length} tougher guards`);

  // Everyone down at once: the run is over.
  s.drainEvents();
  for (const p of [a, b]) {
    p.shield = 0;
    (s as unknown as { damageActor(x: unknown, d: number, by: number): void }).damageActor(p, 999, w2[0].id);
  }
  s.step(dt);
  const over = s.drainEvents().find((e) => e.type === 'gameOver');
  check(!!over, `the squad wiped out ends the run: ${over?.text ?? '—'}`);
}

// Waves: guards find a player who sits still and quiet.
{
  const s = new Sim(buildArena('dvor', 1515, 'waves'));
  const p = s.addPlayer('local', 'альфа', 1);
  const dt = CONFIG.tickDt;
  let hurt = -1;
  for (let t = 0; t < CONFIG.waves.firstBreak + 45 && hurt < 0; t += dt) {
    p.hp = p.maxHp;
    s.step(dt);
    for (const e of s.drainEvents()) if ((e.type === 'hurt' || e.type === 'death') && e.ownerId === p.id) hurt = t;
  }
  check(hurt > 0, `waves: guards track down a hidden player (first hit after ${hurt.toFixed(0)} s)`);
}

// Capture the flag rules.
{
  const s = new Sim(buildArena('sklad', 1616, 'ctf'));
  const a = s.addPlayer('local', 'альфа', 1);
  const b = s.addPlayer('c2', 'браво', 2);
  const dt = CONFIG.tickDt;
  const mid = (s.map.minX + s.map.maxX) / 2;
  check(s.bases.length === 2 && s.bases[0].x < mid && s.bases[1].x > mid, 'each team has a base on its own half');
  const enemyFlag = s.flags[1 - a.team];
  const ownBase = s.bases[a.team];
  const go = (actor: typeof a, x: number, z: number) => {
    actor.x = x;
    actor.z = z;
    s.step(dt);
  };
  b.x = b.z = -500;
  go(a, enemyFlag.x, enemyFlag.z);
  check(a.carrying === enemyFlag.team && enemyFlag.carrier === a.id, 'touching the enemy flag picks it up');
  // Our own flag is away: no capture at home.
  const ownFlag = s.flags[a.team];
  ownFlag.home = false;
  ownFlag.x = ownFlag.z = -400;
  go(a, ownBase.x, ownBase.z);
  check(s.teamScore[a.team] === 0 && a.carrying >= 0, 'no capture while our own flag is away');
  ownFlag.home = true;
  ownFlag.x = ownBase.x;
  ownFlag.z = ownBase.z;
  go(a, ownBase.x, ownBase.z);
  check(s.teamScore[a.team] === 1 && a.carrying === -1 && enemyFlag.home, 'bringing it home scores and resets the flag');

  // Carrier down: the flag drops; its team touching it sends it home.
  go(a, enemyFlag.x, enemyFlag.z);
  a.x += 6;
  s.step(dt);
  a.shield = 0;
  (s as unknown as { damageActor(x: unknown, d: number, by: number): void }).damageActor(a, 999, b.id);
  check(!enemyFlag.home && enemyFlag.carrier === -1, 'a fallen carrier drops the flag');
  const defender = [b].find((x) => x.team === enemyFlag.team) ?? s.addPlayer('c3', 'чарли', 3);
  defender.team = enemyFlag.team;
  go(defender, enemyFlag.x, enemyFlag.z);
  check(enemyFlag.home, 'its own team touching a dropped flag returns it');

  // Left alone, a dropped flag goes home by itself.
  enemyFlag.home = false;
  enemyFlag.x = enemyFlag.z = -300;
  defender.x = defender.z = -500;
  for (let t = 0; t < CONFIG.ctf.returnTime + 0.2; t += dt) s.step(dt);
  check(enemyFlag.home, `a dropped flag returns after ${CONFIG.ctf.returnTime} s`);

  s.teamScore = [CONFIG.ctf.capLimit, 0];
  s.drainEvents();
  s.step(dt);
  const over = s.drainEvents().find((e) => e.type === 'victory');
  check(!!over && over.team === 0, `${CONFIG.ctf.capLimit} captures win: ${over?.text ?? '—'}`);
}

// Bomb planting rules.
{
  const s = new Sim(buildArena('sklad', 1717, 'bomb'));
  const a = s.addPlayer('local', 'альфа', 1);
  const d = s.addPlayer('c2', 'браво', 2);
  const dt = CONFIG.tickDt;
  const priv = s as unknown as { roundT: number; roundAge: number };
  check(a.team === 0 && d.team === 1 && s.sites.length === 2, 'bomb: attackers, defenders and two sites');
  const mid = (s.map.minX + s.map.maxX) / 2;
  check(s.sites.every((x) => x.x > mid && s.nav.walkable(x.x, x.z)), 'both sites are walkable, on the defenders\' half');
  for (const { id } of ARENAS) {
    const m = new Sim(buildArena(id, 1, 'bomb'));
    const from = m.map.spawns.find((p) => p.x < (m.map.minX + m.map.maxX) / 2)!;
    check(m.sites.every((x) => !!m.nav.find(from.x, from.z, x.x, x.z)), `${id}: both bomb sites reachable from the attackers' spawn`);
  }
  const input = { seq: 0, moveX: 0, moveZ: 0, aim: 0, fire: false, reload: false, interact: false, flashlight: false, slot: -1, dt };
  const hold = (who: typeof a, secs: number, use = true) => {
    for (let t = 0; t < secs; t += dt) {
      s.applyInput(who, { ...input, use });
      s.step(dt);
    }
  };
  priv.roundT = 0;
  s.step(dt);
  check(s.roundPhase === 'live' && s.bomb?.carrier === a.id, 'round goes live with the bomb on the (human) attacker');
  const site = s.sites[0];
  d.x = d.z = -500;
  a.x = site.x - 6;
  a.z = site.z;
  hold(a, 1);
  check(!s.bomb!.planted && a.useT === 0, 'no planting off-site');
  a.x = site.x;
  a.z = site.z;
  hold(a, 1.5);
  hold(a, 0.1, false);
  check(!s.bomb!.planted && a.useT === 0, 'letting go of E resets the plant');
  hold(a, CONFIG.bomb.plantTime + 0.1);
  check(!!s.bomb?.planted && s.bomb.site === 0, 'holding E on the site plants the bomb');

  // Defuse.
  d.x = s.bomb!.x + 0.5;
  d.z = s.bomb!.z;
  a.x = a.z = -500;
  s.drainEvents();
  hold(d, CONFIG.bomb.defuseTime + 0.1);
  const ev = s.drainEvents();
  check(!s.bomb && ev.some((e) => e.type === 'bomb' && e.text === 'defused'), 'a defender holding E at the bomb defuses it');
  check(s.teamScore[1] === 1 && s.roundPhase === 'end', 'a defuse wins the round for the defence');

  // Next round: plant and let it blow; whoever stands close dies.
  for (let t = 0; t < CONFIG.comp.endDelay + CONFIG.comp.freezeTime + 0.2; t += dt) s.step(dt);
  check(s.roundPhase === 'live' && !!s.bomb, 'next round starts with a new bomb');
  const carrier = s.actors.get(s.bomb!.carrier)!;
  carrier.x = site.x;
  carrier.z = site.z;
  d.x = site.x + 3;
  d.z = site.z;
  d.alive = true;
  hold(carrier, CONFIG.bomb.plantTime + 0.1);
  s.bomb!.timer = 0.05;
  d.x = site.x + 3;
  d.z = site.z;
  for (let i = 0; i < 5; i++) s.step(dt);
  check(!d.alive && s.teamScore[0] === 1, 'the blast kills nearby defenders and wins the round for the attack');

  // Carrier down: the bomb drops; another attacker picks it up.
  for (let t = 0; t < CONFIG.comp.endDelay + CONFIG.comp.freezeTime + 0.2; t += dt) s.step(dt);
  const c2 = s.actors.get(s.bomb!.carrier)!;
  const mate = s.addPlayer('c3', 'чарли', 3);
  mate.team = 0;
  mate.alive = true;
  c2.shield = 0;
  (s as unknown as { damageActor(x: unknown, dmg: number, by: number): void }).damageActor(c2, 999, d.id);
  check(s.bomb?.carrier === -1, 'a fallen carrier drops the bomb');
  mate.x = s.bomb!.x;
  mate.z = s.bomb!.z;
  s.step(dt);
  check(s.bomb?.carrier === mate.id, 'another attacker picks it up');
}

// Bot difficulty: a hard guard spots the same player sooner than an easy one.
{
  const spotTime = (difficulty: 'easy' | 'hard') => {
    const s = new Sim(generateMap(2024));
    s.difficulty = difficulty;
    const priv = s as unknown as { populateRoom(i: number): void; updateAi(a: unknown, dt: number): void };
    priv.populateRoom(1);
    const guard = [...s.actors.values()].find((a) => a.kind === 'enemy')!;
    const p = s.addPlayer('local', 'тест', 1);
    s.time = 30;
    for (let t = 0; t < 6; t += CONFIG.tickDt) {
      guard.ang = 0;
      guard.x = s.map.rooms[1].wx;
      guard.z = s.map.rooms[1].wz;
      p.x = guard.x + 6;
      p.z = guard.z;
      p.alive = true;
      p.hp = p.maxHp;
      priv.updateAi(guard, CONFIG.tickDt);
      if (guard.ai!.awareness >= 1) return t;
    }
    return Infinity;
  };
  const easy = spotTime('easy');
  const hard = spotTime('hard');
  check(hard < easy, `hard guards spot you sooner: ${hard.toFixed(2)} s vs ${easy.toFixed(2)} s on easy`);
}

// Co-op downed state and revive.
{
  const make = () => {
    const s = new Sim(generateMap(5555));
    const a = s.addPlayer('local', 'альфа', 1);
    const b = s.addPlayer('c2', 'браво', 2);
    for (const p of [a, b]) p.shield = 0;
    return { s, a, b };
  };
  const dt = CONFIG.tickDt;
  const dmg = (s: Sim, who: unknown, amount: number) =>
    (s as unknown as { damageActor(x: unknown, d: number, by: number): void }).damageActor(who, amount, 1000);
  const input = { seq: 0, moveX: 0, moveZ: 0, aim: 0, fire: false, reload: false, interact: false, flashlight: false, slot: -1, dt };

  {
    const { s, a, b } = make();
    dmg(s, a, 999);
    check(a.alive && a.downed, 'co-op: lethal damage knocks you down instead of killing');
    const hostile = (s as unknown as { hostileTo(x: unknown, y: unknown): boolean }).hostileTo.bind(s);
    const guard = { ...a, id: 999, kind: 'enemy' as const, downed: false, alive: true };
    check(!hostile(guard, a) && hostile(guard, b), 'guards leave the downed alone and go for who still fights');
    // Crawl: much slower than running.
    a.vx = a.vz = 0;
    for (let i = 0; i < 60; i++) s.applyInput(a, { ...input, moveX: 1 });
    check(Math.hypot(a.vx, a.vz) < CONFIG.player.maxSpeed * 0.3, `downed players crawl (${Math.hypot(a.vx, a.vz).toFixed(1)} m/s)`);
    // A teammate holds E next to them.
    b.x = a.x + 0.8;
    b.z = a.z;
    for (let t = 0; t < CONFIG.down.reviveTime + 0.1; t += dt) {
      s.applyInput(b, { ...input, use: true });
      b.x = a.x + 0.8;
      b.z = a.z;
      s.step(dt);
    }
    check(!a.downed && a.alive && Math.abs(a.hp - a.maxHp * CONFIG.down.reviveHp) < 1, `a teammate gets them up (hp ${a.hp.toFixed(0)})`);
  }
  {
    const { s, a, b } = make();
    b.x = b.z = -500;
    dmg(s, a, 999);
    for (let t = 0; t < CONFIG.down.bleedOut + 0.2; t += dt) s.step(dt);
    check(!a.alive && !a.downed, 'left alone, a downed player bleeds out');
  }
  {
    const { s, a, b } = make();
    dmg(s, a, 999);
    dmg(s, b, 999);
    s.step(dt);
    const over = s.drainEvents().find((e) => e.type === 'gameOver');
    check(!!over && s.matchOver, `nobody standing ends the run: ${over?.text ?? '—'}`);
  }
  {
    const s = new Sim(generateMap(5555));
    const a = s.addPlayer('local', 'соло', 1);
    a.shield = 0;
    dmg(s, a, 999);
    check(!a.alive && !a.downed, 'solo co-op: no one to revive you, so no downed state');
  }
}

// Guard types.
{
  const s = new Sim(generateMap(777));
  const priv = s as unknown as { pickRole(level: number, rng: { next(): number }): string; giveRole(a: unknown, r: string): void };
  let seed = 1;
  const rng = { next: () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) };
  const share = (level: number) => {
    const n = 2000;
    let special = 0;
    for (let i = 0; i < n; i++) if (priv.pickRole(level, rng) !== 'grunt') special++;
    return special / n;
  };
  const early = share(1);
  const late = share(7);
  check(early < late && late > 0.4, `specialist guards grow deeper in: ${(early * 100).toFixed(0)}% → ${(late * 100).toFixed(0)}%`);

  type heavyType = ReturnType<typeof s.addPlayer>;
  let nextId = 5000;
  const make = (role: string) => {
    const g = (s as unknown as { newActor(id: number, k: string, n: string, x: number, z: number): heavyType }).newActor(nextId++, 'enemy', role, 0, 0);
    priv.giveRole(g, role);
    s.applySpeed(g);
    return g;
  };
  const grunt = make('grunt');
  const heavy = make('heavy');
  const sniper = make('sniper');
  const scout = make('scout');
  check(heavy.maxHp > grunt.maxHp * 2 && heavy.armor > 0 && heavy.weapon === 'shotgun' && heavy.speed < grunt.speed, 'heavy: tough, armoured, shotgun, slow');
  check(sniper.weapon === 'sniper', 'sniper carries a sniper rifle');
  check(!scout.flashOn && scout.gait === 'walk' && !scout.ai!.hasLight, 'scout: no light, quiet feet');
}

// Co-op room tasks.
{
  const dt = CONFIG.tickDt;
  const withTask = (kind: 'hack' | 'charge') => {
    for (let seed = 1; seed < 400; seed++) {
      const s = new Sim(generateMap(seed * 31337));
      const task = s.objectives.find((o) => o.kind === kind && o.room < s.map.rooms.length - 1);
      if (task) return { s, task };
    }
    throw new Error(`no ${kind} task found`);
  };
  {
    const a = new Sim(generateMap(4242)).objectives.map((o) => `${o.room}${o.kind}${o.x.toFixed(2)}`).join();
    const b = new Sim(generateMap(4242)).objectives.map((o) => `${o.room}${o.kind}${o.x.toFixed(2)}`).join();
    check(a === b, 'room tasks are the same for the same level');
  }
  {
    const { s, task } = withTask('hack');
    const p = s.addPlayer('local', 'тест', 1);
    s.roomIndex = task.room;
    s.roomPhase = 'fighting';
    for (const g of s.actors.values()) if (g.kind === 'enemy') g.alive = false;
    p.x = p.z = -500;
    for (let i = 0; i < 30; i++) s.step(dt);
    check(s.roomPhase === 'fighting', 'a cleared room with a terminal stays shut until it is hacked');
    s.drainEvents();
    const input = { seq: 0, moveX: 0, moveZ: 0, aim: 0, fire: false, reload: false, interact: false, flashlight: false, slot: -1, dt };
    let alarm = false;
    for (let t = 0; t < CONFIG.objectives.hackTime + 0.2; t += dt) {
      p.x = task.x + 0.5;
      p.z = task.z;
      s.applyInput(p, { ...input, use: true });
      p.x = task.x + 0.5;
      p.z = task.z;
      s.step(dt);
      for (const e of s.drainEvents()) if (e.type === 'objective' && e.text === 'alarm') alarm = true;
    }
    check(alarm, 'starting the hack raises the alarm');
    check(task.done && s.roomPhase !== 'fighting', 'hacking the terminal opens the way on');
  }
  {
    const { s, task } = withTask('charge');
    const p = s.addPlayer('local', 'тест', 1);
    const room = s.map.rooms[task.room];
    p.x = room.wx;
    p.z = room.wz;
    s.roomIndex = task.room - 1;
    s.step(dt);
    check(task.timer > 0 && task.timer <= CONFIG.objectives.chargeTimer, `walking in arms the charge (${task.timer.toFixed(1)} s)`);
    p.x = p.z = -500;
    s.drainEvents();
    let blown = false;
    for (let t = 0; t < CONFIG.objectives.chargeTimer + 0.5; t += dt) {
      s.step(dt);
      for (const e of s.drainEvents()) if (e.type === 'objective' && e.text === 'blown') blown = true;
    }
    check(blown && task.done, 'an undefused charge goes off');
  }
}

// Waves: money, the shop in the break, a boss every few waves.
{
  const s = new Sim(buildArena('sklad', 1818, 'waves'));
  const a = s.addPlayer('local', 'альфа', 1);
  const dt = CONFIG.tickDt;
  const dmg = (who: unknown, by: number) => (s as unknown as { damageActor(x: unknown, d: number, b: number): void }).damageActor(who, 9999, by);
  for (let t = 0; t < CONFIG.waves.firstBreak + 0.1; t += dt) s.step(dt);
  check(!s.canBuy, 'waves: no shopping mid-wave');
  const money0 = a.money;
  const guards = [...s.actors.values()].filter((g) => g.kind === 'enemy' && g.alive);
  for (const g of guards) dmg(g, a.id);
  s.step(dt);
  check(a.money === money0 + guards.length * CONFIG.waves.killReward + CONFIG.waves.clearBonus, `kills and the cleared wave pay: $${money0} → $${a.money}`);
  check(s.canBuy && s.buy(a, 'armor'), 'the shop is open between waves');
  // Fast-forward to the boss wave.
  s.wave = CONFIG.waves.bossEvery - 1;
  s.waveT = 0.01;
  s.step(dt);
  const boss = [...s.actors.values()].find((g) => g.role === 'boss');
  check(!!boss && boss.maxHp > CONFIG.enemy.maxHp * 5 && boss.name === 'Комендант', `wave ${s.wave} brings the boss (${boss?.maxHp ?? 0} hp)`);
}

// Bomb: the teams change roles at halftime.
{
  const s = new Sim(buildArena('sklad', 1919, 'bomb'));
  s.fighters = 6;
  s.fillBots();
  const dt = CONFIG.tickDt;
  const priv = s as unknown as { endTeamRound(w: number, r: string): void; roundT: number };
  const half = Math.floor(CONFIG.comp.maxRounds / 2);
  // Play out rounds by fiat, alternating winners, up to halftime.
  for (let r = 1; r <= half; r++) {
    priv.roundT = 0;
    s.step(dt); // freeze -> live
    for (const a of s.actors.values()) {
      a.money = 5000;
      if (a.team === 0) s.buy(a, 'rifle');
    }
    priv.endTeamRound(r % 2, 'тест');
    for (let t = 0; t < CONFIG.comp.endDelay + 0.1; t += dt) s.step(dt);
  }
  check(s.sidesSwapped && s.attackTeam === 1, `after round ${half} the teams swap roles`);
  const mid = (s.map.minX + s.map.maxX) / 2;
  const attackers = [...s.actors.values()].filter((a) => a.team === s.attackTeam);
  check(attackers.every((a) => a.x < mid), 'the new attackers start on the left half (sites stay on the right)');
  check([...s.actors.values()].every((a) => a.money <= CONFIG.comp.startMoney + 1000 && !a.weapons.includes('rifle')), 'halftime resets kit and money');
  priv.roundT = 0;
  s.step(dt);
  const carrier = s.actors.get(s.bomb?.carrier ?? -1);
  check(carrier?.team === 1, 'the bomb now goes to the red team');
}

// Weapon balance: time to kill a standing 100 hp target at range, real
// shooting (spread, falloff, cooldown, reloads), on an empty floor.
{
  const ranges = [5, 10, 15, 20, 30];
  const ttk = (weapon: WeaponId, range: number): number => {
    const base = buildArena('sklad', 2222, 'dm');
    // Nothing on the floor: an armour pickup under the target skewed the 20 m column.
    const map = { ...base, walls: [], props: [], lamps: [], bushes: [], pickups: [], powerups: [] };
    let total = 0;
    const trials = 20;
    for (let k = 0; k < trials; k++) {
      const s = new Sim({ ...map, seed: 1000 + k });
      const p = s.addPlayer('a', 'a', 1);
      const t = s.addPlayer('b', 'b', 2);
      p.weapons = [weapon];
      (s as unknown as { equip(a: unknown, w: WeaponId): void }).equip(p, weapon);
      p.x = 20;
      p.z = 20;
      t.x = p.x + range;
      t.z = p.z;
      const dt = CONFIG.tickDt;
      let time = 0;
      while (t.alive && time < 8) {
        p.shield = t.shield = 0;
        t.x = p.x + range;
        t.z = p.z;
        t.vx = t.vz = 0;
        // A sensible shooter: with a sniper rifle, wait for the aim to settle.
        const fire = weapon !== 'sniper' || p.stillT >= CONFIG.gait.sniperSettle;
        s.applyInput(p, { seq: 0, moveX: 0, moveZ: 0, aim: 0, fire, reload: false, interact: false, flashlight: false, slot: -1, dt });
        s.step(dt);
        time += dt;
      }
      total += time;
    }
    return total / trials;
  };
  const table: Record<string, number[]> = {};
  for (const w of WEAPON_ORDER) table[w] = ranges.map((r) => ttk(w, r));
  out.push('TTK, s (to kill 100 hp) at ' + ranges.map((r) => `${r} m`).join(' / '));
  for (const w of WEAPON_ORDER) out.push(`  ${w.padEnd(8)} ${table[w].map((v) => v.toFixed(2).padStart(5)).join('  ')}`);
  // Every gun has a range where it is the best, and the starting pistol has none.
  const best = (i: number) => WEAPON_ORDER.reduce((a, b) => (table[b][i] < table[a][i] ? b : a));
  check(best(0) === 'shotgun', `5 m: the shotgun kills fastest (best: ${best(0)})`);
  check(best(1) === 'smg', `10 m: the SMG (best: ${best(1)})`);
  check(best(3) === 'rifle', `20 m: the rifle (best: ${best(3)})`);
  check(best(4) === 'sniper', `30 m: the sniper rifle (best: ${best(4)})`);
  check(ranges.every((_, i) => best(i) !== 'pistol'), 'the starting pistol is never the best');
  check(ranges.every((_, i) => table.silenced[i] >= table.pistol[i]), 'quiet costs: the silenced pistol never out-kills the plain one');
}

// Round economy: kill money by weapon, a growing loss bonus.
{
  const s = new Sim(buildArena('sklad', 2323, 'bomb'));
  const a = s.addPlayer('local', 'альфа', 1);
  const b = s.addPlayer('c2', 'браво', 2);
  const priv = s as unknown as { rewardKill(k: unknown): void; endTeamRound(w: number, r: string): void; equip(x: unknown, w: string): void };
  const pay = (weapon: string) => {
    priv.equip(a, weapon);
    a.money = 0;
    priv.rewardKill(a);
    return a.money;
  };
  check(pay('shotgun') > pay('rifle') && pay('rifle') > pay('sniper'), `kill money: shotgun $${pay('shotgun')}, rifle $${pay('rifle')}, sniper $${pay('sniper')}`);
  const losses: number[] = [];
  for (let i = 0; i < 5; i++) {
    b.money = 0;
    priv.endTeamRound(a.team, 'тест');
    losses.push(b.money);
    if (s.matchOver) break;
  }
  check(losses[1] > losses[0] && losses[3] === losses[0] + CONFIG.comp.lossStreakBonus * CONFIG.comp.lossStreakMax, `losing in a row pays more, capped: ${losses.join(' → ')}`);
  // Blue's long losing run ends with a win; its next loss is back to the base pay.
  priv.endTeamRound(b.team, 'тест');
  b.money = 0;
  priv.endTeamRound(a.team, 'тест');
  check(b.money === CONFIG.comp.roundLossBonus, `a win resets the streak ($${b.money} for the next loss)`);
}

// Player classes.
{
  const dt = CONFIG.tickDt;
  const input = { seq: 0, moveX: 0, moveZ: 0, aim: 0, fire: false, reload: false, interact: false, flashlight: false, slot: -1, dt };
  {
    const s = new Sim(buildArena('sklad', 3131, 'dm'));
    const plain = s.addPlayer('a', 'a', 1, null);
    const assault = s.addPlayer('b', 'b', 2, 'assault');
    const scout = s.addPlayer('c', 'c', 3, 'scout');
    check(assault.grenades === plain.grenades + CONFIG.classes.assault.extraFrags, 'assault: an extra frag');
    for (const a of [plain, assault]) {
      a.ammo = 1;
      (s as unknown as { startReload(x: unknown): void }).startReload(a);
    }
    check(assault.reloadT < plain.reloadT, 'assault: faster reload');
    check(scout.buffs.nv > 0, 'scout: night vision on spawn');
    // Footsteps: run both a plain player and a scout and compare the noise.
    const stepNoise = (who: typeof plain) => {
      s.noises = [];
      who.stepDist = CONFIG.gait.stepLength;
      who.vx = 5;
      (s as unknown as { updateFootsteps(a: unknown, dt: number): void }).updateFootsteps(who, dt);
      return s.noises.find((n) => n.ownerId === who.id)?.radius ?? 0;
    };
    check(stepNoise(scout) < stepNoise(plain), `scout: quieter steps (${stepNoise(scout)} m vs ${stepNoise(plain)} m)`);
  }
  {
    const s = new Sim(generateMap(6262));
    const medic = s.addPlayer('a', 'медик', 1, 'medic');
    const hurt = s.addPlayer('b', 'раненый', 2, 'assault');
    hurt.hp = 40;
    hurt.x = medic.x + 2;
    hurt.z = medic.z;
    for (let t = 0; t < 2; t += dt) s.step(dt);
    check(hurt.hp > 44, `medic: heals an ally nearby (${hurt.hp.toFixed(1)} hp after 2 s)`);
    // Revive in half the time.
    hurt.shield = 0;
    (s as unknown as { damageActor(x: unknown, d: number, b: number): void }).damageActor(hurt, 999, 1000);
    let t = 0;
    while (hurt.downed && t < 5) {
      medic.x = hurt.x + 0.8;
      medic.z = hurt.z;
      s.applyInput(medic, { ...input, use: true });
      medic.x = hurt.x + 0.8;
      medic.z = hurt.z;
      s.step(dt);
      t += dt;
    }
    check(!hurt.downed && t < CONFIG.down.reviveTime * 0.6, `medic: revives in ${t.toFixed(1)} s`);
  }
  {
    const s = new Sim(buildArena('sklad', 3232, 'dm'));
    const eng = s.addPlayer('a', 'инженер', 1, 'engineer');
    eng.x = s.map.spawns[0].x;
    eng.z = s.map.spawns[0].z;
    const dir = [0, Math.PI / 2, Math.PI, -Math.PI / 2].find((a) =>
      s.world.lineOfSight(eng.x, eng.z, eng.x + Math.cos(a) * 3, eng.z + Math.sin(a) * 3, []),
    )!;
    const before = s.props.length;
    s.applyInput(eng, { ...input, aim: dir, deploy: true });
    s.applyInput(eng, { ...input, aim: dir, deploy: true });
    const shields = s.props.slice(before);
    check(shields.length === 1 && shields[0].deployed === true, 'engineer: one shield per life');
    // A bullet through it stops on the shield.
    const shield = shields[0];
    const target = s.addPlayer('b', 'b', 2, null);
    target.x = eng.x + Math.cos(dir) * 4;
    target.z = eng.z + Math.sin(dir) * 4;
    target.shield = 0;
    const hpBefore = target.hp;
    s.bullets.push({
      // From just past the engineer (a foreign bullet would hit him first).
      id: 'eng', ownerId: 99, ownerKind: 'enemy', x: eng.x + Math.cos(dir) * 0.8, z: eng.z + Math.sin(dir) * 0.8, vx: Math.cos(dir) * 80, vz: Math.sin(dir) * 80, speed: 80,
      damage: 30, damageMul: 1, life: 0.2, weapon: 'rifle', color: 0, range: 0,
    });
    for (let i = 0; i < 6; i++) s.step(dt);
    check(target.hp === hpBefore && shield.hp < CONFIG.classes.engineer.shieldHp, 'the shield takes the bullet');
  }
}

// New weapons: knife, silenced pistol, LMG.
{
  const dt = CONFIG.tickDt;
  const s = new Sim(buildArena('sklad', 4545, 'dm'));
  const a = s.addPlayer('a', 'a', 1);
  const b = s.addPlayer('b', 'b', 2);
  const input = { seq: 0, moveX: 0, moveZ: 0, aim: 0, fire: false, reload: false, interact: false, flashlight: false, slot: -1, dt };
  check(a.weapons.includes('knife'), 'players carry a knife');
  const stab = (behind: boolean, gap = 1.2) => {
    a.x = 20; a.z = 20; a.ang = 0; a.cooldown = 0; a.shield = 0;
    b.x = a.x + gap; b.z = a.z; b.hp = b.maxHp; b.armor = 0; b.shield = 0; b.alive = true;
    b.ang = behind ? 0 : Math.PI; // facing away from the attacker, or at him
    (s as unknown as { equip(x: unknown, w: string): void }).equip(a, 'knife');
    s.applyInput(a, { ...input, aim: 0, fire: true });
    return b.maxHp - b.hp;
  };
  check(stab(false) === WEAPONS.knife.damage, `a knife from the front: ${stab(false)} damage`);
  stab(true);
  check(!b.alive, 'a knife in the back kills');
  check(stab(false, 3) === 0, 'out of reach: nothing');
  // Silenced pistol: barely heard.
  s.noises = [];
  a.cooldown = 0;
  (s as unknown as { equip(x: unknown, w: string): void }).equip(a, 'silenced');
  s.applyInput(a, { ...input, fire: true });
  const shotNoise = s.noises.find((n) => n.ownerId === a.id)?.radius ?? 0;
  check(shotNoise > 0 && shotNoise < 10 && WEAPONS.silenced.silenced === true, `a silenced shot is heard only ${shotNoise} m away`);
  // LMG: slower on your feet.
  (s as unknown as { equip(x: unknown, w: string): void }).equip(a, 'lmg');
  s.applySpeed(a);
  const lmgSpeed = a.speed;
  (s as unknown as { equip(x: unknown, w: string): void }).equip(a, 'rifle');
  s.applySpeed(a);
  check(lmgSpeed < a.speed, 'the LMG slows you down');
}

out.push(`${failures} failures`);
document.getElementById('out')!.textContent = out.join('\n');
(window as unknown as { __result: string }).__result = out.join('\n');
