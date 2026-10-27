import * as THREE from 'three';

function noiseCanvas(size: number, base: [number, number, number], contrast: number, seed: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  let s = seed >>> 0;
  for (let i = 0; i < size * size; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const n = (s >>> 16) / 65535 - 0.5;
    const m = (s >>> 8) / 65535 - 0.5;
    const speck = ((s & 0xff) / 255 - 0.5) * 0.4;
    const v = 1 + (n * 0.6 + m * 0.4 + speck) * contrast;
    img.data[i * 4] = Math.max(0, Math.min(255, base[0] * v));
    img.data[i * 4 + 1] = Math.max(0, Math.min(255, base[1] * v));
    img.data[i * 4 + 2] = Math.max(0, Math.min(255, base[2] * v));
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/** Dark industrial concrete for floors. */
export function makeFloorTexture(size = 512): THREE.Texture {
  const cv = noiseCanvas(size, [104, 110, 124], 0.5, 0x1234abcd);
  const ctx = cv.getContext('2d')!;

  // Faint panel seams.
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 2;
  const step = size / 4;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * step);
    ctx.lineTo(size, i * step);
    ctx.stroke();
  }

  // Scuffs and stains.
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 6 + Math.random() * 42;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const dark = Math.random() < 0.6;
    g.addColorStop(0, dark ? 'rgba(0,0,0,0.22)' : 'rgba(150,160,180,0.07)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Heavier concrete for walls. */
export function makeWallTexture(size = 256): THREE.Texture {
  const cv = noiseCanvas(size, [96, 104, 120], 0.4, 0x77aa3311);
  const ctx = cv.getContext('2d')!;
  for (let i = 0; i < 30; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const w = 4 + Math.random() * 30;
    const h = 2 + Math.random() * 6;
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(x, y, w, h);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft round sprite used for particles and glows. */
export function makeGlowTexture(size = 64): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Hazard stripe used on barrels. */
export function makeBarrelTexture(): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 64;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#8a4a1c';
  ctx.fillRect(0, 0, 128, 64);
  ctx.fillStyle = '#e0a23a';
  for (let i = -64; i < 128; i += 26) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 13, 0);
    ctx.lineTo(i - 20, 64);
    ctx.lineTo(i - 33, 64);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(0, 0, 128, 6);
  ctx.fillRect(0, 58, 128, 6);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Forest floor: dark grass and earth, patchy. */
/** Churned earth: mud, stones and boot-trodden ruts. */
export function makeDirtTexture(size = 512): THREE.Texture {
  const cv = noiseCanvas(size, [86, 70, 50], 0.5, 0xd127d127);
  const ctx = cv.getContext('2d')!;
  for (let i = 0; i < 50; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 10 + Math.random() * 40;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, Math.random() < 0.6 ? 'rgba(34,26,18,0.3)' : 'rgba(130,112,84,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Pebbles.
  for (let i = 0; i < 500; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(150,140,124,0.5)' : 'rgba(40,32,24,0.5)';
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, 0.8 + Math.random() * 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function makeGrassTexture(size = 512): THREE.Texture {
  const cv = noiseCanvas(size, [58, 78, 42], 0.45, 0x5eed6a55);
  const ctx = cv.getContext('2d')!;
  // Bare earth and darker clumps.
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 14 + Math.random() * 46;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const earth = Math.random() < 0.5;
    g.addColorStop(0, earth ? 'rgba(82,66,42,0.3)' : 'rgba(20,34,14,0.18)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Blades: short strokes.
  ctx.lineWidth = 1;
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 0.9;
    const l = 3 + Math.random() * 5;
    ctx.strokeStyle = Math.random() < 0.5 ? 'rgba(96,128,64,0.35)' : 'rgba(24,40,18,0.35)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
