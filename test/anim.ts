/**
 * Animation check: soldiers with every weapon, idle / walking / dead, frozen
 * at a given time. ?view=side|top&t=seconds
 */
import * as THREE from 'three';
import { assets } from '../src/render/assets';
import { ActorVisual } from '../src/render/actors';
import type { WeaponId } from '../src/game/weapons';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'side';
const tEnd = Number(params.get('t') ?? '0.6');
const el = document.getElementById('v')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(el.clientWidth, el.clientHeight);
el.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x30343c);
scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(3, 6, 4);
scene.add(sun);
scene.add(new THREE.GridHelper(40, 40, 0x666666, 0x444444));
const cam = new THREE.PerspectiveCamera(30, el.clientWidth / el.clientHeight, 0.1, 200);
if (view === 'top') { cam.position.set(6, 16, 0.01); cam.lookAt(6, 0, 0); }
else { cam.position.set(6, 3.5, 11); cam.lookAt(6, 1, 0); }

await assets.load();
const weapons: WeaponId[] = ['pistol', 'smg', 'shotgun', 'rifle', 'sniper'];
const rows: { v: ActorVisual; a: { kind: 'player' | 'enemy'; x: number; z: number; ang: number; hp: number; alive: boolean; weapon: WeaponId }; vx: number }[] = [];
weapons.forEach((w, i) => {
  const kind = i % 2 ? 'enemy' : 'player';
  const v = new ActorVisual(i, 0x3fd6c8, kind === 'player');
  scene.add(v.group);
  // Front row stands, back row walks forward (+X is the aim direction... aim toward camera-right).
  rows.push({ v, a: { kind, x: i * 2.4, z: 0, ang: 0, hp: 100, alive: true, weapon: w }, vx: 0 });
  const v2 = new ActorVisual(10 + i, 0x3fd6c8, kind !== 'player');
  scene.add(v2.group);
  rows.push({ v: v2, a: { kind, x: i * 2.4, z: -3, ang: -0.6, hp: 100, alive: true, weapon: w }, vx: 5 });
});
const dt = 1 / 60;
const killAt = Number(params.get('kill') ?? '-1');
let killed = false;
for (let t = 0; t < tEnd; t += dt) {
  if (killAt >= 0 && t >= killAt && !killed) {
    killed = true;
    // Back row is shot from the camera side (+z), harder each column.
    rows.forEach((r, i) => {
      if (i % 2 === 0) return;
      r.v.setDeathImpulse(0.3, 1, 2 + i);
      r.a.alive = false;
      r.vx = 0;
    });
  }
  for (const r of rows) {
    r.a.x += r.vx * dt * Math.cos(r.a.ang);
    r.a.z += r.vx * dt * Math.sin(r.a.ang);
    r.v.update(r.a, dt);
  }
}
renderer.render(scene, cam);
(window as unknown as { __ready: boolean }).__ready = true;
