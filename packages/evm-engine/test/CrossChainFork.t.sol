// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {CCIPLocalSimulatorFork} from "@chainlink/local/src/ccip/CCIPLocalSimulatorFork.sol";
import {Register} from "@chainlink/local/src/ccip/Register.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HomeGateway} from "../src/crosschain/HomeGateway.sol";
import {RemoteVault} from "../src/crosschain/RemoteVault.sol";
import {RemoteReceipt} from "../src/crosschain/RemoteReceipt.sol";

/// The real CCIP routers and lanes, on forks of Arbitrum Sepolia (home) and Robinhood Chain testnet (assets), with
/// Chainlink Local's CCIPLocalSimulatorFork routing the messages: Robinhood's real USDG (Paxos) and TSLA stock token
/// are locked in the vault on Robinhood, receipts are minted on Arbitrum, then redeemed back to the real tokens.
/// Opt-in (network): CCIP_FORK=true forge test --match-contract CrossChainForkTest
contract CrossChainForkTest is Test {
    address constant USDG_RH = 0x7E955252E15c84f5768B83c41a71F9eba181802F; // Paxos USDG, Robinhood testnet (6 dp)
    address constant TSLA_RH = 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E; // Robinhood testnet stock token (18 dp)

    CCIPLocalSimulatorFork sim;
    uint256 arbFork;
    uint256 rhFork;
    Register.NetworkDetails arb;
    Register.NetworkDetails rh;
    HomeGateway gateway;
    RemoteVault vault;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address engine = makeAddr("engine"); // the receipts' only counterparty; the engine path is covered locally

    function setUp() public {
        vm.skip(!vm.envOr("CCIP_FORK", false));
        rhFork = vm.createFork(vm.envOr("RH_TESTNET_RPC", string("https://rpc.testnet.chain.robinhood.com")));
        arbFork = vm.createSelectFork(vm.envOr("ARB_SEPOLIA_RPC", string("https://sepolia-rollup.arbitrum.io/rpc")));
        sim = new CCIPLocalSimulatorFork();
        vm.makePersistent(address(sim));
        arb = sim.getNetworkDetails(421614);
        rh = sim.getNetworkDetails(46630);

        gateway = new HomeGateway(arb.routerAddress, owner, engine, makeAddr("forwarder"));
        vm.selectFork(rhFork);
        vault = new RemoteVault(rh.routerAddress, owner, arb.chainSelector);
        vm.startPrank(owner);
        vault.setHomeGateway(address(gateway));
        vault.setToken(USDG_RH, true);
        vault.setToken(TSLA_RH, true);
        vm.stopPrank();

        vm.selectFork(arbFork);
        vm.startPrank(owner);
        gateway.setRemote(rh.chainSelector, address(vault), 300_000);
        gateway.registerReceipt(rh.chainSelector, USDG_RH, 6, "USDG locked on Robinhood Chain", "USDG.rh");
        gateway.registerReceipt(rh.chainSelector, TSLA_RH, 18, "TSLA locked on Robinhood Chain", "TSLA.rh");
        vm.stopPrank();
    }

    function _lockAndRoute(address token, uint256 amount) internal returns (RemoteReceipt receipt) {
        vm.selectFork(rhFork);
        deal(token, alice, amount);
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        IERC20(token).approve(address(vault), amount);
        uint256 fee = vault.quoteLock(token, amount, alice);
        console2.log("CCIP fee to lock (wei, Robinhood):", fee);
        vault.lock{value: fee}(token, amount, alice);
        vm.stopPrank();
        assertEq(vault.locked(token), amount, "locked on Robinhood");
        sim.switchChainAndRouteMessage(arbFork); // now on Arbitrum Sepolia
        receipt = RemoteReceipt(gateway.receiptOf(rh.chainSelector, token));
        assertEq(receipt.balanceOf(alice), amount, "receipts minted on Arbitrum");
    }

    function _redeemAndRoute(RemoteReceipt receipt, address token, uint256 amount) internal {
        vm.selectFork(arbFork);
        vm.deal(alice, 1 ether);
        uint256 fee = gateway.quoteRedeem(address(receipt), amount, alice);
        console2.log("CCIP fee to redeem (wei, Arbitrum Sepolia):", fee);
        vm.prank(alice);
        gateway.redeem{value: fee}(address(receipt), amount, alice);
        sim.switchChainAndRouteMessage(rhFork); // now on Robinhood
        assertEq(IERC20(token).balanceOf(alice), amount, "real asset paid on Robinhood");
        assertEq(vault.locked(token), 0, "nothing left locked");
    }

    function test_fork_usdgLockedOnRobinhood_receiptsOnArbitrum_redeemed() public {
        RemoteReceipt r = _lockAndRoute(USDG_RH, 250e6);
        _redeemAndRoute(r, USDG_RH, 250e6);
    }

    function test_fork_tslaLockedOnRobinhood_receiptsOnArbitrum_redeemed() public {
        RemoteReceipt r = _lockAndRoute(TSLA_RH, 3e18);
        _redeemAndRoute(r, TSLA_RH, 3e18);
    }

    /// v2 auto-release on the real routers: receipts leave the engine, are burned and queued; the fee pool pays the
    /// real CCIP fee on flush; the vault pays the real TSLA on Robinhood.
    function test_fork_autoRelease_tslaPaidOnRobinhood() public {
        RemoteReceipt r = _lockAndRoute(TSLA_RH, 2e18);
        vm.prank(alice);
        r.transfer(engine, 2e18); // pledge
        vm.prank(engine);
        r.transfer(alice, 2e18); // payout or release: burned here, queued at the gateway
        assertEq(r.balanceOf(alice), 0);
        (,,,, uint256 fee) = gateway.releaseQueue();
        console2.log("CCIP fee of a queued release (wei, Arbitrum Sepolia):", fee);
        gateway.fundFees{value: fee}();
        uint256 g = gasleft();
        assertEq(gateway.flush(25), 1);
        console2.log("flush of 1 release on the real Arbitrum Sepolia router (gas):", g - gasleft());
        sim.switchChainAndRouteMessage(rhFork);
        assertEq(IERC20(TSLA_RH).balanceOf(alice), 2e18, "real TSLA paid on Robinhood");
        assertEq(vault.locked(TSLA_RH), 0);
    }
}
