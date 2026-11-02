import { pointInRect, segCircleHit } from '../core/math';
import { CONFIG } from './config';
import { PhysicsWorld } from './physics';
import type { Actor, Bullet, Drone, SimProp, StaticBody } from './types';
import { WEAPONS } from './weapons';

/** A drone is small: a bullet has to pass this close. */
const DRONE_HIT_RADIUS = 0.45;

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
  /** Drones in the air; a shooter's own drone lets the bullet by. */
  drones?: Drone[];
}

export type BulletHit =
  | { kind: 'static'; x: number; z: number; nx: number; nz: number; bullet: Bullet }
  | { kind: 'actor'; x: number; z: number; bullet: Bullet; actor: Actor }
  | { kind: 'prop'; x: number; z: number; bullet: Bullet; prop: SimProp }
  | { kind: 'drone'; x: number; z: number; bullet: Bullet; drone: Drone };

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
    let hitKind: 'none' | 'static' | 'actor' | 'prop' | 'drone' = 'none';
    let hitNx = 0;
    let hitNz = 0;
    let hitActor: Actor | null = null;
    let hitProp: SimProp | null = null;
    let hitDrone: Drone | null = null;

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
      // Bullets fly through barbed wire.
      if (p.kind === 'wire') continue;
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

    for (const d of ctx.drones ?? []) {
      if (d.down || d.ownerId === b.ownerId) continue;
      const t = segCircleHit(b.x, b.z, b.x + dirX * travel, b.z + dirZ * travel, d.x, d.z, DRONE_HIT_RADIUS);
      if (t !== null && t * travel < bestT) {
        bestT = t * travel;
        hitKind = 'drone';
        hitDrone = d;
      }
    }

    if (hitKind === 'none') {
      b.x += dirX * travel;
      b.z += dirZ * travel;
      continue;
    }

    const hx = b.x + dirX * bestT;
    const hz = b.z + dirZ * bestT;

    // Bullets stop at walls: no ricochets. Heavy rounds (sniper, LMG) punch
    // through one thin wall and keep going at half damage — arena walls are
    // thin enough, the fat co-op walls are not.
    if (hitKind === 'static') {
      hits.push({ kind: 'static', x: hx, z: hz, nx: hitNx, nz: hitNz, bullet: b });
      const P = CONFIG.pierce;
      if (WEAPONS[b.weapon].pierce && !b.pierced) {
        let exit = 0;
        for (let s = 0.15; s <= P.depth; s += 0.15) {
          if (!insideWall(ctx, hx + dirX * s, hz + dirZ * s)) {
            exit = s;
            break;
          }
        }
        if (exit > 0) {
          b.pierced = true;
          b.damageMul *= P.damageMul;
          b.x = hx + dirX * (exit + 0.05);
          b.z = hz + dirZ * (exit + 0.05);
          b.range += bestT + exit;
          continue;
        }
      }
      bullets.splice(i, 1);
      continue;
    }

    if (hitKind === 'actor' && hitActor) {
      hits.push({ kind: 'actor', x: hx, z: hz, bullet: b, actor: hitActor });
      bullets.splice(i, 1);
      continue;
    }

    if (hitKind === 'drone' && hitDrone) {
      hits.push({ kind: 'drone', x: hx, z: hz, bullet: b, drone: hitDrone });
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

/** Is this point inside a wall or a closed door? (how deep a pierce went). */
function insideWall(ctx: BulletCtx, x: number, z: number): boolean {
  for (const w of ctx.world.query(x - 0.1, z - 0.1, x + 0.1, z + 0.1, ctx.scratch)) {
    if (pointInRect(x, z, w.cx, w.cz, w.hw, w.hh)) return true;
  }
  for (const d of ctx.world.doors) {
    if (!d.open && pointInRect(x, z, d.cx, d.cz, d.hw, d.hh)) return true;
  }
  return false;
}
