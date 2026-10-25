#!/usr/bin/env bash
# Seed the live testnet after scripts/deploy-testnets.sh: two short-dated demo notes on Robinhood Chain testnet (a
# worst-of phoenix on ETH/BTC and one on TSLA/NVDA, both cash-settled, USDG collateral) with part of the book sold,
# and the template library through the API. Cash and collateral are Paxos's USDG on Robinhood Chain: the deployer
# key (.keys/deployer.json, issuer and paying agent) must hold the collateral plus what the demo investors subscribe
# with (default 2 x (1,000 + 1,000) = 4,000 USDG; faucet.paxos.com) and testnet ETH for gas for itself and the
# investors (faucet.testnet.chain.robinhood.com).
#
#   bash scripts/seed.sh                         # notes + templates (API=https://notes.markets)
#   STRIKE_IN=1800 OBS_EVERY=600 bash scripts/seed.sh
#   SKIP_TEMPLATES=1 bash scripts/seed.sh
set -euo pipefail
cd "$(dirname "$0")/.."
CHAIN=robinhood-testnet NOTE=crypto npx tsx scripts/seed-note.ts
CHAIN=robinhood-testnet NOTE=equity npx tsx scripts/seed-note.ts
if [ "${SKIP_TEMPLATES:-0}" != "1" ]; then
  API="${API:-https://notes.markets}" npx tsx scripts/seed-templates.ts
fi
