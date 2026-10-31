import * as THREE from 'three';
import { RAGDOLL_JOINTS, Ragdoll, type RagdollJoint } from './ragdoll';

// Procedural animation for any Mixamo-style humanoid, no clips needed (the
// source models ship in a bind pose only). Ported in spirit from frontline's
// SoldierAnimator: every frame starts from the rest pose and layers
//   1. gait — thighs swing along the movement direction, knees lift on the
//      forward swing, the pelvis bobs; amplitude follows speed;
//   2. stance — slight forward lean when running, flinch when hit;
//   3. arms — two-bone IK puts the hands on the weapon's grip points, so
//      recoil and weapon swaps just work.
// Everything is expressed with positions and world-space rotations, never a
// rig's bone-axis convention, so any skeleton with the usual names works.

type BoneKey =
  | 'hips' | 'spine' | 'spine1' | 'spine2' | 'neck' | 'head'
  | 'armL' | 'foreL' | 'handL' | 'armR' | 'foreR' | 'handR'
  | 'thighL' | 'shinL' | 'footL' | 'thighR' | 'shinR' | 'footR';

const BONE_PATTERNS: Record<BoneKey, RegExp> = {
  hips: /Hips(_\d+)?$/,
  spine: /Spine(_\d+)?$/,
  spine1: /Spine1(_\d+)?$/,
  spine2: /Spine2(_\d+)?$/,
  neck: /Neck(_\d+)?$/,
  head: /Head(_\d+)?$/,
  armL: /LeftArm(_\d+)?$/,
  foreL: /LeftForeArm(_\d+)?$/,
  handL: /LeftHand(_\d+)?$/,
  armR: /RightArm(_\d+)?$/,
  foreR: /RightForeArm(_\d+)?$/,
  handR: /RightHand(_\d+)?$/,
  thighL: /LeftUpLeg(_\d+)?$/,
  shinL: /LeftLeg(_\d+)?$/,
  footL: /LeftFoot(_\d+)?$/,
  thighR: /RightUpLeg(_\d+)?$/,
  shinR: /RightLeg(_\d+)?$/,
  footR: /RightFoot(_\d+)?$/,
};

/** Metres travelled per full gait cycle (two steps). */
const STRIDE = 1.9;
const UP = new THREE.Vector3(0, 1, 0);

const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _shoulder = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _wrist = new THREE.Vector3();

export interface AnimInput {
  /** Velocity in the body's frame: x = forward, z = right. m/s. */
  fwd: number;
  side: number;
  speed: number;
  /** World positions the hands should reach (null = leave arm at rest). */
  gripR: THREE.Vector3 | null;
  gripL: THREE.Vector3 | null;
  /** Elbow hint directions in world space. */
  poleR: THREE.Vector3;
  poleL: THREE.Vector3;
  /** 0..1, decays: hit reaction. */
  flinch: number;
}

export class SoldierAnimator {
  readonly ok: boolean;
  private bones: Partial<Record<BoneKey, THREE.Bone>> = {};
  private rest = new Map<THREE.Bone, THREE.Quaternion>();
  private phase = 0;
  private gait = 0;
  private lenUpperR = 0.3;
  private lenLowerR = 0.28;
  private lenUpperL = 0.3;
  private lenLowerL = 0.28;
  /** Vertical body offset for this frame, metres. */
  bob = 0;

  /** Rest positions of the torso joints in the frame (root.parent) space. */
  private restTorso: Record<'hips' | 'spine2' | 'thighL' | 'thighR', THREE.Vector3> | null = null;

  constructor(private readonly root: THREE.Object3D, private readonly body: THREE.Object3D) {
    root.traverse((o) => {
      if (!(o as THREE.Bone).isBone) return;
      const bone = o as THREE.Bone;
      for (const key of Object.keys(BONE_PATTERNS) as BoneKey[]) {
        if (!this.bones[key] && BONE_PATTERNS[key].test(bone.name)) this.bones[key] = bone;
      }
    });
    const b = this.bones;
    this.ok = !!(b.hips && b.armL && b.foreL && b.handL && b.armR && b.foreR && b.handR && b.thighL && b.shinL && b.thighR && b.shinR);
    if (!this.ok) return;

    for (const bone of Object.values(b)) this.rest.set(bone!, bone!.quaternion.clone());

    const frame = root.parent;
    if (frame) {
      frame.updateWorldMatrix(true, true);
      const local = (k: BoneKey) => frame.worldToLocal(this.bones[k]!.getWorldPosition(new THREE.Vector3()));
      const chest = this.bones.spine2 ? 'spine2' : this.bones.spine1 ? 'spine1' : 'spine';
      if (this.bones[chest]) {
        this.restTorso = { hips: local('hips'), spine2: local(chest), thighL: local('thighL'), thighR: local('thighR') };
      }
    }
    root.updateMatrixWorld(true);
    this.lenUpperR = dist(b.armR!, b.foreR!);
    this.lenLowerR = dist(b.foreR!, b.handR!);
    this.lenUpperL = dist(b.armL!, b.foreL!);
    this.lenLowerL = dist(b.foreL!, b.handL!);
  }

  update(dt: number, input: AnimInput): void {
    if (!this.ok) return;
    const b = this.bones;
    for (const [bone, q] of this.rest) bone.quaternion.copy(q);

    // ---- gait
    const targetGait = Math.min(1, input.speed / 6);
    this.gait += (targetGait - this.gait) * Math.min(1, dt * 10);
    this.phase = (this.phase + (input.speed * dt) / STRIDE) % 1;
    const g = this.gait;
    const s = Math.sin(this.phase * Math.PI * 2);
    const c = Math.cos(this.phase * Math.PI * 2);

    // Direction of travel in the body frame (x fwd, z right); default forward.
    let dx = 1;
    let dz = 0;
    if (input.speed > 0.2) {
      dx = input.fwd / input.speed;
      dz = input.side / input.speed;
    }
    // Rotating a downward leg about (d x up) swings the foot toward d.
    const swingAxis = this.bodyAxis(-dz, 0, dx, _axis);
    const swing = 0.62 * g;
    this.rotateWorld(b.thighL!, swingAxis, swing * s);
    this.rotateWorld(b.thighR!, swingAxis, -swing * s);
    // Knees bend backward (about the body's right axis) on the forward swing.
    const kneeAxis = this.bodyAxis(0, 0, 1, _v4);
    this.rotateWorld(b.shinL!, kneeAxis, -(0.15 + 1.0 * Math.max(0, c)) * g);
    this.rotateWorld(b.shinR!, kneeAxis, -(0.15 + 1.0 * Math.max(0, -c)) * g);
    if (b.footL) this.rotateWorld(b.footL, kneeAxis, 0.3 * Math.max(0, c) * g);
    if (b.footR) this.rotateWorld(b.footR, kneeAxis, 0.3 * Math.max(0, -c) * g);

    // Pelvis: double-frequency bob (applied by the owner to the model root,
    // since armature axes vary) and a twist over the standing leg.
    this.bob = -Math.abs(c) * 0.05 * g;
    const hipYaw = this.bodyAxis(0, 1, 0, _v3);
    this.rotateWorld(b.hips!, hipYaw, 0.12 * s * g);

    // ---- stance: lean into the run, flinch backwards when hit.
    const lean = 0.14 * g * dx - input.flinch * 0.35;
    const leanAxis = this.bodyAxis(0, 0, -1, _v3);
    if (b.spine) this.rotateWorld(b.spine, leanAxis, lean * 0.5);
    if (b.spine1) this.rotateWorld(b.spine1, leanAxis, lean * 0.5);
    if (b.spine) this.rotateWorld(b.spine, this.bodyAxis(0, 1, 0, _v3), -0.12 * s * g);

    // ---- arms
    this.root.updateMatrixWorld(true);
    if (input.gripR) this.solveArm(b.armR!, b.foreR!, b.handR!, this.lenUpperR, this.lenLowerR, input.gripR, input.poleR);
    if (input.gripL) this.solveArm(b.armL!, b.foreL!, b.handL!, this.lenUpperL, this.lenLowerL, input.gripL, input.poleL);
  }

  // ------------------------------------------------------------- ragdoll

  private jointBone(j: RagdollJoint): THREE.Bone | undefined {
    const b = this.bones;
    if (j === 'spine2') return b.spine2 ?? b.spine1 ?? b.spine;
    if (j === 'head') return b.head ?? b.neck;
    return b[j as BoneKey];
  }

  /**
   * Builds a ragdoll from the current pose. `vel(i, out)` fills each joint's
   * starting velocity. Null when the rig lacks the needed bones.
   */
  createRagdoll(vel: (joint: RagdollJoint, pos: THREE.Vector3, out: THREE.Vector3) => void): Ragdoll | null {
    if (!this.ok || !this.restTorso) return null;
    this.root.updateMatrixWorld(true);
    const pts: THREE.Vector3[] = [];
    const vels: THREE.Vector3[] = [];
    for (const j of RAGDOLL_JOINTS) {
      const bone = this.jointBone(j);
      if (!bone) return null;
      const p = bone.getWorldPosition(new THREE.Vector3());
      pts.push(p);
      const v = new THREE.Vector3();
      vel(j, p, v);
      vels.push(v);
    }
    return new Ragdoll(pts, vels);
  }

  /**
   * Poses the skeleton from ragdoll particles: the model frame is placed so
   * the pelvis and torso match, then each limb bone is aimed at the next joint.
   */
  applyRagdoll(rag: Ragdoll): void {
    const rest = this.restTorso;
    const frame = this.root.parent;
    if (!rest || !frame || !frame.parent) return;
    for (const [bone, q] of this.rest) bone.quaternion.copy(q);

    const P = (j: RagdollJoint) => rag.pos[Ragdoll.index(j)];
    basis(P('hips'), P('spine2'), P('thighL'), P('thighR'), _mCur);
    basis(rest.hips, rest.spine2, rest.thighL, rest.thighR, _mRest);
    // R = Bcur * Brest^T; world scale is the frame's current one.
    _mRot.multiplyMatrices(_mCur, _mRest.transpose());
    frame.getWorldScale(_scale);
    _q.setFromRotationMatrix(_mRot);
    _v1.copy(rest.hips).multiply(_scale).applyQuaternion(_q);
    _v2.copy(P('hips')).sub(_v1);
    _mWorld.compose(_v2, _q, _scale);
    _mLocal.copy(frame.parent.matrixWorld).invert().multiply(_mWorld);
    _mLocal.decompose(frame.position, frame.quaternion, frame.scale);
    frame.updateMatrixWorld(true);

    const b = this.bones;
    const aim = (bone: THREE.Bone | undefined, child: THREE.Bone | undefined, j: RagdollJoint) => {
      if (bone && child) this.aimBone(bone, child, P(j));
    };
    aim(b.neck, b.head, 'head');
    aim(b.armL, b.foreL, 'foreL');
    aim(b.foreL, b.handL, 'handL');
    aim(b.armR, b.foreR, 'foreR');
    aim(b.foreR, b.handR, 'handR');
    aim(b.thighL, b.shinL, 'shinL');
    aim(b.shinL, b.footL, 'footL');
    aim(b.thighR, b.shinR, 'shinR');
    aim(b.shinR, b.footR, 'footR');
  }

  /** Bone's world position (after the current pose). */
  bonePosition(key: BoneKey, out: THREE.Vector3): THREE.Vector3 | null {
    const bone = this.bones[key];
    return bone ? bone.getWorldPosition(out) : null;
  }

  // ------------------------------------------------------------- helpers

  /** A body-frame direction (x fwd, y up, z right) as a world vector. */
  private bodyAxis(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    out.set(x, y, z).normalize();
    this.body.getWorldQuaternion(_qa);
    return out.applyQuaternion(_qa);
  }

  /** Pre-multiplies a world-space rotation onto the bone's current pose. */
  private rotateWorld(bone: THREE.Object3D, axisWorld: THREE.Vector3, angle: number): void {
    if (Math.abs(angle) < 1e-5) return;
    _q.setFromAxisAngle(axisWorld, angle);
    this.applyWorldRotation(bone, _q);
  }

  private applyWorldRotation(bone: THREE.Object3D, rot: THREE.Quaternion): void {
    const parent = bone.parent;
    if (parent) parent.getWorldQuaternion(_qp);
    else _qp.identity();
    // local' = P^-1 * R * P * local
    const local = bone.quaternion;
    _qa.copy(_qp).invert().multiply(rot).multiply(_qp);
    local.premultiply(_qa);
    bone.updateMatrixWorld(true);
  }

  /** Rotates `bone` so the direction to `child` points at `target`. */
  private aimBone(bone: THREE.Object3D, child: THREE.Object3D, target: THREE.Vector3): void {
    bone.getWorldPosition(_v1);
    child.getWorldPosition(_v2);
    const from = _v2.sub(_v1).normalize();
    const to = _v3.copy(target).sub(_v1).normalize();
    _q.setFromUnitVectors(from, to);
    this.applyWorldRotation(bone, _q);
  }

  private solveArm(
    upper: THREE.Bone,
    lower: THREE.Bone,
    hand: THREE.Bone,
    l1: number,
    l2: number,
    target: THREE.Vector3,
    pole: THREE.Vector3,
  ): void {
    const shoulder = upper.getWorldPosition(_shoulder);
    const toTarget = _v4.copy(target).sub(shoulder);
    let d = toTarget.length();
    const maxReach = (l1 + l2) * 0.999;
    d = Math.min(Math.max(d, Math.abs(l1 - l2) + 1e-3), maxReach);
    const dir = toTarget.normalize();
    // Law of cosines: distance along dir to the elbow's projection, and its offset.
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const bend = _axis.copy(pole).addScaledVector(dir, -pole.dot(dir));
    if (bend.lengthSq() < 1e-6) bend.copy(UP);
    bend.normalize();
    const elbow = _elbow.copy(shoulder).addScaledVector(dir, a).addScaledVector(bend, h);
    const wrist = _wrist.copy(shoulder).addScaledVector(dir, d);
    this.aimBone(upper, lower, elbow);
    this.aimBone(lower, hand, wrist);
  }
}

const _mCur = new THREE.Matrix4();
const _mRest = new THREE.Matrix4();
const _mRot = new THREE.Matrix4();
const _mWorld = new THREE.Matrix4();
const _mLocal = new THREE.Matrix4();
const _scale = new THREE.Vector3();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();

/** Orthonormal torso frame: y = pelvis -> chest, x = left -> right hip. */
function basis(hips: THREE.Vector3, chest: THREE.Vector3, thighL: THREE.Vector3, thighR: THREE.Vector3, out: THREE.Matrix4): void {
  _by.copy(chest).sub(hips).normalize();
  _bx.copy(thighR).sub(thighL);
  _bx.addScaledVector(_by, -_bx.dot(_by)).normalize();
  _bz.crossVectors(_bx, _by);
  out.makeBasis(_bx, _by, _bz);
}

function dist(a: THREE.Object3D, b: THREE.Object3D): number {
  return a.getWorldPosition(_v1).distanceTo(b.getWorldPosition(_v2));
}
