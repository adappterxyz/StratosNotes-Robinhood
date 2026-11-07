#!/usr/bin/env bash
# Seed the live testnets after scripts/deploy-testnets.sh: on each deployed note chain (SEED_CHAINS, default every
# chain whose deployments/<chain>.json has an engine) two short-dated demo notes (a worst-of phoenix on ETH/BTC and
# one on TSLA/NVDA, both cash-settled, stablecoin collateral) with part of the book sold, and the template library
# through the API. Cash and collateral are the chain's stablecoin: Paxos's USDG on Robinhood Chain (faucet.paxos.com),
# Circle's USDC on Base Sepolia (faucet.circle.com). The deployer key (.keys/deployer.json, issuer and paying agent)
# must hold, per chain, the collateral plus what the demo investors subscribe with (default 2 x (1,000 + 1,000) =
# 4,000) and testnet ETH for gas for itself and the investors.
#
#   bash scripts/seed.sh                         # notes + templates (API=https://notes.markets)
#   SEED_CHAINS=base-sepolia bash scripts/seed.sh
#   STRIKE_IN=1800 OBS_EVERY=600 bash scripts/seed.sh
#   SKIP_TEMPLATES=1 bash scripts/seed.sh
set -euo pipefail
cd "$(dirname "$0")/.."
deployed() { python3 -c "import json,sys;sys.exit(0 if json.load(open('deployments/$1.json')).get('engine') else 1)" 2>/dev/null; }
if [ -z "${SEED_CHAINS:-}" ]; then
  SEED_CHAINS=""
  for c in robinhood-testnet base-sepolia; do deployed "$c" && SEED_CHAINS="$SEED_CHAINS $c"; done
fi
for c in $SEED_CHAINS; do
  CHAIN="$c" NOTE=crypto npx tsx scripts/seed-note.ts
  CHAIN="$c" NOTE=equity npx tsx scripts/seed-note.ts
done
if [ "${SKIP_TEMPLATES:-0}" != "1" ]; then
  API="${API:-https://notes.markets}" npx tsx scripts/seed-templates.ts
fi
