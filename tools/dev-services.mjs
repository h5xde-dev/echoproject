// Development: builds the API, meta and game servers and runs all three with
// local settings (dev login, plain-http cookies, one fixed service secret).
// Pair with `npm run dev` (Vite proxies /api, /auth, /meta, /game to them).
//   npm run dev:services
import { spawn, spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const services = ['api', 'meta', 'game'];
const env = { ...process.env, DEV_LOGIN: '1', SECURE_COOKIES: '0', DB_PATH: process.env.DB_PATH ?? `${root}north.db` };

for (const s of services) {
  const r = spawnSync('npm', ['run', '-s', 'build', '-w', `@echo/${s}`], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const children = services.map((s) => {
  const child = spawn('node', [`apps/${s}/dist/main.mjs`], { cwd: root, env });
  const tag = `[${s}]`.padEnd(7);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (d) => {
      for (const line of String(d).split('\n')) if (line) console.log(`${tag}${line}`);
    });
  }
  child.on('exit', (code) => console.log(`${tag}exited ${code}`));
  return child;
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => children.forEach((c) => c.kill('SIGTERM')));
