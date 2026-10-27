import { isRoundMode } from '../game/modes';
import type { Sim } from '../game/sim';
import type { ActorState, RoundState, SnapshotMsg, WaveState } from './protocol';

// What an authority (a hosting browser or the dedicated server) sends its
// clients: the whole visible state of the match.

export function buildSnapshot(sim: Sim, tick: number, ack: Record<string, number>): SnapshotMsg {
  const actors: ActorState[] = [];
  for (const a of sim.actors.values()) {
    actors.push({
      id: a.id,
      kind: a.kind,
      peerId: a.peerId,
      name: a.name,
      x: a.x,
      z: a.z,
      ang: a.ang,
      hp: a.hp,
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
      drones: a.drones,
      piloting: a.piloting,
    });
  }
  const bullets = sim.bullets.map((b) => ({ id: b.id, x: b.x, z: b.z, vx: b.vx, vz: b.vz, color: b.color }));
  const props = sim.props.map((p) => ({
    id: p.id,
    x: p.x,
    z: p.z,
    alive: p.alive,
    hp: Math.round(p.hp),
    ...(p.deployed ? { kind: p.kind, hw: p.hw, hh: p.hh } : {}),
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
    mode: sim.mode,
    scores: scoreRows(sim),
    round: roundStateOf(sim),
    timeLeft: sim.timeLeft,
    teamScore: sim.teamScore,
    wave: waveStateOf(sim) ?? undefined,
    flags: sim.flags.length > 0 ? sim.flags : undefined,
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
