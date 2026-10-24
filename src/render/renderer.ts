import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG, COLORS, TILE } from '../game/config';
import type { FloorRect, GrenadeKind, MapData, PowerupKind, PropKind, RoomTheme, SmokeCloud, StaticBody } from '../game/types';
import { smokeRadius } from '../game/sim';
import type { WeaponId } from '../game/weapons';
import { ActorVisual } from './actors';
import { assets } from './assets';
import { Decals, Ghosts, Particles, Shockwaves, SoundPings } from './fx';
import { makeBarrelTexture, makeFloorTexture, makeGlowTexture, makeWallTexture } from './textures';
import { setRagdollWalls } from './ragdoll';
import { Beam, Viewer, VISION, VISION_SHADER } from './vision';

// Frame: scene -> vision darkening (mask of what the squad can see) -> bloom
// -> output; then an overlay scene (tracers, sound markers) is drawn on top
// so it stays readable in the dark. Camera is near top-down with look-ahead
// toward the cursor, like Bullet Echo.

const WALL_HEIGHT = 2.2;
const EXPLORED_RES = 1024;
/** Brightness of remembered floor / wall tops in the vision mask. */
const MEMORY_FLOOR = 0.33;
const MEMORY_WALL = 0.4;
const EXPLORED_MAT = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false });
/** Height bullets and the aim plane live at (gun height of a scaled soldier). */
export const GUN_HEIGHT = 1.4;

interface PropVisual {
  id: number;
  group: THREE.Group;
}

interface DoorVisual {
  mesh: THREE.Mesh;
  body: StaticBody;
  openT: number;
}

export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly particles = new Particles();
  readonly smoke = new Particles({ additive: false });
  readonly shockwaves = new Shockwaves();
  readonly decals = new Decals();
  readonly pings = new SoundPings();
  readonly ghosts = new Ghosts();

  private renderer: THREE.WebGLRenderer;
  private container: HTMLElement;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private visionPass: ShaderPass;
  private maskTarget: THREE.WebGLRenderTarget;
  private maskScene = new THREE.Scene();
  private exploredTarget: THREE.WebGLRenderTarget;
  private exploredCam: THREE.OrthographicCamera;
  private exploredScene = new THREE.Scene();
  private exploredDirty = false;
  private exploredMeshes: THREE.Mesh[] = [];
  private warmVisuals: ActorVisual[] = [];
  private memoryPlane: THREE.Mesh | null = null;
  private overlay = new THREE.Scene();
  private viewers: Viewer[] = [];
  private visionWalls: StaticBody[] = [];

  private mapGroup = new THREE.Group();
  private map: MapData | null = null;
  private tracerMesh: THREE.InstancedMesh;
  private propVisuals: PropVisual[] = [];
  private doorVisuals: DoorVisual[] = [];
  private pickupVisuals = new Map<number, THREE.Group>();
  private beamPool: Beam[] = [];
  private grenadeMeshes: { body: THREE.Mesh; ring: THREE.Mesh }[] = [];
  private grenadeGeo = new THREE.SphereGeometry(0.13, 10, 8);
  private grenadeMat = new THREE.MeshStandardMaterial({ color: 0x3d4a2e, roughness: 0.6, metalness: 0.3, emissive: 0x220000 });
  private grenadeMats: Record<GrenadeKind, THREE.Material> = {
    frag: this.grenadeMat,
    smoke: new THREE.MeshStandardMaterial({ color: 0x6d7378, roughness: 0.7, metalness: 0.2 }),
    flash: new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.4, metalness: 0.5, emissive: 0x202020 }),
  };
  /** Smoke clouds: a cluster of soft sprites each, keyed by cloud id. */
  private smokeClouds = new Map<number, { group: THREE.Group; seen: boolean }>();
  /** The same clouds as circles, for line of sight. */
  private smokeCircles: { x: number; z: number; r: number }[] = [];
  private smokeTexture = makeSmokeTexture();
  private bushVisuals: { x: number; z: number; r: number; material: THREE.MeshStandardMaterial }[] = [];
  private powerupVisuals = new Map<number, THREE.Group>();
  private hostile: (id: number) => boolean = (id) => id >= 1000;
  private viewerCount = 2;
  private lamps: { x: number; z: number; color: number; on: boolean; fixture: THREE.Mesh }[] = [];
  private lampPool: THREE.PointLight[] = [];
  private lampUsed = [-1, -1, -1];
  private spotlights: { light: THREE.SpotLight; target: THREE.Object3D }[] = [];
  private flashLights: { light: THREE.PointLight; life: number; max: number; peak: number }[] = [];
  private boomLights: { light: THREE.PointLight; life: number; max: number; peak: number }[] = [];
  private actorVisuals = new Map<number, ActorVisual>();
  private reveal = new Map<number, number>();
  private selfLight: THREE.PointLight;
  private capMask: THREE.Mesh | null = null;

  private camTarget = new THREE.Vector3();
  private camPos = new THREE.Vector3();
  private camInit = false;
  private look = new THREE.Vector2();
  private lookSmooth = new THREE.Vector2();
  private pointer = new THREE.Vector2();
  private shakeAmount = 0;
  private time = 0;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -GUN_HEIGHT);
  private tmpMatrix = new THREE.Matrix4();
  private tmpQuat = new THREE.Quaternion();
  private tmpVec = new THREE.Vector3();
  private tmpScale = new THREE.Vector3();
  private tmpColor = new THREE.Color();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  /** Shadow maps are expensive; they can be disabled for low-end devices. */
  private shadowsEnabled: boolean;

  constructor(container: HTMLElement, opts: { shadows?: boolean } = {}) {
    this.container = container;
    this.shadowsEnabled = opts.shadows !== false;

    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = this.shadowsEnabled;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      CONFIG.camera.fov,
      container.clientWidth / Math.max(1, container.clientHeight),
      1,
      200,
    );
    this.camera.position.set(0, CONFIG.camera.height, CONFIG.camera.back);
    this.camera.lookAt(0, 0, 0);

    this.scene.background = new THREE.Color(0x020306);
    this.scene.add(this.mapGroup);
    this.scene.add(new THREE.AmbientLight(0x3a4a66, 3.6));
    this.scene.add(new THREE.HemisphereLight(0x6a7a98, 0x0b0d12, 2.2));
    // Soft light that follows the local player so their soldier always reads.
    this.selfLight = new THREE.PointLight(0xa8bcd8, 22, 7, 1.4);
    this.scene.add(this.selfLight);

    this.scene.add(this.particles.points);
    this.scene.add(this.smoke.points);
    this.scene.add(this.shockwaves.group);
    this.scene.add(this.decals.group);
    this.overlay.add(this.pings.group);

    // Every light lives for the whole session and is only dimmed to zero:
    // changing the number of active lights makes three.js rebuild the shader
    // of every material, which is what caused the in-game freezes.
    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(0xffc98a, 0, 14, 2);
      this.scene.add(light);
      this.flashLights.push({ light, life: 0, max: 0.06, peak: 90 });
    }
    for (let i = 0; i < 2; i++) {
      const light = new THREE.PointLight(0xff9a3c, 0, 30, 1.7);
      this.scene.add(light);
      this.boomLights.push({ light, life: 0, max: 0.45, peak: 260 });
    }
    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(COLORS.lamp, 0, 22, 2);
      this.scene.add(light);
      this.lampPool.push(light);
    }
    for (let i = 0; i < 2; i++) {
      const light = new THREE.SpotLight(0xfff0d6, 0, 34, 0.62, 0.6, 1.2);
      // Both beams need shadows: without one the teammate's light shines
      // through walls into the next room. Always on: toggling castShadow
      // changes the shadow count and rebuilds every shader.
      light.castShadow = this.shadowsEnabled;
      const res = i === 0 ? 1024 : 512;
      light.shadow.mapSize.set(res, res);
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = 36;
      light.shadow.bias = -0.002;
      light.shadow.normalBias = 0.04;
      const target = new THREE.Object3D();
      this.scene.add(light, target);
      light.target = target;
      this.spotlights.push({ light, target });
    }

    // Tracers: bright additive streaks, in the overlay so they read in the dark.
    const tracerGeo = new THREE.BoxGeometry(1, 0.06, 0.06);
    tracerGeo.translate(-0.5, 0, 0);
    const tracerMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.tracerMesh = new THREE.InstancedMesh(tracerGeo, tracerMat, 256);
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.count = 0;
    this.overlay.add(this.tracerMesh);

    // Vision: two viewers (local player + teammate) drawn into a half-res mask.
    const maskMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    for (let i = 0; i < 2; i++) {
      const v = new Viewer(maskMat);
      v.mesh.renderOrder = 2;
      this.viewers.push(v);
      this.maskScene.add(v.mesh);
    }
    this.maskScene.background = new THREE.Color(0x000000);
    this.maskTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType });
    // Fog-of-war memory: a top-down texture of everything the squad has seen.
    this.exploredTarget = new THREE.WebGLRenderTarget(EXPLORED_RES, EXPLORED_RES, { type: THREE.UnsignedByteType });
    this.exploredCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    this.exploredCam.up.set(0, 0, -1);
    for (const v of this.viewers) {
      const m = new THREE.Mesh(v.mesh.geometry, EXPLORED_MAT);
      m.frustumCulled = false;
      this.exploredMeshes.push(m);
      this.exploredScene.add(m);
    }
    this.overlay.add(this.ghosts.group);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.visionPass = new ShaderPass(VISION_SHADER);
    this.visionPass.uniforms.tMask.value = this.maskTarget.texture;
    this.composer.addPass(this.visionPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.4, 0.4, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    const mw = Math.max(1, Math.floor((w * pr) / 2));
    const mh = Math.max(1, Math.floor((h * pr) / 2));
    this.maskTarget.setSize(mw, mh);
    (this.visionPass.uniforms.uTexel.value as THREE.Vector2).set(1 / mw, 1 / mh);
    this.visionPass.uniforms.uAspect.value = w / Math.max(1, h);
    this.bloom.resolution.set(w / 2, h / 2);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ map

  buildMap(map: MapData): void {
    this.clearMap();
    this.map = map;
    setRagdollWalls(map.walls);
    const g = this.mapGroup;

    // Floors: one mesh per room theme; the void outside stays black.
    const byTheme = new Map<RoomTheme, THREE.BufferGeometry[]>();
    const marks: THREE.BufferGeometry[] = [];
    for (const f of map.floors) {
      const geo = new THREE.PlaneGeometry(f.x1 - f.x0, f.z1 - f.z0);
      geo.rotateX(-Math.PI / 2);
      geo.translate((f.x0 + f.x1) / 2, 0, (f.z0 + f.z1) / 2);
      worldUv(geo, FLOOR_STYLE[f.theme].tile);
      if (!byTheme.has(f.theme)) byTheme.set(f.theme, []);
      byTheme.get(f.theme)!.push(geo);
      // Painted markings follow room outlines; arena floors are merged strips.
      if (map.mode === 'coop') floorMarkings(f, marks);
    }
    for (const [theme, geos] of byTheme) {
      const floor = new THREE.Mesh(mergeGeometries(geos), this.floorMaterial(theme));
      floor.receiveShadow = true;
      g.add(floor);
    }
    if (marks.length > 0) {
      const m = new THREE.Mesh(
        mergeGeometries(marks),
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -1 }),
      );
      m.receiveShadow = true;
      g.add(m);
    }

    // Walls: one merged mesh with world-scaled UVs; a pale cap on top so the
    // layout reads from above even in the dark.
    const wallTex = assets.textures.wall ?? makeWallTexture(256);
    const wallMat = new THREE.MeshStandardMaterial({
      map: wallTex,
      color: 0xb4bac4,
      roughness: 0.88,
      metalness: 0.04,
      vertexColors: true,
    });
    const wallGeos = map.walls.map((w) => wallBox(w, WALL_HEIGHT));
    if (wallGeos.length > 0) {
      const walls = new THREE.Mesh(mergeGeometries(wallGeos), wallMat);
      walls.castShadow = true;
      walls.receiveShadow = true;
      g.add(walls);

      // Wall tops are half-lit in the vision mask so the layout reads in the dark.
      // A wall top counts as known once the floor next to it has been seen.
      const caps = map.walls.map((w) => {
        const geo = new THREE.PlaneGeometry(w.hw * 2, w.hh * 2);
        geo.rotateX(-Math.PI / 2);
        geo.translate(w.cx, WALL_HEIGHT + 0.01, w.cz);
        return geo;
      });
      this.capMask = new THREE.Mesh(mergeGeometries(caps), this.memoryMaterial(map, MEMORY_WALL, 1.7));
      this.capMask.frustumCulled = false;
      this.capMask.renderOrder = 1;
      this.maskScene.add(this.capMask);
    }

    // Fog-of-war memory: reset, fit the top-down capture to this map, and
    // show remembered floor in the mask.
    const spanX = map.maxX - map.minX;
    const spanZ = map.maxZ - map.minZ;
    const ec = this.exploredCam;
    ec.left = -spanX / 2;
    ec.right = spanX / 2;
    ec.top = spanZ / 2;
    ec.bottom = -spanZ / 2;
    ec.position.set((map.minX + map.maxX) / 2, 50, (map.minZ + map.maxZ) / 2);
    ec.lookAt(ec.position.x, 0, ec.position.z);
    ec.updateProjectionMatrix();
    this.exploredDirty = true;
    const memGeo = new THREE.PlaneGeometry(spanX, spanZ);
    memGeo.rotateX(-Math.PI / 2);
    memGeo.translate(ec.position.x, 0, ec.position.z);
    this.memoryPlane = new THREE.Mesh(memGeo, this.memoryMaterial(map, MEMORY_FLOOR, 0));
    this.memoryPlane.frustumCulled = false;
    this.maskScene.add(this.memoryPlane);

    // Ceiling lamps: the fixed pool of lights is moved to the nearest ones.
    // Each also gets a visible fixture, so players know what to shoot.
    this.lamps = map.lamps.map((l) => {
      const fixture = new THREE.Mesh(LAMP_FIXTURE_GEO, new THREE.MeshBasicMaterial({ color: l.color, toneMapped: false }));
      fixture.position.set(l.x, 2.9, l.z);
      g.add(fixture);
      return { x: l.x, z: l.z, color: l.color, on: true, fixture };
    });

    // Bushes: a clump of leafy blobs each; see-through while you stand in one.
    this.bushVisuals = (map.bushes ?? []).map((b, i) => {
      const material = new THREE.MeshStandardMaterial({ color: 0x2c4424, roughness: 0.95, transparent: true });
      const group = new THREE.Group();
      group.position.set(b.x, 0, b.z);
      const blobs = 6;
      for (let k = 0; k < blobs; k++) {
        const a = (k / blobs) * Math.PI * 2 + i;
        const off = k === 0 ? 0 : b.r * 0.5;
        const blob = new THREE.Mesh(BUSH_BLOB_GEO, material);
        const size = b.r * (k === 0 ? 0.75 : 0.55 + ((k * 37 + i * 11) % 10) * 0.02);
        blob.scale.set(size, size * 0.85, size);
        blob.position.set(Math.cos(a) * off, size * 0.6, Math.sin(a) * off);
        blob.castShadow = true;
        blob.receiveShadow = true;
        group.add(blob);
      }
      g.add(group);
      return { x: b.x, z: b.z, r: b.r, material };
    });

    // Props: asset models fitted to the collision boxes, primitives otherwise.
    const barrelMat = new THREE.MeshStandardMaterial({ map: makeBarrelTexture(), roughness: 0.6, metalness: 0.25 });
    const boxMat = new THREE.MeshStandardMaterial({ color: 0x6a5434, roughness: 0.9 });
    for (const p of map.props) {
      const group = new THREE.Group();
      group.position.set(p.x, 0, p.z);
      // Long props standing along Z are the model turned by 90°.
      const turned = p.hh > p.hw && LONG_PROPS.has(p.kind);
      const model = turned ? assets.prop(p.kind, p.hh * 2, p.hw * 2) : assets.prop(p.kind, p.hw * 2, p.hh * 2);
      if (model) {
        if (turned) model.rotation.y = Math.PI / 2;
        // A little variety: same props, slightly different turns.
        else if (!LONG_PROPS.has(p.kind)) model.rotation.y = ((p.id * 7919) % 4) * (Math.PI / 2);
        group.add(model);
      } else {
        const h = p.kind === 'table' ? 0.85 : p.kind === 'cover' ? 1.15 : 1.35;
        const mesh = new THREE.Mesh(
          p.kind === 'barrel' ? new THREE.CylinderGeometry(p.hw, p.hw, h, 16) : new THREE.BoxGeometry(p.hw * 2, h, p.hh * 2),
          p.kind === 'barrel' ? barrelMat : boxMat,
        );
        mesh.position.y = h / 2;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
      g.add(group);
      this.propVisuals.push({ id: p.id, group });
    }

    // Doors: steel shutters matching the sim's door bodies (see Sim ctor).
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x59606b, roughness: 0.5, metalness: 0.7 });
    const stripeMat = new THREE.MeshBasicMaterial({ color: 0xffa040, toneMapped: false });
    for (const room of map.rooms) {
      if (!room.hasDoor) continue;
      const body: StaticBody =
        room.doorAxis === 'x'
          ? { cx: room.doorX, cz: room.doorZ, hw: 0.35, hh: TILE / 2 }
          : { cx: room.doorX, cz: room.doorZ, hw: TILE / 2, hh: 0.35 };
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(body.hw * 2, WALL_HEIGHT, body.hh * 2), doorMat);
      mesh.position.set(body.cx, WALL_HEIGHT / 2, body.cz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(body.hw * 2 + 0.02, 0.08, body.hh * 2 + 0.02), stripeMat);
      stripe.position.y = WALL_HEIGHT / 2 - 0.04;
      mesh.add(stripe);
      g.add(mesh);
      this.doorVisuals.push({ mesh, body, openT: 0 });
    }

    this.warmup();
  }

  /**
   * Compiles every shader the level can need up front (soldiers of both
   * sides with every weapon, hidden effects), so nothing compiles mid-fight.
   */
  private warmup(): void {
    for (const v of this.warmVisuals) v.dispose();
    const temps: ActorVisual[] = [];
    const weapons: WeaponId[] = ['pistol', 'smg', 'shotgun', 'rifle', 'sniper'];
    weapons.forEach((weapon, i) => {
      const v = new ActorVisual(-1 - i, i % 2 ? COLORS.enemy : COLORS.player, i % 2 === 0);
      v.update({ kind: i % 2 ? 'enemy' : 'player', x: 0, z: 0, ang: 0, hp: 1, alive: true, weapon }, 0);
      v.triggerFlash();
      v.update({ kind: i % 2 ? 'enemy' : 'player', x: 0, z: 0, ang: 0, hp: 1, alive: true, weapon }, 0.001);
      this.scene.add(v.group);
      temps.push(v);
    });
    // Things that appear mid-game: a beam, a grenade with its ring, a pickup.
    this.updateBeams([{ x: 0, z: 0, ang: 0 }]);
    this.syncGrenades([{ x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 0, fuse: 1 }], 0);
    const pickup = weaponPickupVisual('smg');
    this.scene.add(pickup);
    const hidden: THREE.Object3D[] = [];
    for (const root of [this.scene, this.overlay, this.maskScene]) {
      root.traverse((o) => {
        if (!o.visible) {
          hidden.push(o);
          o.visible = true;
        }
      });
    }
    this.renderer.compile(this.scene, this.camera);
    this.renderer.compile(this.overlay, this.camera);
    this.renderer.compile(this.maskScene, this.camera);
    for (const o of hidden) o.visible = false;
    this.updateBeams([]);
    this.syncGrenades([], 0);
    this.scene.remove(pickup);
    // Not disposed on purpose: releasing the last user of a program deletes
    // it, and the next enemy would compile it again mid-game.
    for (const v of temps) this.scene.remove(v.group);
    this.warmVisuals = temps;
  }

  private floorMaterial(theme: RoomTheme): THREE.MeshStandardMaterial {
    const style = FLOOR_STYLE[theme];
    const map =
      style.tex === 'asphalt'
        ? assets.textures.floor ?? makeFloorTexture(512)
        : style.tex === 'tiles'
          ? makeTileTexture()
          : assets.textures.wall ?? makeWallTexture(256);
    return new THREE.MeshStandardMaterial({
      map,
      normalMap: style.tex === 'asphalt' ? assets.textures.floorNormal ?? null : null,
      normalScale: new THREE.Vector2(0.7, 0.7),
      color: style.color,
      roughness: style.tex === 'tiles' ? 0.55 : 0.92,
      metalness: 0.02,
    });
  }

  /**
   * Mask material that reads the explored texture at the fragment's world
   * position; `reach` > 0 takes the max over a ring of samples that far away
   * (wall tops sit next to, not on, the floor that was seen).
   */
  private memoryMaterial(map: MapData, brightness: number, reach: number): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        tExplored: { value: this.exploredTarget.texture },
        uMin: { value: new THREE.Vector2(map.minX, map.minZ) },
        uSpan: { value: new THREE.Vector2(map.maxX - map.minX, map.maxZ - map.minZ) },
        uBright: { value: brightness },
        uReach: { value: reach },
      },
      vertexShader: /* glsl */ `
        varying vec2 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tExplored;
        uniform vec2 uMin;
        uniform vec2 uSpan;
        uniform float uBright;
        uniform float uReach;
        varying vec2 vWorld;
        float at(vec2 p) {
          vec2 uv = (p - uMin) / uSpan;
          return texture2D(tExplored, vec2(uv.x, 1.0 - uv.y)).r;
        }
        void main() {
          float m = at(vWorld);
          if (uReach > 0.0) {
            for (int i = 0; i < 8; i++) {
              float a = float(i) * 0.785398;
              m = max(m, at(vWorld + vec2(cos(a), sin(a)) * uReach));
            }
          }
          gl_FragColor = vec4(vec3(m * uBright), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
  }

  private clearMap(): void {
    this.mapGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    this.mapGroup.clear();
    for (const m of [this.capMask, this.memoryPlane]) {
      if (!m) continue;
      this.maskScene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.capMask = null;
    this.memoryPlane = null;
    this.ghosts.clear();
    this.propVisuals = [];
    this.doorVisuals = [];
    for (const v of this.pickupVisuals.values()) this.scene.remove(v);
    this.pickupVisuals.clear();
    for (const v of this.powerupVisuals.values()) this.scene.remove(v);
    this.powerupVisuals.clear();
    this.lamps = [];
    this.bushVisuals = [];
    this.lampUsed.fill(-1);
    for (const light of this.lampPool) light.intensity = 0;
    this.decals.clear();
    for (const id of [...this.actorVisuals.keys()]) this.removeActor(id);
  }

  // --------------------------------------------------------------- actors

  ensureActor(id: number, color: number, isPlayer: boolean): ActorVisual {
    let visual = this.actorVisuals.get(id);
    if (!visual) {
      visual = new ActorVisual(id, color, isPlayer);
      this.actorVisuals.set(id, visual);
      this.scene.add(visual.group);
    }
    return visual;
  }

  removeActor(id: number): void {
    const visual = this.actorVisuals.get(id);
    if (!visual) return;
    this.scene.remove(visual.group);
    visual.dispose();
    this.actorVisuals.delete(id);
    this.reveal.delete(id);
  }

  /** Who the fog of war hides (co-op: guards; deathmatch: everyone else). */
  setHostility(fn: (id: number) => boolean): void {
    this.hostile = fn;
  }

  /** Whether this actor is currently visible to the local side. */
  isRevealed(id: number): boolean {
    const v = this.actorVisuals.get(id);
    if (!v) return false;
    return !this.hostile(id) || (this.reveal.get(id) ?? 0) > 0.3;
  }

  /** Removes visuals of actors that no longer exist. */
  pruneActors(alive: Map<number, unknown>): void {
    for (const id of [...this.actorVisuals.keys()]) if (!alive.has(id)) this.removeActor(id);
  }

  resetCamera(): void {
    this.camInit = false;
  }

  /** Weapon pickups (shown or hidden) and powerups (created / removed). */
  syncItems(
    pickups: { id: number; weapon: WeaponId; x: number; z: number }[],
    powerups: { id: number; kind: PowerupKind; x: number; z: number; active: boolean }[],
  ): void {
    // Weapons on the ground come and go (taken ones vanish, the dead drop theirs).
    const have = new Set<number>();
    for (const p of pickups) {
      have.add(p.id);
      if (this.pickupVisuals.has(p.id)) continue;
      const v = weaponPickupVisual(p.weapon);
      v.position.set(p.x, 0, p.z);
      this.scene.add(v);
      this.pickupVisuals.set(p.id, v);
    }
    for (const [id, v] of this.pickupVisuals) {
      if (have.has(id)) continue;
      this.scene.remove(v);
      this.pickupVisuals.delete(id);
    }
    const seen = new Set<number>();
    for (const p of powerups) {
      seen.add(p.id);
      let v = this.powerupVisuals.get(p.id);
      if (!v) {
        v = powerupVisual(p.kind);
        v.position.set(p.x, 0, p.z);
        this.scene.add(v);
        this.powerupVisuals.set(p.id, v);
      }
      v.visible = p.active;
    }
    for (const [id, v] of this.powerupVisuals) {
      if (seen.has(id)) continue;
      this.scene.remove(v);
      this.powerupVisuals.delete(id);
    }
  }

  /** Grenades in flight: body in the scene, danger ring above the fog. */
  syncGrenades(
    grenades: { kind?: GrenadeKind; x: number; y: number; z: number; vx: number; vy: number; vz: number; fuse: number }[],
    ahead: number,
  ): void {
    while (this.grenadeMeshes.length < grenades.length) {
      const body = new THREE.Mesh(this.grenadeGeo, this.grenadeMat);
      body.castShadow = true;
      const ringGeo = new THREE.RingGeometry(0.92, 1, 48);
      ringGeo.rotateX(-Math.PI / 2);
      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color: 0xff3a2a, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
      );
      ring.scale.setScalar(CONFIG.grenade.radius);
      this.scene.add(body);
      this.overlay.add(ring);
      this.grenadeMeshes.push({ body, ring });
    }
    this.grenadeMeshes.forEach((m, i) => {
      const g = grenades[i];
      m.body.visible = m.ring.visible = !!g;
      if (!g) return;
      const kind = g.kind ?? 'frag';
      m.body.material = this.grenadeMats[kind];
      // Only a frag has a blast to stay out of.
      m.ring.visible = kind === 'frag';
      m.body.position.set(g.x + g.vx * ahead, Math.max(0.12, g.y + g.vy * ahead), g.z + g.vz * ahead);
      m.body.rotation.x += 0.3;
      m.ring.position.set(m.body.position.x, 0.08, m.body.position.z);
      const urgency = 1 - Math.max(0, g.fuse) / CONFIG.grenade.fuse;
      const blink = 0.5 + 0.5 * Math.sin(this.time * (8 + urgency * 22));
      (m.ring.material as THREE.MeshBasicMaterial).opacity = (0.15 + urgency * 0.5) * (0.6 + 0.4 * blink);
    });
  }

  private updateBeams(beams: { x: number; z: number; ang: number }[]): void {
    const map = this.map;
    while (this.beamPool.length < beams.length) {
      const b = new Beam(BEAM_MAT);
      b.mesh.renderOrder = 1;
      this.overlay.add(b.mesh);
      this.beamPool.push(b);
    }
    this.beamPool.forEach((b, i) => {
      const src = beams[i];
      b.mesh.visible = !!src && !!map;
      if (!src || !map) return;
      const near = this.visionWalls;
      near.length = 0;
      for (const w of map.walls) {
        if (Math.abs(w.cx - src.x) - w.hw < Beam.RANGE && Math.abs(w.cz - src.z) - w.hh < Beam.RANGE) near.push(w);
      }
      for (const d of this.doorVisuals) if (d.openT < 0.5) near.push(d.body);
      b.compute(near, src.x, src.z, src.ang);
    });
  }

  powerupTaken(x: number, z: number, kind: PowerupKind): void {
    this.tmpColor.setHex(POWERUP_COLOR[kind]);
    this.particles.burst(x, 0.9, z, 26, 6, this.tmpColor, 0.22, 0.5, 2);
    this.shockwaves.spawn(x, z, 2.5, POWERUP_COLOR[kind], 0.35);
  }

  /** A shot from an unseen enemy leaves a sound marker. */
  shotFrom(ownerId: number, x: number, z: number): void {
    const v = this.actorVisuals.get(ownerId);
    if (v && this.hostile(ownerId) && !this.isRevealed(ownerId)) this.pings.spawn(x, z);
  }

  /** Smoke clouds from the simulation: billowing sprites and sight blockers. */
  setSmokes(smokes: SmokeCloud[]): void {
    this.smokeCircles.length = 0;
    for (const c of this.smokeClouds.values()) c.seen = false;
    for (const s of smokes) {
      const r = smokeRadius(s.age);
      this.smokeCircles.push({ x: s.x, z: s.z, r });
      let cloud = this.smokeClouds.get(s.id);
      if (!cloud) {
        const group = new THREE.Group();
        group.position.set(s.x, 0, s.z);
        for (let i = 0; i < 9; i++) {
          const sprite = new THREE.Sprite(
            new THREE.SpriteMaterial({ map: this.smokeTexture, color: 0x8d9399, transparent: true, depthWrite: false }),
          );
          const a = (i / 9) * Math.PI * 2;
          const k = i === 0 ? 0 : 0.55;
          sprite.userData = { ox: Math.cos(a) * k, oz: Math.sin(a) * k, spin: (Math.random() - 0.5) * 0.4 };
          group.add(sprite);
        }
        this.scene.add(group);
        cloud = { group, seen: true };
        this.smokeClouds.set(s.id, cloud);
      }
      cloud.seen = true;
      const fade = Math.min(1, Math.max(0, (CONFIG.smoke.life - s.age) / CONFIG.smoke.fade));
      for (const child of cloud.group.children) {
        const sprite = child as THREE.Sprite;
        const u = sprite.userData as { ox: number; oz: number; spin: number };
        sprite.position.set(u.ox * r, 1.1 + u.ox * 0.3, u.oz * r);
        sprite.scale.setScalar(r * 1.35);
        sprite.material.rotation += u.spin * 0.016;
        sprite.material.opacity = 0.82 * fade;
      }
    }
    for (const [id, c] of this.smokeClouds) {
      if (c.seen) continue;
      this.scene.remove(c.group);
      for (const child of c.group.children) (child as THREE.Sprite).material.dispose();
      this.smokeClouds.delete(id);
    }
  }

  smokePop(x: number, z: number): void {
    this.tmpColor.setRGB(0.5, 0.52, 0.55);
    this.smoke.burst(x, 0.4, z, 14, 3, this.tmpColor, 0.6, 0.9, 1);
  }

  /** A flash grenade: a white burst of light that lights the room for a moment. */
  flashBang(x: number, z: number): void {
    const slot = this.boomLights.find((b) => b.life <= 0) ?? this.boomLights[0];
    slot.life = slot.max;
    slot.peak = 520;
    slot.light.color.setHex(0xf2f6ff);
    slot.light.position.set(x, 1.6, z);
    slot.light.intensity = slot.peak;
    this.shockwaves.spawn(x, z, 5, 0xffffff, 0.25);
  }

  /** Night vision goggles: the whole picture goes green and bright. */
  setNightVision(on: boolean): void {
    this.container.classList.toggle('night-vision', on);
  }

  /** A lamp shot out: the light dies at once (no fade), glass rains down. */
  breakLamp(index: number): void {
    const lamp = this.lamps[index];
    if (!lamp || !lamp.on) return;
    this.setLampOn(index, false);
    const k = this.lampUsed.indexOf(index);
    if (k >= 0) this.lampPool[k].intensity = 0;
    this.tmpColor.setRGB(0.85, 0.92, 1);
    this.particles.burst(lamp.x, 2.8, lamp.z, 18, 4, this.tmpColor, 0.08, 0.6, -9);
  }

  /** Lamp states from the host (snapshots also cover late joiners). */
  syncLamps(alive: boolean[]): void {
    alive.forEach((on, i) => {
      if (this.lamps[i] && this.lamps[i].on !== on) this.setLampOn(i, on);
    });
  }

  private setLampOn(index: number, on: boolean): void {
    const lamp = this.lamps[index];
    lamp.on = on;
    (lamp.fixture.material as THREE.MeshBasicMaterial).color.setHex(on ? lamp.color : 0x1a1c20);
  }

  /** Footsteps of an unseen enemy: a small, faint marker. */
  stepFrom(ownerId: number, x: number, z: number): void {
    const v = this.actorVisuals.get(ownerId);
    if (v && this.hostile(ownerId) && !this.isRevealed(ownerId)) this.pings.spawn(x, z, 0.45, 0.4);
  }

  syncProps(props: { id: number; x: number; z: number; alive: boolean }[]): void {
    for (const pv of this.propVisuals) {
      const p = props.find((x) => x.id === pv.id);
      if (!p) continue;
      pv.group.visible = p.alive;
      pv.group.position.set(p.x, 0, p.z);
    }
  }

  syncDoors(doors: { room: number; open: boolean; openT: number }[]): void {
    doors.forEach((d, i) => {
      const vis = this.doorVisuals[i];
      if (!vis) return;
      vis.openT = d.openT;
      // Shutters sink into the floor.
      vis.mesh.position.y = WALL_HEIGHT / 2 - d.openT * (WALL_HEIGHT + 0.1);
      vis.mesh.visible = d.openT < 0.98;
    });
  }

  syncTracers(bullets: { x: number; z: number; vx: number; vz: number; color: number }[]): void {
    const mesh = this.tracerMesh;
    const n = Math.min(bullets.length, 256);
    for (let i = 0; i < n; i++) {
      const b = bullets[i];
      const speed = Math.hypot(b.vx, b.vz);
      const len = Math.min(2.6, 0.6 + speed * 0.025);
      this.tmpVec.set(b.x, GUN_HEIGHT, b.z);
      this.tmpQuat.setFromAxisAngle(Renderer.UP, -Math.atan2(b.vz, b.vx));
      this.tmpScale.set(len, 1, 1);
      this.tmpMatrix.compose(this.tmpVec, this.tmpQuat, this.tmpScale);
      mesh.setMatrixAt(i, this.tmpMatrix);
      this.tmpColor.setHex(b.color).multiplyScalar(1.6);
      mesh.setColorAt(i, this.tmpColor);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------------ fx

  muzzleFlash(x: number, z: number, dirX: number, dirZ: number, size: number): void {
    const slot = this.flashLights.find((f) => f.life <= 0) ?? this.flashLights[0];
    slot.life = slot.max;
    slot.peak = 80 * size;
    slot.light.position.set(x + dirX * 0.9, GUN_HEIGHT, z + dirZ * 0.9);
    slot.light.intensity = slot.peak;

    this.tmpColor.setHex(0xffd9a0);
    this.particles.burst(x + dirX * 1.0, GUN_HEIGHT, z + dirZ * 1.0, 4, 3.5 * size, this.tmpColor, 0.16 * size, 0.1);
    this.tmpColor.setRGB(0.5, 0.5, 0.52);
    this.smoke.spawn(x + dirX * 1.1, GUN_HEIGHT, z + dirZ * 1.1, dirX * 1.2, 0.3, dirZ * 1.2, 0.5, 0.5 * size, this.tmpColor, 2.5, 0.4);
  }

  impact(x: number, z: number, color = 0xffd08a): void {
    this.tmpColor.setHex(color);
    this.particles.burst(x, GUN_HEIGHT, z, 7, 5, this.tmpColor, 0.1, 0.3, -6);
    this.tmpColor.setRGB(0.55, 0.53, 0.5);
    this.smoke.burst(x, GUN_HEIGHT, z, 2, 1.2, this.tmpColor, 0.45, 0.6);
  }

  blood(x: number, z: number): void {
    this.tmpColor.setHex(0x8a0d18);
    this.smoke.burst(x, GUN_HEIGHT - 0.2, z, 10, 4.5, this.tmpColor, 0.18, 0.45, -8);
    this.decals.add('blood', x + (Math.random() - 0.5) * 0.8, z + (Math.random() - 0.5) * 0.8, 0.7 + Math.random() * 0.9);
  }

  explosion(x: number, z: number): void {
    const slot = this.boomLights.find((b) => b.life <= 0) ?? this.boomLights[0];
    slot.life = slot.max;
    slot.peak = 260;
    // The pool is shared with flash grenades, which turn it white.
    slot.light.color.setHex(0xff9a3c);
    slot.light.position.set(x, 1.6, z);
    slot.light.intensity = slot.peak;

    this.tmpColor.setHex(0xffa53a);
    this.particles.burst(x, 1.0, z, 60, 15, this.tmpColor, 0.35, 0.6, -4);
    this.tmpColor.setHex(0xfff0c0);
    this.particles.burst(x, 0.8, z, 20, 24, this.tmpColor, 0.2, 0.25);
    this.tmpColor.setRGB(0.16, 0.15, 0.14);
    this.smoke.burst(x, 1.0, z, 28, 5, this.tmpColor, 1.6, 2.4, 0.6);
    this.shockwaves.spawn(x, z, 8, 0xffa040, 0.45);
    this.decals.add('scorch', x, z, 4.5);
    this.shake(1.4);
  }

  /** Blast wave for bodies: corpses get thrown, the dying fly further. */
  blastRagdolls(x: number, z: number): void {
    for (const v of this.actorVisuals.values()) v.blast(x, z, 8);
  }

  shake(amount: number): void {
    this.shakeAmount = Math.min(1.6, this.shakeAmount + amount);
  }

  // --------------------------------------------------------------- camera

  setCameraTarget(x: number, z: number): void {
    this.camTarget.set(x, 0, z);
  }

  /** Cursor position in client pixels; drives the look-ahead. */
  setPointer(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      ((clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1,
    );
  }

  screenToGround(clientX: number, clientY: number): { x: number; z: number } {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) {
      return { x: this.camTarget.x, z: this.camTarget.z };
    }
    return { x: hit.x, z: hit.z };
  }

  /** World point -> client pixels; `visible` false when behind the camera. */
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    this.tmpVec.set(x, y, z).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((this.tmpVec.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - this.tmpVec.y) / 2) * rect.height,
      visible: this.tmpVec.z < 1,
    };
  }

  /**
   * `players` drive flashlights; the first `viewerCount` of them also share
   * their sight (co-op squad), in deathmatch only the local player sees.
   */
  update(
    dt: number,
    players: { x: number; z: number; ang: number; flashOn: boolean; alive: boolean; nv?: boolean }[],
    viewerCount = 2,
    beams: { x: number; z: number; ang: number }[] = [],
  ): void {
    this.viewerCount = viewerCount;
    this.updateBeams(beams);
    this.time += dt;

    // Player flashlights.
    for (let i = 0; i < this.spotlights.length; i++) {
      const p = players[i];
      const spot = this.spotlights[i];
      const on = !!p && p.alive && p.flashOn;
      // Fade instead of toggling (see the constructor on light counts).
      const target = on ? 85 : 0;
      spot.light.intensity += (target - spot.light.intensity) * Math.min(1, dt * 18);
      if (!p) continue;
      // In front of the gun: a light at the head blows the soldier out.
      spot.light.position.set(p.x + Math.cos(p.ang) * 0.9, 1.7, p.z + Math.sin(p.ang) * 0.9);
      spot.target.position.set(p.x + Math.cos(p.ang) * 14, 0.4, p.z + Math.sin(p.ang) * 14);
      spot.target.updateMatrixWorld();
    }

    const self = players[0];
    if (self) this.selfLight.position.set(self.x, 3.2, self.z);

    this.updateVision(dt, players);

    this.placeLamps(dt);
    // The bush you stand in turns see-through, so you can see yourself.
    for (const b of this.bushVisuals) {
      const inside = Math.hypot(this.camTarget.x - b.x, this.camTarget.z - b.z) < b.r + 0.3;
      b.material.opacity += ((inside ? 0.35 : 1) - b.material.opacity) * Math.min(1, dt * 8);
    }

    for (const f of this.flashLights) decayLight(f, dt);
    for (const b of this.boomLights) decayLight(b, dt);

    for (const p of this.pickupVisuals.values()) {
      const holder = p.children[1];
      if (holder) {
        holder.rotation.y += dt * 1.2;
        holder.position.y = 0.75 + Math.sin(this.time * 2 + p.position.x) * 0.08;
      }
    }
    for (const p of this.powerupVisuals.values()) {
      const icon = p.children[1];
      if (icon) {
        icon.rotation.y += dt * 2;
        icon.position.y = 0.8 + Math.sin(this.time * 3 + p.position.x) * 0.12;
      }
    }

    this.particles.update(dt);
    this.smoke.update(dt);
    this.shockwaves.update(dt);
    this.pings.update(dt);
    this.ghosts.update(dt);
    this.visionPass.uniforms.uTime.value = this.time;

    // Camera: follow with look-ahead toward the cursor, smooth shake.
    const la = CONFIG.camera.lookAhead;
    this.look.set(clampAbs(this.pointer.x, 1) * la * this.camera.aspect * 0.6, clampAbs(this.pointer.y, 1) * la);
    const lk = 1 - Math.exp(-4 * dt);
    this.lookSmooth.lerp(this.look, lk);
    const tx = this.camTarget.x + this.lookSmooth.x;
    const tz = this.camTarget.z + this.lookSmooth.y;
    if (!this.camInit) {
      this.camPos.set(tx, 0, tz);
      this.camInit = true;
    }
    const lerp = 1 - Math.exp(-CONFIG.camera.lerp * dt);
    this.camPos.x += (tx - this.camPos.x) * lerp;
    this.camPos.z += (tz - this.camPos.z) * lerp;

    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 3);
    const s = this.shakeAmount * this.shakeAmount * 0.6;
    const t = this.time;
    const ox = (Math.sin(t * 53.1) + Math.sin(t * 31.7 + 1.3)) * 0.5 * s;
    const oz = (Math.sin(t * 47.3 + 2.1) + Math.sin(t * 29.9 + 0.4)) * 0.5 * s;

    this.camera.position.set(this.camPos.x + ox, CONFIG.camera.height, this.camPos.z + CONFIG.camera.back + oz);
    this.camera.lookAt(this.camPos.x + ox * 0.6, 0, this.camPos.z + oz * 0.6);
  }

  /**
   * Keeps the lamp light pool on the lamps nearest to the camera. A light
   * leaving a lamp fades out before it moves and fades in at the new one, so
   * lamps never blink on or off as the camera pans.
   */
  private placeLamps(dt: number): void {
    const cx = this.camTarget.x;
    const cz = this.camTarget.z;
    const pool = this.lampPool;
    const used = this.lampUsed;
    const wanted = this.lamps
      .map((l, i) => ({ i, on: l.on, d: Math.hypot(l.x - cx, l.z - cz) }))
      .filter((e) => e.on)
      .sort((a, b) => a.d - b.d)
      .slice(0, pool.length)
      .map((e) => e.i);
    const step = LAMP_INTENSITY * Math.min(1, dt * 4);
    for (let k = 0; k < pool.length; k++) {
      const light = pool[k];
      if (used[k] >= 0 && wanted.includes(used[k])) {
        light.intensity = Math.min(LAMP_INTENSITY, light.intensity + step);
        continue;
      }
      if (light.intensity > 0) {
        light.intensity = Math.max(0, light.intensity - step);
        continue;
      }
      // Dark and free: take a wanted lamp no other light holds.
      const next = wanted.find((i) => !used.includes(i)) ?? -1;
      used[k] = next;
      if (next < 0) continue;
      light.position.set(this.lamps[next].x, 3.4, this.lamps[next].z);
      light.color.setHex(this.lamps[next].color);
    }
  }

  private updateVision(dt: number, players: { x: number; z: number; ang: number; alive: boolean; flashOn: boolean; nv?: boolean }[]): void {
    const map = this.map;
    for (let i = 0; i < this.viewers.length; i++) {
      const v = this.viewers[i];
      const p = i < this.viewerCount ? players[i] : undefined;
      v.active = !!p && !!map;
      v.mesh.visible = v.active;
      this.exploredMeshes[i].visible = v.active;
      if (!p || !map) continue;
      // Flashlight on: long sight; off: eyes adjust, but you see less.
      // Night vision gives the long sight without the giveaway beam.
      v.range = p.flashOn || p.nv ? CONFIG.flashlight.visionOn : CONFIG.flashlight.visionOff;
      // Only walls (and closed doors) that can intersect the sight radius.
      const r = VISION.range + 2;
      const near = this.visionWalls;
      near.length = 0;
      for (const w of map.walls) {
        if (Math.abs(w.cx - p.x) - w.hw < r && Math.abs(w.cz - p.z) - w.hh < r) near.push(w);
      }
      for (const d of this.doorVisuals) if (d.openT < 0.5) near.push(d.body);
      // Dead players keep a small circle of sight around their body.
      v.compute(near, p.x, p.z, p.ang, [0, WALL_HEIGHT + 0.1], this.smokeCircles, CONFIG.smoke.insideSight);
    }

    for (const [id, visual] of this.actorVisuals) {
      if (!this.hostile(id)) {
        visual.setRevealed(1);
        continue;
      }
      const pos = visual.group.position;
      let seen = !this.map;
      for (const v of this.viewers) {
        if (!v.sees(pos.x, pos.z)) continue;
        // In a bush and quiet: only spotted right next to it.
        if (visual.concealed && Math.hypot(v.x - pos.x, v.z - pos.z) > CONFIG.bush.spotDist) continue;
        seen = true;
      }
      const prev = this.reveal.get(id) ?? 0;
      const a = seen ? Math.min(1, prev + dt * VISION.fadeIn) : Math.max(0, prev - dt * VISION.fadeOut);
      this.reveal.set(id, a);
      visual.setRevealed(a);
      // Lost sight of a living enemy: leave a marker where it was last seen.
      if (!seen && prev >= 1 && a < 1 && visual.alive) this.ghosts.spawn(pos.x, pos.z);
    }
  }

  render(): void {
    const r = this.renderer;
    // Accumulate what the squad sees into the memory texture (never cleared
    // during a level, so everything ever seen stays known).
    r.setRenderTarget(this.exploredTarget);
    if (this.exploredDirty) {
      r.setClearColor(0x000000, 1);
      r.clear();
      this.exploredDirty = false;
    }
    r.autoClear = false;
    r.render(this.exploredScene, this.exploredCam);
    r.autoClear = true;
    r.setRenderTarget(this.maskTarget);
    r.render(this.maskScene, this.camera);
    r.setRenderTarget(null);
    this.composer.render();
    r.autoClear = false;
    r.clearDepth();
    r.render(this.overlay, this.camera);
    r.autoClear = true;
  }

  get info(): THREE.WebGLInfo {
    return this.renderer.info;
  }
}

function decayLight(f: { light: THREE.PointLight; life: number; max: number; peak: number }, dt: number): void {
  if (f.life <= 0) return;
  f.life -= dt;
  f.light.intensity = Math.max(0, (f.life / f.max) * f.peak);
  if (f.life <= 0) f.light.intensity = 0;
}

function clampAbs(v: number, m: number): number {
  return Math.max(-m, Math.min(m, v));
}

/** Planar UVs from world XZ so textures tile at a fixed world scale. */
function worldUv(geo: THREE.BufferGeometry, metresPerTile: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, pos.getX(i) / metresPerTile, pos.getZ(i) / metresPerTile);
  }
}

/** A wall box with UVs scaled to its size and a pale vertex-colour cap. */
function wallBox(w: StaticBody, height: number): THREE.BufferGeometry {
  const sx = w.hw * 2;
  const sz = w.hh * 2;
  const geo = new THREE.BoxGeometry(sx, height, sz);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const colors = new Float32Array(uv.count * 3);
  const tile = 2.5;
  // BoxGeometry faces: +x, -x, +y, -y, +z, -z; 4 vertices each.
  const faceSize: [number, number][] = [
    [sz, height], [sz, height], [sx, sz], [sx, sz], [sx, height], [sx, height],
  ];
  for (let f = 0; f < 6; f++) {
    const [u, v] = faceSize[f];
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, (uv.getX(i) * u) / tile, (uv.getY(i) * v) / tile);
      const c = f === 2 ? 1.9 : 1;
      colors[i * 3] = c * 0.96;
      colors[i * 3 + 1] = c;
      colors[i * 3 + 2] = c * 1.05;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.translate(w.cx, height / 2, w.cz);
  return geo;
}

/** Props whose model is long along X (turned when the box is long along Z). */
const BUSH_BLOB_GEO = new THREE.IcosahedronGeometry(1, 1);

/** A ceiling lamp seen from above: a flat disc. */
const LAMP_FIXTURE_GEO = new THREE.CylinderGeometry(0.34, 0.34, 0.06, 20);

/** Ceiling lamp brightness at full fade-in. */
const LAMP_INTENSITY = 32;

const LONG_PROPS = new Set<PropKind>(['cover', 'car', 'table', 'pallet', 'ammo', 'cabinet']);

const FLOOR_STYLE: Record<RoomTheme, { tile: number; color: number; tex: 'asphalt' | 'concrete' | 'tiles' }> = {
  yard: { tile: 3.5, color: 0xa4a8ae, tex: 'asphalt' },
  warehouse: { tile: 4, color: 0x9a948a, tex: 'concrete' },
  office: { tile: 2.4, color: 0xb6b8b4, tex: 'tiles' },
  bunker: { tile: 3, color: 0x6c7670, tex: 'concrete' },
};

export const POWERUP_COLOR: Record<PowerupKind, number> = {
  medkit: 0x5dff8a,
  armor: 0x52a8ff,
  damage: 0xff4a4a,
  speed: 0xffe04a,
  rapid: 0xff9a2a,
  nv: 0x7dff6a,
};

/** Painted lines: warehouse lanes, parking bays in yards, hazard edges in bunkers. */
function floorMarkings(f: FloorRect, out: THREE.BufferGeometry[]): void {
  const line = (x0: number, z0: number, x1: number, z1: number, color: number) => {
    const geo = new THREE.PlaneGeometry(Math.max(0.08, x1 - x0), Math.max(0.08, z1 - z0));
    geo.rotateX(-Math.PI / 2);
    geo.translate((x0 + x1) / 2, 0.012, (z0 + z1) / 2);
    const c = new THREE.Color(color);
    const n = geo.attributes.position.count;
    const cols = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.toArray(cols, i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    geo.deleteAttribute('uv');
    out.push(geo);
  };
  const w = f.x1 - f.x0;
  const h = f.z1 - f.z0;
  if (w < 5 || h < 5) return;
  const inset = 1.4;
  if (f.theme === 'warehouse') {
    const y = 0xc9a227;
    line(f.x0 + inset, f.z0 + inset, f.x1 - inset, f.z0 + inset + 0.12, y);
    line(f.x0 + inset, f.z1 - inset - 0.12, f.x1 - inset, f.z1 - inset, y);
    line(f.x0 + inset, f.z0 + inset, f.x0 + inset + 0.12, f.z1 - inset, y);
    line(f.x1 - inset - 0.12, f.z0 + inset, f.x1 - inset, f.z1 - inset, y);
  } else if (f.theme === 'yard') {
    for (let x = f.x0 + 2.5; x < f.x1 - 2; x += 2.8) line(x, f.z0 + 1, x + 0.1, f.z0 + 4, 0xd8d8d0);
  } else if (f.theme === 'bunker') {
    for (let x = f.x0 + 1; x < f.x1 - 1; x += 1.2) line(x, f.z0 + 0.7, x + 0.6, f.z0 + 0.9, 0xd0a020);
  }
}

let tileTex: THREE.Texture | null = null;
/** Office floor: worn linoleum tiles. */
function makeTileTexture(): THREE.Texture {
  if (tileTex) return tileTex;
  const n = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const ctx = cv.getContext('2d')!;
  const cells = 4;
  const s = n / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const v = (x + y) % 2 ? 150 : 172;
      const j = Math.floor(Math.random() * 14);
      ctx.fillStyle = `rgb(${v + j},${v + j},${v - 4 + j})`;
      ctx.fillRect(x * s, y * s, s, s);
    }
  }
  ctx.strokeStyle = 'rgba(40,40,40,0.5)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= cells; i++) {
    ctx.beginPath();
    ctx.moveTo(i * s, 0);
    ctx.lineTo(i * s, n);
    ctx.moveTo(0, i * s);
    ctx.lineTo(n, i * s);
    ctx.stroke();
  }
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(30,25,20,${Math.random() * 0.12})`;
    ctx.beginPath();
    ctx.arc(Math.random() * n, Math.random() * n, 4 + Math.random() * 18, 0, Math.PI * 2);
    ctx.fill();
  }
  tileTex = new THREE.CanvasTexture(cv);
  tileTex.wrapS = tileTex.wrapT = THREE.RepeatWrapping;
  tileTex.colorSpace = THREE.SRGBColorSpace;
  tileTex.anisotropy = 8;
  return tileTex;
}

/** A powerup: glowing pad plus a spinning symbol in its colour. */
function powerupVisual(kind: PowerupKind): THREE.Group {
  const color = POWERUP_COLOR[kind];
  const g = new THREE.Group();
  const pad = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 1.6).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: makeGlowTexture(),
      color,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  pad.position.y = 0.03;
  g.add(pad);
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.6, roughness: 0.4 });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8 });
  const icon = new THREE.Group();
  if (kind === 'medkit') {
    icon.add(new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.36, 0.42), white));
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.38, 0.12), mat);
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.38, 0.4), mat);
    a.position.y = b.position.y = 0.01;
    icon.add(a, b);
  } else if (kind === 'armor') {
    const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.2, 0.55, 6), mat);
    icon.add(shield);
  } else if (kind === 'damage') {
    icon.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.34), mat));
  } else if (kind === 'speed') {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.6, 3), mat);
    c.rotation.z = -Math.PI / 2;
    icon.add(c);
  } else {
    const t = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.08, 8, 20), mat);
    t.rotation.x = Math.PI / 2;
    icon.add(t, new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), white));
  }
  icon.position.y = 0.8;
  icon.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  g.add(icon);
  return g;
}

const BEAM_MAT = new THREE.MeshBasicMaterial({
  color: 0xffe8b8,
  vertexColors: true,
  transparent: true,
  opacity: 0.32,
  blending: THREE.AdditiveBlending,
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
  side: THREE.DoubleSide,
});

let pickupPadTex: THREE.Texture | null = null;
/** A gun on the ground: the model floating over a glowing pad. */
function weaponPickupVisual(weapon: WeaponId): THREE.Group {
  if (!pickupPadTex) pickupPadTex = makeGlowTexture();
  const group = new THREE.Group();
  const pad = new THREE.Mesh(
    new THREE.PlaneGeometry(1.8, 1.8).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: pickupPadTex,
      color: 0x46e0d0,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  pad.position.y = 0.03;
  group.add(pad);
  const holder = new THREE.Group();
  holder.position.y = 0.7;
  const gun = assets.weapon(weapon);
  if (gun) {
    gun.model.position.x = -gun.length * (0.5 - gun.grip);
    holder.add(gun.model);
  } else {
    holder.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.08), new THREE.MeshStandardMaterial({ color: 0x2a2d33 })));
  }
  holder.scale.setScalar(1.3);
  group.add(holder);
  return group;
}

/** Soft round puff for smoke sprites. */
function makeSmokeTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}
