#!/usr/bin/env bash
# Deploy one cross-chain collateral pair (docs/CROSS-CHAIN.md): the HomeGateway next to the engine on the note's chain
# (HOME_CHAIN), a RemoteVault on the other chain (ASSET_CHAIN) allowing the pair's tokens, and the wiring (the
# gateway's remote vault and one receipt per token). Writes deployments/crosschain/<home>.json (checked against
# packages/core: XC_CHAINS, wirePlan), then regenerates the CRE staging config and the server configs.
#
#   HOME_CHAIN=robinhood-testnet ASSET_CHAIN=base-sepolia bash scripts/deploy-crosschain.sh   # USDC, WETH on Base
#   HOME_CHAIN=base-sepolia ASSET_CHAIN=robinhood-testnet bash scripts/deploy-crosschain.sh   # USDG, WETH, TSLA, AMZN, AMD, PLTR on Robinhood
#   REHEARSAL=1 HOME_CHAIN=... ASSET_CHAIN=... bash scripts/deploy-crosschain.sh              # on anvil forks of both chains
#
# Needs deployments/<home>.json with an engine (scripts/deploy-testnets.sh). FEE_POOL (wei, default 0.005 ETH) funds
# the gateway's release fee pool in the same run; OWNER (default: the deployer) owns gateway and vault and must be the
# broadcaster here (the vault and wire steps configure). RPC_ROBINHOOD_TESTNET / RPC_BASE_SEPOLIA override the RPCs.
# A home that already has deployments/crosschain/<home>.json is refused unless REDEPLOY=1 (receipts of the old pair
# would stay redeemable only through the old gateway: keep its record, e.g. under deployments/archive/xc-<n>/).
#
# The deployer key is read from .keys/deployer.json at run time, handed to each forge command in its environment only
# (DEPLOYER_KEY), never printed. A rehearsal without .keys/deployer.json uses anvil's public test key #0 (forks only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"
H="${HOME_CHAIN:?set HOME_CHAIN (robinhood-testnet | base-sepolia)}"
A="${ASSET_CHAIN:?set ASSET_CHAIN (the other note chain)}"
REHEARSAL="${REHEARSAL:-0}"
FEE_POOL="${FEE_POOL:-5000000000000000}"
eval "$(npx tsx scripts/xc-plan.ts env "$H" "$A")"
declare -A RPC=(
  [robinhood-testnet]="${RPC_ROBINHOOD_TESTNET:-https://rpc.testnet.chain.robinhood.com}"
  [base-sepolia]="${RPC_BASE_SEPOLIA:-https://sepolia.base.org}"
)
declare -A ID=( [$H]="$HOME_ID" [$A]="$ASSET_ID" )

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
  echo "missing .keys/deployer.json"; exit 1
fi
OWNER="${OWNER:-$DEPLOYER}"

OUTBASE="deployments"
[ "$REHEARSAL" = "1" ] && OUTBASE="deployments/local/rehearsal"
RECORD="$OUTBASE/crosschain/$H.json"
STEPS="$ROOT/$OUTBASE/xc-steps/$H"
if [ "$REHEARSAL" != "1" ] && [ -f "$RECORD" ] && [ "${REDEPLOY:-0}" != "1" ]; then
  echo "$RECORD exists: this home already has a gateway (REDEPLOY=1 deploys a new pair; archive the old record first)"; exit 1
fi
rm -rf "$STEPS"; mkdir -p "$STEPS" "$OUTBASE/crosschain"

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
if [ "$REHEARSAL" = "1" ]; then
  port=28700
  for c in "$H" "$A"; do
    port=$((port + 1))
    anvil --fork-url "${RPC[$c]}" --chain-id "${ID[$c]}" --port "$port" --silent & PIDS+=($!)
    for _ in $(seq 1 60); do cast chain-id --rpc-url "http://127.0.0.1:$port" >/dev/null 2>&1 && break; sleep 1; done
    cast rpc anvil_setBalance "$DEPLOYER" 0x8AC7230489E80000 --rpc-url "http://127.0.0.1:$port" >/dev/null   # 10 ETH, fork only
    RPC[$c]="http://127.0.0.1:$port"
  done
fi
for c in "$H" "$A"; do
  [ "$(cast chain-id --rpc-url "${RPC[$c]}")" = "${ID[$c]}" ] || { echo "$c: RPC ${RPC[$c]} is not chain ${ID[$c]}"; exit 1; }
done

# The home engine: deployments/<home>.json. A rehearsal whose home has none yet (Base before its first deploy) deploys
# one on the fork first.
ENGINE="$(python3 -c "import json,os;f='deployments/$H.json';print(json.load(open(f)).get('engine','') if os.path.exists(f) else '')")"
if [ -z "$ENGINE" ] && [ "$REHEARSAL" = "1" ]; then
  echo "== $H (fork): no engine in deployments/$H.json, deploying one on the fork"
  (cd packages/evm-engine && export DEPLOYER_KEY="$(deployer_key)" && \
    CHAIN="$H" FORWARDER_MODE=mock OWNER="$DEPLOYER" OUT="$STEPS/engine.json" VERIFIER="$ANVIL_ADDR1" REQUIRE_EMAIL=1 \
    forge script script/Deploy.s.sol --rpc-url "${RPC[$H]}" --broadcast > "$STEPS/engine.log" 2>&1) \
    || { echo "engine deploy failed (see $STEPS/engine.log)"; exit 1; }
  ENGINE="$(python3 -c "import json;print(json.load(open('$STEPS/engine.json'))['engine'])")"
fi
[ -n "$ENGINE" ] || { echo "no engine in deployments/$H.json: run CHAINS=$H bash scripts/deploy-testnets.sh first"; exit 1; }
echo "== pair: notes on $H (engine $ENGINE), collateral locked on $A: ${XC_SYMBOLS//,/, }"

need() { # chain, minimum ETH
  local bal; bal="$(cast balance "$DEPLOYER" --rpc-url "${RPC[$1]}" --ether)"
  echo "   $1: deployer $DEPLOYER has $bal ETH (needs >= $2)"
  python3 -c "import sys; sys.exit(0 if float('$bal') >= float('$2') else 1)" || { echo "$1: fund the deployer first"; exit 1; }
}
need "$H" "$(python3 -c "print($FEE_POOL/1e18 + 0.002)")"
need "$A" 0.001

# Gas used by the last forge broadcast on chain id $1 (the rehearsal's measurement; the live run's actual cost).
gas_report() {
  local bc="packages/evm-engine/broadcast/DeployCrossChain.s.sol/$1/run-latest.json"
  [ -f "$bc" ] && python3 -c "
import json;d=json.load(open('$bc'));rs=d['receipts']
g=sum(int(r['gasUsed'],16) for r in rs);p=max(int(r.get('effectiveGasPrice','0x0'),16) for r in rs)
v=sum(int(t['transaction'].get('value','0x0'),16) for t in d['transactions'])
print('   $2: %d gas over %d transaction(s) (gas price %.4f gwei), value sent %.6f ETH' % (g,len(rs),p/1e9,v/1e18))
open('$STEPS/gas.txt','a').write('$2 %d %d %d\n' % (g,len(rs),v))"
}
# One role of DeployCrossChain.s.sol on chain $1; the rest of the env is the caller's.
role() {
  local chain="$1" name="$2"
  (cd packages/evm-engine && export DEPLOYER_KEY="$(deployer_key)" && \
    ROLE="$name" CHAIN="$chain" OUT="$STEPS/$name.json" \
    forge script script/DeployCrossChain.s.sol --rpc-url "${RPC[$chain]}" --broadcast --slow > "$STEPS/$name.log" 2>&1) \
    || { echo "$name on $chain failed (see $STEPS/$name.log)"; exit 1; }
  gas_report "${ID[$chain]}" "$name ($chain)"
}

gw_block="$(cast block-number --rpc-url "${RPC[$H]}")"
echo "== 1/3 gateway on $H (fee pool $FEE_POOL wei)"
ENGINE="$ENGINE" OWNER="$OWNER" FEE_POOL="$FEE_POOL" role "$H" gateway
GATEWAY="$(python3 -c "import json;print(json.load(open('$STEPS/gateway.json'))['gateway'])")"
echo "   HomeGateway $GATEWAY"

v_block="$(cast block-number --rpc-url "${RPC[$A]}")"
echo "== 2/3 vault on $A"
HOME_CHAIN="$H" GATEWAY="$GATEWAY" OWNER="$OWNER" TOKENS="$XC_TOKENS" role "$A" vault
VAULT="$(python3 -c "import json;print(json.load(open('$STEPS/vault.json'))['vault'])")"
echo "   RemoteVault $VAULT"

echo "== 3/3 wire on $H: receipts ${XC_SYMBOLS//,/, }"
GATEWAY="$GATEWAY" REMOTE="$A" VAULT="$VAULT" TOKENS="$XC_TOKENS" DECIMALS="$XC_DECIMALS" SYMBOLS="$XC_SYMBOLS" role "$H" wire

echo "{\"gateway\": $gw_block, \"vault\": $v_block}" > "$STEPS/blocks.json"
npx tsx scripts/xc-plan.ts assemble "$H" "$A" "$STEPS" "$ENGINE" "$OWNER" "$RECORD"

# Read back on-chain: the vault answers to the gateway, the gateway to the vault, the pool is funded.
[ "$(cast call "$VAULT" 'homeGateway()(address)' --rpc-url "${RPC[$A]}" | tr A-F a-f)" = "$(echo "$GATEWAY" | tr A-F a-f)" ] || { echo "vault does not answer to the gateway"; exit 1; }
echo "   gateway VERSION $(cast call "$GATEWAY" 'VERSION()(uint256)' --rpc-url "${RPC[$H]}"), releaseQueue $(cast call "$GATEWAY" 'releaseQueue()(uint256,uint256,uint256,uint256,uint256)' --rpc-url "${RPC[$H]}" | tr '\n' ' ')"

if [ "$REHEARSAL" != "1" ]; then
  npx tsx scripts/cre-config.ts staging
  npx tsx scripts/server-config.ts
fi
echo "done: $RECORD"
