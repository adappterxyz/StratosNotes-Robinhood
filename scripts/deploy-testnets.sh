#!/usr/bin/env bash
# Deploy StratosNotes to Robinhood Chain testnet (chain 46630), the only note chain: FlowEngine (CRE
# MockKeystoneForwarder, fallback reporter OFF) and NotesLens. Notes use real tokens only (USDG, WETH, Robinhood's
# stock tokens: packages/core CHAIN_TOKENS), so the retired test tokens and their TokenFaucet are not deployed
# (TEST_TOKENS=1 brings them back, e.g. for a rehearsal that seeds with CASH=tUSD; rehearsals default to it). Writes
# deployments/robinhood-testnet.json, then the CRE staging config and the server configs (scripts/server-config.ts).
#
#   bash scripts/deploy-testnets.sh                          # Robinhood Chain testnet
#   REHEARSAL=1 bash scripts/deploy-testnets.sh              # against a local anvil fork; writes deployments/local/rehearsal/
#   REHEARSAL=1 SEED=1 bash scripts/deploy-testnets.sh       # ... and issue the demo notes on the fork
#
# The deployer key is read from .keys/deployer.json (never printed) and is OWNER of the engine, tokens and faucet.
# Re-running redeploys: move deployments/<chain>.json aside first if you mean to keep the old one.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"
CHAINS="${CHAINS:-robinhood-testnet}"
declare -A RPC=( [robinhood-testnet]="${RPC_ROBINHOOD_TESTNET:-https://rpc.testnet.chain.robinhood.com}" )
declare -A ID=( [robinhood-testnet]=46630 )
for c in $CHAINS; do [ -n "${ID[$c]:-}" ] || { echo "unknown chain $c: notes run on robinhood-testnet only"; exit 1; }; done
OUTDIR="deployments"
[ -f .keys/deployer.json ] || { echo "missing .keys/deployer.json (cast wallet new --json > .keys/deployer.json)"; exit 1; }
DEPLOYER="$(python3 -c "import json;print(json.load(open('.keys/deployer.json'))[0]['address'])")"

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
if [ "${REHEARSAL:-0}" = "1" ]; then
  OUTDIR="deployments/local/rehearsal"
  port=28600
  for c in $CHAINS; do
    port=$((port + 1))
    anvil --fork-url "${RPC[$c]}" --chain-id "${ID[$c]}" --port "$port" --silent & PIDS+=($!)
    for _ in $(seq 1 60); do cast chain-id --rpc-url "http://127.0.0.1:$port" >/dev/null 2>&1 && break; sleep 1; done
    cast rpc anvil_setBalance "$DEPLOYER" 0x8AC7230489E80000 --rpc-url "http://127.0.0.1:$port" >/dev/null   # 10 ETH, fork only
    RPC[$c]="http://127.0.0.1:$port"
  done
fi
mkdir -p "$OUTDIR"

# Verified emails (EmailAttest): the API's verifier key signs attestations; REQUIRE_EMAIL=1 (default) gates issuing,
# subscribing and receiving units on them. The key file holds the private key; only its address is used here.
VERIFIER="$(python3 -c "import json;print(json.load(open('$ROOT/.keys/verifier.json'))[0]['address'])" 2>/dev/null || true)"
[ -n "$VERIFIER" ] || { echo "no .keys/verifier.json: create it with cast wallet new --json > .keys/verifier.json"; exit 1; }

for c in $CHAINS; do
  rpc="${RPC[$c]}"
  [ "$(cast chain-id --rpc-url "$rpc")" = "${ID[$c]}" ] || { echo "$c: RPC $rpc is not chain ${ID[$c]}"; exit 1; }
  bal="$(cast balance "$DEPLOYER" --rpc-url "$rpc" --ether)"
  echo "== $c: deployer $DEPLOYER has $bal ETH"
  python3 -c "import sys; sys.exit(0 if float('$bal') >= 0.002 else 1)" || { echo "$c: fund the deployer first (docs/DEPLOY.md)"; exit 1; }
  # The key reaches the script through DEPLOYER_KEY in this one command's environment: never on a command line,
  # never echoed.
  head="$(cast block-number --rpc-url "$rpc")" # the chain's own block (Solidity's block.number is L1's on an Orbit chain)
  (cd packages/evm-engine && export DEPLOYER_KEY="$(python3 -c "import json;k=json.load(open('$ROOT/.keys/deployer.json'))[0]['private_key'];print(k if k.startswith('0x') else '0x'+k)")" && \
    CHAIN="$c" FORWARDER_MODE=mock OWNER="$DEPLOYER" TEST_TOKENS="${TEST_TOKENS:-${REHEARSAL:-0}}" OUT="$ROOT/$OUTDIR/$c.json" \
    VERIFIER="$VERIFIER" REQUIRE_EMAIL="${REQUIRE_EMAIL:-1}" \
    forge script script/Deploy.s.sol --rpc-url "$rpc" --broadcast --slow > "$ROOT/$OUTDIR/deploy-$c.log" 2>&1) \
    || { echo "$c: deploy failed (see $OUTDIR/deploy-$c.log)"; exit 1; }
  python3 scripts/set-deploy-block.py "$OUTDIR/$c.json" "$head"
  echo "   $(python3 -c "import json;d=json.load(open('$OUTDIR/$c.json'));print('engine',d['engine'],'lens',d['lens'],'faucet',d.get('faucet'))")"
done

# Rehearsal only: also issue the demo notes on the fork (scripts/seed-note.ts), as scripts/seed.sh would.
if [ "${REHEARSAL:-0}" = "1" ] && [ "${SEED:-0}" = "1" ]; then
  for c in $CHAINS; do
    for n in crypto equity; do
      echo "== seed: $c ($n)"
      CHAIN="$c" RPC="${RPC[$c]}" DEPLOY_DIR="$OUTDIR" CASH="${CASH:-tUSD}" NOTE="$n" npx tsx scripts/seed-note.ts
    done
  done
fi

if [ "$OUTDIR" = "deployments" ]; then
  npx tsx scripts/cre-config.ts staging
  npx tsx scripts/server-config.ts
fi
echo "done: $OUTDIR/"
