#!/usr/bin/env bash
# End to end, without testnet gas: Chainlink CRE (simulator, --broadcast) and the fallback keeper each run a
# note's whole life on a local fork of a real testnet, and every payout is checked against the reference payoff.
#
#   1. Robinhood Chain testnet fork (anvil, chain id 46630): the real MockKeystoneForwarder is there. Deploy FlowEngine +
#      NotesLens + a mock USDC, issue a worst-of phoenix on ETH and BTC (strike ~2 min out, observations
#      OBS_EVERY apart), subscribe two investors, then run `cre workflow simulate --broadcast` until it completes.
#      Prices: Chainlink ETH/USD and BTC/USD on Ethereum mainnet, read at a finalized block. E2E_NOTE=equity: TSLA and
#      NVDA on Robinhood Chain mainnet, read over the CRE HTTP capability (JSON-RPC eth_call; no EVM read there).
#   2. A second Robinhood Chain testnet fork: same note, driven by services/keeper-fallback through
#      FlowEngine.fallbackReport (the path for Robinhood mainnet, where CRE cannot write yet).
#
# Accounts are anvil's public test accounts (scripts/e2e/lib.ts). No real key is read or used.
# Needs: anvil/forge/cast (Foundry), bun + the CRE CLI logged in (`cre whoami`), Node 20+, network access.
# The issuer (anvil account 1) is driven by scripts/issuer-bot.ts: it funds each payment as it falls due. With
# MISS=1:<period> it leaves that payment unfunded and the note must default (collateral to the holders).
#   bash scripts/e2e-cre-evm.sh            # both parts
#   PARTS=cre bash scripts/e2e-cre-evm.sh  # only the CRE part (PARTS=fallback for the other)
#   MISS=1:1 PARTS=fallback bash scripts/e2e-cre-evm.sh   # the issuer misses payment 1: default
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.cre/bin:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"
PARTS="${PARTS:-cre fallback}"
STRIKE_IN="${STRIKE_IN:-150}"
OBS_EVERY="${OBS_EVERY:-150}"
# Payment date 70 s after each observation, then 70 s of grace: CRE writes an observation up to a minute late.
export LAG="${LAG:-$((OBS_EVERY * 7 / 15))}" GRACE="${GRACE:-$((OBS_EVERY * 7 / 15))}"
WORK="$ROOT/deployments/local"
mkdir -p "$WORK"
# fork() runs in a command substitution (a subshell), so it records anvil's pid in a file for cleanup.
cleanup() { issuer_bot_stop; for f in "$WORK"/anvil-*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; done; rm -f "$ROOT/cre/local-fork.env" "$WORK/fallback.key"; }
trap cleanup EXIT

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
# Anvil's public test accounts, resolved once (0 deployer/owner, 8 CRE broadcaster, 9 fallback reporter).
read -r KEY0 KEY1 KEY8 KEY9 ADDR0 ADDR9 < <(npx tsx -e "import { keyOf, acct } from '$ROOT/scripts/e2e/lib'; console.log(keyOf(0), keyOf(1), keyOf(8), keyOf(9), acct(0).address, acct(9).address)")
# The issuer's side, running beside the keeper: fund each payment as soon as an observation fixes it, checking
# every 4 s (MISS=pid:period leaves one unfunded). Stopped by issuer_bot_stop or cleanup.
issuer_bot_start() { # <rpc> <chain id> <deployment json>
  RPC="$1" CHAIN_ID="$2" ENGINE="$(python3 -c "import json;print(json.load(open('$3'))['engine'])")" LENS="$(python3 -c "import json;print(json.load(open('$3'))['lens'])")" \
    FROM_BLOCK="$(python3 -c "import json;print(json.load(open('$3'))['block'])")" \
    ISSUER_KEY="$KEY1" MINT=1 MISS="${MISS:-}" INTERVAL=4 npx tsx scripts/issuer-bot.ts >> "$WORK/issuer-bot.log" 2>&1 &
  echo $! > "$WORK/issuer-bot.pid"
}
# Only this run's bot (and its npx/tsx children): a pattern kill would also stop issuer bots running beside it (pm2).
kill_tree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done; kill "$1" 2>/dev/null || true; }
issuer_bot_stop() { [ -f "$WORK/issuer-bot.pid" ] && kill_tree "$(cat "$WORK/issuer-bot.pid")"; rm -f "$WORK/issuer-bot.pid"; }

# fork <name> <rpc> <chain id>: starts anvil, prints the port. Blocks every 2 s (so "finalized", two blocks
# behind, keeps moving) and a 30M gas limit for the deploy.
fork() {
  local port; port="$(free_port)"
  anvil --fork-url "$2" --chain-id "$3" --port "$port" --block-time 2 --slots-in-an-epoch 1 --gas-limit 30000000 \
    > "$WORK/anvil-$1.log" 2>&1 &
  echo $! > "$WORK/anvil-$1.pid"
  for _ in $(seq 1 60); do cast chain-id --rpc-url "http://127.0.0.1:$port" >/dev/null 2>&1 && break; sleep 1; done
  echo "$port"
}

# deploy <name> <port> <CHAIN for Deploy.s.sol>: engine + lens (mock forwarder) and a mock USDC.
deploy() {
  local rpc="http://127.0.0.1:$2" head
  head="$(cast block-number --rpc-url "$rpc")" # the chain's own block (Solidity's block.number is L1's on an Orbit chain)
  (cd packages/evm-engine && CHAIN="$3" FORWARDER_MODE=mock OWNER="$ADDR0" OUT="$WORK/$1.json" \
    forge script script/Deploy.s.sol --rpc-url "$rpc" --private-key "$KEY0" --broadcast --slow > "$WORK/deploy-$1.log" 2>&1)
  python3 scripts/set-deploy-block.py "$WORK/$1.json" "$head"
  (cd packages/evm-engine && forge create test/mocks/MockERC20.sol:MockERC20 --rpc-url "$rpc" --private-key "$KEY0" \
    --broadcast --constructor-args USDC 6 2>/dev/null | awk '/Deployed to:/ {print $3}')
}

wait_for_completion() { # <rpc> <chain id> <note json> <driver command...>
  local rpc="$1" id="$2" note="$3"; shift 3
  for _ in $(seq 1 60); do
    "$@" || true
    [ "$(RPC="$rpc" CHAIN_ID="$id" NOTE_JSON="$note" STATUS_ONLY=1 npx tsx scripts/e2e/verify.ts)" = "1" ] && return 0
    sleep 20
  done
  echo "note did not complete" >&2; return 1
}

if [[ " $PARTS " == *" cre "* ]]; then
  echo "== CRE on a Robinhood Chain testnet fork"
  PORT="$(fork robinhood-cre https://rpc.testnet.chain.robinhood.com 46630)"
  RPC="http://127.0.0.1:$PORT"
  FWD=0x0b93082D9b3C7C97fAcd250082899BAcf3af3885  # Robinhood Chain testnet MockKeystoneForwarder
  [ "$(cast code "$FWD" --rpc-url "$RPC" | wc -c)" -gt 4 ] || { echo "MockKeystoneForwarder missing on the fork" >&2; exit 1; }
  echo "fork :$PORT, MockKeystoneForwarder $FWD has code"
  USDC="$(deploy robinhood-fork "$PORT" robinhood-testnet)"
  echo "deployed: $(cat "$WORK/robinhood-fork.json" | tr -d '\n')  USDC $USDC"
  RPC="$RPC" CHAIN_ID=46630 DEPLOYMENT="$WORK/robinhood-fork.json" USDC="$USDC" STRIKE_IN="$STRIKE_IN" OBS_EVERY="$OBS_EVERY" \
    OUT="$WORK/note-cre.json" npx tsx scripts/e2e/issue.ts > /dev/null
  echo "issued: $(cat "$WORK/note-cre.json" | tr -d '\n ')"
  npx tsx scripts/cre-config.ts local-fork "$WORK/robinhood-fork.json"
  # The simulator's broadcaster pays gas on the fork: anvil account 8 (a public test key), in a throwaway env file.
  printf 'CRE_ETH_PRIVATE_KEY=%s\n' "${KEY8#0x}" > cre/local-fork.env
  export SN_FORK_PORT="$PORT"
  issuer_bot_start "$RPC" 46630 "$WORK/robinhood-fork.json"
  simulate() {
    (cd cre && cre workflow simulate notes-keeper-evm --target local-fork --non-interactive --trigger-index 0 \
      --broadcast -e local-fork.env 2>&1 | grep -E 'USER LOG|Workflow Simulation Result|^"\{|✗|rror' || true) | tee -a "$WORK/cre.log"
  }
  wait_for_completion "$RPC" 46630 "$WORK/note-cre.json" simulate
  RPC="$RPC" CHAIN_ID=46630 NOTE_JSON="$WORK/note-cre.json" EXPECT_REPORTER="$FWD" MISS="${MISS:-}" npx tsx scripts/e2e/verify.ts | tee "$WORK/verify-cre.txt"
  issuer_bot_stop
  rm -f cre/local-fork.env
fi

if [[ " $PARTS " == *" fallback "* ]]; then
  echo "== Fallback keeper on a Robinhood Chain testnet fork"
  PORT="$(fork robinhood-fallback https://rpc.testnet.chain.robinhood.com 46630)"
  RPC="http://127.0.0.1:$PORT"
  USDC="$(deploy robinhood-fallback "$PORT" robinhood-testnet)"
  echo "deployed: $(cat "$WORK/robinhood-fallback.json" | tr -d '\n')  USDC $USDC"
  RPC="$RPC" CHAIN_ID=46630 DEPLOYMENT="$WORK/robinhood-fallback.json" USDC="$USDC" STRIKE_IN="$STRIKE_IN" OBS_EVERY="$OBS_EVERY" FALLBACK=1 \
    OUT="$WORK/note-fallback.json" npx tsx scripts/e2e/issue.ts > /dev/null
  echo "issued: $(cat "$WORK/note-fallback.json" | tr -d '\n ')"
  ENGINE="$(python3 -c "import json;print(json.load(open('$WORK/robinhood-fallback.json'))['engine'])")"
  LENS="$(python3 -c "import json;print(json.load(open('$WORK/robinhood-fallback.json'))['lens'])")"
  cat > "$WORK/keeper-fallback.json" <<JSON
{ "chain": { "name": "robinhood-fallback", "chainId": 46630, "rpc": "$RPC", "engine": "$ENGINE", "lens": "$LENS" },
  "feedRpcs": { "ethereum-mainnet": "https://ethereum-rpc.publicnode.com", "robinhood-mainnet": "https://rpc.mainnet.chain.robinhood.com" },
  "blockTag": "finalized", "finalityAllowanceSec": 1800, "maxReportsPerRun": 5, "gasLimit": "8000000" }
JSON
  echo "$KEY9" > "$WORK/fallback.key"
  issuer_bot_start "$RPC" 46630 "$WORK/robinhood-fallback.json"
  fallback() {
    KEEPER_CONFIG="$WORK/keeper-fallback.json" KEEPER_KEY_FILE="$WORK/fallback.key" npx tsx services/keeper-fallback/src/main.ts --once 2>&1 | tee -a "$WORK/fallback.log"
  }
  wait_for_completion "$RPC" 46630 "$WORK/note-fallback.json" fallback
  RPC="$RPC" CHAIN_ID=46630 NOTE_JSON="$WORK/note-fallback.json" EXPECT_REPORTER="$ADDR9" MISS="${MISS:-}" npx tsx scripts/e2e/verify.ts | tee "$WORK/verify-fallback.txt"
  issuer_bot_stop
  rm -f "$WORK/fallback.key"
fi
