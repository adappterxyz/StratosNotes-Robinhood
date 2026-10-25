#!/usr/bin/env bash
# The platform on one machine with the Cloudflare backend: the Worker (wrangler dev, local mode) serves the API from
# a local D1 and runs the indexer + notifier cron, against a local fork of Arbitrum Sepolia. No real network is
# written to and nothing is deployed: D1 is Miniflare's on-disk SQLite under deployments/local/d1dev.
#
#   1. anvil forks Arbitrum Sepolia (chain id 421614, so Chainlink's MockKeystoneForwarder is there)
#   2. FlowEngine + NotesLens + a mock USDC are deployed with anvil's public test account 0
#   3. web/migrations are applied to a local D1 (`wrangler d1 migrations apply --local`)
#   4. `wrangler dev --local --test-scheduled` runs web/worker.ts with that D1; a loop calls /__scheduled every few
#      seconds (the cron, which in production fires every minute)
#   5. the app (dev build, test wallet) proxies /api to the Worker; a keeper runs the notes:
#      KEEPER=fallback (default) or KEEPER=cre (the CRE simulator, --broadcast to the fork; needs `cre login`)
#
#   bash scripts/dev-local-d1.sh          # then open the app URL it prints; Ctrl-C stops everything
#   E2E=1 bash scripts/dev-local-d1.sh    # start everything, run the app end-to-end check (scripts/e2e/app.e2e.ts), stop
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.cre/bin:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"
KEEPER="${KEEPER:-fallback}"
FORK_RPC="${FORK_RPC:-https://sepolia-rollup.arbitrum.io/rpc}"
FEED_RPC="${FEED_RPC:-https://ethereum-rpc.publicnode.com}"
WORK="$ROOT/deployments/local/d1dev"
rm -rf "$WORK"; mkdir -p "$WORK/assets"
PIDS=()
set -m
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -TERM -- "-$p" 2>/dev/null || true; done
  sleep 1
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -KILL -- "-$p" 2>/dev/null || true; done
  rm -f "$WORK/fallback.key" "$WORK/pusher.key" "$ROOT/cre/local-fork.env" "$WORK/wrangler.json" "$WORK/.dev.vars"
}
trap cleanup EXIT INT TERM

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
wait_http() { for _ in $(seq 1 180); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 1; done; echo "timed out waiting for $1" >&2; return 1; }
APP_PORT="${APP_PORT:-$(free_port)}"
read -r KEY0 KEY8 KEY9 ADDR0 ADDR9 KEY7 ADDR7 KEY6 < <(npx tsx -e "import { keyOf, acct } from '$ROOT/scripts/e2e/lib'; console.log(keyOf(0), keyOf(8), keyOf(9), acct(0).address, acct(9).address, keyOf(7), acct(7).address, keyOf(6))")

echo "== anvil: fork of Arbitrum Sepolia"
ANVIL_PORT="$(free_port)"
anvil --fork-url "$FORK_RPC" --chain-id 421614 --port "$ANVIL_PORT" --block-time 2 --slots-in-an-epoch 1 --gas-limit 30000000 \
  > "$WORK/anvil.log" 2>&1 & PIDS+=($!)
RPC="http://127.0.0.1:$ANVIL_PORT"
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done

echo "== deploy: engine, lens, mock USDC"
HEAD="$(cast block-number --rpc-url "$RPC")"
# Verified emails: anvil account 7 is the local verifier (its public test key signs attestations); requireEmail on.
(cd packages/evm-engine && CHAIN=arbitrum-sepolia FORWARDER_MODE=mock OWNER="$ADDR0" OUT="$WORK/deployment.json" VERIFIER="$ADDR7" REQUIRE_EMAIL=1 \
  forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$KEY0" --broadcast --slow > "$WORK/deploy.log" 2>&1)
USDC="$(cd packages/evm-engine && forge create test/mocks/MockERC20.sol:MockERC20 --rpc-url "$RPC" --private-key "$KEY0" \
  --broadcast --constructor-args USDC 6 2>/dev/null | awk '/Deployed to:/ {print $3}')"
python3 scripts/set-deploy-block.py "$WORK/deployment.json" "$HEAD"
read -r ENGINE LENS BLOCK < <(python3 -c "import json;d=json.load(open('$WORK/deployment.json'));print(d['engine'],d['lens'],d['block'])")
echo "engine $ENGINE lens $LENS from block $BLOCK, USDC $USDC"

echo "== worker: wrangler dev (local D1, cron on /__scheduled)"
W_PORT="$(free_port)"
# A local-only wrangler config: the edge Worker with D1, no Workers AI (it would need Cloudflare), the rate limits
# simulated locally, and this fork's config in SN_CONFIG.
python3 - "$WORK" "$RPC" "$ENGINE" "$LENS" "$BLOCK" "$USDC" "$APP_PORT" "$KEY0" "$ROOT" <<'PY'
import json, sys
work, rpc, engine, lens, block, usdc, app_port, key0, root = sys.argv[1:]
block = int(block)
cfg = {
  "api": { "allowedOrigins": [f"http://127.0.0.1:{app_port}", f"http://localhost:{app_port}"],
    "chains": [ { "key": "local", "rpc": rpc, "engine": engine, "lens": lens, "fromBlock": block,
      "stablecoin": { "symbol": "USDC", "address": usdc, "decimals": 6 }, "faucet": { "token": usdc, "amount": "100000" } } ] },
  "indexer": { "chains": [ { "key": "local", "family": "evm", "chainId": 421614, "rpc": rpc, "engine": engine,
    "startBlock": block, "confirmations": 1, "maxRange": 500 } ] },
}
w = {
  "name": "notes-markets-local", "main": f"{root}/web/worker.ts", "compatibility_date": "2026-04-22",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": f"{work}/assets", "binding": "ASSETS", "not_found_handling": "none", "run_worker_first": True },
  "d1_databases": [ { "binding": "DB", "database_name": "notes-markets-local", "database_id": "local", "migrations_dir": f"{root}/web/migrations" } ],
  "ratelimits": [ { "name": "READ_LIMIT", "namespace_id": "9602", "simple": { "limit": 1000, "period": 60 } } ],
  "triggers": { "crons": ["* * * * *"] },
  "vars": { "API_MODE": "edge", "API_ORIGIN": "http://127.0.0.1:1", "EMAIL_SENDING": "off", "EMAIL_SENDER": "mock",
    "SITE_URL": f"http://127.0.0.1:{app_port}", "SN_CONFIG": json.dumps(cfg), "FAUCET_KEY": key0 },
}
json.dump(w, open(f"{work}/wrangler.json", "w"), indent=2)
PY
echo '<!doctype html><title>notes.markets local</title>' > "$WORK/assets/index.html"
# Local secrets for wrangler dev: the verifier key (anvil account 7's public test key).
printf 'VERIFIER_KEY=%s\n' "$KEY7" > "$WORK/.dev.vars"
(cd "$WORK" && wrangler d1 migrations apply DB --local --config wrangler.json --persist-to "$WORK/state" > "$WORK/migrate.log" 2>&1)
(cd "$WORK" && wrangler dev --config wrangler.json --local --test-scheduled --persist-to "$WORK/state" --port "$W_PORT" --ip 127.0.0.1 \
  > "$WORK/worker.log" 2>&1) & PIDS+=($!)
wait_http "http://127.0.0.1:$W_PORT/api/health"
# The cron: production fires every minute; here every 3 s, so the e2e moves at the fork's pace.
(while true; do curl -s "http://127.0.0.1:$W_PORT/__scheduled?cron=*+*+*+*+*" >/dev/null || true; sleep 3; done) > /dev/null 2>&1 & PIDS+=($!)

echo "== app"
(cd app && VITE_TEST_WALLET=1 VITE_API_PROXY="http://127.0.0.1:$W_PORT" npx vite --port "$APP_PORT" --strictPort --host 127.0.0.1 > "$WORK/app.log" 2>&1) & PIDS+=($!)
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
{ "chain": { "name": "local", "chainId": 421614, "rpc": "$RPC", "engine": "$ENGINE", "lens": "$LENS" },
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
RPC="$RPC" CHAIN_ID=421614 ENGINE="$ENGINE" LENS="$LENS" FROM_BLOCK="$BLOCK" ISSUER_KEY_FILE="$WORK/pusher.key" PUSH_ONLY=1 PUSH_ASSETS=1 INTERVAL=4 \
  npx tsx scripts/issuer-bot.ts > "$WORK/pusher.log" 2>&1 & PIDS+=($!)

cat <<EOF

notes.markets is running locally on the Cloudflare backend (D1):
  app      http://127.0.0.1:$APP_PORT   (dev build: test wallet in Connect)
  worker   http://127.0.0.1:$W_PORT/api/health   (local D1 in $WORK/state; cron on /__scheduled every 3 s)
  chain    $RPC (fork of Arbitrum Sepolia)   engine $ENGINE   USDC $USDC
  keeper   $KEEPER   logs in $WORK
EOF

if [ "${E2E:-}" = "1" ]; then
  APP_URL="http://127.0.0.1:$APP_PORT" API_URL="http://127.0.0.1:$W_PORT" RPC="$RPC" ENGINE="$ENGINE" LENS="$LENS" BLOCK="$BLOCK" KEEPER="$KEEPER" \
    EXPECT_REPORTER="$([ "$KEEPER" = cre ] && echo 0xD41263567DdfeAd91504199b8c6c87371e83ca5d || echo "$ADDR9")" \
    npx tsx scripts/e2e/app.e2e.ts 2>&1 | tee "$WORK/e2e.log"
  status="${PIPESTATUS[0]}"
  # Evidence: what the cron did and what D1 holds.
  grep -o '{"cron":"indexer"[^}]*}[^\n]*' "$WORK/worker.log" | tail -3 > "$WORK/cron-sample.log" || true
  (cd "$WORK" && wrangler d1 execute DB --local --config wrangler.json --persist-to "$WORK/state" --json \
    --command "SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM notes) AS notes, (SELECT count(*) FROM holdings) AS holdings, (SELECT count(*) FROM changes) AS changes, (SELECT cursor FROM chains) AS cursor" \
    > "$WORK/d1-counts.json" 2>/dev/null) || true
  exit "$status"
fi
echo "Ctrl-C to stop."
wait
