#!/usr/bin/env bash
# The CRE keeper on the live testnets until the workflow is deployed to the DON: run notes-keeper-evm in
# Chainlink's simulator every INTERVAL seconds with --broadcast, so its reports go on-chain through each
# testnet's MockKeystoneForwarder (Arbitrum Sepolia, Robinhood Chain testnet).
#
#   pm2 start scripts/keeper-loop.sh --name sn-arb-keeper --interpreter bash
#
# Needs the CRE CLI logged in (`cre whoami`) and the keeper key in .keys/keeper.json (funded on both chains). The
# key is written to a temporary env file (mode 600) for each run and deleted right after; it is never printed.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cre/bin:$HOME/.bun/bin:$PATH"
INTERVAL="${INTERVAL:-60}"
cd "$ROOT/cre"
while true; do
  start=$(date +%s)
  echo "=== $(date -u +%FT%TZ)"
  ENVF="$(mktemp "$ROOT/cre/.keeper-env.XXXXXX")"
  chmod 600 "$ENVF"
  python3 -c "import json;k=json.load(open('$ROOT/.keys/keeper.json'))[0]['private_key'];print('CRE_ETH_PRIVATE_KEY='+(k[2:] if k.startswith('0x') else k))" > "$ENVF"
  timeout 300 cre workflow simulate ./notes-keeper-evm --target staging-settings --trigger-index 0 --non-interactive --broadcast -e "$ENVF" 2>&1 \
    | grep -E "USER LOG|\"\{|✗|rror" || echo "(no output)"
  rm -f "$ENVF"
  sleep $(( INTERVAL - ( $(date +%s) - start ) > 5 ? INTERVAL - ( $(date +%s) - start ) : 5 ))
done
