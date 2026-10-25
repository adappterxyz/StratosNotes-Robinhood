-- One-off reset of the notes.markets D1 read model for the switch to Robinhood Chain testnet as the only note chain.
-- NOT a migration (it lives outside web/migrations, so `wrangler d1 migrations apply` never runs it). Run it once,
-- by hand, after the fresh FlowEngine/NotesLens deploy and the regenerated deployments/server/*.json, and before (or
-- right after) the Worker deploy; the Worker's cron then re-indexes the new engine from its deploy block:
--
--   npx wrangler d1 execute notes-markets --remote --file web/reset/0000_robinhood_reset.sql --config web/wrangler.jsonc
--
-- (from the repo root; from web/ drop --config and use --file reset/0000_robinhood_reset.sql). Try it first on a
-- local copy: the same command with --local instead of --remote.
--
-- What it clears: everything indexed from the earlier engines (Arbitrum Sepolia v1-v4 and the earlier Robinhood
-- Chain testnet engines, none of which this build serves): the per-engine cursors (chains), block hashes (blocks),
-- events, definitions, notes, note_underlyings, holdings and live-update changes; queued alert emails and the
-- "Emails sent" copies that concern those notes (note_id set); and saved templates whose terms only made sense on
-- the Arbitrum build (note on arbitrum-sepolia, collateral locked on Robinhood Chain as .rh receipts). The API hides
-- such templates anyway (templateOffered); deleting them keeps the library's 500-row window for live ones.
--
-- What it keeps: email_bindings (verified emails per wallet address, unchanged across chains; note the NEW engine
-- has no on-chain email attestations yet, so wallets re-attest in the app on their next issue or subscribe), account
-- emails with no note (verification codes, note_id NULL), the other templates (chain-neutral term sheets: they
-- compile to the same definition on Robinhood Chain), rate_limits and d1_migrations.

DELETE FROM changes;
DELETE FROM holdings;
DELETE FROM note_underlyings;
DELETE FROM notes;
DELETE FROM definitions;
DELETE FROM events;
DELETE FROM blocks;
DELETE FROM chains;

DELETE FROM email_outbox WHERE note_id IS NOT NULL;

DELETE FROM templates
WHERE entry LIKE '%"arbitrum-sepolia"%'
   OR entry LIKE '%"collateralChain":"robinhood"%'
   OR entry LIKE '%.rh"%'
   OR entry LIKE '%"stockTokens"%';
