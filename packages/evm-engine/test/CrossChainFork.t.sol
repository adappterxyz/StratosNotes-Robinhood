// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {CCIPLocalSimulatorFork} from "@chainlink/local/src/ccip/CCIPLocalSimulatorFork.sol";
import {Register} from "@chainlink/local/src/ccip/Register.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HomeGateway} from "../src/crosschain/HomeGateway.sol";
import {RemoteVault} from "../src/crosschain/RemoteVault.sol";
import {RemoteReceipt} from "../src/crosschain/RemoteReceipt.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// Cross-chain collateral (docs/CROSS-CHAIN.md) on the real CCIP routers and lanes: a fork of the home chain (the
/// note's chain, where the gateway and receipts live; default Robinhood Chain testnet) and a fork of the asset chain
/// (default Ethereum Sepolia), with Chainlink Local's CCIPLocalSimulatorFork routing the messages. Both are
/// selectable, so each deployed direction runs on its real routers:
///   Robinhood home, Base vault:  REMOTE_RPC=https://sepolia.base.org REMOTE_CHAIN_ID=84532 \
///                                REMOTE_WETH=0x4200000000000000000000000000000000000006
///   Base home, Robinhood vault:  HOME_RPC=https://sepolia.base.org HOME_CHAIN_ID=84532 \
///                                REMOTE_RPC=https://rpc.testnet.chain.robinhood.com REMOTE_CHAIN_ID=46630 \
///                                REMOTE_WETH=0x7943e237c7F95DA44E0301572D358911207852Fa
/// The asset chain's real WETH (and a stand-in stablecoin deployed on the fork) are locked in the vault there,
/// receipts are minted at home, then redeemed back to the real tokens, and an auto-release is flushed from the fee
/// pool. Opt-in (network): CCIP_FORK=true [env above] forge test --match-contract CrossChainForkTest -vv
/// Passed 2026-10-25 (Robinhood home, Ethereum Sepolia vault) and 2026-11-06 in both Robinhood <-> Base directions
/// (fees and gas in docs/CROSS-CHAIN.md). The same mechanism was proven live in the earlier Arbitrum build.
contract CrossChainForkTest is Test {
    /// WETH9 on Ethereum Sepolia (18 dp); REMOTE_WETH overrides it for another remote chain.
    address constant SEPOLIA_WETH = 0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9;

    CCIPLocalSimulatorFork sim;
    uint256 homeFork;
    uint256 remoteFork;
    Register.NetworkDetails home;
    Register.NetworkDetails remote;
    HomeGateway gateway;
    RemoteVault vault;
    address weth;
    address usd;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address engine = makeAddr("engine"); // the receipts' only counterparty; the engine path is covered locally

    function setUp() public {
        vm.skip(!vm.envOr("CCIP_FORK", false));
        remoteFork = vm.createSelectFork(vm.envOr("REMOTE_RPC", string("https://ethereum-sepolia-rpc.publicnode.com")));
        // The chains' ids (block.chainid can be stale right after a switch).
        uint256 remoteId = vm.envOr("REMOTE_CHAIN_ID", uint256(11155111));
        uint256 homeId = vm.envOr("HOME_CHAIN_ID", uint256(46630));
        weth = vm.envOr("REMOTE_WETH", SEPOLIA_WETH);
        homeFork = vm.createSelectFork(
            vm.envOr("HOME_RPC", vm.envOr("RH_TESTNET_RPC", string("https://rpc.testnet.chain.robinhood.com")))
        );
        sim = new CCIPLocalSimulatorFork();
        vm.makePersistent(address(sim));
        home = sim.getNetworkDetails(homeId);
        remote = sim.getNetworkDetails(remoteId);
        console2.log("home chain id", homeId, "asset chain id", remoteId);

        gateway = new HomeGateway(home.routerAddress, owner, engine, makeAddr("forwarder"));
        vm.selectFork(remoteFork);
        usd = address(new MockERC20("USD", 6)); // a stand-in stablecoin on the remote fork (after the persistent sim)
        vault = new RemoteVault(remote.routerAddress, owner, home.chainSelector);
        vm.startPrank(owner);
        vault.setHomeGateway(address(gateway));
        vault.setToken(usd, true);
        vault.setToken(weth, true);
        vm.stopPrank();

        vm.selectFork(homeFork);
        vm.startPrank(owner);
        gateway.setRemote(remote.chainSelector, address(vault), 300_000);
        gateway.registerReceipt(remote.chainSelector, usd, 6, "USD locked on the remote chain", "USD.x");
        gateway.registerReceipt(remote.chainSelector, weth, 18, "WETH locked on the remote chain", "WETH.x");
        vm.stopPrank();
    }

    function _lockAndRoute(address token, uint256 amount) internal returns (RemoteReceipt receipt) {
        vm.selectFork(remoteFork);
        deal(token, alice, amount);
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        IERC20(token).approve(address(vault), amount);
        uint256 fee = vault.quoteLock(token, amount, alice);
        console2.log("CCIP fee to lock (wei, asset chain):", fee);
        uint256 g = gasleft();
        vault.lock{value: fee}(token, amount, alice);
        console2.log("lock gas (asset chain):", g - gasleft());
        vm.stopPrank();
        assertEq(vault.locked(token), amount, "locked on the asset chain");
        sim.switchChainAndRouteMessage(homeFork); // now on the home chain
        receipt = RemoteReceipt(gateway.receiptOf(remote.chainSelector, token));
        assertEq(receipt.balanceOf(alice), amount, "receipts minted on the home chain");
    }

    function _redeemAndRoute(RemoteReceipt receipt, address token, uint256 amount) internal {
        vm.selectFork(homeFork);
        vm.deal(alice, 1 ether);
        uint256 fee = gateway.quoteRedeem(address(receipt), amount, alice);
        console2.log("CCIP fee to redeem (wei, home chain):", fee);
        vm.prank(alice);
        gateway.redeem{value: fee}(address(receipt), amount, alice);
        sim.switchChainAndRouteMessage(remoteFork); // now on the asset chain
        assertEq(IERC20(token).balanceOf(alice), amount, "real asset paid on the asset chain");
        assertEq(vault.locked(token), 0, "nothing left locked");
    }

    function test_fork_usdLockedRemotely_receiptsAtHome_redeemed() public {
        RemoteReceipt r = _lockAndRoute(usd, 250e6);
        _redeemAndRoute(r, usd, 250e6);
    }

    function test_fork_wethLockedRemotely_receiptsAtHome_redeemed() public {
        RemoteReceipt r = _lockAndRoute(weth, 3e18);
        _redeemAndRoute(r, weth, 3e18);
    }

    /// v2 auto-release on the real routers: receipts leave the engine, are burned and queued; the fee pool pays the
    /// real CCIP fee on flush; the vault pays the real WETH on the asset chain.
    function test_fork_autoRelease_wethPaidRemotely() public {
        RemoteReceipt r = _lockAndRoute(weth, 2e18);
        vm.prank(alice);
        r.transfer(engine, 2e18); // pledge
        vm.prank(engine);
        r.transfer(alice, 2e18); // payout or release: burned here, queued at the gateway
        assertEq(r.balanceOf(alice), 0);
        (,,,, uint256 fee) = gateway.releaseQueue();
        console2.log("CCIP fee of a queued release (wei, home chain):", fee);
        gateway.fundFees{value: fee}();
        uint256 g = gasleft();
        assertEq(gateway.flush(25), 1);
        console2.log("flush of 1 release on the real home router (gas):", g - gasleft());
        sim.switchChainAndRouteMessage(remoteFork);
        assertEq(IERC20(weth).balanceOf(alice), 2e18, "real WETH paid on the asset chain");
        assertEq(vault.locked(weth), 0);
    }
}
