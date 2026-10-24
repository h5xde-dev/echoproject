import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage();
p.on('pageerror', e => console.log('ERR', e.message));
await p.goto('http://127.0.0.1:5179/test/dm.html');
await p.waitForFunction(() => window.__result, null, { timeout: 280000 });
console.log((await p.evaluate(() => window.__result)).split('\n').filter(l => /FAIL|failures|gait|silent|quieter|heard|spread|guard/.test(l)).join('\n'));
await b.close();
