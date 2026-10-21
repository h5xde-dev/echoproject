import * as THREE from 'three';
import { makeGlowTexture } from './textures';

const MAX_PARTICLES = 2400;

const PARTICLE_VERT = `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (320.0 / max(0.001, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FRAG = `
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  float a = t.a * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
}`;

export class Particles {
  readonly points: THREE.Points;
  private positions: Float32Array;
  private velocities: Float32Array;
  private colors: Float32Array;
  private sizes: Float32Array;
  private alphas: Float32Array;
  private lives: Float32Array;
  private maxLives: Float32Array;
  private drags: Float32Array;
  private gravities: Float32Array;
  private count = 0;

  constructor(opts: { additive?: boolean } = {}) {
    const additive = opts.additive !== false;
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.velocities = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.sizes = new Float32Array(MAX_PARTICLES);
    this.alphas = new Float32Array(MAX_PARTICLES);
    this.lives = new Float32Array(MAX_PARTICLES);
    this.maxLives = new Float32Array(MAX_PARTICLES);
    this.drags = new Float32Array(MAX_PARTICLES);
    this.gravities = new Float32Array(MAX_PARTICLES);

    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: makeGlowTexture() } },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size: number,
    color: THREE.Color,
    drag = 2.2,
    gravity = 0,
  ): void {
    let i = this.count;
    if (i >= MAX_PARTICLES) {
      // Recycle the oldest slot rather than dropping the effect.
      i = 0;
      let worst = Infinity;
      for (let j = 0; j < MAX_PARTICLES; j++) {
        if (this.lives[j] < worst) {
          worst = this.lives[j];
          i = j;
        }
      }
    } else {
      this.count++;
    }

    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.velocities[i * 3] = vx;
    this.velocities[i * 3 + 1] = vy;
    this.velocities[i * 3 + 2] = vz;
    this.colors[i * 3] = color.r;
    this.colors[i * 3 + 1] = color.g;
    this.colors[i * 3 + 2] = color.b;
    this.sizes[i] = size;
    this.alphas[i] = 1;
    this.lives[i] = life;
    this.maxLives[i] = life;
    this.drags[i] = drag;
    this.gravities[i] = gravity;
  }

  burst(
    x: number,
    y: number,
    z: number,
    amount: number,
    speed: number,
    color: THREE.Color,
    size = 0.16,
    life = 0.5,
    gravity = 0,
  ): void {
    for (let i = 0; i < amount; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.9);
      this.spawn(
        x,
        y,
        z,
        Math.cos(a) * s,
        (Math.random() - 0.2) * speed * 0.7,
        Math.sin(a) * s,
        life * (0.6 + Math.random() * 0.8),
        size * (0.6 + Math.random() * 0.9),
        color,
        3.2,
        gravity,
      );
    }
  }

  update(dt: number): void {
    let live = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.lives[i] <= 0) {
        this.alphas[i] = 0;
        continue;
      }
      this.lives[i] -= dt;
      if (this.lives[i] <= 0) {
        this.alphas[i] = 0;
        continue;
      }
      const d = Math.max(0, 1 - this.drags[i] * dt);
      this.velocities[i * 3] *= d;
      this.velocities[i * 3 + 1] = this.velocities[i * 3 + 1] * d + this.gravities[i] * dt;
      this.velocities[i * 3 + 2] *= d;
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
      if (this.positions[i * 3 + 1] < 0.05) {
        this.positions[i * 3 + 1] = 0.05;
        this.velocities[i * 3 + 1] *= -0.28;
      }
      const t = this.lives[i] / this.maxLives[i];
      this.alphas[i] = t * t;
      live = i + 1;
    }

    const geo = this.points.geometry;
    geo.setDrawRange(0, live);
    (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Expanding shockwave ring. */
export class Shockwaves {
  readonly group = new THREE.Group();
  private items: { mesh: THREE.Mesh; life: number; max: number; scale: number }[] = [];

  constructor() {
    const geo = new THREE.RingGeometry(0.5, 1, 32);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffb066,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 4;
      this.group.add(mesh);
      this.items.push({ mesh, life: 0, max: 1, scale: 1 });
    }
  }

  spawn(x: number, z: number, scale: number, color: number, life = 0.45): void {
    const item = this.items.find((i) => i.life <= 0);
    if (!item) return;
    item.mesh.position.set(x, 0.12, z);
    item.mesh.visible = true;
    (item.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    item.life = life;
    item.max = life;
    item.scale = scale;
  }

  update(dt: number): void {
    for (const item of this.items) {
      if (item.life <= 0) continue;
      item.life -= dt;
      const t = 1 - Math.max(0, item.life) / item.max;
      const s = 0.6 + t * item.scale;
      item.mesh.scale.set(s, 1, s);
      (item.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.85;
      if (item.life <= 0) item.mesh.visible = false;
    }
  }
}

/**
 * Flat marks on the floor (blood, scorch). One instanced mesh per kind, used
 * as a ring buffer so old marks are recycled instead of piling up.
 */
export class Decals {
  readonly group = new THREE.Group();
  private kinds = new Map<'blood' | 'scorch', { mesh: THREE.InstancedMesh; next: number }>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  constructor(max = 160) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    for (const kind of ['blood', 'scorch'] as const) {
      const mat = new THREE.MeshStandardMaterial({
        map: splatTexture(kind),
        transparent: true,
        depthWrite: false,
        roughness: kind === 'blood' ? 0.35 : 1,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, max);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.kinds.set(kind, { mesh, next: 0 });
    }
  }

  add(kind: 'blood' | 'scorch', x: number, z: number, size: number): void {
    const k = this.kinds.get(kind)!;
    const cap = k.mesh.instanceMatrix.count;
    this.q.setFromAxisAngle(Decals.UP, Math.random() * Math.PI * 2);
    this.p.set(x, 0.015 + Math.random() * 0.004, z);
    this.s.set(size, 1, size * (0.75 + Math.random() * 0.5));
    this.m.compose(this.p, this.q, this.s);
    k.mesh.setMatrixAt(k.next, this.m);
    k.next = (k.next + 1) % cap;
    k.mesh.count = Math.min(cap, k.mesh.count + 1);
    k.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    for (const k of this.kinds.values()) {
      k.mesh.count = 0;
      k.next = 0;
    }
  }
}

function splatTexture(kind: 'blood' | 'scorch'): THREE.Texture {
  const n = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const ctx = cv.getContext('2d')!;
  const blobs = kind === 'blood' ? 14 : 22;
  for (let i = 0; i < blobs; i++) {
    const r = (i === 0 ? 0.3 : 0.05 + Math.random() * 0.14) * n;
    const d = i === 0 ? 0 : Math.random() * n * 0.3;
    const a = Math.random() * Math.PI * 2;
    const x = n / 2 + Math.cos(a) * d;
    const y = n / 2 + Math.sin(a) * d;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    if (kind === 'blood') {
      g.addColorStop(0, 'rgba(110,6,12,0.95)');
      g.addColorStop(0.7, 'rgba(80,4,10,0.85)');
      g.addColorStop(1, 'rgba(60,0,6,0)');
    } else {
      g.addColorStop(0, 'rgba(8,7,6,0.9)');
      g.addColorStop(0.6, 'rgba(14,12,10,0.6)');
      g.addColorStop(1, 'rgba(20,18,16,0)');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Bullet Echo's "sound" markers: a hidden shooter leaves a pulsing red ring
 * where the shot came from. Drawn in the overlay scene, above the darkness.
 */
export class SoundPings {
  readonly group = new THREE.Group();
  private items: { mesh: THREE.Mesh; life: number }[] = [];
  static readonly LIFE = 1.1;

  constructor() {
    const geo = new THREE.RingGeometry(0.55, 0.85, 36);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 12; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xff3048,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      this.group.add(mesh);
      this.items.push({ mesh, life: 0 });
    }
  }

  spawn(x: number, z: number): void {
    const item = this.items.find((i) => i.life <= 0) ?? this.items[0];
    item.life = SoundPings.LIFE;
    item.mesh.position.set(x, 0.1, z);
    item.mesh.visible = true;
  }

  update(dt: number): void {
    for (const item of this.items) {
      if (item.life <= 0) continue;
      item.life -= dt;
      const t = 1 - Math.max(0, item.life) / SoundPings.LIFE;
      const s = 0.7 + t * 1.6;
      item.mesh.scale.set(s, 1, s);
      (item.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.9;
      if (item.life <= 0) item.mesh.visible = false;
    }
  }
}

/**
 * Last-known-position markers: when an enemy slips out of sight a faint
 * hollow marker stays where it was last seen, then fades. Overlay scene.
 */
export class Ghosts {
  readonly group = new THREE.Group();
  private items: { mesh: THREE.Mesh; life: number }[] = [];
  static readonly LIFE = 3.2;

  constructor() {
    const ring = new THREE.RingGeometry(0.5, 0.62, 28, 1, 0, Math.PI * 2);
    ring.rotateX(-Math.PI / 2);
    for (let i = 0; i < 10; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xff6070,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(ring, mat);
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.12, 12).rotateX(-Math.PI / 2), mat);
      mesh.add(dot);
      mesh.visible = false;
      this.group.add(mesh);
      this.items.push({ mesh, life: 0 });
    }
  }

  spawn(x: number, z: number): void {
    const item = this.items.find((i) => i.life <= 0) ?? this.items.reduce((a, b) => (a.life < b.life ? a : b));
    item.life = Ghosts.LIFE;
    item.mesh.position.set(x, 0.1, z);
    item.mesh.visible = true;
  }

  update(dt: number): void {
    for (const item of this.items) {
      if (item.life <= 0) continue;
      item.life -= dt;
      const t = Math.max(0, item.life) / Ghosts.LIFE;
      (item.mesh.material as THREE.MeshBasicMaterial).opacity = 0.55 * t * (0.75 + 0.25 * Math.sin(item.life * 9));
      if (item.life <= 0) item.mesh.visible = false;
    }
  }

  clear(): void {
    for (const item of this.items) {
      item.life = 0;
      item.mesh.visible = false;
    }
  }
}
