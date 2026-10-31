/**
 * Arena and gameplay checks (test/dm.ts) in headless Chrome.
 *
 *   npm run dev            # in another terminal
 *   npm run test:arenas
 */
import { chromium } from 'playwright';

const URL = process.env.DM_URL ?? 'http://127.0.0.1:5173/test/dm.html';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__result, null, { timeout: 280000 });
const result = await page.evaluate(() => window.__result);
await browser.close();

console.log(result);
for (const e of pageErrors) console.log(`page error: ${e}`);
const failed = /^([1-9]\d*) failures$/m.test(result) || pageErrors.length > 0;
process.exit(failed ? 1 : 0);
