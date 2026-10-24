import * as THREE from 'three';
import type { StaticBody } from '../game/types';

// Bullet Echo–style line of sight. For each viewer we cast a full circle of
// rays against the wall boxes: inside the aim cone a ray reaches `range`,
// elsewhere only `nearRadius` (you "hear" whoever is right next to you).
// The result is used twice:
//   - as a fan mesh rendered into a mask, which the post pass uses to plunge
//     everything outside into darkness;
//   - as a lookup table (distance per ray angle) to decide in O(1) whether an
//     enemy is visible.
// Pure render-side logic: the authoritative sim never depends on it.

export const VISION = {
  rays: 360,
  range: 24,
  halfAngle: (44 * Math.PI) / 180,
  nearRadius: 1,
  /** Rays stop slightly inside walls so the wall face itself is lit. */
  wallBite: 0.35,
  /** How deep into a smoke cloud the view still reaches (its near side). */
  smokeBite: 1.8,
  /** Fraction of the range after which sight fades out toward the edge. */
  fadeStart: 0.62,
  /** Mask value at the very end of the range (1 = fully seen). */
  fadeEnd: 0.5,
  /** Enemy fade in / out speed, alpha per second. */
  fadeIn: 9,
  fadeOut: 2.6,
};

export class Viewer {
  readonly dist = new Float32Array(VISION.rays);
  x = 0;
  z = 0;
  ang = 0;
  active = false;
  /** Fan mesh: centre + one vertex per ray, at floor and wall-top height. */
  readonly mesh: THREE.Mesh;
  private positions: Float32Array;
  private colors: Float32Array;

  constructor(material: THREE.Material) {
    const n = VISION.rays;
    const geo = new THREE.BufferGeometry();
    // Two fans (floor and y=top) so tall things inside the area stay lit.
    this.positions = new Float32Array((n + 1) * 2 * 3);
    this.colors = new Float32Array((n + 1) * 2 * 3).fill(1);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    const idx: number[] = [];
    for (let layer = 0; layer < 2; layer++) {
      const base = layer * (n + 1);
      for (let i = 0; i < n; i++) {
        idx.push(base, base + 1 + ((i + 1) % n), base + 1 + i);
      }
    }
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
  }

  /** Sight distance of the cone: long with the flashlight on, short without. */
  range = VISION.range;

  /** Max distance of the cone at angle `a` (world), before walls. */
  reach(a: number, aim: number): number {
    let d = a - aim;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const edge = Math.abs(d) - VISION.halfAngle;
    if (edge <= 0) return this.range;
    // Soft shoulder over ~8° so the cone edge is not a hard step.
    const t = Math.min(1, edge / 0.14);
    return this.range + (VISION.nearRadius - this.range) * t;
  }

  /**
   * `smokes`: clouds (centre + radius) that stop sight like walls; from
   * inside one, nothing is seen beyond `insideSight`.
   */
  compute(
    walls: StaticBody[],
    x: number,
    z: number,
    ang: number,
    heights: [number, number],
    smokes: { x: number; z: number; r: number }[] = [],
    insideSight = 1.5,
  ): void {
    this.x = x;
    this.z = z;
    this.ang = ang;
    const n = VISION.rays;
    const p = this.positions;
    const top = (n + 1) * 3;
    p[0] = x; p[1] = heights[0]; p[2] = z;
    p[top] = x; p[top + 1] = heights[1]; p[top + 2] = z;

    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      let max = this.reach(a, ang);
      let hit = max;
      for (let w = 0; w < walls.length; w++) {
        const t = rayBox(x, z, dx, dz, walls[w]);
        if (t >= 0 && t < hit) hit = t;
      }
      // Smoke stops sight like a wall, but the near side of the cloud stays
      // visible (the light reaches into it), so it reads as smoke, not a hole.
      let bite = VISION.wallBite;
      for (const s of smokes) {
        const t = rayCircle(x, z, dx, dz, s.x, s.z, s.r);
        if (t === 0) max = Math.min(max, insideSight);
        else if (t > 0 && t < hit) {
          hit = t;
          bite = Math.min(VISION.smokeBite, s.r);
        }
      }
      hit = Math.min(hit, max);
      const d = hit < max ? Math.min(max, hit + bite) : max;
      this.dist[i] = hit;
      const o = (i + 1) * 3;
      p[o] = x + dx * d; p[o + 1] = heights[0]; p[o + 2] = z + dz * d;
      p[top + o] = x + dx * d; p[top + o + 1] = heights[1]; p[top + o + 2] = z + dz * d;
      // Sight thins out toward the end of the range instead of a hard edge.
      const f = Math.min(1, Math.max(0, (d / this.range - VISION.fadeStart) / (1 - VISION.fadeStart)));
      const c = 1 + (VISION.fadeEnd - 1) * f;
      this.colors[o] = this.colors[o + 1] = this.colors[o + 2] = c;
      this.colors[top + o] = this.colors[top + o + 1] = this.colors[top + o + 2] = c;
    }
    (this.mesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.mesh.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Whether a point (with a body radius) is inside this viewer's sight. */
  sees(px: number, pz: number, radius = 0.4): boolean {
    if (!this.active) return false;
    const dx = px - this.x;
    const dz = pz - this.z;
    const d = Math.hypot(dx, dz);
    if (d < VISION.nearRadius * 0.6) return true;
    let a = Math.atan2(dz, dx);
    if (a < 0) a += Math.PI * 2;
    const n = VISION.rays;
    const i = Math.floor((a / (Math.PI * 2)) * n) % n;
    const lim = Math.min(this.dist[i], this.dist[(i + 1) % n]);
    return d - radius < lim && d - radius < this.reach(a, this.ang);
  }
}

/**
 * A hostile flashlight beam: a narrow fan cut by walls, drawn additively in
 * the overlay (above the fog), bright at the lamp and fading with distance.
 */
export class Beam {
  static readonly RAYS = 28;
  static readonly RANGE = 17;
  static readonly HALF = 0.36;
  readonly mesh: THREE.Mesh;
  private positions: Float32Array;
  private colors: Float32Array;

  constructor(material: THREE.Material) {
    const n = Beam.RAYS;
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array((n + 1) * 3);
    this.colors = new Float32Array((n + 1) * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    const idx: number[] = [];
    for (let i = 0; i < n - 1; i++) idx.push(0, i + 2, i + 1);
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  compute(walls: StaticBody[], x: number, z: number, ang: number): void {
    const n = Beam.RAYS;
    const p = this.positions;
    const c = this.colors;
    p[0] = x + Math.cos(ang) * 0.5;
    p[1] = 0.06;
    p[2] = z + Math.sin(ang) * 0.5;
    c[0] = c[1] = c[2] = 0.55;
    for (let i = 0; i < n; i++) {
      const a = ang - Beam.HALF + (i / (n - 1)) * Beam.HALF * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      let hit = Beam.RANGE;
      for (const w of walls) {
        const t = rayBox(x, z, dx, dz, w);
        if (t >= 0 && t < hit) hit = t;
      }
      const o = (i + 1) * 3;
      p[o] = x + dx * hit;
      p[o + 1] = 0.06;
      p[o + 2] = z + dz * hit;
      // Edge rays fade to nothing (soft sides), far ends fade out.
      const e = Math.abs(i / (n - 1) - 0.5) * 2;
      const edge = Math.max(0, 1 - e * e);
      const v = Math.max(0, 1 - hit / Beam.RANGE) * edge * 0.55;
      c[o] = c[o + 1] = c[o + 2] = v;
    }
    (this.mesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.mesh.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Distance along the ray to an axis-aligned box, or -1. Origin inside -> -1. */
export function rayBox(ox: number, oz: number, dx: number, dz: number, b: StaticBody): number {
  const minX = b.cx - b.hw;
  const maxX = b.cx + b.hw;
  const minZ = b.cz - b.hh;
  const maxZ = b.cz + b.hh;
  let tmin = -Infinity;
  let tmax = Infinity;
  if (Math.abs(dx) < 1e-9) {
    if (ox < minX || ox > maxX) return -1;
  } else {
    const inv = 1 / dx;
    let t1 = (minX - ox) * inv;
    let t2 = (maxX - ox) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }
  if (Math.abs(dz) < 1e-9) {
    if (oz < minZ || oz > maxZ) return -1;
  } else {
    const inv = 1 / dz;
    let t1 = (minZ - oz) * inv;
    let t2 = (maxZ - oz) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }
  if (tmax < 0 || tmin > tmax || tmin < 0) return -1;
  return tmin;
}

/**
 * Composite: the mask holds 1 where the squad sees now, ~0.33 where it has
 * been before (memory), 0 where nobody has looked yet. Seen areas keep full
 * colour; remembered ones turn grey and dim; unknown ones are near black.
 * A slow drifting haze and film grain keep the dark from looking flat.
 */
export const VISION_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tMask: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
    uMemory: { value: 0.2 },
    uUnknown: { value: 0.035 },
    uTime: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tMask;
    uniform vec2 uTexel;
    uniform float uMemory;
    uniform float uUnknown;
    uniform float uTime;
    uniform float uAspect;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
    }

    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // 9-tap blur of the half-res mask: soft edges without a blur pass.
      float m = 0.0;
      for (int x = -1; x <= 1; x++)
        for (int y = -1; y <= 1; y++)
          m += texture2D(tMask, vUv + vec2(float(x), float(y)) * uTexel * 2.0).r;
      m /= 9.0;
      float seen = smoothstep(0.42, 0.95, m);
      float known = smoothstep(0.04, 0.3, m);

      vec2 p = vec2(vUv.x * uAspect, vUv.y);
      float haze = noise(p * 5.0 + vec2(uTime * 0.05, uTime * 0.03)) * 0.6
                 + noise(p * 11.0 - vec2(uTime * 0.04, 0.0)) * 0.4;
      float grain = hash(vUv * 913.0 + fract(uTime * 7.13)) - 0.5;

      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      vec3 memory = mix(vec3(l), c.rgb, 0.15) * vec3(0.78, 0.88, 1.12) * uMemory * (0.8 + haze * 0.4);
      vec3 unknown = vec3(0.55, 0.62, 0.8) * uUnknown * (0.4 + haze * 0.9);
      vec3 dark = mix(unknown, memory + unknown * 0.5, known) + grain * 0.012;
      gl_FragColor = vec4(mix(dark, c.rgb, seen), c.a);
    }`,
};

/**
 * Distance along the ray to where it enters a circle: 0 when the origin is
 * inside, -1 when it misses.
 */
function rayCircle(ox: number, oz: number, dx: number, dz: number, cx: number, cz: number, r: number): number {
  const fx = ox - cx;
  const fz = oz - cz;
  const c = fx * fx + fz * fz - r * r;
  if (c <= 0) return 0;
  const b = fx * dx + fz * dz;
  if (b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  return -b - Math.sqrt(disc);
}
