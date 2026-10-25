// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {FlowEngine} from "../src/FlowEngine.sol";
import {NotesLens} from "../src/NotesLens.sol";
import {TestToken} from "../src/test-tokens/TestToken.sol";
import {TokenFaucet} from "../src/test-tokens/TokenFaucet.sol";

/// Deploy FlowEngine and its NotesLens (keeper reads) to one chain and record them in deployments/<chain>.json
/// (repo root; OUT overrides the path, e.g. for a local fork). On testnets, TEST_TOKENS=1 also deploys the test
/// tokens (tUSD, tETH, tBTC, tSOL, tTSLA, tNVDA, tAAPL, tSPY) and a TokenFaucet that mints them.
///
///   CHAIN=arbitrum-sepolia FORWARDER_MODE=mock OWNER=0x... TEST_TOKENS=1 \
///   forge script script/Deploy.s.sol --rpc-url $RPC --private-key $KEY --broadcast
///
/// CHAIN:          arbitrum-sepolia | robinhood-testnet | arbitrum-one | robinhood-mainnet
/// FORWARDER_MODE: mock (`cre workflow simulate --broadcast` writes through the MockKeystoneForwarder) or
///                 production (a deployed CRE workflow writes through the KeystoneForwarder)
/// FORWARDER:      optional override; required on robinhood-mainnet, where CRE has no forwarder yet
/// OWNER:          the engine's admin (pause, forwarder, workflow checks); a multisig in production
///
/// Forwarder addresses: `cre workflow supported-chains` (CRE CLI v1.36), checked 2026-10-23. Check them again
/// before a live deployment. The fallback reporter is left unset (off).
contract Deploy is Script {
    struct Target {
        uint256 chainId;
        address mock;
        address production;
        bool testnet;
    }

    function _chain(string memory name) internal pure returns (Target memory) {
        bytes32 h = keccak256(bytes(name));
        if (h == keccak256("arbitrum-sepolia")) {
            return Target(421614, 0xD41263567DdfeAd91504199b8c6c87371e83ca5d, 0x76c9cf548b4179F8901cda1f8623568b58215E62, true);
        }
        if (h == keccak256("robinhood-testnet")) {
            return Target(46630, 0x0b93082D9b3C7C97fAcd250082899BAcf3af3885, 0x8E6E6A1f2B2D4dF503bfd67951CF28F27BF3AF19, true);
        }
        if (h == keccak256("arbitrum-one")) {
            return Target(42161, 0xd770499057619C9a76205fD4168161cf94Abc532, 0xF8344CFd5c43616a4366C34E3EEE75af79a74482, false);
        }
        if (h == keccak256("robinhood-mainnet")) return Target(4663, address(0), address(0), false);
        revert(string.concat("unknown CHAIN ", name));
    }

    function run() external returns (FlowEngine engine) {
        string memory name = vm.envString("CHAIN");
        string memory mode = vm.envOr("FORWARDER_MODE", string("mock"));
        address owner = vm.envAddress("OWNER");
        bool testTokens = vm.envOr("TEST_TOKENS", false);
        Target memory c = _chain(name);
        require(block.chainid == c.chainId, "RPC is not on CHAIN");
        require(!testTokens || c.testnet, "TEST_TOKENS is for testnets only");
        address forwarder = vm.envOr("FORWARDER", keccak256(bytes(mode)) == keccak256("production") ? c.production : c.mock);
        require(forwarder != address(0), "no CRE forwarder on this chain: set FORWARDER");

        string memory key = "deployment";
        // DEPLOYER_KEY (env) keeps the key off the command line (scripts/deploy-testnets.sh); else --private-key.
        uint256 pk = vm.envOr("DEPLOYER_KEY", uint256(0));
        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast();
        engine = new FlowEngine(owner, forwarder);
        // Verified emails (EmailAttest): VERIFIER signs attestations; REQUIRE_EMAIL gates issuing, subscribing and
        // receiving units on them. Set here only when the broadcaster is the owner (testnets).
        address emailVerifier = vm.envOr("VERIFIER", address(0));
        bool requireEmail = vm.envOr("REQUIRE_EMAIL", false);
        if (emailVerifier != address(0)) engine.setEmailPolicy(emailVerifier, requireEmail);
        NotesLens lens = new NotesLens(engine);
        if (testTokens) _testTokens(key, owner);
        vm.stopBroadcast();

        vm.serializeString(key, "chain", name);
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "engine", address(engine));
        vm.serializeAddress(key, "lens", address(lens));
        vm.serializeAddress(key, "forwarder", forwarder);
        vm.serializeString(key, "forwarderMode", mode);
        vm.serializeAddress(key, "owner", owner);
        vm.serializeAddress(key, "verifier", engine.verifier());
        vm.serializeBool(key, "requireEmail", engine.requireEmail());
        vm.serializeUint(key, "block", block.number);
        string memory json = vm.serializeUint(key, "deployedAt", block.timestamp);
        string memory path = vm.envOr("OUT", string.concat(vm.projectRoot(), "/../../deployments/", name, ".json"));
        vm.writeJson(json, path);
        console2.log("FlowEngine", address(engine));
        console2.log("NotesLens", address(lens));
        console2.log("written", path);
    }

    /// Test tokens and their faucet. The broadcaster deploys them as `owner`'s stand-in: it must BE the owner
    /// (it calls setMinter and setDrip), so run with OWNER = the deployer on testnets.
    TokenFaucet internal faucet;
    address internal tokenOwner;
    string internal tokensJson;

    /// Every claim: a fixed amount per token, once an hour per account.
    uint64 internal constant COOLDOWN = 1 hours;

    function _testTokens(string memory key, address owner) internal {
        tokenOwner = owner;
        faucet = new TokenFaucet(owner);
        // name, symbol, decimals, whole tokens per claim
        _token("Test USD", "tUSD", 6, 2_000);
        _token("Test Ether", "tETH", 9, 2);
        _token("Test Bitcoin", "tBTC", 8, 1);
        _token("Test Solana", "tSOL", 9, 50);
        _token("Test Tesla", "tTSLA", 9, 20);
        _token("Test NVIDIA", "tNVDA", 9, 20);
        _token("Test Apple", "tAAPL", 9, 20);
        _token("Test SPY", "tSPY", 9, 10);
        vm.serializeString(key, "tokens", tokensJson);
        vm.serializeAddress(key, "faucet", address(faucet));
    }

    function _token(string memory name, string memory symbol, uint8 decimals, uint256 units) internal {
        TestToken t = new TestToken(name, symbol, decimals, tokenOwner);
        t.setMinter(address(faucet), true);
        faucet.setDrip(address(t), units * 10 ** decimals, COOLDOWN);
        tokensJson = vm.serializeAddress("tokens", symbol, address(t));
    }
}
