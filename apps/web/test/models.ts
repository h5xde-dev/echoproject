/**
 * Asset preview: every normalised model in a row with axes, so orientation
 * and scale can be checked by eye. ?view=top|side|front
 */
import * as THREE from 'three';
import { assets } from '../src/render/assets';
import type { PropKind } from '@echo/shared/game/types';
import type { WeaponId } from '@echo/shared/game/weapons';

const view = new URLSearchParams(location.search).get('view') ?? 'side';
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

const cam = new THREE.PerspectiveCamera(35, el.clientWidth / el.clientHeight, 0.1, 200);
if (view === 'top') cam.position.set(20, 30, 0.01);
else if (view === 'front') cam.position.set(30, 2, 0);
else if (view === 'guns') cam.position.set(5.4, 1.6, 3.2);
else cam.position.set(14, 4, 26);
if (view === 'guns') cam.lookAt(5.4, 1, 0);
else cam.lookAt(14, view === 'top' ? 0 : 0.8, 0);

await assets.load();
let x = 0;
function place(obj: THREE.Object3D | null, w: number): void {
  if (!obj) { x += w; return; }
  obj.position.x = x;
  scene.add(obj);
  const axes = new THREE.AxesHelper(0.8);
  axes.position.set(x, 0.01, 0);
  scene.add(axes);
  x += w;
}
place(assets.character('player'), 1.6);
place(assets.character('enemy'), 1.6);
for (const id of ['smg', 'shotgun', 'rifle', 'sniper'] as WeaponId[]) {
  const w = assets.weapon(id);
  if (w) w.model.position.y = 1;
  place(w?.model ?? null, 1.5);
}
const sizes: Record<PropKind, [number, number]> = { crate: [1.5, 1.5], barrel: [1.2, 1.2], cover: [2.7, 0.8], table: [3, 1.7], chair: [1, 1], car: [4.2, 1.9], pallet: [2, 1.6], drum: [0.9, 0.9], cabinet: [1.1, 0.8], tires: [1.8, 1.8], ammo: [1.2, 0.7], wire: [1.5, 0.9], mine: [0.6, 0.6] };
for (const k of Object.keys(sizes) as PropKind[]) place(assets.prop(k, ...sizes[k]), sizes[k][0] + 0.6);
renderer.render(scene, cam);
(window as unknown as { __ready: boolean }).__ready = true;
