#!/usr/bin/env bash
# Deploy StratosNotes to the note chains: Robinhood Chain testnet (46630) and Base Sepolia (84532). Per chain:
# FlowEngine (CRE MockKeystoneForwarder, fallback reporter OFF) and NotesLens. Notes use real tokens only
# (packages/core CHAIN_TOKENS: USDG, WETH and Robinhood's stock tokens on Robinhood Chain; Circle's USDC and WETH on
# Base), so the retired test tokens and their TokenFaucet are not deployed (TEST_TOKENS=1 brings them back, e.g. for
# a rehearsal that seeds with CASH=tUSD; rehearsals default to it). Writes deployments/<chain>.json, then the CRE
# staging config and the server configs (scripts/cre-config.ts, scripts/server-config.ts).
#
#   bash scripts/deploy-testnets.sh                          # both chains; a chain already deployed is skipped
#   CHAINS=base-sepolia bash scripts/deploy-testnets.sh      # Base Sepolia only
#   REDEPLOY=1 CHAINS=robinhood-testnet bash scripts/deploy-testnets.sh   # replace a live engine (move its file aside)
#   REHEARSAL=1 bash scripts/deploy-testnets.sh              # against local anvil forks; writes deployments/local/rehearsal/
#   REHEARSAL=1 SEED=1 bash scripts/deploy-testnets.sh       # ... and issue the demo notes on the forks
#
# A chain whose deployments/<chain>.json already names an engine is SKIPPED unless REDEPLOY=1, so re-running never
# replaces the live engine (and strands its notes) by accident.
# The deployer key is read from .keys/deployer.json (never printed) and is OWNER of the engine. A rehearsal without
# .keys/deployer.json uses anvil's public test key #0 (forks only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"
CHAINS="${CHAINS:-robinhood-testnet base-sepolia}"
declare -A RPC=(
  [robinhood-testnet]="${RPC_ROBINHOOD_TESTNET:-https://rpc.testnet.chain.robinhood.com}"
  [base-sepolia]="${RPC_BASE_SEPOLIA:-https://sepolia.base.org}"
)
declare -A ID=( [robinhood-testnet]=46630 [base-sepolia]=84532 )
for c in $CHAINS; do [ -n "${ID[$c]:-}" ] || { echo "unknown chain $c: notes run on robinhood-testnet and base-sepolia"; exit 1; }; done
OUTDIR="deployments"
REHEARSAL="${REHEARSAL:-0}"
# anvil's well-known test key #0 and account #1 (public; forks only).
ANVIL_KEY0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ANVIL_ADDR1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
if [ -f .keys/deployer.json ]; then
  DEPLOYER="$(python3 -c "import json;print(json.load(open('.keys/deployer.json'))[0]['address'])")"
  deployer_key() { python3 -c "import json;k=json.load(open('$ROOT/.keys/deployer.json'))[0]['private_key'];print(k if k.startswith('0x') else '0x'+k)"; }
elif [ "$REHEARSAL" = "1" ]; then
  DEPLOYER="$(cast wallet address "$ANVIL_KEY0")"
  deployer_key() { echo "$ANVIL_KEY0"; }
  echo "rehearsal: no .keys/deployer.json, using anvil's test key #0 ($DEPLOYER) on the forks"
else
  echo "missing .keys/deployer.json (cast wallet new --json > .keys/deployer.json)"; exit 1
fi

# Skip chains already deployed (live runs only).
if [ "$REHEARSAL" != "1" ] && [ "${REDEPLOY:-0}" != "1" ]; then
  todo=""
  for c in $CHAINS; do
    if [ -f "deployments/$c.json" ] && python3 -c "import json,sys;sys.exit(0 if json.load(open('deployments/$c.json')).get('engine') else 1)"; then
      echo "== $c: already deployed ($(python3 -c "import json;print(json.load(open('deployments/$c.json'))['engine'])")), skipped (REDEPLOY=1 replaces it)"
    else
      todo="$todo $c"
    fi
  done
  CHAINS="${todo# }"
fi

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
if [ "$REHEARSAL" = "1" ]; then
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
# subscribing and receiving units on them. The key file holds the private key; only its address is used here. Both
# chains take the same verifier (one API signs for both).
VERIFIER="$(python3 -c "import json;print(json.load(open('$ROOT/.keys/verifier.json'))[0]['address'])" 2>/dev/null || true)"
if [ -z "$VERIFIER" ] && [ "$REHEARSAL" = "1" ]; then VERIFIER="$ANVIL_ADDR1"; fi
[ -n "$VERIFIER" ] || { echo "no .keys/verifier.json: create it with cast wallet new --json > .keys/verifier.json"; exit 1; }

for c in $CHAINS; do
  rpc="${RPC[$c]}"
  [ "$(cast chain-id --rpc-url "$rpc")" = "${ID[$c]}" ] || { echo "$c: RPC $rpc is not chain ${ID[$c]}"; exit 1; }
  bal="$(cast balance "$DEPLOYER" --rpc-url "$rpc" --ether)"
  echo "== $c: deployer $DEPLOYER has $bal ETH"
  python3 -c "import sys; sys.exit(0 if float('$bal') >= 0.002 else 1)" || { echo "$c: fund the deployer first (docs/DEPLOY.md)"; exit 1; }
  # The key reaches the script through DEPLOYER_KEY in this one command's environment: never on a command line,
  # never echoed.
  # The chain's own block: on an Orbit chain (Robinhood Chain) Solidity's block.number is L1's; on Base (OP Stack)
  # it is the chain's own, and the head read here is the same kind of number either way.
  head="$(cast block-number --rpc-url "$rpc")"
  (cd packages/evm-engine && export DEPLOYER_KEY="$(deployer_key)" && \
    CHAIN="$c" FORWARDER_MODE=mock OWNER="$DEPLOYER" TEST_TOKENS="${TEST_TOKENS:-$REHEARSAL}" OUT="$ROOT/$OUTDIR/$c.json" \
    VERIFIER="$VERIFIER" REQUIRE_EMAIL="${REQUIRE_EMAIL:-1}" \
    forge script script/Deploy.s.sol --rpc-url "$rpc" --broadcast --slow > "$ROOT/$OUTDIR/deploy-$c.log" 2>&1) \
    || { echo "$c: deploy failed (see $OUTDIR/deploy-$c.log)"; exit 1; }
  python3 scripts/set-deploy-block.py "$OUTDIR/$c.json" "$head"
  echo "   $(python3 -c "import json;d=json.load(open('$OUTDIR/$c.json'));print('engine',d['engine'],'lens',d['lens'],'faucet',d.get('faucet'))")"
  # Gas actually used, from the broadcast receipts (also on a fork: the rehearsal's measurement).
  bc="packages/evm-engine/broadcast/Deploy.s.sol/${ID[$c]}/run-latest.json"
  [ -f "$bc" ] && python3 -c "
import json;d=json.load(open('$bc'));g=sum(int(r['gasUsed'],16) for r in d['receipts']);p=max(int(r.get('effectiveGasPrice','0x0'),16) for r in d['receipts'])
print('   gas used: %d over %d transaction(s), effective gas price %.4f gwei' % (g, len(d['receipts']), p/1e9))"
done

# Rehearsal only: also issue the demo notes on the forks (scripts/seed-note.ts), as scripts/seed.sh would.
if [ "$REHEARSAL" = "1" ] && [ "${SEED:-0}" = "1" ]; then
  for c in $CHAINS; do
    for n in crypto equity; do
      echo "== seed: $c ($n)"
      CHAIN="$c" RPC="${RPC[$c]}" DEPLOY_DIR="$OUTDIR" CASH="${CASH:-tUSD}" NOTE="$n" npx tsx scripts/seed-note.ts
    done
  done
fi

if [ "$OUTDIR" = "deployments" ] && [ -n "$CHAINS" ]; then
  npx tsx scripts/cre-config.ts staging
  npx tsx scripts/server-config.ts
fi
echo "done: $OUTDIR/"
