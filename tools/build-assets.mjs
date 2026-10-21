// Builds the browser asset pack in public/assets/ from the frontline (Godot)
// asset library. The sources are large desktop assets (1–130 MB each), so
// every model is welded, simplified, gets WebP textures capped at a small size
// and meshopt compression; textures are cropped and made tileable.
// Output is committed, so deploys do not depend on the frontline folder.
//
//   FRONTLINE_ASSETS=~/frontline/assets node tools/build-assets.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, metalRough, meshopt, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const SRC = process.env.FRONTLINE_ASSETS ?? join(homedir(), 'frontline/assets');
const OUT = new URL('../public/assets/', import.meta.url).pathname;

/** name -> source, texture size cap, simplify ratio (1 = keep), nodes / materials to remove. */
const MODELS = {
  soldier: { src: 'ostrov/characters/army_soldier_character.glb', tex: 512, ratio: 1 },
  enemy: { src: 'characters/russian_soldier_mixamo.glb', tex: 512, ratio: 1 },
  w_smg: { src: 'ostrov/weapons/m4_free.glb', tex: 256, ratio: 0.6 },
  w_shotgun: { src: 'ostrov/weapons/shotgun.glb', tex: 256, ratio: 0.2 },
  // Loose cartridges lie next to the RPK in the source scene.
  w_rifle: { src: 'ostrov/weapons/low_poly_rpk_16.glb', tex: 256, ratio: 0.3, dropMaterials: ['bullet', 'casing', 'primer'] },
  w_sniper: { src: 'ostrov/weapons/ak47_with_scope.glb', tex: 256, ratio: 0.3 },
  p_crate: { src: 'ostrov/props/crate_box.glb', tex: 512, ratio: 1 },
  // The source has a second, toppled barrel next to the standing one.
  p_barrel: { src: 'ostrov/props/oil_barrel.glb', tex: 512, ratio: 0.6, drop: ['barrel_oil1_barrel_oil_0'] },
  p_cover: { src: 'ostrov/fences/concrete_barier_medium_01.glb', tex: 512, ratio: 1 },
  p_table: { src: 'ostrov/props/soviet_weapon_box.glb', tex: 512, ratio: 1 },
  p_chair: { src: 'ostrov/props/old_soviet_trash_can.glb', tex: 256, ratio: 1 },
  p_car: { src: 'ostrov/vehicles/zaaz_s844w_soviet.glb', tex: 512, ratio: 1 },
  p_pallet: { src: 'ostrov/props/wooden_boxes.glb', tex: 512, ratio: 0.6 },
  p_drum: { src: 'ostrov/props/oil_drum.glb', tex: 256, ratio: 0.25 },
  p_cabinet: { src: 'ostrov/props/electrical_box_free.glb', tex: 512, ratio: 1 },
  p_tires: { src: 'ostrov/props/pile_of_old_tires.glb', tex: 512, ratio: 0.06 },
  p_ammo: { src: 'ostrov/props/ammo_box.glb', tex: 256, ratio: 0.5 },
};

/** Textures: source, square crop (x, y, side as fractions of the image), output size. */
const TEXTURES = {
  // One clean patch of the scanned asphalt atlas (uniform, so mirroring is invisible).
  floor: { src: 'ostrov/ground/asphalt_texture_3d_scan_0.png', crop: [0.335, 0.03, 0.25], size: 512 },
  floor_n: { src: 'ostrov/ground/asphalt_texture_3d_scan_1.png', crop: [0.335, 0.03, 0.25], size: 512 },
  wall: { src: 'ostrov/fences/soviet_concrete_block_0.png', crop: [0.1, 0.4, 0.5], size: 512 },
};

const SOUNDS = [
  ...Array.from({ length: 8 }, (_, i) => `ak_shot_0${i + 1}`),
  ...Array.from({ length: 4 }, (_, i) => `ak_shot_far_0${i + 1}`),
];

mkdirSync(OUT, { recursive: true });

async function buildModels() {
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

  for (const [name, cfg] of Object.entries(MODELS)) {
    const doc = await io.read(join(SRC, cfg.src));
    for (const node of doc.getRoot().listNodes()) {
      if (cfg.drop?.includes(node.getName())) node.dispose();
    }
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        if (cfg.dropMaterials?.includes(prim.getMaterial()?.getName())) prim.dispose();
      }
    }
    // three.js dropped spec-gloss materials; convert to metal-rough.
    const steps = [metalRough(), dedup(), prune(), weld()];
    if (cfg.ratio < 1) steps.push(simplify({ simplifier: MeshoptSimplifier, ratio: cfg.ratio, error: 0.002 }));
    steps.push(
      textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 80, resize: [cfg.tex, cfg.tex] }),
      prune(),
      meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
    );
    await doc.transform(...steps);
    await io.write(join(OUT, `${name}.glb`), doc);
  }
}

/**
 * Crops a square from the scan. The game samples it with mirrored repeat,
 * which wraps without seams and hides the crop's edges.
 */
async function buildTextures() {
  for (const [name, cfg] of Object.entries(TEXTURES)) {
    const img = sharp(join(SRC, cfg.src)).removeAlpha();
    const meta = await img.metadata();
    const [fx, fy, fs] = cfg.crop;
    const side = Math.floor(meta.width * fs);
    await img
      .extract({ left: Math.floor(meta.width * fx), top: Math.floor(meta.height * fy), width: side, height: side })
      .resize(cfg.size, cfg.size)
      .webp({ quality: 82 })
      .toFile(join(OUT, `${name}.webp`));
  }
}

function buildSounds() {
  mkdirSync(join(OUT, 'sfx'), { recursive: true });
  for (const name of SOUNDS) {
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', join(SRC, 'audio/sfx', `${name}.wav`),
      '-af', 'silenceremove=start_periods=1:start_threshold=-45dB',
      '-ac', '1', '-b:a', '96k',
      join(OUT, 'sfx', `${name}.mp3`),
    ]);
  }
}

function dirSize(dir) {
  let total = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const s = statSync(p);
    total += s.isDirectory() ? dirSize(p) : s.size;
  }
  return total;
}

if (!existsSync(SRC)) {
  console.error(`Asset library not found: ${SRC}`);
  process.exit(1);
}
if (!process.argv.includes('--textures-only')) await buildModels();
await buildTextures();
buildSounds();
for (const f of readdirSync(OUT)) {
  const p = join(OUT, f);
  if (statSync(p).isFile()) console.log(`${(statSync(p).size / 1024).toFixed(0).padStart(6)} KB  ${f}`);
}
console.log(`total ${(dirSize(OUT) / 1024 / 1024).toFixed(2)} MB`);
