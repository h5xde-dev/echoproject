import { segCircleHit } from '../core/math';
import { PhysicsWorld } from './physics';
import type { Actor, Bullet, SimProp, StaticBody } from './types';

/** Minimal shape a bullet needs from an actor to test a hit. */
export interface BulletActor {
  id: number;
  x: number;
  z: number;
  radius: number;
  alive: boolean;
}

export interface BulletCtx {
  world: PhysicsWorld;
  props: SimProp[];
  actors: Map<number, BulletActor>;
  scratch: StaticBody[];
}

export type BulletHit =
  | { kind: 'static'; x: number; z: number; nx: number; nz: number; bullet: Bullet }
  | { kind: 'actor'; x: number; z: number; bullet: Bullet; actor: Actor }
  | { kind: 'prop'; x: number; z: number; bullet: Bullet; prop: SimProp };

/**
 * Advances every bullet and resolves collisions. Shared by the authoritative
 * host simulation and the client-side replica so both agree on trajectories.
 */
export function updateBullets(bullets: Bullet[], ctx: BulletCtx, dt: number): BulletHit[] {
  const hits: BulletHit[] = [];

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.life -= dt;
    if (b.life <= 0) {
      bullets.splice(i, 1);
      continue;
    }

    const dirX = b.vx / b.speed;
    const dirZ = b.vz / b.speed;
    const travel = b.speed * dt;
    b.range += travel;

    let bestT = travel + 1e-6;
    let hitKind: 'none' | 'static' | 'actor' | 'prop' = 'none';
    let hitNx = 0;
    let hitNz = 0;
    let hitActor: Actor | null = null;
    let hitProp: SimProp | null = null;

    const staticHit = ctx.world.castSegment(b.x, b.z, dirX, dirZ, travel, ctx.scratch);
    if (staticHit) {
      bestT = staticHit.t;
      hitKind = 'static';
      hitNx = staticHit.nx;
      hitNz = staticHit.nz;
    }

    for (const actor of ctx.actors.values()) {
      if (!actor.alive || actor.id === b.ownerId) continue;
      const t = segCircleHit(b.x, b.z, b.x + dirX * travel, b.z + dirZ * travel, actor.x, actor.z, actor.radius);
      if (t !== null && t * travel < bestT) {
        bestT = t * travel;
        hitKind = 'actor';
        hitActor = actor as unknown as Actor;
      }
    }

    for (const p of ctx.props) {
      if (!p.alive) continue;
      const t = segCircleHit(
        b.x,
        b.z,
        b.x + dirX * travel,
        b.z + dirZ * travel,
        p.x,
        p.z,
        Math.max(p.hw, p.hh) * 0.92,
      );
      if (t !== null && t * travel < bestT) {
        bestT = t * travel;
        hitKind = 'prop';
        hitProp = p;
      }
    }

    if (hitKind === 'none') {
      b.x += dirX * travel;
      b.z += dirZ * travel;
      continue;
    }

    const hx = b.x + dirX * bestT;
    const hz = b.z + dirZ * bestT;

    // Bullets stop at walls: no ricochets.
    if (hitKind === 'static') {
      hits.push({ kind: 'static', x: hx, z: hz, nx: hitNx, nz: hitNz, bullet: b });
      bullets.splice(i, 1);
      continue;
    }

    if (hitKind === 'actor' && hitActor) {
      hits.push({ kind: 'actor', x: hx, z: hz, bullet: b, actor: hitActor });
      bullets.splice(i, 1);
      continue;
    }

    if (hitKind === 'prop' && hitProp) {
      hits.push({ kind: 'prop', x: hx, z: hz, bullet: b, prop: hitProp });
      bullets.splice(i, 1);
    }
  }

  return hits;
}
