import { isRoundMode } from '../game/modes';
import type { Sim } from '../game/sim';
import type { ActorState, RoundState, SnapshotMsg, WaveState } from './protocol';

// What an authority (a hosting browser or the dedicated server) sends its
// clients: the whole visible state of the match. Kept small, 20 times a
// second per client: coordinates to the millimetre, and props only once they
// differ from the map (clients start from the map they were welcomed with).

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Per match: props that have moved, been hit or placed — sent from then on. */
const touched = new WeakMap<Sim, { defs: Map<number, { x: number; z: number; hp: number }>; ids: Set<number> }>();

function changedProps(sim: Sim): Set<number> {
  let t = touched.get(sim);
  if (!t) {
    t = { defs: new Map(sim.map.props.map((p) => [p.id, { x: p.x, z: p.z, hp: p.hp }])), ids: new Set() };
    touched.set(sim, t);
  }
  for (const p of sim.props) {
    if (t.ids.has(p.id)) continue;
    const d = t.defs.get(p.id);
    if (!d || p.deployed || !p.alive || Math.abs(p.x - d.x) > 0.005 || Math.abs(p.z - d.z) > 0.005 || Math.round(p.hp) !== Math.round(d.hp)) t.ids.add(p.id);
  }
  return t.ids;
}

export function buildSnapshot(sim: Sim, tick: number, ack: Record<string, number>): SnapshotMsg {
  const actors: ActorState[] = [];
  for (const a of sim.actors.values()) {
    actors.push({
      id: a.id,
      kind: a.kind,
      peerId: a.peerId,
      name: a.name,
      x: r3(a.x),
      z: r3(a.z),
      ang: r3(a.ang),
      hp: Math.round(a.hp * 10) / 10,
      maxHp: a.maxHp,
      armor: a.armor,
      alive: a.alive,
      weapon: a.weapon,
      weapons: a.weapons,
      buffs: a.buffs,
      shield: a.shield,
      grenades: a.grenades,
      money: a.money,
      tier: a.tier,
      tierKills: a.tierKills,
      ammo: a.ammo,
      reloading: a.reloading,
      flashOn: a.flashOn,
      slot: a.slot,
      smokes: a.smokes,
      flashes: a.flashes,
      molotovs: a.molotovs,
      burning: a.burnT > 0,
      blind: a.blind,
      concealed: a.concealed,
      team: a.team,
      carrying: a.carrying,
      useT: a.useT,
      crouched: a.gait === 'crouch',
      downed: a.downed,
      downT: a.downT,
      reviveT: a.reviveT,
      role: a.role,
      aiming: a.role === 'sniper' && a.ai?.mode === 'attack',
      cls: a.cls,
      shieldUsed: a.shieldUsed,
      color: a.color,
      camo: a.camo,
      badge: a.badge,
      drones: a.drones,
      piloting: a.piloting,
      streak: a.streak || undefined,
      strikes: a.strikes || undefined,
      mines: a.mines || undefined,
      flares: a.flares || undefined,
      hold: a.holdT > 0 ? a.holdT : undefined,
    });
  }
  const bullets = sim.bullets.map((b) => ({ id: b.id, x: r3(b.x), z: r3(b.z), vx: r3(b.vx), vz: r3(b.vz), color: b.color }));
  const changed = changedProps(sim);
  const props = sim.props.filter((p) => changed.has(p.id)).map((p) => ({
    id: p.id,
    x: r3(p.x),
    z: r3(p.z),
    alive: p.alive,
    hp: Math.round(p.hp),
    ...(p.deployed ? { kind: p.kind, hw: p.hw, hh: p.hh, owner: p.ownerId } : {}),
  }));
  const doors = sim.doors.map((d) => ({ room: d.room, open: d.open, openT: d.openT }));
  return {
    t: 'snap',
    tick,
    time: sim.time,
    room: sim.roomIndex,
    phase: sim.roomPhase,
    actors,
    bullets,
    props,
    doors,
    pickups: sim.pickups.map((p) => ({ id: p.id, weapon: p.weapon, x: p.x, z: p.z })),
    powerups: sim.powerups.map((p) => ({ id: p.id, kind: p.kind, x: p.x, z: p.z, active: p.active })),
    grenades: sim.grenades,
    lampsOut: sim.lampAlive.flatMap((alive, i) => (alive ? [] : [i])),
    smokes: sim.smokes,
    fires: sim.fires,
    drones: sim.drones.length > 0 ? sim.drones : undefined,
    inter: sim.interactables.length > 0 ? sim.interactables.map((o) => ({ id: o.id, on: o.on, charge: Math.round(o.charge), cd: Math.round(o.cd * 10) / 10 })) : undefined,
    supply: sim.drops.length > 0 ? sim.drops : undefined,
    shells: sim.shells.length > 0 ? sim.shells : undefined,
    flares: sim.flares.length > 0 ? sim.flares : undefined,
    mode: sim.mode,
    scores: scoreRows(sim),
    round: roundStateOf(sim),
    timeLeft: sim.timeLeft,
    teamScore: sim.teamScore,
    wave: waveStateOf(sim) ?? undefined,
    flags: sim.flags.length > 0 ? sim.flags : undefined,
    modeState: sim.modeState.text ? sim.modeState : undefined,
    world: sim.worldEvent.kind ? sim.worldEvent : undefined,
    bases: sim.bases.length > 0 ? sim.bases : undefined,
    bomb: sim.mode === 'bomb' ? sim.bomb : undefined,
    attackTeam: sim.mode === 'bomb' ? sim.attackTeam : undefined,
    objectives: sim.objectives.length > 0 ? sim.objectives : undefined,
    sites: sim.sites.length > 0 ? sim.sites : undefined,
    ack,
  };
  }

/** Arena scoreboard rows: [actor id, kills, deaths, rounds won]. */
export function scoreRows(sim: Sim): [number, number, number, number][] {
  return [...sim.scores].map(([id, s]) => [id, s.kills, s.deaths, s.rounds]);
}

export function waveStateOf(sim: Sim): WaveState | null {
  if (sim.mode !== 'waves') return null;
  let left = 0;
  for (const a of sim.actors.values()) if (a.kind === 'enemy' && a.alive) left++;
  return { n: sim.wave, phase: sim.wavePhase, t: Math.max(0, sim.waveT), left, canBuy: sim.canBuy };
}

export function roundStateOf(sim: Sim): RoundState | null {
  if (!isRoundMode(sim.mode)) return null;
  return { n: sim.round, phase: sim.roundPhase, t: Math.max(0, sim.roundT), canBuy: sim.canBuy };
}
