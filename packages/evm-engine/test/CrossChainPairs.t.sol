// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {console2} from "forge-std/Test.sol";
import {ProductsBase} from "./Products.t.sol";
import {HomeGateway} from "../src/crosschain/HomeGateway.sol";
import {RemoteVault} from "../src/crosschain/RemoteVault.sol";
import {RemoteReceipt} from "../src/crosschain/RemoteReceipt.sol";
import {MockCCIPRouter} from "./mocks/MockCCIPRouter.sol";
import {FreezableERC20} from "./mocks/MockERC20.sol";

/// The two deployed pairs (docs/CROSS-CHAIN.md), both directions at once, on mock CCIP routers that stand for the
/// real lanes (selectors as in the CCIP directory):
///  - Robinhood Chain testnet is home to its notes (gateway rhGateway); USDC and WETH stay locked in a vault on Base
///    Sepolia (baseVault), credited as USDC.base / WETH.base receipts.
///  - Base Sepolia is home to its notes (gateway baseGateway); USDG, WETH and Robinhood's stock tokens (TSLA, AMZN, AMD,
///    PLTR) stay locked in a vault on Robinhood Chain (rhVault), credited as USDG.rh / WETH.rh / TSLA.rh ... receipts.
/// Each chain therefore runs a gateway (home side) and a vault (asset side) behind the same router. One EVM carries
/// both chains, so one FlowEngine stands for each chain's engine: both gateways name it, and every receipt burns and
/// queues at its own gateway when it leaves it. The note lifecycles replay the reference fixtures with their
/// collateral locked on the other chain; every amount must equal the reference payoff.
contract CrossChainPairsTest is ProductsBase {
    uint64 constant RH = 2032988798112970440; // Robinhood Chain testnet
    uint64 constant BASE = 10344971235874465080; // Base Sepolia
    uint256 constant FEE = 0.0005 ether;

    MockCCIPRouter rhRouter;
    MockCCIPRouter baseRouter;
    HomeGateway rhGateway; // Robinhood Chain notes
    HomeGateway baseGateway; // Base notes
    RemoteVault baseVault; // on Base, behind rhGateway
    RemoteVault rhVault; // on Robinhood Chain, behind baseGateway

    // Base Sepolia's tokens (Circle USDC, the WETH predeploy) and Robinhood Chain's (Paxos USDG, bridge WETH, stocks).
    FreezableERC20 usdc;
    FreezableERC20 wethBase;
    FreezableERC20 usdg;
    FreezableERC20 wethRh;
    FreezableERC20[4] stocks; // TSLA, AMZN, AMD, PLTR
    string[4] stockSyms = ["TSLA", "AMZN", "AMD", "PLTR"];

    /// One direction: the gateway at home, the vault on the asset chain, and the two receipts the fixtures pledge.
    struct Dir {
        HomeGateway gateway;
        MockCCIPRouter homeRouter;
        MockCCIPRouter assetRouter;
        uint64 assetSel;
        RemoteVault vault;
        FreezableERC20 usd; // the stablecoin locked as USD collateral
        FreezableERC20 eth; // WETH locked as ETH collateral
        RemoteReceipt rUsd;
        RemoteReceipt rEth;
    }

    function setUp() public override {
        super.setUp();
        rhRouter = new MockCCIPRouter(RH, FEE);
        baseRouter = new MockCCIPRouter(BASE, FEE);
        rhRouter.connect(baseRouter);
        baseRouter.connect(rhRouter);

        rhGateway = new HomeGateway(address(rhRouter), admin, address(engine), forwarder);
        baseGateway = new HomeGateway(address(baseRouter), admin, address(engine), forwarder);
        baseVault = new RemoteVault(address(baseRouter), admin, RH);
        rhVault = new RemoteVault(address(rhRouter), admin, BASE);

        usdc = new FreezableERC20("USDC", 6);
        wethBase = new FreezableERC20("WETH", 18);
        usdg = new FreezableERC20("USDG", 6);
        wethRh = new FreezableERC20("WETH", 18);
        for (uint256 i = 0; i < 4; i++) stocks[i] = new FreezableERC20(stockSyms[i], 18);

        vm.startPrank(admin);
        // Robinhood Chain home <- Base vault: USDC, WETH (wirePlan('robinhood-testnet', 'base-sepolia')).
        baseVault.setHomeGateway(address(rhGateway));
        baseVault.setToken(address(usdc), true);
        baseVault.setToken(address(wethBase), true);
        rhGateway.setRemote(BASE, address(baseVault), 300_000);
        rhGateway.registerReceipt(BASE, address(usdc), 6, "USDC (locked on base-sepolia)", "USDC.base");
        rhGateway.registerReceipt(BASE, address(wethBase), 18, "WETH (locked on base-sepolia)", "WETH.base");
        // Base home <- Robinhood Chain vault: USDG, WETH, TSLA, AMZN, AMD, PLTR (wirePlan('base-sepolia', 'robinhood-testnet')).
        rhVault.setHomeGateway(address(baseGateway));
        rhVault.setToken(address(usdg), true);
        rhVault.setToken(address(wethRh), true);
        baseGateway.setRemote(RH, address(rhVault), 300_000);
        baseGateway.registerReceipt(RH, address(usdg), 6, "USDG (locked on robinhood-testnet)", "USDG.rh");
        baseGateway.registerReceipt(RH, address(wethRh), 18, "WETH (locked on robinhood-testnet)", "WETH.rh");
        for (uint256 i = 0; i < 4; i++) {
            rhVault.setToken(address(stocks[i]), true);
            baseGateway.registerReceipt(
                RH, address(stocks[i]), 18, string.concat(stockSyms[i], " (locked on robinhood-testnet)"), string.concat(stockSyms[i], ".rh")
            );
        }
        vm.stopPrank();
        rhGateway.fundFees{value: 1 ether}();
        baseGateway.fundFees{value: 1 ether}();
    }

    function _rhHome() internal view returns (Dir memory d) {
        d = Dir(rhGateway, rhRouter, baseRouter, BASE, baseVault, usdc, wethBase, _receipt(rhGateway, BASE, usdc), _receipt(rhGateway, BASE, wethBase));
    }

    function _baseHome() internal view returns (Dir memory d) {
        d = Dir(baseGateway, baseRouter, rhRouter, RH, rhVault, usdg, wethRh, _receipt(baseGateway, RH, usdg), _receipt(baseGateway, RH, wethRh));
    }

    function _receipt(HomeGateway g, uint64 sel, FreezableERC20 t) internal view returns (RemoteReceipt) {
        return RemoteReceipt(g.receiptOf(sel, address(t)));
    }

    function _idx(string memory needle) internal view returns (uint256) {
        for (uint256 i = 0; i < fixtures.length; i++) {
            if (vm.indexOf(_fixture(i).name, needle) != type(uint256).max) return i;
        }
        revert("fixture not found");
    }

    // ---------------------------------------------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------------------------------------------

    function test_pairs_receiptsAsPlanned() public view {
        Dir memory r = _rhHome();
        Dir memory b = _baseHome();
        assertEq(r.rUsd.symbol(), "USDC.base");
        assertEq(r.rUsd.decimals(), 6);
        assertEq(r.rEth.symbol(), "WETH.base");
        assertEq(b.rUsd.symbol(), "USDG.rh");
        assertEq(b.rEth.symbol(), "WETH.rh");
        for (uint256 i = 0; i < 4; i++) {
            RemoteReceipt s = _receipt(baseGateway, RH, stocks[i]);
            assertEq(s.symbol(), string.concat(stockSyms[i], ".rh"));
            assertEq(s.decimals(), 18);
        }
        // Each gateway knows only the other chain's vault; each vault answers to the other chain's gateway.
        assertEq(baseVault.homeGateway(), address(rhGateway));
        assertEq(rhVault.homeGateway(), address(baseGateway));
        assertEq(baseVault.homeChainSelector(), RH);
        assertEq(rhVault.homeChainSelector(), BASE);
        assertEq(rhGateway.receiptOf(RH, address(usdg)), address(0), "no receipt for a token on the home chain itself");
        assertEq(baseGateway.receiptOf(BASE, address(usdc)), address(0));
    }

    /// The headline: TSLA locked on Robinhood Chain backs a Base note. Lock on Robinhood Chain -> TSLA.rh minted on
    /// Base -> pledged into the engine -> leaves it (paid back) -> burned and queued -> CRE flush -> TSLA paid on
    /// Robinhood Chain. And USDC locked on Base for a Robinhood Chain note, the other way, in the same run.
    function test_pairs_bothDirections_lockPledgeReleaseFlush() public {
        address issuer = makeAddr("issuer");
        RemoteReceipt tslaRh = _receipt(baseGateway, RH, stocks[0]);
        Dir memory r = _rhHome();

        _lock(rhVault, rhRouter, stocks[0], issuer, 3e18);
        _lock(baseVault, baseRouter, usdc, issuer, 250e6);
        assertEq(tslaRh.balanceOf(issuer), 3e18, "TSLA.rh minted on Base");
        assertEq(r.rUsd.balanceOf(issuer), 250e6, "USDC.base minted on Robinhood Chain");

        // Pledge into the note (a transfer into the engine), then the note lets it go (the engine pays it out).
        vm.startPrank(issuer);
        tslaRh.transfer(address(engine), 3e18);
        r.rUsd.transfer(address(engine), 250e6);
        vm.stopPrank();
        vm.startPrank(address(engine));
        tslaRh.transfer(issuer, 3e18);
        r.rUsd.transfer(issuer, 250e6);
        vm.stopPrank();
        assertEq(tslaRh.balanceOf(issuer), 0, "burned on leaving the engine");
        assertEq(baseGateway.releasesQueued(), 1);
        assertEq(rhGateway.releasesQueued(), 1);

        // CRE writes one flush report per home chain; CCIP delivers each RELEASE on the asset chain.
        vm.startPrank(forwarder);
        baseGateway.onReport("", abi.encode(uint8(1), uint256(10)));
        rhGateway.onReport("", abi.encode(uint8(1), uint256(10)));
        vm.stopPrank();
        baseRouter.deliverAll();
        rhRouter.deliverAll();
        assertEq(stocks[0].balanceOf(issuer), 3e18, "TSLA paid back on Robinhood Chain");
        assertEq(usdc.balanceOf(issuer), 250e6, "USDC paid back on Base");
        assertEq(rhVault.locked(address(stocks[0])), 0);
        assertEq(baseVault.locked(address(usdc)), 0);
        assertEq(baseGateway.releasesSent(), 1);
        assertEq(rhGateway.releasesSent(), 1);
    }

    /// Every Robinhood stock token locks and redeems by hand (receipts held, never pledged).
    function test_pairs_everyStockLocksAndRedeems() public {
        address alice = makeAddr("alice");
        for (uint256 i = 0; i < 4; i++) {
            _lock(rhVault, rhRouter, stocks[i], alice, (i + 1) * 1e18);
            RemoteReceipt s = _receipt(baseGateway, RH, stocks[i]);
            assertEq(s.balanceOf(alice), (i + 1) * 1e18);
            vm.deal(alice, FEE);
            vm.prank(alice);
            baseGateway.redeem{value: FEE}(address(s), (i + 1) * 1e18, alice);
            baseRouter.deliver(baseRouter.count() - 1);
            assertEq(stocks[i].balanceOf(alice), (i + 1) * 1e18);
            assertEq(s.totalSupply(), rhVault.locked(address(stocks[i])));
        }
    }

    /// A Robinhood Chain RELEASE cannot be forged from the other pair: the Base vault answers only to the
    /// Robinhood Chain gateway, the Robinhood Chain vault only to the Base gateway.
    function test_pairs_crossedPeersRejected() public {
        address alice = makeAddr("alice");
        _lock(baseVault, baseRouter, usdc, alice, 10e6);
        bytes memory rel = abi.encode(uint8(2), bytes32("x"), alice, address(usdc), uint256(1e6));
        vm.expectRevert(abi.encodeWithSelector(RemoteVault.UnknownSender.selector, BASE, address(baseGateway)));
        baseRouter.execute(BASE, address(baseGateway), address(baseVault), rel, bytes32("m"));
        vm.expectRevert(abi.encodeWithSelector(RemoteVault.UnknownSender.selector, RH, address(baseGateway)));
        baseRouter.execute(RH, address(baseGateway), address(baseVault), rel, bytes32("m2"));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Note lifecycles with collateral on the other chain (reference fixtures)
    // ---------------------------------------------------------------------------------------------------------

    function test_pairs_rhNote_baseCollateral_marginCallCured() public {
        _runRemote(_rhHome(), _idx("margin call cured"));
    }

    function test_pairs_baseNote_rhCollateral_marginCallCured() public {
        _runRemote(_baseHome(), _idx("margin call cured"));
    }

    function test_pairs_rhNote_baseCollateral_defaultPaysHoldersOnBase() public {
        _runRemote(_rhHome(), _idx("margin call not cured"));
    }

    function test_pairs_baseNote_rhCollateral_defaultPaysHoldersOnRobinhood() public {
        _runRemote(_baseHome(), _idx("margin call not cured"));
    }

    /// Stablecoin and WETH both locked on the other chain; a missed coupon defaults (cap-at-owed).
    function test_pairs_rhNote_usdcAndWethOnBase_cappedDefault() public {
        _runRemote(_rhHome(), _idx("misses coupon 2 -> default (capped)"));
    }

    function test_pairs_baseNote_usdgAndWethOnRobinhood_cappedDefault() public {
        _runRemote(_baseHome(), _idx("misses coupon 2 -> default (capped)"));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------------------

    function _lock(RemoteVault vault, MockCCIPRouter router, FreezableERC20 token, address who, uint256 base)
        internal
        returns (uint256 m)
    {
        m = _lockNoDeliver(vault, router, token, who, base);
        router.deliver(m);
    }

    function _lockNoDeliver(RemoteVault vault, MockCCIPRouter router, FreezableERC20 token, address who, uint256 base)
        internal
        returns (uint256 m)
    {
        token.mint(who, base);
        vm.deal(who, who.balance + FEE);
        vm.startPrank(who);
        token.approve(address(vault), base);
        vault.lock{value: FEE}(address(token), base, who);
        vm.stopPrank();
        m = router.count() - 1;
    }

    function _hasUsdCollateral(Fixture memory f) internal pure returns (bool) {
        for (uint256 a = CASH + 1; a < f.tokenOf.length; a++) if (f.tokenOf[a] == 1) return true;
        return false;
    }

    function _receiptFor(Dir memory d, Fixture memory f, uint256 a) internal pure returns (RemoteReceipt) {
        if (f.tokenOf[a] == 2) return d.rEth;
        if (f.tokenOf[a] == 1 && a != CASH) return d.rUsd;
        return RemoteReceipt(address(0));
    }

    function _receiptForToken(Dir memory d, Fixture memory f, uint8 token) internal pure returns (RemoteReceipt) {
        if (token == 2) return d.rEth;
        if (token == 1 && _hasUsdCollateral(f)) return d.rUsd;
        return RemoteReceipt(address(0));
    }

    function _lockFor(Dir memory d, RemoteReceipt r, address who, uint256 base, bool deliver) internal returns (uint256 m) {
        m = _lockNoDeliver(d.vault, d.assetRouter, r == d.rEth ? d.eth : d.usd, who, base);
        if (deliver) d.assetRouter.deliver(m);
    }

    function _issueRemote(Dir memory d, Fixture memory f, address issuer, address pa) internal returns (uint256 pid) {
        vm.warp(t0);
        bytes32 id = engine.registerDefinition(f.def);
        address[] memory t = new address[](f.tokenOf.length);
        for (uint256 a = 0; a < f.tokenOf.length; a++) {
            RemoteReceipt r = _receiptFor(d, f, a);
            if (address(r) != address(0)) t[a] = address(r);
            else if (f.tokenOf[a] != 0) t[a] = address(tokens[f.tokenOf[a]]);
        }
        vm.prank(issuer);
        pid = engine.startProcess(id, 1, _roles(issuer, pa), t, f.startStep, _none(), "Note", "NOTE");
        vm.startPrank(issuer);
        for (uint256 k = 1; k < 5; k++) tokens[k].approve(address(engine), type(uint256).max);
        d.rEth.approve(address(engine), type(uint256).max);
        d.rUsd.approve(address(engine), type(uint256).max);
        vm.stopPrank();
        for (uint256 k = 0; k < f.pledges.length; k++) {
            RemoteReceipt r = _receiptForToken(d, f, f.pledges[k].token);
            if (address(r) != address(0)) _lockFor(d, r, issuer, f.pledges[k].base, true);
            else tokens[f.pledges[k].token].mint(issuer, f.pledges[k].base);
        }
        vm.startPrank(issuer);
        engine.executeStep(pid, f.approveStep, NO, f.approveInputs);
        engine.executeStep(pid, f.mandateStep, NO, _none());
        vm.stopPrank();
    }

    /// Top-ups of remote collateral arrive late (CCIP latency): the first attempt fails, the second succeeds.
    function _playRemote(Dir memory d, Fixture memory f, uint256 pid, address issuer) internal {
        for (uint256 i = 0; i < f.actions.length; i++) {
            Action memory a = f.actions[i];
            if (a.at > block.timestamp) vm.warp(a.at);
            if (a.kind == 1) {
                _report(pid, a.step, a.values);
            } else if (a.kind == 2) {
                _report(pid, NO, new int256[](0));
            } else if (a.kind == 3) {
                if (a.token == 2) {
                    uint256 m = _lockFor(d, d.rEth, issuer, a.base, false);
                    vm.prank(issuer);
                    vm.expectRevert(); // the receipts have not arrived yet
                    engine.executeStep(pid, a.step, NO, a.inputs);
                    d.assetRouter.deliver(m);
                } else {
                    tokens[a.token].mint(issuer, a.base);
                }
                vm.prank(issuer);
                engine.executeStep(pid, a.step, NO, a.inputs);
            } else {
                revert("cross-chain fixtures have no secondary transfer");
            }
        }
    }

    function _cashOut(Dir memory d, Fixture memory f, uint256 pid, address who, int256[] memory expected, string memory label) internal {
        for (uint8 a = CASH; a < f.tokenOf.length; a++) {
            int256 got = engine.balanceOf(pid, who, a);
            assertApproxEqAbs(got, expected[a], uint256(TOLERANCE), string.concat(f.name, ": ", label, " asset ", vm.toString(a)));
            RemoteReceipt r = _receiptFor(d, f, a);
            uint256 dec = address(r) != address(0) ? r.decimals() : decimals[f.tokenOf[a]];
            uint256 base = uint256(got * int256(10 ** dec) / SCALE);
            if (base == 0) continue;
            vm.prank(who);
            engine.withdraw(pid, a, base);
            if (address(r) != address(0)) {
                assertEq(r.balanceOf(who), 0, "burned on leaving the engine");
                FreezableERC20 token = r == d.rEth ? d.eth : d.usd;
                uint256 before = token.balanceOf(who);
                vm.prank(keeper);
                d.gateway.flush(25);
                d.homeRouter.deliverAll();
                assertEq(token.balanceOf(who) - before, base, string.concat(f.name, ": ", label, " paid on the asset chain"));
            }
        }
    }

    function _runRemote(Dir memory d, uint256 idx) internal {
        Fixture memory f = _fixture(idx);
        address issuer = makeAddr(string.concat("issuer", vm.toString(idx)));
        uint256 pid = _issueRemote(d, f, issuer, makeAddr(string.concat("pa", vm.toString(idx))));
        address[] memory holders = _holders(f, idx);
        for (uint256 k = 0; k < f.investorUnits.length; k++) _subscribe(f, pid, holders[k], f.investorUnits[k], f.investorCash[k]);
        _playRemote(d, f, pid, issuer);
        assertEq(engine.processOf(pid).status, engine.COMPLETED(), string.concat(f.name, ": completed"));
        for (uint256 k = 0; k < holders.length; k++) _cashOut(d, f, pid, holders[k], f.expected[k], string.concat("holder ", vm.toString(k)));
        int256[] memory issuerEnd = new int256[](f.tokenOf.length);
        issuerEnd[CASH] = engine.balanceOf(pid, issuer, CASH);
        for (uint256 a = CASH + 1; a < f.tokenOf.length; a++) issuerEnd[a] = f.issuerCollateral[a];
        _cashOut(d, f, pid, issuer, issuerEnd, "issuer");
        assertEq(d.vault.locked(address(d.eth)), d.rEth.totalSupply(), "WETH: locked = receipts outstanding");
        assertEq(d.vault.locked(address(d.usd)), d.rUsd.totalSupply(), "stablecoin: locked = receipts outstanding");
        console2.log(f.name, "releases sent", d.gateway.releasesSent());
    }
}
