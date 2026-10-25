#!/usr/bin/env bash
# Automatic release of cross-chain collateral, end to end on a local ANVIL FORK of Arbitrum Sepolia, against the
# live FlowEngine v4 and HomeGateway v2 (docs/CROSS-CHAIN.md). Two notes whose only collateral is TSLA.rh (receipts
# minted by impersonating the gateway, as a CCIP lock would): one is paid in full, the other's issuer misses payment 1
# and it defaults. The fallback keeper (anvil account 9, fork-only fallback reporter) runs their schedules; the issuer
# bot (scripts/issuer-bot.ts, anvil account 1) funds the payments, then must:
#   - withdraw the paid-in-full note's TSLA.rh from the issuer's ledger  -> ReleaseQueued to the issuer
#   - push the defaulted note's TSLA.rh to every holder                  -> ReleaseQueued per holder
#   - flush those releases only after FLUSH_AFTER seconds (CRE is not running on the fork) -> ReleaseSent (real router)
# Nothing touches a real network: every transaction goes to the fork. Accounts are anvil's public test accounts.
#   bash scripts/e2e-xc-autorelease.sh        (Foundry + Node 20+; ~12 minutes)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"
STRIKE_IN="${STRIKE_IN:-90}" OBS_EVERY="${OBS_EVERY:-120}" FLUSH_AFTER="${FLUSH_AFTER:-180}"
WORK="$ROOT/deployments/local/xc"
mkdir -p "$WORK"
rm -f "$WORK"/*.log
# Only this run's bot and its npx/tsx children (a pattern kill would also stop the issuer bots under pm2).
kill_tree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done; kill "$1" 2>/dev/null || true; }
cleanup() {
  [ -f "$WORK/bot.pid" ] && kill_tree "$(cat "$WORK/bot.pid")"
  [ -f "$WORK/anvil.pid" ] && kill "$(cat "$WORK/anvil.pid")" 2>/dev/null
  rm -f "$WORK"/*.pid "$WORK/fallback.key"
}
trap cleanup EXIT
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
RPC="http://127.0.0.1:$PORT"
anvil --fork-url https://sepolia-rollup.arbitrum.io/rpc --chain-id 421614 --port "$PORT" --block-time 2 --slots-in-an-epoch 1 \
  --gas-limit 30000000 > "$WORK/anvil.log" 2>&1 &
echo $! > "$WORK/anvil.pid"
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
read -r KEY0 KEY1 KEY9 < <(npx tsx -e "import { keyOf } from '$ROOT/scripts/e2e/lib'; console.log(keyOf(0), keyOf(1), keyOf(9))")
USDC="$(cd packages/evm-engine && forge create test/mocks/MockERC20.sol:MockERC20 --rpc-url "$RPC" --private-key "$KEY0" --broadcast --constructor-args USDC 6 2>/dev/null | awk '/Deployed to:/ {print $3}')"
[ -n "$USDC" ] || { echo "mock cash deploy failed (packages/evm-engine/lib: see its README)" >&2; exit 1; }
echo "fork :$PORT, mock cash $USDC"
RPC="$RPC" USDC="$USDC" STRIKE_IN="$STRIKE_IN" OBS_EVERY="$OBS_EVERY" OUT="$WORK/paid.json" npx tsx scripts/e2e/xc-issue.ts > /dev/null
RPC="$RPC" USDC="$USDC" STRIKE_IN="$STRIKE_IN" OBS_EVERY="$OBS_EVERY" OUT="$WORK/defaulted.json" npx tsx scripts/e2e/xc-issue.ts > /dev/null
A="$(python3 -c "import json;print(json.load(open('$WORK/paid.json'))['pid'])")"
B="$(python3 -c "import json;print(json.load(open('$WORK/defaulted.json'))['pid'])")"
FROM="$(python3 -c "import json;print(json.load(open('$WORK/paid.json'))['fromBlock'])")"
echo "issued: note $A (paid in full), note $B (misses payment 1)"
ENGINE=0x7d36Da43724b09Bb03ED98a4574685070073020b LENS=0x7EE0F15F5DF7773C702C38d9d227466386974734
# The bot under test: the gateway comes from deployments/crosschain-testnet.json (same chain id and engine).
RPC="$RPC" CHAIN_ID=421614 ENGINE="$ENGINE" LENS="$LENS" FROM_BLOCK="$FROM" GATEWAY_FROM_BLOCK="$FROM" PIDS="$A,$B" \
  ISSUER_KEY="$KEY1" MINT=1 MISS="$B:1" INTERVAL=4 FLUSH_AFTER="$FLUSH_AFTER" npx tsx scripts/issuer-bot.ts > "$WORK/bot.log" 2>&1 &
echo $! > "$WORK/bot.pid"
cat > "$WORK/keeper.json" <<JSON
{ "chain": { "name": "arbitrum-fork", "chainId": 421614, "rpc": "$RPC", "engine": "$ENGINE", "lens": "$LENS" },
  "blockTag": "latest", "finalityAllowanceSec": 1800, "maxReportsPerRun": 5, "gasLimit": "8000000" }
JSON
echo "$KEY9" > "$WORK/fallback.key"
for _ in $(seq 1 60); do
  KEEPER_CONFIG="$WORK/keeper.json" KEEPER_KEY_FILE="$WORK/fallback.key" npx tsx services/keeper-fallback/src/main.ts --once >> "$WORK/keeper.log" 2>&1 || true
  st="$(RPC="$RPC" PAID="$WORK/paid.json" DEFAULTED="$WORK/defaulted.json" STATUS_ONLY=1 npx tsx scripts/e2e/xc-verify.ts)"
  echo "$(date -u +%T) status $st"
  [[ "$st" != *0* ]] && break
  sleep 15
done
echo "both notes ended; waiting $((FLUSH_AFTER + 90)) s for the bot's withdraw, pushes and late fallback flush"
sleep $((FLUSH_AFTER + 90))
grep -E "withdrew|pushed receipt|flushed|receipt|gateway" "$WORK/bot.log" || true
RPC="$RPC" PAID="$WORK/paid.json" DEFAULTED="$WORK/defaulted.json" FLUSH_AFTER="$FLUSH_AFTER" npx tsx scripts/e2e/xc-verify.ts
