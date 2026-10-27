// Landing page screenshots (public/shots/*.webp) from a running dev server.

import { chromium } from 'playwright';
import sharp from 'sharp';
const base = process.env.SHOTS_URL ?? 'http://127.0.0.1:5173';
const out = new URL('../public/shots/', import.meta.url).pathname;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu'] });
async function shot(name, mode, arena) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.log('err', e.message));
  await page.goto(base + '/play');
  await page.waitForFunction(() => !document.querySelector('#btn-solo').disabled, null, { timeout: 120000 });
  await page.click(`.mode-card[data-mode="${mode}"]`);
  if (arena) await page.click(`.arena-btn[data-arena="${arena}"]`);
  await page.click('#btn-solo');
  await page.mouse.move(1100, 380);
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyD');
  await page.waitForTimeout(5000);
  const buf = await page.screenshot();
  await sharp(buf).resize(960, 540).webp({ quality: 78 }).toFile(out + name + '.webp');
  await page.close();
}
if (!process.env.ONLY) await shot('coop', 'coop');
await shot('arena', 'dm', process.env.ARENA ?? 'sklad');
await browser.close();
console.log('done');
