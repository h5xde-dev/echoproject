export interface Vec2 {
  x: number;
  z: number;
}

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential smoothing. */
export function damp(a: number, b: number, lambda: number, dt: number): number {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

export function angleDiff(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDiff(a, b) * t;
}

export function len(x: number, z: number): number {
  return Math.hypot(x, z);
}

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

export function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

export function normalize(x: number, z: number): Vec2 {
  const l = Math.hypot(x, z);
  if (l < 1e-6) return { x: 0, z: 0 };
  return { x: x / l, z: z / l };
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function segCircleHit(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  cx: number,
  cz: number,
  r: number,
): number | null {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const fx = x0 - cx;
  const fz = z0 - cz;
  const a = dx * dx + dz * dz;
  if (a < 1e-9) return fx * fx + fz * fz <= r * r ? 0 : null;
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - r * r;
  let disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  disc = Math.sqrt(disc);
  const t1 = (-b - disc) / (2 * a);
  const t2 = (-b + disc) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}

export function pointInRect(
  px: number,
  pz: number,
  cx: number,
  cz: number,
  hw: number,
  hh: number,
): boolean {
  return px >= cx - hw && px <= cx + hw && pz >= cz - hh && pz <= cz + hh;
}

export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * WASD turned to follow the aim ("по прицелу"): W runs toward `aim`, S away
 * from it, A/D sideways. `mx`/`mz` are the keys on screen axes (W is z = -1);
 * the result is a world vector of the same length.
 */
export function aimRelativeMove(mx: number, mz: number, aim: number): { x: number; z: number } {
  const fx = Math.cos(aim);
  const fz = Math.sin(aim);
  // Right of the facing direction on a screen whose z points down.
  const rx = -fz;
  const rz = fx;
  const forward = -mz;
  return { x: fx * forward + rx * mx, z: fz * forward + rz * mx };
}
