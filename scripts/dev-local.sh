#!/usr/bin/env bash
# The whole platform on one machine, against a local fork of Robinhood Chain testnet. No real network is written to.
#
#   1. anvil forks Robinhood Chain testnet (chain id 46630, so Chainlink's MockKeystoneForwarder is there)
#   2. FlowEngine + NotesLens + a mock USDC are deployed with anvil's public test account 0
#   3. Postgres 17 runs in Docker (throwaway, in memory)
#   4. the indexer, the API (with a faucet for the mock USDC) and the app (dev build, with the test wallet) start
#   5. a keeper runs the notes: KEEPER=fallback (default; services/keeper-fallback as anvil account 9) or
#      KEEPER=cre (the CRE workflow in Chainlink's simulator, --broadcast to the fork; needs `cre login`)
#
#   bash scripts/dev-local.sh            # then open the app URL it prints; Ctrl-C stops everything
#   APP_PORT=5290 bash scripts/dev-local.sh   # a fixed app port
#   E2E=1 bash scripts/dev-local.sh      # start everything, run the app end-to-end check, stop
#
# Needs: Foundry (anvil, forge, cast), Docker, Node 20+, network access (the fork and Chainlink's Ethereum-mainnet
# feeds via a public RPC). Accounts are anvil's well-known test keys (scripts/e2e/lib.ts); no real key is read.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.cre/bin:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"
KEEPER="${KEEPER:-fallback}"
FORK_RPC="${FORK_RPC:-https://rpc.testnet.chain.robinhood.com}"
FEED_RPC="${FEED_RPC:-https://ethereum-rpc.publicnode.com}"
WORK="$ROOT/deployments/local/dev"
mkdir -p "$WORK"
PIDS=()
PG=sn-dev-pg-$$
# Job control: every background service gets its own process group, so cleanup stops its children too
# (npx -> tsx -> node, vite, the keeper loop), not just the shell that started them.
set -m

cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -TERM -- "-$p" 2>/dev/null || true; done
  sleep 1
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -KILL -- "-$p" 2>/dev/null || true; done
  docker rm -f "$PG" >/dev/null 2>&1 || true
  rm -f "$WORK/fallback.key" "$WORK/pusher.key" "$WORK/verifier.json" "$ROOT/cre/local-fork.env"
}
trap cleanup EXIT INT TERM

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
wait_http() { for _ in $(seq 1 120); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 1; done; echo "timed out waiting for $1" >&2; return 1; }
APP_PORT="${APP_PORT:-$(free_port)}"
read -r KEY0 KEY8 KEY9 ADDR0 ADDR9 KEY7 ADDR7 KEY6 < <(npx tsx -e "import { keyOf, acct } from '$ROOT/scripts/e2e/lib'; console.log(keyOf(0), keyOf(8), keyOf(9), acct(0).address, acct(9).address, keyOf(7), acct(7).address, keyOf(6))")

echo "== anvil: fork of Robinhood Chain testnet"
ANVIL_PORT="$(free_port)"
anvil --fork-url "$FORK_RPC" --chain-id 46630 --port "$ANVIL_PORT" --block-time 2 --slots-in-an-epoch 1 --gas-limit 30000000 \
  > "$WORK/anvil.log" 2>&1 & PIDS+=($!)
RPC="http://127.0.0.1:$ANVIL_PORT"
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done

echo "== deploy: engine, lens, mock USDC"
HEAD="$(cast block-number --rpc-url "$RPC")" # the chain's own block (Solidity's block.number is L1's on an Orbit chain)
# Verified emails: anvil account 7 is the local verifier (its public test key signs attestations); requireEmail on.
printf '[{"address":"%s","private_key":"%s"}]\n' "$ADDR7" "$KEY7" > "$WORK/verifier.json"
(cd packages/evm-engine && CHAIN=robinhood-testnet FORWARDER_MODE=mock OWNER="$ADDR0" OUT="$WORK/deployment.json" VERIFIER="$ADDR7" REQUIRE_EMAIL=1 \
  forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$KEY0" --broadcast --slow > "$WORK/deploy.log" 2>&1)
USDC="$(cd packages/evm-engine && forge create test/mocks/MockERC20.sol:MockERC20 --rpc-url "$RPC" --private-key "$KEY0" \
  --broadcast --constructor-args USDC 6 2>/dev/null | awk '/Deployed to:/ {print $3}')"
python3 scripts/set-deploy-block.py "$WORK/deployment.json" "$HEAD"
read -r ENGINE LENS BLOCK < <(python3 -c "import json;d=json.load(open('$WORK/deployment.json'));print(d['engine'],d['lens'],d['block'])")
echo "engine $ENGINE lens $LENS from block $BLOCK, USDC $USDC"

echo "== postgres (docker, in memory)"
PG_PORT="$(free_port)"
PG_PASS="$(python3 -c 'import secrets;print(secrets.token_hex(12))')"
docker run -d --rm --name "$PG" -e POSTGRES_PASSWORD="$PG_PASS" -e POSTGRES_DB=stratosnotes -p "127.0.0.1:$PG_PORT:5432" \
  --tmpfs /var/lib/postgresql/data postgres:17 >/dev/null
for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 1
export DATABASE_URL="postgres://postgres:$PG_PASS@127.0.0.1:$PG_PORT/stratosnotes"

cat > "$WORK/indexer.json" <<JSON
{ "chains": [ { "key": "local", "family": "evm", "chainId": 46630, "rpc": "$RPC", "engine": "$ENGINE", "lens": "$LENS",
  "startBlock": $BLOCK, "confirmations": 1, "maxRange": 500, "pollMs": 1000 } ] }
JSON
API_PORT="$(free_port)"
cat > "$WORK/api.json" <<JSON
{ "allowedOrigins": ["http://127.0.0.1:$APP_PORT", "http://localhost:$APP_PORT"],
  "chains": [ { "key": "local", "rpc": "$RPC", "engine": "$ENGINE", "lens": "$LENS", "fromBlock": $BLOCK,
    "stablecoin": { "symbol": "USDC", "address": "$USDC", "decimals": 6 },
    "faucet": { "token": "$USDC", "amount": "100000" } } ],
  "ai": true }
JSON

echo "== indexer, api, app"
INDEXER_CONFIG="$WORK/indexer.json" npx tsx services/indexer/src/main.ts > "$WORK/indexer.log" 2>&1 & PIDS+=($!)
# Email: an in-memory mailbox (GET /api/dev/emails), the local verifier key, a fast notifier tick.
API_CONFIG="$WORK/api.json" PORT="$API_PORT" FAUCET_KEY="$KEY0" EMAIL_SENDER=mock VERIFIER_KEY_FILE="$WORK/verifier.json" NOTIFIER_INTERVAL=5000 SITE_URL="http://127.0.0.1:$APP_PORT" npx tsx services/api/src/main.ts > "$WORK/api.log" 2>&1 & PIDS+=($!)
wait_http "http://127.0.0.1:$API_PORT/api/health"
(cd app && VITE_TEST_WALLET=1 VITE_API_PROXY="http://127.0.0.1:$API_PORT" npx vite --port "$APP_PORT" --strictPort --host 127.0.0.1 > "$WORK/app.log" 2>&1) & PIDS+=($!)
wait_http "http://127.0.0.1:$APP_PORT/"

echo "== keeper: $KEEPER"
if [ "$KEEPER" = "cre" ]; then
  npx tsx scripts/cre-config.ts local-fork "$WORK/deployment.json"
  printf 'CRE_ETH_PRIVATE_KEY=%s\n' "${KEY8#0x}" > cre/local-fork.env
  export SN_FORK_PORT="$ANVIL_PORT"
  (while true; do
    (cd cre && cre workflow simulate notes-keeper-evm --target local-fork --non-interactive --trigger-index 0 --broadcast -e local-fork.env 2>&1 \
      | grep -E 'USER LOG|✗|rror' || true)
    sleep 15
  done) > "$WORK/keeper.log" 2>&1 & PIDS+=($!)
else
  cast send "$ENGINE" 'setFallbackReporter(address)' "$ADDR9" --rpc-url "$RPC" --private-key "$KEY0" >/dev/null
  echo "$KEY9" > "$WORK/fallback.key"; chmod 600 "$WORK/fallback.key"
  cat > "$WORK/keeper.json" <<JSON
{ "chain": { "name": "local", "chainId": 46630, "rpc": "$RPC", "engine": "$ENGINE", "lens": "$LENS" },
  "feedRpcs": { "ethereum-mainnet": "$FEED_RPC" },
  "blockTag": "finalized", "finalityAllowanceSec": 1800, "maxReportsPerRun": 5, "gasLimit": "8000000", "intervalSec": 10 }
JSON
  KEEPER_CONFIG="$WORK/keeper.json" KEEPER_KEY_FILE="$WORK/fallback.key" npx tsx services/keeper-fallback/src/main.ts > "$WORK/keeper.log" 2>&1 & PIDS+=($!)
fi

# Payouts are claimed by default (FlowEngine v4): holders claim from the portfolio or the note page, which the e2e
# does. This keeper (the issuer bot in PUSH_ONLY mode, anvil account 6; pushing is permissionless) pushes only notes
# whose terms opt in to paying wallets automatically. Only the stablecoin: delivered tokens and a default's
# collateral are withdrawn from the note page.
echo "== payout pusher"
echo "$KEY6" > "$WORK/pusher.key"; chmod 600 "$WORK/pusher.key"
RPC="$RPC" CHAIN_ID=46630 ENGINE="$ENGINE" LENS="$LENS" FROM_BLOCK="$BLOCK" ISSUER_KEY_FILE="$WORK/pusher.key" PUSH_ONLY=1 PUSH_ASSETS=1 INTERVAL=4 \
  npx tsx scripts/issuer-bot.ts > "$WORK/pusher.log" 2>&1 & PIDS+=($!)

cat <<EOF

StratosNotes is running locally:
  app      http://127.0.0.1:$APP_PORT   (dev build: "StratosNotes test wallet" in Connect; Test switches accounts)
  api      http://127.0.0.1:$API_PORT/api/health
  chain    $RPC (fork of Robinhood Chain testnet, chain id 46630)   engine $ENGINE   USDC $USDC
  keeper   $KEEPER   logs in $WORK
EOF

if [ "${E2E:-}" = "1" ]; then
  APP_URL="http://127.0.0.1:$APP_PORT" API_URL="http://127.0.0.1:$API_PORT" RPC="$RPC" ENGINE="$ENGINE" LENS="$LENS" BLOCK="$BLOCK" KEEPER="$KEEPER" \
    EXPECT_REPORTER="$([ "$KEEPER" = cre ] && echo 0xD41263567DdfeAd91504199b8c6c87371e83ca5d || echo "$ADDR9")" \
    npx tsx scripts/e2e/app.e2e.ts 2>&1 | tee "$WORK/e2e.log"
  exit "${PIPESTATUS[0]}"
fi
echo "Ctrl-C to stop."
wait
