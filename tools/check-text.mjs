// Fails when a source file holds U+FFFD: text broken by a bad encoding round
// trip (it once turned «СОЗДАТЬ КОМНАТУ» in the menu into question-mark diamonds).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['.'];
const skip = new Set(['node_modules', 'dist', 'server-dist', '.git', 'public', 'releases']);
const exts = /\.(ts|mts|mjs|js|html|css|md|json|sh|conf|service|timer)$/;
let bad = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (exts.test(name)) {
      readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
        if (line.includes(String.fromCharCode(0xfffd))) {
          console.error(`${path}:${i + 1}: broken character (U+FFFD): ${line.trim().slice(0, 80)}`);
          bad++;
        }
      });
    }
  }
}
for (const r of roots) walk(r);
if (bad) process.exit(1);
