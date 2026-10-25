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

/// Planned cross-chain collateral (docs/CROSS-CHAIN.md) on the real CCIP routers and lanes: forks of Robinhood Chain
/// testnet (home: the note's chain, where the gateway and receipts live) and of a remote asset chain (default
/// Ethereum Sepolia; REMOTE_RPC and REMOTE_CHAIN_ID override it), with Chainlink Local's CCIPLocalSimulatorFork
/// routing the messages. Passed 2026-10-25: lock fee ~0.00022 ETH (Sepolia), redeem or queued release ~0.00063 ETH
/// (Robinhood Chain testnet), flush of 1 release ~284k gas on the real Robinhood Chain testnet router.
/// The remote chain's real WETH (and a stand-in stablecoin deployed on the fork) are locked in the vault there,
/// receipts are minted on Robinhood Chain, then redeemed back to the real tokens.
/// Opt-in (network): CCIP_FORK=true forge test --match-contract CrossChainForkTest
/// (The same mechanism was proven live in the earlier Arbitrum build, home Arbitrum Sepolia, vault on Robinhood Chain.)
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
        // The remote chain's id (REMOTE_CHAIN_ID with REMOTE_RPC; block.chainid here can be stale right after the switch).
        uint256 remoteId = vm.envOr("REMOTE_CHAIN_ID", uint256(11155111));
        weth = vm.envOr("REMOTE_WETH", SEPOLIA_WETH);
        homeFork = vm.createSelectFork(vm.envOr("RH_TESTNET_RPC", string("https://rpc.testnet.chain.robinhood.com")));
        sim = new CCIPLocalSimulatorFork();
        vm.makePersistent(address(sim));
        home = sim.getNetworkDetails(46630);
        remote = sim.getNetworkDetails(remoteId);

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
        console2.log("CCIP fee to lock (wei, remote chain):", fee);
        vault.lock{value: fee}(token, amount, alice);
        vm.stopPrank();
        assertEq(vault.locked(token), amount, "locked on the remote chain");
        sim.switchChainAndRouteMessage(homeFork); // now on Robinhood Chain
        receipt = RemoteReceipt(gateway.receiptOf(remote.chainSelector, token));
        assertEq(receipt.balanceOf(alice), amount, "receipts minted on Robinhood Chain");
    }

    function _redeemAndRoute(RemoteReceipt receipt, address token, uint256 amount) internal {
        vm.selectFork(homeFork);
        vm.deal(alice, 1 ether);
        uint256 fee = gateway.quoteRedeem(address(receipt), amount, alice);
        console2.log("CCIP fee to redeem (wei, Robinhood Chain testnet):", fee);
        vm.prank(alice);
        gateway.redeem{value: fee}(address(receipt), amount, alice);
        sim.switchChainAndRouteMessage(remoteFork); // now on the remote chain
        assertEq(IERC20(token).balanceOf(alice), amount, "real asset paid on the remote chain");
        assertEq(vault.locked(token), 0, "nothing left locked");
    }

    function test_fork_usdLockedRemotely_receiptsOnRobinhood_redeemed() public {
        RemoteReceipt r = _lockAndRoute(usd, 250e6);
        _redeemAndRoute(r, usd, 250e6);
    }

    function test_fork_wethLockedRemotely_receiptsOnRobinhood_redeemed() public {
        RemoteReceipt r = _lockAndRoute(weth, 3e18);
        _redeemAndRoute(r, weth, 3e18);
    }

    /// v2 auto-release on the real routers: receipts leave the engine, are burned and queued; the fee pool pays the
    /// real CCIP fee on flush; the vault pays the real WETH on the remote chain.
    function test_fork_autoRelease_wethPaidRemotely() public {
        RemoteReceipt r = _lockAndRoute(weth, 2e18);
        vm.prank(alice);
        r.transfer(engine, 2e18); // pledge
        vm.prank(engine);
        r.transfer(alice, 2e18); // payout or release: burned here, queued at the gateway
        assertEq(r.balanceOf(alice), 0);
        (,,,, uint256 fee) = gateway.releaseQueue();
        console2.log("CCIP fee of a queued release (wei, Robinhood Chain testnet):", fee);
        gateway.fundFees{value: fee}();
        uint256 g = gasleft();
        assertEq(gateway.flush(25), 1);
        console2.log("flush of 1 release on the real Robinhood Chain testnet router (gas):", g - gasleft());
        sim.switchChainAndRouteMessage(remoteFork);
        assertEq(IERC20(weth).balanceOf(alice), 2e18, "real WETH paid on the remote chain");
        assertEq(vault.locked(weth), 0);
    }
}
