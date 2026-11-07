/**
 * Smoke test of the two note chains (Robinhood Chain testnet and Base Sepolia) and cross-chain collateral in the app,
 * in a headless browser, with NOTHING deployed: the built app is served by `vite preview` and every /api call is
 * answered here from a local served-config fixture (app/src/lib/multichain.fixture.ts: both chains, both
 * gateway–vault pairs, synthetic addresses) plus two notes (one per chain). Chain RPCs point at a closed local port,
 * so no chain is read and nothing is signed or sent.
 *
 *   npm -w app run build && npx tsx scripts/e2e/multichain.e2e.ts      # PORT=5392 by default; SHOT_DIR=/path for screenshots
 *
 * Checks: the header names both networks; the marketplace has a network filter and lists the Base note under Base;
 * the issue wizard shows a network picker with both chains, and picking Base switches the cash token to USDC; the
 * Collateral step offers "held on Robinhood Chain", whose chips are Robinhood's stock tokens locked there (TSLA.rh…);
 * the review's issue panel renders the "Lock collateral on Robinhood Chain testnet" panel; the faucet menu is per chain.
 */
import { spawn } from 'node:child_process';
import { chromium, type Route } from 'playwright';
import { compileTemplate, definitionId, EXAMPLE_PRODUCTS, FEEDS, type ProductParams } from '@sn/core';
import { noteId, noteView, type NoteState } from '@sn/sdk';
import { FIXTURE, multichainConfig } from '../../app/src/lib/multichain.fixture';

const PORT = Number(process.env.PORT ?? 5392);
const APP = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR;
const DEAD_RPC = 'http://127.0.0.1:9'; // closed: the app never reaches a chain

let ok = true;
const check = (c: boolean, what: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'} ${what}`);
  if (!c) ok = false;
};

// ---- the fixture: served config and one note per chain ---------------------------------------------------------
const config = multichainConfig({ 'robinhood-testnet': DEAD_RPC, 'base-sepolia': DEAD_RPC });
const now = Math.floor(Date.now() / 1000);
function note(chain: 'robinhood-testnet' | 'base-sepolia', p: ProductParams, pid: number) {
  const c = compileTemplate({ product: p });
  const engine = FIXTURE[chain].engine;
  const state: NoteState = {
    id: noteId(chain, engine, pid),
    chain,
    engine,
    pid: String(pid),
    definition: definitionId(c),
    creator: '0x00000000000000000000000000000000000000aa',
    ref: '',
    roles: [],
    assetTokens: [],
    status: 0,
    tokens: [],
    stepsRun: 0,
    values: {},
    holdings: [],
    createdAt: now - 60,
    updatedAt: now - 60,
    reports: { cre: 0, fallback: 0, last: null },
  };
  return { id: state.id, chain, definition: state.definition, view: noteView(c.def, state) };
}
const baseNote = note(
  'base-sepolia',
  {
    ...EXAMPLE_PRODUCTS['reverse-convertible'],
    name: 'TSLA RC on Base, TSLA locked on Robinhood Chain',
    chain: 'base-sepolia',
    underlyings: [FEEDS.TSLA],
    collateralChain: 'robinhood-testnet',
    collateral: [{ symbol: 'TSLA', haircutPct: 60 }],
  },
  1,
);
const rhNote = note('robinhood-testnet', { ...EXAMPLE_PRODUCTS.phoenix, name: 'ETH phoenix on Robinhood Chain' }, 1);
const notes = [rhNote, baseNote];

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// ---- serve the built app ---------------------------------------------------------------------------------------
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: new URL('../../app/', import.meta.url).pathname,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stop = () => server.kill('SIGTERM');
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(APP)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.route('**/api/**', (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    if (p === '/api/config') return json(route, config);
    if (p === '/api/notes') return json(route, { notes, next: null });
    if (p.startsWith('/api/notes/')) {
      const n = notes.find((x) => p === `/api/notes/${encodeURIComponent(x.id)}`);
      return n
        ? json(route, { state: { ...n.view, id: n.id }, view: n.view })
        : json(route, { error: 'not found' }, 404);
    }
    if (p === '/api/templates') return json(route, []);
    if (p.startsWith('/api/portfolio')) return json(route, { positions: [], payouts: [] });
    return json(route, { error: 'not mocked' }, 404);
  });

  // The header and the marketplace.
  await page.goto(`${APP}/`);
  await page.locator('[data-networks]').waitFor();
  const nets = await page.locator('[data-networks]').innerText();
  check(/Robinhood Chain testnet/.test(nets) && /Base Sepolia/.test(nets), `the header names both networks (${nets})`);
  const filter = page.locator('[data-chain-filter]');
  check(await filter.isVisible(), 'the marketplace has a network filter');
  check(
    (await filter.locator('[data-chain]').allInnerTexts()).join('|') === 'All networks|Robinhood Chain|Base',
    'filter: All networks, Robinhood Chain, Base',
  );
  // Show every note, not only open books (the fixture's notes have no strike date).
  const open = page.getByRole('button', { name: 'Open now' });
  if ((await open.getAttribute('aria-pressed')) === 'true') await open.click();
  await page.locator('[data-note]').first().waitFor();
  check((await page.locator('[data-note]').count()) === 2, 'both notes listed under All networks');
  await filter.locator('[data-chain="base-sepolia"]').click();
  const rows = page.locator('[data-note]');
  check(
    (await rows.count()) === 1 && (await rows.first().getAttribute('data-note')) === baseNote.id,
    'Base lists only the Base note',
  );
  check((await rows.first().locator('[data-note-chain]').innerText()) === 'Base', 'the row says Base');
  check(
    /TSLA locked on Robinhood Chain/.test(await rows.first().innerText()),
    'the Base note says its TSLA collateral is locked on Robinhood Chain',
  );
  await filter.locator('[data-chain="robinhood-testnet"]').click();
  check(
    (await rows.count()) === 1 && (await rows.first().getAttribute('data-note')) === rhNote.id,
    'Robinhood Chain lists only the Robinhood Chain note',
  );
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/multichain-marketplace.png` });

  // The issue wizard: the network picker.
  await page.goto(`${APP}/issue?product=reverse-convertible&step=0`);
  const picker = page.locator('[data-chain-picker]');
  await picker.waitFor();
  check(
    (await picker.locator('[data-chain]').allInnerTexts()).join('|') === 'Robinhood Chain|Base',
    'the issue wizard picks between Robinhood Chain and Base',
  );
  check(
    (await picker.locator('[data-chain="robinhood-testnet"]').getAttribute('aria-checked')) === 'true',
    'Robinhood Chain is the default',
  );
  check(/USDG/.test(await page.locator('[data-issue-network]').innerText()), 'on Robinhood Chain the cash is USDG');
  await picker.locator('[data-chain="base-sepolia"]').click();
  check(
    (await page.locator('[data-issue-network]').getAttribute('data-issue-network')) === 'base-sepolia',
    'picking Base moves the note to Base Sepolia',
  );
  check(/paid in USDC/.test(await page.locator('[data-issue-network]').innerText()), 'on Base the cash is USDC');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/multichain-network.png` });

  // On to Collateral: held on Robinhood Chain, Robinhood's stock tokens locked there.
  for (let s = 0; s < 3; s++) await page.locator('.iw-nav .btn.primary').click();
  const held = page.locator('[data-held-on]');
  await held.waitFor();
  check((await held.getAttribute('data-held-on')) === 'note', 'collateral starts in the note');
  const onRh = held.locator('[data-held-on-choice="robinhood-testnet"]');
  check(await onRh.isEnabled(), '"Robinhood Chain, locked via Chainlink CCIP" is offered (its pair is served)');
  await onRh.click();
  check((await held.getAttribute('data-held-on')) === 'robinhood-testnet', 'collateral now held on Robinhood Chain');
  const chips = page.getByRole('group', { name: 'Collateral' });
  const chipText = (await chips.innerText()).replace(/\s+/g, ' ');
  check(
    ['TSLA', 'AMZN', 'AMD', 'PLTR', 'USDG', 'WETH'].every((t) => chipText.includes(t)),
    `the chips are the tokens locked on Robinhood Chain (${chipText})`,
  );
  check((await chips.locator('[data-remote="rh"]').count()) >= 6, 'each chip is a .rh receipt');
  await chips.getByRole('button', { name: /TSLA/ }).click();
  check(
    (await chips.getByRole('button', { name: /TSLA/ }).getAttribute('aria-pressed')) === 'true',
    'TSLA (locked on Robinhood Chain) picked',
  );
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/multichain-collateral.png`, fullPage: true });

  // Review: the issue panel's lock step on Robinhood Chain.
  await page.locator('.iw-nav .btn.primary').click();
  const lock = page.locator('[data-xc-lock="robinhood-testnet"]');
  await lock.waitFor({ timeout: 20_000 }).catch(() => {});
  check(await lock.isVisible(), 'the review shows "Lock collateral on Robinhood Chain testnet"');
  check(/TSLA/.test(await lock.innerText().catch(() => '')), 'the lock panel offers TSLA');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/multichain-lock.png`, fullPage: true });

  check(errs.length === 0, `no page errors${errs.length ? `: ${errs.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  stop();
}
console.log(ok ? 'multichain smoke: all good' : 'multichain smoke: FAILED');
process.exit(ok ? 0 : 1);
