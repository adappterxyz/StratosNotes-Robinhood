#!/usr/bin/env bash
# Seed the live testnet after scripts/deploy-testnets.sh: two short-dated demo notes, both on Arbitrum Sepolia (a
# worst-of phoenix on ETH/BTC and one on TSLA/NVDA, cash-settled) with part of the book sold, and the template
# library through the API. Every note is issued on Arbitrum; Robinhood Chain testnet is a collateral chain only and
# gets no notes (seed-note.ts refuses it).
#
#   bash scripts/seed.sh                         # notes + templates (API=https://notes.markets)
#   STRIKE_IN=1800 OBS_EVERY=600 bash scripts/seed.sh
#   SKIP_TEMPLATES=1 bash scripts/seed.sh
set -euo pipefail
cd "$(dirname "$0")/.."
NOTE_CHAIN="${NOTE_CHAIN:-arbitrum-sepolia}"
CHAIN="$NOTE_CHAIN" NOTE=crypto npx tsx scripts/seed-note.ts
CHAIN="$NOTE_CHAIN" NOTE=equity npx tsx scripts/seed-note.ts
if [ "${SKIP_TEMPLATES:-0}" != "1" ]; then
  API="${API:-https://notes.markets}" npx tsx scripts/seed-templates.ts
fi
