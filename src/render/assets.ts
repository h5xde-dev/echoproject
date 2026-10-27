import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { PropKind } from '../game/types';
import type { WeaponId } from '../game/weapons';

// Models come from tools/build-assets.mjs (public/assets). Every source model
// has its own scale and axes, so each one is normalised here once, at load:
// characters face +X and stand 1.8 m tall, weapons point their muzzle at +X
// with the grip at the origin, props fill their collision box. Everything the
// game spawns is a cheap clone of those templates. If loading fails the game
// keeps its primitive fallbacks, so assets are an enhancement, not a hard
// dependency.

const BASE = `${import.meta.env.BASE_URL}assets/`;

export type CharacterKind = 'player' | 'enemy';

interface WeaponSpec {
  file: string;
  /** Length of the gun along X, metres. */
  length: number;
  /** Euler applied to the raw model before measuring (radians). */
  rot: [number, number, number];
  /** Where the hand grips the gun, as a fraction of its length from the stock. */
  grip: number;
}

const WEAPON_SPECS: Partial<Record<WeaponId, WeaponSpec>> = {
  smg: { file: 'w_smg', length: 0.72, rot: [0, Math.PI / 2, 0], grip: 0.32 },
  shotgun: { file: 'w_shotgun', length: 0.95, rot: [0, Math.PI / 2, 0], grip: 0.1 },
  rifle: { file: 'w_rifle', length: 1.0, rot: [0, 0, 0], grip: 0.25 },
  sniper: { file: 'w_sniper', length: 1.15, rot: [0, Math.PI, 0], grip: 0.36 },
  // The rifle model, longer: reads as a heavier gun.
  lmg: { file: 'w_rifle', length: 1.2, rot: [0, 0, 0], grip: 0.25 },
};

interface PropSpec {
  file: string;
  /** Rotation about Y applied before fitting, so the long side lies along X. */
  rotY: number;
  height: number;
}

const PROP_SPECS: Partial<Record<PropKind, PropSpec>> = {
  crate: { file: 'p_crate', rotY: 0, height: 1.4 },
  barrel: { file: 'p_barrel', rotY: 0, height: 1.3 },
  cover: { file: 'p_cover', rotY: 0, height: 1.15 },
  table: { file: 'p_table', rotY: 0, height: 0.85 },
  chair: { file: 'p_chair', rotY: 0, height: 0.95 },
  car: { file: 'p_car', rotY: Math.PI / 2, height: 1.45 },
  pallet: { file: 'p_pallet', rotY: 0, height: 1.25 },
  drum: { file: 'p_drum', rotY: 0, height: 1.0 },
  cabinet: { file: 'p_cabinet', rotY: 0, height: 1.7 },
  tires: { file: 'p_tires', rotY: 0, height: 0.9 },
  ammo: { file: 'p_ammo', rotY: 0, height: 0.5 },
};

export class GameAssets {
  ready = false;
  private characters = new Map<CharacterKind, THREE.Object3D>();
  private weapons = new Map<WeaponId, { model: THREE.Object3D; length: number; grip: number }>();
  private props = new Map<PropKind, THREE.Object3D>();
  readonly textures: {
    floor?: THREE.Texture;
    floorNormal?: THREE.Texture;
    wall?: THREE.Texture;
  } = {};
  readonly sounds = new Map<string, ArrayBuffer>();

  async load(onProgress?: (fraction: number) => void): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const texLoader = new THREE.TextureLoader();

    const jobs: (() => Promise<void>)[] = [];

    jobs.push(async () => {
      this.characters.set('player', normaliseCharacter((await loader.loadAsync(`${BASE}soldier.glb`)).scene));
    });
    jobs.push(async () => {
      this.characters.set('enemy', normaliseCharacter((await loader.loadAsync(`${BASE}enemy.glb`)).scene));
    });
    for (const [id, spec] of Object.entries(WEAPON_SPECS) as [WeaponId, WeaponSpec][]) {
      jobs.push(async () => {
        const gltf = await loader.loadAsync(`${BASE}${spec.file}.glb`);
        this.weapons.set(id, { model: normaliseWeapon(gltf.scene, spec), length: spec.length, grip: spec.grip });
      });
    }
    for (const [kind, spec] of Object.entries(PROP_SPECS) as [PropKind, PropSpec][]) {
      jobs.push(async () => {
        const gltf = await loader.loadAsync(`${BASE}${spec.file}.glb`);
        this.props.set(kind, prepareProp(gltf.scene, spec));
      });
    }
    const tex = (name: string, srgb: boolean) => async () => {
      const t = await texLoader.loadAsync(`${BASE}${name}.webp`);
      // Mirrored repeat: the scans are not tileable, mirroring hides the seams.
      t.wrapS = THREE.MirroredRepeatWrapping;
      t.wrapT = THREE.MirroredRepeatWrapping;
      t.anisotropy = 8;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    jobs.push(async () => void (this.textures.floor = await tex('floor', true)()));
    jobs.push(async () => void (this.textures.floorNormal = await tex('floor_n', false)()));
    jobs.push(async () => void (this.textures.wall = await tex('wall', true)()));
    for (const name of SOUND_NAMES) {
      jobs.push(async () => {
        const res = await fetch(`${BASE}sfx/${name}.mp3`);
        if (res.ok) this.sounds.set(name, await res.arrayBuffer());
      });
    }

    let done = 0;
    const results = await Promise.allSettled(
      jobs.map((job) =>
        job().finally(() => {
          done++;
          onProgress?.(done / jobs.length);
        }),
      ),
    );
    for (const r of results) {
      if (r.status === 'rejected') console.warn('asset failed to load', r.reason);
    }
    this.ready = true;
  }

  /** A fresh, independently animatable character (own skeleton). */
  character(kind: CharacterKind): THREE.Object3D | null {
    const tpl = this.characters.get(kind);
    return tpl ? SkeletonUtils.clone(tpl) : null;
  }

  weapon(id: WeaponId): { model: THREE.Object3D; length: number; grip: number } | null {
    const w = this.weapons.get(id);
    return w ? { model: w.model.clone(), length: w.length, grip: w.grip } : null;
  }

  prop(kind: PropKind, sizeX: number, sizeZ: number): THREE.Object3D | null {
    const tpl = this.props.get(kind);
    if (!tpl) return null;
    const obj = tpl.clone();
    obj.scale.x *= sizeX;
    obj.scale.z *= sizeZ;
    return obj;
  }
}

export const SOUND_NAMES = [
  ...Array.from({ length: 8 }, (_, i) => `ak_shot_0${i + 1}`),
  ...Array.from({ length: 4 }, (_, i) => `ak_shot_far_0${i + 1}`),
];

export const assets = new GameAssets();

// ------------------------------------------------------------- normalisers

function forEachMesh(root: THREE.Object3D, fn: (m: THREE.Mesh) => void): void {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) fn(o as THREE.Mesh);
  });
}

/** Wraps the scene so the wrapper's transform is ours and the model's is baked under it. */
function wrap(scene: THREE.Object3D): { root: THREE.Group; inner: THREE.Group } {
  const root = new THREE.Group();
  const inner = new THREE.Group();
  inner.add(scene);
  root.add(inner);
  return { root, inner };
}

function normaliseCharacter(scene: THREE.Object3D): THREE.Object3D {
  const { root, inner } = wrap(scene);
  // Mixamo characters face +Z; the game's "forward" is +X.
  inner.rotation.y = Math.PI / 2;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner, true);
  const height = box.max.y - box.min.y;
  const s = 1.8 / Math.max(0.01, height);
  inner.scale.setScalar(s);
  root.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(inner, true);
  const c = box2.getCenter(new THREE.Vector3());
  inner.position.set(-c.x, -box2.min.y, -c.z);

  forEachMesh(root, (m) => {
    m.castShadow = true;
    m.receiveShadow = false;
    m.frustumCulled = false;
    const mat = m.material as THREE.MeshStandardMaterial;
    if (mat && 'roughness' in mat) {
      mat.roughness = Math.max(0.6, mat.roughness);
      mat.metalness = Math.min(0.2, mat.metalness);
    }
  });
  return root;
}

function normaliseWeapon(scene: THREE.Object3D, spec: WeaponSpec): THREE.Object3D {
  const { root, inner } = wrap(scene);
  inner.rotation.set(spec.rot[0], spec.rot[1], spec.rot[2]);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner, true);
  const size = box.getSize(new THREE.Vector3());
  const s = spec.length / Math.max(0.001, size.x);
  inner.scale.multiplyScalar(s);
  root.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(inner, true);
  const cy = (b.min.y + b.max.y) / 2;
  const cz = (b.min.z + b.max.z) / 2;
  // Grip at the origin: the stock end is min.x.
  inner.position.set(-(b.min.x + spec.length * spec.grip), -cy, -cz);
  forEachMesh(root, (m) => {
    m.castShadow = true;
    m.frustumCulled = false;
  });
  return root;
}

function prepareProp(scene: THREE.Object3D, spec: PropSpec): THREE.Object3D {
  // The turn sits below `inner` so the scale below acts on world X/Z; on a
  // turned `inner` it would act on the model's own axes and swap them.
  const turn = new THREE.Group();
  turn.rotation.y = spec.rotY;
  turn.add(scene);
  const { root, inner } = wrap(turn);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner, true);
  const size = box.getSize(new THREE.Vector3());
  // Unit footprint: the caller scales X/Z to the collision box.
  inner.scale.set(1 / size.x, spec.height / size.y, 1 / size.z);
  root.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(inner, true);
  const c = b.getCenter(new THREE.Vector3());
  inner.position.set(-c.x, -b.min.y, -c.z);
  forEachMesh(root, (m) => {
    m.castShadow = true;
    m.receiveShadow = true;
  });
  return root;
}
