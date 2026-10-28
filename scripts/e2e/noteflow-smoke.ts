/**
 * Smoke test of the note diagram ("How this note runs") and the Issue page's three ways in, in a headless browser.
 * Read-only: nothing is signed or sent.
 *
 *   (cd app && VITE_API_PROXY=https://notes.markets npx vite --port 5391)   # or against the local stack
 *   APP_URL=http://127.0.0.1:5391 npx tsx scripts/e2e/noteflow-smoke.ts
 *
 * Note page (the newest note on the current engine): expand the diagram, click a step and see its values, open full
 * screen and close it with Esc (focus back on the button), and at 400 px no horizontal page scroll. Issue: the three
 * ways in and no blank-canvas entry; a recent note opens the wizard prefilled; /issue/advanced with nothing loaded
 * points back to the ways in. SHOT_DIR=/path saves screenshots of the diagram (desktop and 400 px).
 */
import { chromium } from 'playwright';
const APP = process.env.APP_URL ?? 'http://127.0.0.1:5391';
const SHOTS = process.env.SHOT_DIR ?? '/tmp';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errs: string[] = [];
page.on('pageerror', (e) => errs.push(e.message));
let ok = true;
const check = (c: boolean, what: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'} ${what}`);
  if (!c) ok = false;
};
/** A screenshot of the diagram section, scrolled to sit just under the sticky top bar. */
const shot = async (name: string) => {
  await page
    .locator('[data-noteflow]')
    .evaluate((e) => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 120));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};
const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// ---- the note page --------------------------------------------------------------------------------------------
const cfg = await (await fetch(`${APP}/api/config`)).json();
const engines = new Set(cfg.chains.map((c: { key: string; engine: string }) => `${c.key}:${c.engine.toLowerCase()}`));
const { notes } = await (await fetch(`${APP}/api/notes?status=all&limit=50`)).json();
const note = (notes as Array<{ id: string; view: { createdAt: number; activeSteps: string[] } }>)
  .filter((n) => engines.has(n.id.split(':').slice(0, 2).join(':')))
  .sort((a, b) => b.view.createdAt - a.view.createdAt)[0];
check(!!note, `a note on the current engine: ${note?.id}`);

await page.goto(`${APP}/note/${encodeURIComponent(note.id)}`);
const toggle = page.locator('[data-noteflow-toggle]');
await toggle.waitFor();
if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click(); // start collapsed
check((await toggle.getAttribute('aria-expanded')) === 'false', 'the diagram section starts collapsed');
await toggle.click();
check((await toggle.getAttribute('aria-expanded')) === 'true', 'expanding "How this note runs"');
const steps = page.locator('.fm-canvas .djs-element[tabindex="0"]');
await steps.first().waitFor();
check((await steps.count()) > 10, `the diagram's steps are focusable buttons (${await steps.count()})`);
const active = note.view.activeSteps[0];
if (active)
  check(
    (await page.locator(`.fm-canvas [data-element-id="${active}"]`).getAttribute('class'))?.includes('active-step') ??
      false,
    `where the note is now is highlighted (${active})`,
  );
// Readable: the diagram never fits below 80%.
const scale = Number((await page.locator('.fm-scale').first().innerText()).replace('%', ''));
check(scale >= 80, `drawn at a readable scale (${scale}%)`);
// A step: click it, see its values.
await page.locator('.fm-canvas [data-element-id="Task_FixStrike"]').click();
const panel = page.locator('[data-step-panel]');
await panel.waitFor();
const text = await panel.innerText();
check(/Fix Strike/.test(text) && /strike/i.test(text), 'clicking Fix Strike shows its panel');
check(
  (await panel.locator('[data-fact]').count()) > 0,
  `the panel shows values (${await panel.locator('[data-fact]').count()})`,
);
check(/Done|Here now|Not reached/.test(text), 'the panel says whether the step ran');
// Keyboard: focusing a step shows it too.
await page.locator('.fm-canvas [data-element-id="Task_IssueNote"]').focus();
check(
  /Issue Note/.test(await panel.locator('[data-step-title]').innerText()),
  'focusing a step with the keyboard shows it',
);
// Zoom.
await page.getByRole('button', { name: 'Zoom in' }).first().click();
const zoomed = Number((await page.locator('.fm-scale').first().innerText()).replace('%', ''));
check(zoomed > scale, `zoom in (${scale}% -> ${zoomed}%)`);
await page.getByRole('button', { name: 'Fit to width' }).first().click();
await shot('note-diagram-desktop');
// Full screen, closed with Esc.
await page.locator('[data-fullscreen]').click();
const dialog = page.locator('[data-noteflow-dialog]');
await dialog.locator('.fm-canvas .djs-element[tabindex="0"]').first().waitFor();
check(await dialog.evaluate((d) => (d as HTMLDialogElement).open), 'full screen opens');
check(
  await page.evaluate(() => !!document.activeElement?.closest('[data-noteflow-dialog]')),
  'focus moves into the full-screen view',
);
const box = await dialog.boundingBox();
check(!!box && box.width >= 1270 && box.height >= 890, 'full screen fills the viewport');
check((await dialog.getByRole('button', { name: 'Zoom in' }).count()) === 1, 'zoom controls in full screen');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check(!(await dialog.evaluate((d) => (d as HTMLDialogElement).open)), 'Esc closes full screen');
check(
  await page.evaluate(() => document.activeElement?.hasAttribute('data-fullscreen') ?? false),
  'focus returns to the Full screen button',
);
// Remembered per viewer.
await page.reload();
await page.locator('[data-noteflow-toggle]').waitFor();
check(
  (await page.locator('[data-noteflow-toggle]').getAttribute('aria-expanded')) === 'true',
  'the open section is remembered on reload',
);
// Phone width.
await page.setViewportSize({ width: 400, height: 900 });
await page.locator('.fm-canvas .djs-element[tabindex="0"]').first().waitFor();
await page.waitForTimeout(400);
check(await noHScroll(), 'no horizontal page scroll at 400 px (the diagram scrolls in its own box)');
const sc = page.locator('.fm-scroll').first();
check(
  await sc.evaluate((e) => e.scrollWidth > e.clientWidth && getComputedStyle(e).overflowX === 'auto'),
  'the diagram scrolls sideways inside its container',
);
await shot('note-diagram-400');
await page.locator('[data-fullscreen]').click();
await page.waitForTimeout(300);
await page.locator('[data-close-fullscreen]').click();
check(!(await dialog.evaluate((d) => (d as HTMLDialogElement).open)), 'the Close button closes full screen');

// ---- Issue: three ways in -------------------------------------------------------------------------------------
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto(`${APP}/issue`);
await page.locator('[data-door="describe"]').waitFor();
for (const d of ['from', 'wizard', 'describe'])
  check((await page.locator(`[data-door="${d}"]`).count()) === 1, `Issue shows the way in: ${d}`);
const body = await page.locator('main').innerText();
check(!/blank/i.test(body), 'no blank workflow / blank canvas entry');
check((await page.locator('main a[href*="/issue/advanced"]').count()) === 0, 'no link to an empty advanced editor');
const recent = page.locator('[data-recent]').first();
await recent.waitFor();
const recentName = (await recent.locator('strong').first().innerText()).trim();
await recent.click();
await page.locator('[data-started-from]').waitFor();
check(
  /ready=note%3A|ready=note:/.test(page.url()) && /step=2/.test(page.url()),
  'a recent note opens the wizard at the schedule',
);
check(
  (await page.locator('[data-started-from]').innerText()).includes(recentName),
  `the wizard says it started from ${recentName}, terms filled in`,
);
for (let i = 0; i < 2; i++) await page.getByRole('button', { name: /^Continue: / }).click();
await page.locator('[data-review-flow] .fm-canvas .djs-element[tabindex="0"]').first().waitFor();
check(true, "the review shows the note's workflow diagram");
check((await page.locator('[data-open-advanced]').count()) === 1, 'the review offers Open in advanced editor');

// ---- the advanced editor with nothing loaded --------------------------------------------------------------------
await page.goto(`${APP}/issue/advanced`);
await page.locator('[data-advanced-empty]').waitFor();
check(
  (await page.locator('.ws-start a[href*="/issue"]').count()) === 3,
  '/issue/advanced, nothing loaded: points to the three ways in',
);
check((await page.getByRole('button', { name: /blank/i }).count()) === 0, 'and offers no blank workflow');

check(!errs.length, `no page errors${errs.length ? `: ${errs.join('; ')}` : ''}`);
console.log(`screenshots: ${SHOTS}/note-diagram-desktop.png ${SHOTS}/note-diagram-400.png`);
await browser.close();
process.exit(ok ? 0 : 1);
