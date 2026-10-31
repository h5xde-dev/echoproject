import * as THREE from 'three';
import type { StaticBody } from '@echo/shared/game/types';

// Verlet ragdoll: one particle per major joint, distance sticks for bones
// plus cross-braces that keep the torso and pelvis rigid. Particles collide
// with the floor and the level's wall boxes. Purely cosmetic and local to
// each client — the sim only knows the soldier is dead.
// SoldierAnimator turns the particle positions back into a bone pose.

export const RAGDOLL_JOINTS = [
  'hips', 'spine2', 'head',
  'armL', 'foreL', 'handL', 'armR', 'foreR', 'handR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR',
] as const;
export type RagdollJoint = (typeof RAGDOLL_JOINTS)[number];

const J = Object.fromEntries(RAGDOLL_JOINTS.map((k, i) => [k, i])) as Record<RagdollJoint, number>;

const BONES: [RagdollJoint, RagdollJoint][] = [
  ['hips', 'spine2'], ['spine2', 'head'],
  ['spine2', 'armL'], ['armL', 'foreL'], ['foreL', 'handL'],
  ['spine2', 'armR'], ['armR', 'foreR'], ['foreR', 'handR'],
  ['hips', 'thighL'], ['thighL', 'shinL'], ['shinL', 'footL'],
  ['hips', 'thighR'], ['thighR', 'shinR'], ['shinR', 'footR'],
];
const BRACES: [RagdollJoint, RagdollJoint][] = [
  ['armL', 'armR'], ['thighL', 'thighR'],
  ['armL', 'thighL'], ['armR', 'thighR'], ['armL', 'thighR'], ['armR', 'thighL'],
  ['armL', 'hips'], ['armR', 'hips'], ['head', 'armL'], ['head', 'armR'],
];
/** Limbs may bend but not fold flat (crude elbow/knee limits). */
const MIN_SPANS: [RagdollJoint, RagdollJoint, number][] = [
  ['armL', 'handL', 0.45], ['armR', 'handR', 0.45],
  ['thighL', 'footL', 0.55], ['thighR', 'footR', 0.55],
];

const GRAVITY = -16;
const ITERATIONS = 8;
const SUBSTEP = 1 / 120;
const SLEEP_AFTER = 4;
const WALL_TOP = 2.2;

let walls: StaticBody[] = [];

/** Level geometry the ragdolls collide with (set when a map is built). */
export function setRagdollWalls(list: StaticBody[]): void {
  walls = list;
}

interface Stick {
  a: number;
  b: number;
  len: number;
  min: boolean;
}

export class Ragdoll {
  readonly pos: THREE.Vector3[];
  private prev: THREE.Vector3[];
  private radius: number[];
  private sticks: Stick[] = [];
  private walls: StaticBody[];
  private age = 0;
  private acc = 0;
  asleep = false;

  /**
   * `points` are the joints' current world positions (the live pose at the
   * moment of death); `vel` is the initial velocity of each joint.
   */
  constructor(points: THREE.Vector3[], vel: THREE.Vector3[]) {
    this.pos = points.map((p) => p.clone());
    this.prev = points.map((p, i) => p.clone().addScaledVector(vel[i], -SUBSTEP));
    // Only walls the body can reach in a few seconds of tumbling.
    const c = points[J.hips];
    this.walls = walls.filter((w) => Math.abs(w.cx - c.x) - w.hw < 6 && Math.abs(w.cz - c.z) - w.hh < 6);
    this.radius = RAGDOLL_JOINTS.map((k) => (k === 'head' ? 0.13 : k === 'spine2' || k === 'hips' ? 0.14 : 0.07));
    const add = (a: RagdollJoint, b: RagdollJoint, min = false, scale = 1) =>
      this.sticks.push({ a: J[a], b: J[b], len: this.pos[J[a]].distanceTo(this.pos[J[b]]) * scale, min });
    for (const [a, b] of BONES) add(a, b);
    for (const [a, b] of BRACES) add(a, b);
    for (const [a, b, f] of MIN_SPANS) {
      const full = this.pos[J[a]].distanceTo(this.pos[J[b]]);
      add(a, b, true, f);
      this.sticks[this.sticks.length - 1].len = Math.min(full, this.sticks[this.sticks.length - 1].len);
    }
  }

  /** Adds velocity to every joint (explosions), waking the body up. */
  push(vx: number, vy: number, vz: number): void {
    for (const q of this.prev) {
      q.x -= vx * SUBSTEP;
      q.y -= vy * SUBSTEP;
      q.z -= vz * SUBSTEP;
    }
    this.asleep = false;
    this.age = Math.min(this.age, SLEEP_AFTER - 2.5);
  }

  static index(j: RagdollJoint): number {
    return J[j];
  }

  step(dt: number): void {
    if (this.asleep) return;
    this.age += dt;
    this.acc += Math.min(dt, 1 / 20);
    let moved = 0;
    while (this.acc >= SUBSTEP) {
      this.acc -= SUBSTEP;
      moved = Math.max(moved, this.integrate(SUBSTEP));
      for (let k = 0; k < ITERATIONS; k++) this.solve();
    }
    if (this.age > SLEEP_AFTER || (this.age > 1.2 && moved < 0.0004)) this.asleep = true;
  }

  private integrate(h: number): number {
    let maxMove = 0;
    for (let i = 0; i < this.pos.length; i++) {
      const p = this.pos[i];
      const q = this.prev[i];
      const onGround = p.y <= this.radius[i] + 0.01;
      // Ground contact acts as friction; air drag is small.
      const damp = onGround ? 0.82 : 0.995;
      const vx = (p.x - q.x) * damp;
      const vy = (p.y - q.y) * 0.995;
      const vz = (p.z - q.z) * damp;
      q.copy(p);
      p.x += vx;
      p.y += vy + GRAVITY * h * h;
      p.z += vz;
      maxMove = Math.max(maxMove, Math.abs(vx) + Math.abs(vy) + Math.abs(vz));
    }
    return maxMove;
  }

  private solve(): void {
    for (const s of this.sticks) {
      const a = this.pos[s.a];
      const b = this.pos[s.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      if (s.min && d >= s.len) continue;
      const k = ((d - s.len) / d) * 0.5;
      a.x += dx * k; a.y += dy * k; a.z += dz * k;
      b.x -= dx * k; b.y -= dy * k; b.z -= dz * k;
    }
    for (let i = 0; i < this.pos.length; i++) {
      const p = this.pos[i];
      const r = this.radius[i];
      if (p.y < r) p.y = r;
      if (p.y > WALL_TOP) continue;
      for (const w of this.walls) {
        const ox = w.hw + r - Math.abs(p.x - w.cx);
        const oz = w.hh + r - Math.abs(p.z - w.cz);
        if (ox <= 0 || oz <= 0) continue;
        if (ox < oz) p.x += ox * Math.sign(p.x - w.cx || 1);
        else p.z += oz * Math.sign(p.z - w.cz || 1);
      }
    }
  }
}
