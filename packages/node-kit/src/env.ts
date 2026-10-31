import { existsSync, readFileSync } from 'node:fs';

// Settings come from the environment: systemd's EnvironmentFile in production
// (/etc/northecho/env), an optional .env file next to the service when
// developing. Secrets never live in the repository.

/** Reads KEY=value lines into process.env (values already set win). */
export function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export const env = (key: string, fallback = ''): string => process.env[key] ?? fallback;
export const envNum = (key: string, fallback: number): number => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && process.env[key] !== '' && process.env[key] !== undefined ? v : fallback;
};

/**
 * The secret the services sign tickets and internal calls with. Production
 * refuses to start without one; development gets a fixed one so the three
 * services agree without setup.
 */
export function serviceSecret(): string {
  const s = env('SERVICE_SECRET');
  if (s) return s;
  if (env('NODE_ENV') === 'production') throw new Error('SERVICE_SECRET is not set');
  return 'dev-secret-not-for-production';
}
