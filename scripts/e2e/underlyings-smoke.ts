/**
 * Smoke test of the underlying picker in the issue flow, in a headless browser. Read-only: nothing is signed or sent.
 *
 *   (cd app && VITE_API_PROXY=https://notes.markets npx vite --port 5391)   # or against the local stack
 *   APP_URL=http://127.0.0.1:5391 npx tsx scripts/e2e/underlyings-smoke.ts
 *
 * Step 0: search "EUR", pick EUR/USD (physical settlement off, with the reason), continue to Review & issue;
 * ?demo=tsla still opens filled in; at phone width, browse the catalogue by class and build a worst-of basket.
 * SHOT=/path/x.png saves screenshots.
 */
import { chromium } from 'playwright';
const APP = process.env.APP_URL ?? 'http://127.0.0.1:5391';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errs: string[] = [];
page.on('pageerror', (e) => errs.push(e.message));
const next = () => page.getByRole('button', { name: /^Continue: / }).click();
let ok = true;
const check = (c: boolean, what: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'} ${what}`);
  if (!c) ok = false;
};

await page.goto(`${APP}/issue`);
await page.locator('[data-product="phoenix"]').click();
const group = page.locator('[aria-label="Underlyings"]');
await group.waitFor();
check((await group.locator('button').count()) >= 10, 'the Underlyings group lists the chosen and popular chips');
check(
  (await group.locator('[data-underlying="ETH"]').getAttribute('aria-pressed')) === 'true',
  'ETH chosen by default',
);
await page.getByLabel('Search underlyings').fill('EUR');
const opt = page.locator('[data-underlying-option="EUR"]');
await opt.waitFor();
check((await page.locator('[data-class="Forex"]').count()) === 1, 'search "EUR" shows a Forex group');
check((await opt.innerText()).includes('Chainlink · Ethereum'), 'EUR/USD shows its source: Chainlink · Ethereum');
await page.screenshot({ path: process.env.SHOT ?? '/tmp/und-search.png', fullPage: true });
await opt.click();
check(
  (await group.locator('[data-underlying="EUR"]').getAttribute('aria-pressed')) === 'true',
  'EUR chosen: its chip is in the Underlyings group',
);
check(
  (await group.locator('[data-underlying="ETH"]').getAttribute('aria-pressed')) === 'false',
  'single underlying: EUR replaced ETH',
);
const phys = page.getByRole('radio', { name: /The asset itself/ });
check(await phys.isDisabled(), 'physical settlement disabled for EUR');
check(
  /no token on .* to deliver.*cash/i.test((await page.locator('[data-physical-disabled]').getAttribute('title')) ?? ''),
  'the disabled physical option explains why',
);
await next(); // Terms
await next(); // Schedule
await next(); // Collateral
await next(); // Review
const body = await page.locator('main').innerText();
check(
  /Review/.test(body) && /Phoenix \(memory\) on EUR/.test(body),
  'reached Review & issue on EUR/USD, the default name follows (on EUR)',
);
await page.screenshot({
  path: (process.env.SHOT ?? '/tmp/und-search.png').replace('.png', '-review.png'),
  fullPage: true,
});

// The recorded demo still opens with every field filled in.
await page.goto(`${APP}/issue?product=reverse-convertible&demo=tsla`);
await group.waitFor();
check(
  (await group.locator('[data-underlying="TSLA"]').getAttribute('aria-pressed')) === 'true',
  '?demo=tsla: TSLA chosen',
);
await next();
await next();
await next();
await next();
check(/TSLA/.test(await page.locator('main').innerText()), '?demo=tsla reaches Review & issue');
// Phone width: browse the whole catalogue, grouped by class, without a horizontal scroll.
await page.setViewportSize({ width: 400, height: 900 });
await page.goto(`${APP}/issue`);
await page.locator('[data-product="worst-of"]').click();
await page.getByRole('button', { name: 'Browse all' }).click();
for (const c of ['Stocks', 'Crypto', 'Forex', 'Commodities'])
  check((await page.locator(`[data-class="${c}"]`).count()) === 1, `browse lists ${c}`);
check(await page.locator('[data-underlying-option="XAU"]').isDisabled(), 'the default basket (ETH, BTC, SOL) is full');
await group.locator('[data-underlying="SOL"]').click();
await group.locator('[data-underlying="BTC"]').click();
await page.locator('[data-underlying-option="XAU"]').click();
await page.locator('[data-underlying-option="EUR"]').click();
const chosen = await group
  .locator('[aria-pressed="true"]')
  .evaluateAll((b) => b.map((x) => x.getAttribute('data-underlying')));
check(chosen.includes('XAU') && chosen.includes('EUR') && chosen.length === 3, `worst-of basket: ${chosen.join(', ')}`);
check(await page.locator('[data-underlying-option="BTC"]').isDisabled(), 'a full basket (3) disables further picks');
check(await page.evaluate(() => document.documentElement.scrollWidth <= 400), 'no horizontal scroll at 400 px');
await page.screenshot({
  path: (process.env.SHOT ?? '/tmp/und-search.png').replace('.png', '-phone.png'),
  fullPage: false,
});
check(!errs.length, `no page errors${errs.length ? `: ${errs.join('; ')}` : ''}`);
await browser.close();
process.exit(ok ? 0 : 1);
