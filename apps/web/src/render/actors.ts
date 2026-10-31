import * as THREE from 'three';
import { assets } from './assets';
import type { Ragdoll } from './ragdoll';
import { SoldierAnimator } from './soldierAnimator';
import { makeGlowTexture } from './textures';
import type { WeaponId } from '@echo/shared/game/weapons';

// One visual per actor: a skinned soldier (players and enemies use different
// models) driven by SoldierAnimator, with the weapon held in the body frame
// so recoil and swaps are trivial and the hands follow via IK. Falls back to
// a primitive figure when the asset pack failed to load.
//
// Body frame: +X forward (aim), +Y up, +Z the soldier's right.

export interface ActorView {
  kind: 'player' | 'enemy';
  x: number;
  z: number;
  ang: number;
  hp: number;
  alive: boolean;
  weapon: WeaponId;
  buffs?: { damage: number; speed: number; rapid: number };
  shield?: number;
  /** Crouched soldiers are drawn lower (others can tell they are sneaking). */
  crouched?: boolean;
  /** Co-op: knocked down, drawn low to the ground. */
  downed?: boolean;
  /** Guard type: heavies are drawn bigger. */
  role?: string;
}

interface HoldSpec {
  /** Right hand (= weapon origin) in the body frame. */
  grip: [number, number, number];
  /** Left hand, metres forward of the grip along the gun. */
  fore: number;
}

const HOLD: Record<WeaponId, HoldSpec> = {
  pistol: { grip: [0.5, 1.3, 0.06], fore: 0.02 },
  smg: { grip: [0.22, 1.24, 0.15], fore: 0.27 },
  shotgun: { grip: [0.16, 1.24, 0.15], fore: 0.44 },
  rifle: { grip: [0.2, 1.24, 0.15], fore: 0.38 },
  sniper: { grip: [0.2, 1.24, 0.15], fore: 0.42 },
  lmg: { grip: [0.2, 1.22, 0.15], fore: 0.44 },
  silenced: { grip: [0.5, 1.3, 0.06], fore: 0.02 },
  knife: { grip: [0.45, 1.15, 0.12], fore: 0.02 },
  flamer: { grip: [0.18, 1.2, 0.15], fore: 0.4 },
};

const DEATH_TIME = 0.45;
const DEFAULT_DEATH_POWER = 3.5;
const FLASH_TIME = 0.06;

const _vel = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _glow = new THREE.Color();

let glowTex: THREE.Texture | null = null;
let blobGeo: THREE.BufferGeometry | null = null;
let blobMat: THREE.MeshBasicMaterial | null = null;

function blobShadow(): THREE.Mesh {
  if (!blobGeo) {
    blobGeo = new THREE.CircleGeometry(0.6, 20);
    blobGeo.rotateX(-Math.PI / 2);
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const ctx = cv.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(0,0,0,0.75)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    blobMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false });
  }
  const m = new THREE.Mesh(blobGeo, blobMat!);
  m.position.y = 0.02;
  m.renderOrder = 1;
  return m;
}

export class ActorVisual {
  /** Hiding in a bush: enemies only see it up close. */
  concealed = false;
  readonly group = new THREE.Group();
  readonly bodyGroup = new THREE.Group();
  /** Muzzle point (child of the weapon holder). */
  readonly muzzle = new THREE.Object3D();

  private fallPivot = new THREE.Group();
  private weaponHolder = new THREE.Group();
  private weaponModel: THREE.Object3D | null = null;
  private currentWeapon: WeaponId | null = null;
  private animator: SoldierAnimator | null = null;
  private materials: THREE.MeshStandardMaterial[] = [];
  private baseColors: THREE.Color[] = [];
  private flash: THREE.Mesh;
  private flashMaterial: THREE.MeshBasicMaterial;
  private ring: THREE.Mesh;
  private ringMaterial: THREE.MeshBasicMaterial;
  private get ringOpacity(): number {
    return this.isPlayer ? 0.55 : 0.4;
  }
  private revealAlpha = 1;
  private ragdoll: Ragdoll | null = null;
  private deathDir = new THREE.Vector3();
  private deathPower = DEFAULT_DEATH_POWER;
  /** Seconds the last impulse hint stays valid (it may arrive before the death). */
  private deathHintT = 0;
  private weaponMaterials: THREE.Material[] = [];
  private gripR = new THREE.Vector3();
  private gripL = new THREE.Vector3();

  private flashTimer = 0;
  private kick = 0;
  private flinch = 0;
  private hitGlow = 0;
  private dead = false;
  private deathT = 0;
  private prevX = NaN;
  private prevZ = NaN;
  private velX = 0;
  private velZ = 0;
  private prevHp = -1;

  constructor(public readonly actorId: number, color: number, readonly isPlayer: boolean) {
    // Chunkier than life so soldiers read from the top-down camera.
    this.bodyGroup.scale.setScalar(1.15);
    this.group.add(blobShadow());
    this.group.add(this.bodyGroup);
    this.bodyGroup.add(this.fallPivot);
    this.fallPivot.add(this.weaponHolder);
    this.weaponHolder.add(this.muzzle);

    const model = assets.character(isPlayer ? 'player' : 'enemy');
    if (model) {
      this.fallPivot.add(model);
      model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        // Per-instance materials: hit flashes and death darkening are per actor.
        const src = mesh.material as THREE.MeshStandardMaterial;
        const mat = src.clone();
        if (isPlayer) mat.color.lerp(new THREE.Color(color), 0.18);
        // Always transparent so fog-of-war fades never swap shader programs.
        mat.transparent = true;
        mesh.material = mat;
        this.materials.push(mat);
        this.baseColors.push(mat.color.clone());
      });
      const animator = new SoldierAnimator(model, this.bodyGroup);
      if (animator.ok) this.animator = animator;
    } else {
      this.buildFallback(color, isPlayer);
    }

    if (!glowTex) glowTex = makeGlowTexture();
    this.flashMaterial = new THREE.MeshBasicMaterial({
      map: glowTex,
      color: 0xffe2a8,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0,
    });
    const flashGeo = new THREE.PlaneGeometry(1.1, 0.55);
    flashGeo.rotateX(-Math.PI / 2);
    this.flash = new THREE.Mesh(flashGeo, this.flashMaterial);
    this.flash.position.x = 0.4;
    this.flash.renderOrder = 6;
    this.flash.visible = false;
    this.muzzle.add(this.flash);

    // Team ring under the feet: teal/orange for players, red for enemies.
    this.ringMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: this.ringOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ringGeo = new THREE.RingGeometry(0.62, 0.72, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(ringGeo, this.ringMaterial);
    this.ring.position.y = 0.03;
    this.ring.renderOrder = 2;
    this.group.add(this.ring);
  }

  triggerFlash(): void {
    this.flashTimer = FLASH_TIME;
    this.kick = 1;
  }

  /**
   * Fog of war: 0 = hidden (not drawn), 1 = fully visible. Enemy materials
   * are created transparent once so fading never changes shader programs.
   */
  setRevealed(alpha: number): void {
    this.group.visible = alpha > 0.01;
    if (alpha === this.revealAlpha) return;
    this.revealAlpha = alpha;
    for (const m of this.materials) m.opacity = alpha;
    for (const m of this.weaponMaterials) m.opacity = alpha;
    this.ringMaterial.opacity = this.dead ? 0 : this.ringOpacity * alpha;
  }

  get alive(): boolean {
    return !this.dead;
  }

  /** 0 standing … 1 fully crouched, eased. */
  private crouch = 0;

  update(actor: ActorView, dt: number): void {
    const low = !actor.alive ? 0 : actor.downed ? 2.5 : actor.crouched ? 1 : 0;
    this.crouch += (low - this.crouch) * Math.min(1, dt * 10);
    const big = actor.role === 'boss' ? 1.4 : actor.role === 'heavy' ? 1.15 : 1;
    this.bodyGroup.scale.set(big, big * (1 - 0.22 * this.crouch), big);
    // Velocity from positions works for local, simulated and interpolated actors.
    if (Number.isNaN(this.prevX) || dt <= 0) {
      this.prevX = actor.x;
      this.prevZ = actor.z;
    }
    const k = Math.min(1, dt * 14);
    if (dt > 0) {
      const ix = (actor.x - this.prevX) / dt;
      const iz = (actor.z - this.prevZ) / dt;
      // Teleports (respawn) should not read as a sprint.
      if (Math.hypot(ix, iz) < 30) {
        this.velX += (ix - this.velX) * k;
        this.velZ += (iz - this.velZ) * k;
      }
    }
    this.prevX = actor.x;
    this.prevZ = actor.z;

    this.group.position.set(actor.x, 0, actor.z);
    this.bodyGroup.rotation.y = -actor.ang;

    if (this.prevHp >= 0 && actor.hp < this.prevHp - 0.01 && actor.alive) {
      this.flinch = 1;
      this.hitGlow = 1;
    }
    this.prevHp = actor.hp;
    this.flinch = Math.max(0, this.flinch - dt * 5);
    if (!this.dead) this.deathHintT = Math.max(0, this.deathHintT - dt);
    this.hitGlow = Math.max(0, this.hitGlow - dt * 7);
    this.kick = Math.max(0, this.kick - dt * 9);

    this.setWeapon(actor.weapon);

    if (actor.alive) {
      if (this.dead) this.revive();
      this.updateAlive(actor, dt);
    } else {
      if (!this.dead) this.die(actor);
      if (this.ragdoll && this.animator) {
        if (!this.ragdoll.asleep) {
          this.ragdoll.step(dt);
          this.animator.applyRagdoll(this.ragdoll);
        }
      } else {
        // No usable rig: simple scripted fall.
        this.deathT = Math.min(DEATH_TIME, this.deathT + dt);
        const t = this.deathT / DEATH_TIME;
        const e = t * t * (3 - 2 * t);
        this.fallPivot.rotation.z = (Math.PI / 2) * e;
        this.fallPivot.position.y = 0.14 * e;
      }
    }

    // Status glow: hit flash, spawn shield (blue pulse), buffs.
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.012);
    _glow.setRGB(this.hitGlow * 0.9, this.hitGlow * 0.25, this.hitGlow * 0.2);
    if (actor.alive) {
      if ((actor.shield ?? 0) > 0) _glow.r += 0.05 * pulse, _glow.g += 0.25 * pulse, _glow.b += 0.6 * pulse;
      const b = actor.buffs;
      if (b) {
        if (b.damage > 0) _glow.r += 0.35 * pulse;
        if (b.speed > 0) (_glow.r += 0.22 * pulse), (_glow.g += 0.2 * pulse);
        if (b.rapid > 0) (_glow.r += 0.25 * pulse), (_glow.g += 0.1 * pulse);
      }
    }
    for (let i = 0; i < this.materials.length; i++) {
      const m = this.materials[i];
      m.emissive.copy(_glow);
      m.color.copy(this.baseColors[i]).multiplyScalar(this.dead ? 0.45 : 1);
    }

    this.ringMaterial.opacity = actor.alive ? this.ringOpacity * this.revealAlpha : 0;

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      const f = Math.max(0, this.flashTimer / FLASH_TIME);
      this.flashMaterial.opacity = f;
      this.flash.scale.set(0.8 + (1 - f) * 0.6, 1, 0.8 + Math.random() * 0.5);
      this.flash.rotation.y = (Math.random() - 0.5) * 0.3;
      this.flash.visible = true;
    } else {
      this.flash.visible = false;
    }
  }

  private updateAlive(actor: ActorView, dt: number): void {
    const hold = HOLD[actor.weapon];
    const recoil = this.kick * this.kick;
    this.weaponHolder.position.set(hold.grip[0] - recoil * 0.09, hold.grip[1] + recoil * 0.02, hold.grip[2]);
    this.weaponHolder.rotation.z = recoil * 0.12;

    if (!this.animator) {
      const bob = Math.hypot(this.velX, this.velZ) > 0.5 ? Math.sin(performance.now() * 0.016) * 0.035 : 0;
      this.fallPivot.position.y = bob;
      return;
    }

    const c = Math.cos(actor.ang);
    const s = Math.sin(actor.ang);
    const fwd = this.velX * c + this.velZ * s;
    const side = -this.velX * s + this.velZ * c;
    const speed = Math.hypot(this.velX, this.velZ);

    this.group.updateMatrixWorld(true);
    this.weaponHolder.getWorldPosition(this.gripR);
    this.weaponHolder.getWorldQuaternion(_q);
    this.gripL.set(hold.fore, -0.03, actor.weapon === 'pistol' ? -0.05 : 0).applyQuaternion(_q).add(this.gripR);

    this.bodyGroup.getWorldQuaternion(_q);
    const poleR = _vel.set(-0.4, -1, 0.9).normalize().applyQuaternion(_q);
    const poleL = _pole.set(0.1, -1, -0.8).normalize().applyQuaternion(_q);

    this.animator.update(dt, {
      fwd, side, speed,
      gripR: this.gripR, gripL: this.gripL,
      poleR, poleL,
      flinch: this.flinch,
    });
    this.fallPivot.position.y = this.animator.bob;
  }

  /**
   * Direction (world XZ, any length) and strength of the killing blow; the
   * ragdoll is launched with it. Without a hint the body falls backwards.
   */
  setDeathImpulse(dx: number, dz: number, power: number): void {
    const l = Math.hypot(dx, dz) || 1;
    this.deathDir.set(dx / l, 0, dz / l);
    this.deathPower = power;
    this.deathHintT = 0.3;
  }

  /** Explosion nearby: launches a corpse, or primes the impulse for a death. */
  blast(x: number, z: number, radius: number): void {
    const dx = this.group.position.x - x;
    const dz = this.group.position.z - z;
    const d = Math.hypot(dx, dz);
    if (d > radius) return;
    const power = 10 * (1 - d / radius) + 3;
    if (this.ragdoll) {
      const l = d || 1;
      this.ragdoll.push((dx / l) * power, power * 0.6, (dz / l) * power);
    } else {
      this.setDeathImpulse(dx, dz, power);
    }
  }

  private die(actor: ActorView): void {
    this.dead = true;
    this.deathT = 0;
    this.weaponHolder.visible = false;
    this.flash.visible = false;
    if (this.deathHintT <= 0) this.deathDir.set(-Math.cos(actor.ang), 0, -Math.sin(actor.ang));
    const dir = this.deathDir;
    const power = this.deathPower;
    const vx = this.velX;
    const vz = this.velZ;
    // Upper body takes the hit, legs mostly keep the body's own momentum.
    this.ragdoll =
      this.animator?.createRagdoll((joint, _p, out) => {
        const upper = joint === 'head' || joint === 'spine2' || joint.startsWith('arm') || joint.startsWith('fore') || joint.startsWith('hand');
        const k = upper ? 1 : joint === 'hips' ? 0.55 : 0.25;
        out.set(vx * 0.6 + dir.x * power * k, (upper ? 0.6 : 0.2) * power * 0.35, vz * 0.6 + dir.z * power * k);
        out.x += (Math.random() - 0.5) * 0.8;
        out.z += (Math.random() - 0.5) * 0.8;
      }) ?? null;
    this.deathHintT = 0;
    this.deathPower = DEFAULT_DEATH_POWER;
  }

  private revive(): void {
    this.dead = false;
    this.deathT = 0;
    this.ragdoll = null;
    this.fallPivot.rotation.set(0, 0, 0);
    this.fallPivot.position.set(0, 0, 0);
    this.fallPivot.scale.set(1, 1, 1);
    this.weaponHolder.visible = true;
  }

  private setWeapon(id: WeaponId): void {
    if (id === this.currentWeapon) return;
    this.currentWeapon = id;
    if (this.weaponModel) {
      this.weaponHolder.remove(this.weaponModel);
      this.weaponModel = null;
    }
    const w = assets.weapon(id);
    let length: number;
    let grip: number;
    if (w) {
      this.weaponModel = w.model;
      length = w.length;
      grip = w.grip;
    } else if (id === 'knife') {
      // Knife: a pale blade on a dark grip.
      const g = new THREE.Group();
      const blade = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.04, 0.012),
        new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.25, metalness: 0.9 }),
      );
      blade.position.set(0.15, 0, 0);
      const hilt = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.035, 0.03), new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.8 }));
      g.add(blade, hilt);
      this.weaponModel = g;
      length = 0.26;
      grip = 0.05;
    } else if (id === 'flamer') {
      // Flamethrower: a long tube over a fuel tank, a pilot flame at the nozzle.
      const g = new THREE.Group();
      const metal = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.5, metalness: 0.7 });
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.8, 10), metal);
      tube.rotation.z = Math.PI / 2;
      tube.position.set(0.2, 0.04, 0);
      const tank = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 0.32, 12),
        new THREE.MeshStandardMaterial({ color: 0x8a2a1a, roughness: 0.55, metalness: 0.4 }),
      );
      tank.rotation.z = Math.PI / 2;
      tank.position.set(0.12, -0.06, 0);
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.035, 0.08, 10), metal);
      nozzle.rotation.z = Math.PI / 2;
      nozzle.position.set(0.62, 0.04, 0);
      const pilot = new THREE.Mesh(
        new THREE.SphereGeometry(0.025, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0xff7a20, emissive: 0xff6a10, emissiveIntensity: 2 }),
      );
      pilot.position.set(0.67, 0.0, 0);
      g.add(tube, tank, nozzle, pilot);
      g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
      this.weaponModel = g;
      length = 0.9;
      grip = 0.25;
    } else {
      // Pistol (no source model) and fallback; a silencer on the silenced one.
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0x23262d, roughness: 0.45, metalness: 0.6 });
      const slide = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.07, 0.05), mat);
      slide.position.set(0.07, 0.05, 0);
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.13, 0.045), mat);
      handle.position.set(0, -0.03, 0);
      handle.rotation.z = 0.25;
      g.add(slide, handle);
      length = 0.26;
      if (id === 'silenced') {
        const can = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.16, 10), mat);
        can.rotation.z = Math.PI / 2;
        can.position.set(0.27, 0.05, 0);
        g.add(can);
        length = 0.36;
      }
      g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
      this.weaponModel = g;
      grip = 0.27;
    }
    // Soldiers fade with the fog of war, so the gun needs its own materials.
    for (const m of this.weaponMaterials) m.dispose();
    this.weaponMaterials = [];
    this.weaponModel.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = (mesh.material as THREE.Material).clone();
      mat.transparent = true;
      mat.opacity = this.revealAlpha;
      mesh.material = mat;
      this.weaponMaterials.push(mat);
    });
    this.weaponHolder.add(this.weaponModel);
    this.muzzle.position.set(length * (1 - grip), 0.04, 0);
  }

  private buildFallback(color: number, isPlayer: boolean): void {
    const body = new THREE.MeshStandardMaterial({ color: isPlayer ? color : 0x5a2530, roughness: 0.72 });
    this.materials.push(body);
    this.baseColors.push(body.color.clone());
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.5, 4, 12), body);
    torso.position.y = 0.95;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 12), body);
    head.position.y = 1.55;
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.6, 0.45), body);
    legs.position.y = 0.3;
    for (const m of [torso, head, legs]) {
      m.castShadow = true;
      this.fallPivot.add(m);
    }
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    for (const m of this.weaponMaterials) m.dispose();
    this.flashMaterial.dispose();
    this.ringMaterial.dispose();
  }
}
