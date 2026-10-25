// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Vm, console2} from "forge-std/Test.sol";
import {ProductsBase} from "./Products.t.sol";
import {FlowEngine} from "../src/FlowEngine.sol";
import {HomeGateway} from "../src/crosschain/HomeGateway.sol";
import {RemoteVault} from "../src/crosschain/RemoteVault.sol";
import {RemoteReceipt} from "../src/crosschain/RemoteReceipt.sol";
import {CrossChainMessages} from "../src/crosschain/CrossChainMessages.sol";
import {MockCCIPRouter} from "./mocks/MockCCIPRouter.sol";
import {MockERC20, FreezableERC20} from "./mocks/MockERC20.sol";
import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IAny2EVMMessageReceiver} from "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";
import {CreReceiver} from "../src/cre/CreReceiver.sol";
import {IReceiver} from "../src/cre/IReceiver.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// Stage 1 of the (planned) cross-chain lifecycle: a note runs on its home chain (Ethereum Sepolia) while its
/// collateral stays locked on other chains (Ethereum Sepolia, Base), coordinated by CCIP. The note fixtures that pledge collateral
/// are replayed with that collateral locked remotely: the issuer locks it in the vault, the gateway mints receipts,
/// the engine uses them exactly like local collateral (coverage, margin calls, release, the default rule), and at
/// the end every receipt is redeemed for the real asset on its own chain. Every amount must equal the reference.
contract CrossChainTest is ProductsBase {
    uint64 constant HOME = 2032988798112970440; // Ethereum Sepolia testnet (home)
    uint64 constant SEP = 16015286601757825753; // Ethereum Sepolia
    uint64 constant BASE = 10344971235874465080; // Base Sepolia
    uint256 constant FEE = 0.001 ether;

    MockCCIPRouter homeRouter;
    MockCCIPRouter sepRouter;
    MockCCIPRouter baseRouter;
    HomeGateway gateway;
    RemoteVault sepVault;
    RemoteVault baseVault;
    FreezableERC20 sepEth; // the ETH-like collateral token on Ethereum Sepolia (18 decimals, as the fixtures' WETH)
    FreezableERC20 baseUsdg; // a stablecoin on Base (6 decimals, as the fixtures' USD collateral)
    RemoteReceipt rEth;
    RemoteReceipt rUsd;

    function setUp() public override {
        super.setUp();
        homeRouter = new MockCCIPRouter(HOME, FEE);
        sepRouter = new MockCCIPRouter(SEP, FEE);
        baseRouter = new MockCCIPRouter(BASE, FEE);
        homeRouter.connect(sepRouter);
        homeRouter.connect(baseRouter);
        sepRouter.connect(homeRouter);
        baseRouter.connect(homeRouter);

        gateway = new HomeGateway(address(homeRouter), admin, address(engine), forwarder);
        sepVault = new RemoteVault(address(sepRouter), admin, HOME);
        baseVault = new RemoteVault(address(baseRouter), admin, HOME);
        sepEth = new FreezableERC20("ETH.sep", decimals[2]);
        baseUsdg = new FreezableERC20("USDG.base", decimals[1]);

        vm.startPrank(admin);
        sepVault.setHomeGateway(address(gateway));
        baseVault.setHomeGateway(address(gateway));
        sepVault.setToken(address(sepEth), true);
        baseVault.setToken(address(baseUsdg), true);
        gateway.setRemote(SEP, address(sepVault), 300_000);
        gateway.setRemote(BASE, address(baseVault), 300_000);
        rEth = RemoteReceipt(gateway.registerReceipt(SEP, address(sepEth), decimals[2], "ETH locked on Ethereum Sepolia", "ETH.sep"));
        rUsd = RemoteReceipt(gateway.registerReceipt(BASE, address(baseUsdg), decimals[1], "USDG locked on Base", "USDG.base"));
        vm.stopPrank();
        gateway.fundFees{value: 1 ether}(); // the release fee pool (the issuer or the protocol funds it)
    }

    // ---------------------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------------------

    function _idx(string memory needle) internal view returns (uint256) {
        for (uint256 i = 0; i < fixtures.length; i++) {
            if (vm.indexOf(_fixture(i).name, needle) != type(uint256).max) return i;
        }
        revert("fixture not found");
    }

    /// Which remote receipt stands in for asset `a` (0 = keep the local token).
    function _receiptFor(Fixture memory f, uint256 a) internal view returns (RemoteReceipt) {
        if (f.tokenOf[a] == 2) return rEth; // ETH collateral: on Ethereum Sepolia
        if (f.tokenOf[a] == 1 && a != CASH) return rUsd; // stablecoin collateral (not the cash leg): on Base
        return RemoteReceipt(address(0));
    }

    function _assetTokensRemote(Fixture memory f) internal view returns (address[] memory t) {
        t = new address[](f.tokenOf.length);
        for (uint256 a = 0; a < f.tokenOf.length; a++) {
            RemoteReceipt r = _receiptFor(f, a);
            if (address(r) != address(0)) t[a] = address(r);
            else if (f.tokenOf[a] != 0) t[a] = address(tokens[f.tokenOf[a]]);
        }
    }

    /// The issuer locks `base` of the asset behind `r` on its chain; the lock is delivered home unless `deliver` is false.
    function _lockRemote(RemoteReceipt r, address who, uint256 base, bool deliver) internal returns (uint256 msgIndex) {
        (RemoteVault vault, FreezableERC20 token, MockCCIPRouter router) =
            r == rEth ? (sepVault, sepEth, sepRouter) : (baseVault, baseUsdg, baseRouter);
        token.mint(who, base);
        vm.deal(who, who.balance + FEE);
        vm.startPrank(who);
        token.approve(address(vault), base);
        vault.lock{value: FEE}(address(token), base, who);
        vm.stopPrank();
        msgIndex = router.count() - 1;
        if (deliver) router.deliver(msgIndex);
    }

    /// Redeem `base` receipts held by `who` for the real asset on its chain; returns what arrived there.
    function _redeem(RemoteReceipt r, address who, uint256 base) internal returns (uint256 got) {
        FreezableERC20 token = r == rEth ? sepEth : baseUsdg;
        uint256 before = token.balanceOf(who);
        vm.deal(who, who.balance + FEE);
        vm.prank(who);
        gateway.redeem{value: FEE}(address(r), base, who);
        homeRouter.deliver(homeRouter.count() - 1); // RELEASE runs on the asset chain
        got = token.balanceOf(who) - before;
    }

    function _issueRemote(Fixture memory f, address issuer, address pa) internal returns (uint256 pid) {
        vm.warp(t0);
        bytes32 id = engine.registerDefinition(f.def);
        vm.prank(issuer);
        pid = engine.startProcess(id, 1, _roles(issuer, pa), _assetTokensRemote(f), f.startStep, _none(), "Note", "NOTE");
        vm.startPrank(issuer);
        for (uint256 t = 1; t < 5; t++) tokens[t].approve(address(engine), type(uint256).max);
        rEth.approve(address(engine), type(uint256).max);
        rUsd.approve(address(engine), type(uint256).max);
        vm.stopPrank();
        // Pledges of remote collateral: locked on their chain first (the receipts arrive over CCIP).
        for (uint256 k = 0; k < f.pledges.length; k++) {
            Pledge memory p = f.pledges[k];
            RemoteReceipt r = _receiptForToken(f, p.token);
            if (address(r) != address(0)) _lockRemote(r, issuer, p.base, true);
            else tokens[p.token].mint(issuer, p.base);
        }
        vm.startPrank(issuer);
        engine.executeStep(pid, f.approveStep, NO, f.approveInputs);
        engine.executeStep(pid, f.mandateStep, NO, _none());
        vm.stopPrank();
    }

    /// The fixtures name a pledge by token id: 2 = ETH (remote, Ethereum Sepolia); 1 with a stablecoin collateral asset in
    /// the note = USD collateral (remote, Base) only when the cash leg is minted separately (see _cashPledges).
    function _receiptForToken(Fixture memory f, uint8 token) internal view returns (RemoteReceipt) {
        if (token == 2) return rEth;
        if (token == 1 && _hasUsdCollateral(f)) return rUsd;
        return RemoteReceipt(address(0));
    }

    function _hasUsdCollateral(Fixture memory f) internal pure returns (bool) {
        for (uint256 a = CASH + 1; a < f.tokenOf.length; a++) if (f.tokenOf[a] == 1) return true;
        return false;
    }

    /// Replay the timeline; top-ups of remote collateral are locked remotely and arrive late: the first attempt to
    /// pledge them (before the CCIP message lands) fails, the second (after) succeeds, inside the grace period.
    function _playRemote(Fixture memory f, uint256 pid, address issuer) internal {
        for (uint256 i = 0; i < f.actions.length; i++) {
            Action memory a = f.actions[i];
            if (a.at > block.timestamp) vm.warp(a.at);
            if (a.kind == 1) {
                _report(pid, a.step, a.values);
            } else if (a.kind == 2) {
                _report(pid, NO, new int256[](0));
            } else if (a.kind == 3) {
                RemoteReceipt r = a.token == 2 ? rEth : RemoteReceipt(address(0));
                if (address(r) != address(0)) {
                    uint256 m = _lockRemote(r, issuer, a.base, false);
                    vm.prank(issuer);
                    vm.expectRevert(); // the receipts have not arrived yet
                    engine.executeStep(pid, a.step, NO, a.inputs);
                    sepRouter.deliver(m); // CCIP delivers (15-20 minutes on testnet)
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

    function _decimalsOf(Fixture memory f, uint256 a) internal view returns (uint256) {
        RemoteReceipt r = _receiptFor(f, a);
        if (address(r) != address(0)) return r.decimals();
        return decimals[f.tokenOf[a]];
    }

    /// Withdraw every balance. Receipts never reach the wallet: they are burned on the way out and a RELEASE is
    /// queued; a flush (anyone, fees from the pool) sends it and the vault pays the real asset on its chain.
    function _cashOut(Fixture memory f, uint256 pid, address who, int256[] memory expected, string memory label) internal {
        for (uint8 a = CASH; a < f.tokenOf.length; a++) {
            int256 got = engine.balanceOf(pid, who, a);
            assertApproxEqAbs(got, expected[a], uint256(TOLERANCE), string.concat(f.name, ": ", label, " asset ", vm.toString(a)));
            uint256 base = uint256(got * int256(10 ** _decimalsOf(f, a)) / SCALE);
            if (base == 0) continue;
            RemoteReceipt r = _receiptFor(f, a);
            uint256 queued = gateway.releasesQueued();
            vm.prank(who);
            engine.withdraw(pid, a, base);
            if (address(r) != address(0)) {
                assertEq(r.balanceOf(who), 0, "receipts burned on leaving the engine, never in the wallet");
                assertEq(gateway.releasesQueued(), queued + 1, "one release queued");
                (address qr,, address qto, uint96 qamount) = gateway.releases(queued + 1);
                assertEq(qr, address(r));
                assertEq(qto, who, "released to the same address on the asset chain");
                assertEq(uint256(qamount), base);
                assertEq(_flushAndDeliver(r, who), base, string.concat(f.name, ": ", label, " paid in the real asset on its chain"));
            }
        }
    }

    /// Anyone flushes the queue (CCIP fees from the pool); CCIP delivers; what `who` received on r's asset chain.
    function _flushAndDeliver(RemoteReceipt r, address who) internal returns (uint256 got) {
        FreezableERC20 token = r == rEth ? sepEth : baseUsdg;
        uint256 before = token.balanceOf(who);
        vm.prank(keeper);
        gateway.flush(25);
        homeRouter.deliverAll();
        got = token.balanceOf(who) - before;
    }

    function _runRemote(uint256 idx) internal returns (uint256 pid, address issuer) {
        Fixture memory f = _fixture(idx);
        issuer = makeAddr(string.concat("issuer", vm.toString(idx)));
        address pa = makeAddr(string.concat("pa", vm.toString(idx)));
        pid = _issueRemote(f, issuer, pa);
        address[] memory holders = _holders(f, idx);
        for (uint256 k = 0; k < f.investorUnits.length; k++) _subscribe(f, pid, holders[k], f.investorUnits[k], f.investorCash[k]);
        assertEq(f.transferUnits, 0, "cross-chain fixtures have no secondary transfer");
        _playRemote(f, pid, issuer);
        assertEq(engine.processOf(pid).status, engine.COMPLETED(), string.concat(f.name, ": completed"));
        for (uint256 k = 0; k < holders.length; k++) _cashOut(f, pid, holders[k], f.expected[k], string.concat("holder ", vm.toString(k)));
        // The issuer: proceeds (cash) and collateral released to it, back as the real asset on its chain.
        int256[] memory issuerEnd = new int256[](f.tokenOf.length);
        issuerEnd[CASH] = engine.balanceOf(pid, issuer, CASH);
        for (uint256 a = CASH + 1; a < f.tokenOf.length; a++) issuerEnd[a] = f.issuerCollateral[a];
        _cashOut(f, pid, issuer, issuerEnd, "issuer");
        // Every receipt redeemed: what the vaults still lock equals what is outstanding at home (dust only).
        assertEq(sepVault.locked(address(sepEth)), rEth.totalSupply(), "Ethereum Sepolia vault: locked = receipts outstanding");
        assertEq(baseVault.locked(address(baseUsdg)), rUsd.totalSupply(), "Base vault: locked = receipts outstanding");
    }

    // ---------------------------------------------------------------------------------------------------------
    // The lifecycle with remote collateral
    // ---------------------------------------------------------------------------------------------------------

    /// ETH collateral locked on Ethereum Sepolia: a margin call (ETH falls 40%) cured by a top-up that is itself locked
    /// remotely and arrives late; paid in full; the collateral is released and redeemed on Ethereum Sepolia.
    function test_remoteCollateral_marginCallCured_paidInFull_released() public {
        uint256 i = _idx("margin call cured");
        Fixture memory f = _fixture(i);
        assertFalse(f.defaulted);
        _runRemote(i);
        assertEq(rEth.totalSupply(), 0, "all ETH receipts redeemed");
        assertEq(sepVault.locked(address(sepEth)), 0, "nothing left locked on Ethereum Sepolia");
    }

    /// Not cured: default at the end of grace; the holders receive the ETH collateral (as receipts, through the
    /// engine's default rule) and redeem it on Ethereum Sepolia for real ETH, pro rata.
    function test_remoteCollateral_marginCallNotCured_defaultPaysHoldersOnRemoteChain() public {
        uint256 i = _idx("margin call not cured");
        assertTrue(_fixture(i).defaulted);
        _runRemote(i);
        assertEq(sepVault.locked(address(sepEth)), rEth.totalSupply(), "locked = outstanding");
    }

    /// Collateral on TWO remote chains: stablecoin on Base and ETH on Ethereum Sepolia. Coverage sums both; a missed
    /// coupon defaults; cap-at-owed pays holders the coupon plus par (stablecoin first, then ETH) and releases the
    /// rest of the ETH to the issuer, each redeemed on its own chain.
    function test_remoteCollateral_twoChains_cappedDefault() public {
        uint256 i = _idx("misses coupon 2 -> default (capped)");
        Fixture memory f = _fixture(i);
        assertTrue(f.defaulted);
        assertTrue(_hasUsdCollateral(f), "the fixture has stablecoin collateral");
        _runRemote(i);
    }

    function test_remoteCollateral_twoChains_allToHolders() public {
        _runRemote(_idx("misses coupon 2 -> default (all to holders)"));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Messages
    // ---------------------------------------------------------------------------------------------------------

    function test_duplicateLockAndReleaseApplyOnce() public {
        address alice = makeAddr("alice");
        uint256 m = _lockRemote(rEth, alice, 5e9, true);
        sepRouter.deliver(m); // CCIP retry / a manual re-execution of the same message
        assertEq(rEth.balanceOf(alice), 5e9, "receipts minted once");

        // Receipts reach alice only through the engine in real use; here the gateway path is what matters.
        vm.deal(alice, FEE);
        vm.prank(alice);
        gateway.redeem{value: FEE}(address(rEth), 2e9, alice);
        uint256 r = homeRouter.count() - 1;
        homeRouter.deliver(r);
        homeRouter.deliver(r); // replay
        assertEq(sepEth.balanceOf(alice), 2e9, "released once");
        assertEq(sepVault.locked(address(sepEth)), 3e9);
        assertEq(rEth.totalSupply(), 3e9);
    }

    function test_forgedOrUnknownSendersAreRejected() public {
        bytes memory lock = CrossChainMessages.encode(CrossChainMessages.LOCKED, bytes32("x"), address(this), address(sepEth), 1e9);
        // A contract on Ethereum Sepolia that is not the vault.
        vm.expectRevert(abi.encodeWithSelector(HomeGateway.UnknownSender.selector, SEP, address(0xBAD)));
        homeRouter.execute(SEP, address(0xBAD), address(gateway), lock, bytes32("m1"));
        // The vault's address on a chain that is not configured.
        vm.expectRevert(abi.encodeWithSelector(HomeGateway.UnknownSender.selector, uint64(1), address(sepVault)));
        homeRouter.execute(1, address(sepVault), address(gateway), lock, bytes32("m2"));
        // Anyone but the router.
        _callReceiveDirectly(address(gateway), SEP, address(sepVault), lock);

        bytes memory rel = CrossChainMessages.encode(CrossChainMessages.RELEASE, bytes32("y"), address(this), address(sepEth), 1);
        // RELEASE from the home chain but not from the gateway, and from the gateway's address on another chain.
        vm.expectRevert(abi.encodeWithSelector(RemoteVault.UnknownSender.selector, HOME, address(0xBAD)));
        sepRouter.execute(HOME, address(0xBAD), address(sepVault), rel, bytes32("m3"));
        vm.expectRevert(abi.encodeWithSelector(RemoteVault.UnknownSender.selector, BASE, address(gateway)));
        sepRouter.execute(BASE, address(gateway), address(sepVault), rel, bytes32("m4"));
        // A LOCKED sent to the vault, or a RELEASE sent home, is the wrong kind.
        vm.expectRevert(RemoteVault.WrongKind.selector);
        sepRouter.execute(HOME, address(gateway), address(sepVault), lock, bytes32("m5"));
    }

    function _callReceiveDirectly(address receiver, uint64 source, address sender, bytes memory data) internal {
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: bytes32("direct"),
            sourceChainSelector: source,
            sender: abi.encode(sender),
            data: data,
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
        vm.expectRevert(abi.encodeWithSelector(CCIPReceiver.InvalidRouter.selector, address(this)));
        CCIPReceiver(receiver).ccipReceive(m);
    }

    function test_releaseCannotExceedWhatIsLocked() public {
        address alice = makeAddr("alice");
        _lockRemote(rEth, alice, 1e9, true);
        bytes memory rel = CrossChainMessages.encode(CrossChainMessages.RELEASE, bytes32("big"), alice, address(sepEth), 2e9);
        vm.expectRevert(abi.encodeWithSelector(RemoteVault.OverRelease.selector, address(sepEth), 2e9, 1e9));
        sepRouter.execute(HOME, address(gateway), address(sepVault), rel, bytes32("m"));
    }

    /// Out of order: two locks delivered in reverse; both credited, each once.
    function test_locksDeliveredOutOfOrder() public {
        address alice = makeAddr("alice");
        uint256 m1 = _lockRemote(rEth, alice, 1e9, false);
        uint256 m2 = _lockRemote(rEth, alice, 2e9, false);
        sepRouter.deliver(m2);
        assertEq(rEth.balanceOf(alice), 2e9);
        sepRouter.deliver(m1);
        assertEq(rEth.balanceOf(alice), 3e9);
        assertEq(sepVault.locked(address(sepEth)), 3e9);
    }

    /// A lock of a token the home side does not know yet fails there and stays executable: register the receipt,
    /// then execute the same message manually.
    function test_lockOfUnregisteredTokenIsRetryable() public {
        FreezableERC20 tsla = new FreezableERC20("TSLA", 18);
        vm.prank(admin);
        sepVault.setToken(address(tsla), true);
        address alice = makeAddr("alice");
        tsla.mint(alice, 3e18);
        vm.deal(alice, FEE);
        vm.startPrank(alice);
        tsla.approve(address(sepVault), 3e18);
        sepVault.lock{value: FEE}(address(tsla), 3e18, alice);
        vm.stopPrank();
        uint256 m = sepRouter.count() - 1;
        vm.expectRevert(abi.encodeWithSelector(HomeGateway.UnknownToken.selector, SEP, address(tsla)));
        sepRouter.deliver(m);
        vm.prank(admin);
        address rTsla = gateway.registerReceipt(SEP, address(tsla), 18, "TSLA locked on Ethereum Sepolia", "TSLA.sep");
        sepRouter.deliver(m); // manual execution after the fix
        assertEq(RemoteReceipt(rTsla).balanceOf(alice), 3e18);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Receipts and vault safety
    // ---------------------------------------------------------------------------------------------------------

    function test_receiptsMoveOnlyIntoOrOutOfTheEngine() public {
        address alice = makeAddr("alice");
        _lockRemote(rEth, alice, 1e9, true);
        vm.prank(alice);
        vm.expectRevert(RemoteReceipt.ReceiptNotTransferable.selector);
        rEth.transfer(makeAddr("bob"), 1);
        vm.expectRevert(RemoteReceipt.OnlyGateway.selector);
        rEth.mint(alice, 1);
        vm.expectRevert(RemoteReceipt.OnlyGateway.selector);
        rEth.burnFrom(alice, 1);
    }

    /// The token's issuer freezes a holder (Paxos USDG and stock tokens can): the RELEASE still completes, the
    /// amount waits as unclaimed, and the holder claims it once unfrozen. No CCIP message is ever stuck.
    function test_frozenRecipientClaimsLater() public {
        address alice = makeAddr("alice");
        _lockRemote(rUsd, alice, 100e6, true);
        baseUsdg.freeze(alice, true);
        vm.deal(alice, FEE);
        vm.prank(alice);
        gateway.redeem{value: FEE}(address(rUsd), 40e6, alice);
        homeRouter.deliver(homeRouter.count() - 1);
        assertEq(baseVault.unclaimed(alice, address(baseUsdg)), 40e6);
        assertEq(baseVault.locked(address(baseUsdg)), 60e6);
        assertEq(baseVault.surplus(address(baseUsdg)), 0, "owed = locked + unclaimed");
        vm.prank(alice);
        vm.expectRevert(); // still frozen
        baseVault.claim(address(baseUsdg));
        baseUsdg.freeze(alice, false);
        vm.prank(alice);
        baseVault.claim(address(baseUsdg));
        assertEq(baseUsdg.balanceOf(alice), 40e6);
    }

    /// The token's issuer takes tokens out of the vault: the vault's surplus goes negative, which the CRE keeper
    /// reports as a shortfall against the receipts outstanding (scripts and keeper: collateralShortfalls).
    function test_vaultShortfallIsVisible() public {
        address alice = makeAddr("alice");
        _lockRemote(rEth, alice, 5e9, true);
        assertEq(sepVault.surplus(address(sepEth)), 0);
        sepEth.seize(address(sepVault), 2e9);
        assertEq(sepVault.surplus(address(sepEth)), -2e9, "shortfall visible on the asset chain");
        assertEq(rEth.totalSupply(), 5e9, "receipts outstanding at home");
    }

    /// Destination gas of each message (what the CCIP gas limits must cover): LOCKED at home, RELEASE on the vault.
    function test_messageExecutionGas() public {
        address alice = makeAddr("alice");
        uint256 m = _lockRemote(rEth, alice, 1e9, false);
        uint256 g = gasleft();
        sepRouter.deliver(m);
        uint256 lockedGas = g - gasleft();
        vm.deal(alice, FEE);
        vm.prank(alice);
        gateway.redeem{value: FEE}(address(rEth), 1e9, alice);
        uint256 r = homeRouter.count() - 1;
        g = gasleft();
        homeRouter.deliver(r);
        uint256 releaseGas = g - gasleft();
        console2.log("LOCKED execution gas (incl. mock delivery)", lockedGas);
        console2.log("RELEASE execution gas (incl. mock delivery)", releaseGas);
        assertLt(lockedGas, 200_000, "within the LOCKED gas limit");
        assertLt(releaseGas, 300_000, "within the RELEASE gas limit");
    }

    function test_feesAreChargedAndExcessRefunded() public {
        address alice = makeAddr("alice");
        sepEth.mint(alice, 1e9);
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        sepEth.approve(address(sepVault), 1e9);
        vm.expectRevert(abi.encodeWithSelector(RemoteVault.FeeTooLow.selector, FEE));
        sepVault.lock{value: FEE - 1}(address(sepEth), 1e9, alice);
        sepVault.lock{value: 1 ether}(address(sepEth), 1e9, alice);
        vm.stopPrank();
        assertEq(alice.balance, 1 ether - FEE, "excess refunded");
    }

    function test_onlyOwnerConfigures() public {
        vm.expectRevert();
        gateway.setRemote(SEP, address(1), 300_000);
        vm.expectRevert();
        gateway.registerReceipt(SEP, address(2), 18, "x", "x");
        vm.expectRevert();
        sepVault.setHomeGateway(address(3));
        vm.expectRevert();
        sepVault.setToken(address(4), true);
    }

    function test_pausedVaultStillReleases() public {
        address alice = makeAddr("alice");
        _lockRemote(rEth, alice, 2e9, true);
        vm.prank(admin);
        sepVault.pause();
        assertEq(_redeem(rEth, alice, 2e9), 2e9, "releases pay while new locks are paused");
    }

    // ---------------------------------------------------------------------------------------------------------
    // Auto-release (v2): receipts leaving the engine are burned and released on their own chain
    // ---------------------------------------------------------------------------------------------------------

    bytes32 constant PAYOUT_DEFERRED = keccak256("PayoutDeferred(uint256,uint8,uint64,address,uint256)");
    bytes32 constant FLUSH_STALLED = keccak256("FlushStalled(uint256,uint256,uint256)");

    /// `who` gets `base` receipts out of the engine, as the engine's own transfer does (withdraw / push).
    function _outOfEngine(RemoteReceipt r, address who, uint256 base) internal {
        address locker = makeAddr("locker");
        _lockRemote(r, locker, base, true);
        vm.prank(locker);
        r.transfer(address(engine), base); // pledging is a transfer into the engine
        vm.prank(address(engine));
        r.transfer(who, base);
    }

    function _drainPool() internal {
        uint256 bal = address(gateway).balance;
        vm.prank(admin);
        gateway.withdrawFees(payable(admin), bal);
    }

    function _flushReport(uint256 maxItems) internal {
        vm.prank(forwarder);
        gateway.onReport("", abi.encode(uint8(1), maxItems));
    }

    /// A default whose collateral payout is PUSHED (keeper, pushTo): each holder's receipts are burned inside the
    /// engine's capped push transfer and queued; one CRE report flushes them; CCIP delivers; the vault pays every
    /// holder the real asset on its own chain, exactly the reference amounts. Nothing is deferred.
    function test_autoRelease_pushedDefault_creFlush_paysHoldersOnTheirChain() public {
        uint256 idx = _idx("margin call not cured");
        Fixture memory f = _fixture(idx);
        address issuer = makeAddr(string.concat("issuer", vm.toString(idx)));
        uint256 pid = _issueRemote(f, issuer, makeAddr("pa"));
        address[] memory holders = _holders(f, idx);
        for (uint256 k = 0; k < f.investorUnits.length; k++) _subscribe(f, pid, holders[k], f.investorUnits[k], f.investorCash[k]);
        _playRemote(f, pid, issuer);
        assertTrue(f.defaulted);
        uint8 a = 0;
        for (uint8 x = CASH + 1; x < f.tokenOf.length; x++) if (address(_receiptFor(f, x)) == address(rEth)) a = x;
        assertGt(a, 0, "the note's ETH collateral is the Ethereum Sepolia receipt");
        uint256[] memory owed = new uint256[](holders.length);
        uint256 expectQueued;
        for (uint256 k = 0; k < holders.length; k++) {
            owed[k] = uint256(engine.balanceOf(pid, holders[k], a) * int256(10 ** rEth.decimals()) / SCALE);
            if (owed[k] > 0) expectQueued++;
        }
        assertGt(expectQueued, 0, "holders are owed collateral");
        uint256 q0 = gateway.releasesQueued();
        vm.recordLogs();
        vm.prank(keeper);
        engine.pushTo(pid, a, holders);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) assertTrue(logs[i].topics[0] != PAYOUT_DEFERRED, "no push deferred: the release fits the cap");
        assertEq(gateway.releasesQueued(), q0 + expectQueued, "one release queued per holder");
        uint256[] memory before = new uint256[](holders.length);
        for (uint256 k = 0; k < holders.length; k++) {
            assertEq(rEth.balanceOf(holders[k]), 0, "no receipt rests in a wallet");
            assertLt(engine.balanceOf(pid, holders[k], a), SCALE / int256(10 ** rEth.decimals()) + 1, "paid out of the note");
            before[k] = sepEth.balanceOf(holders[k]);
        }
        _flushReport(25);
        homeRouter.deliverAll();
        for (uint256 k = 0; k < holders.length; k++) {
            assertApproxEqAbs(sepEth.balanceOf(holders[k]) - before[k], owed[k], 1, "the vault paid the real asset on Ethereum Sepolia");
        }
        (uint256 pending,,,,) = gateway.releaseQueue();
        assertEq(pending, 0, "queue empty");
        assertEq(sepVault.locked(address(sepEth)), rEth.totalSupply(), "locked = receipts outstanding");
    }

    /// What queueing costs inside the engine's transfer, against the 150k gas the engine gives each pushed transfer.
    function test_autoRelease_gasFitsThePushCap() public {
        address holder = makeAddr("holder");
        address locker = makeAddr("locker");
        _lockRemote(rEth, locker, 10e9, true);
        vm.prank(locker);
        rEth.transfer(address(engine), 10e9);
        // A fresh release (new queue entry), then one that joins it (same receipt and recipient, unsent).
        vm.prank(address(engine));
        uint256 g = gasleft();
        rEth.transfer(holder, 4e9);
        uint256 fresh = g - gasleft();
        vm.prank(address(engine));
        g = gasleft();
        rEth.transfer(holder, 1e9);
        uint256 joined = g - gasleft();
        console2.log("receipt transfer out of the engine, new release queued (gas):", fresh);
        console2.log("receipt transfer out of the engine, joins an open release (gas):", joined);
        assertLt(fresh, 120_000, "well under the engine's 150k push cap");
        // Exactly as the engine pushes: a call with 150k gas must succeed for a third address (cold everything).
        address other = makeAddr("other");
        vm.prank(address(engine));
        (bool ok,) = address(rEth).call{gas: 150_000}(abi.encodeCall(rEth.transfer, (other, 2e9)));
        assertTrue(ok, "fits the 150k cap");
        assertEq(gateway.releasesQueued(), 2);
        (,, uint256 queued, uint256 pool,) = gateway.releaseQueue();
        assertEq(queued, 2);
        assertEq(pool, 1 ether);
        // Flushing: per release sent (mock router; a real on-ramp adds its own ~100-200k).
        vm.prank(keeper);
        g = gasleft();
        gateway.flush(25);
        console2.log("flush of 2 releases (gas, mock router):", g - gasleft());
    }

    /// The pool runs dry: what it cannot pay for stays queued (FlushStalled) and goes on the next flush. Nothing
    /// is lost and nothing is sent twice.
    function test_autoRelease_poolEmpty_staysQueued_thenRetried() public {
        _drainPool();
        address[3] memory who = [makeAddr("h1"), makeAddr("h2"), makeAddr("h3")];
        for (uint256 k = 0; k < 3; k++) _outOfEngine(rEth, who[k], (k + 1) * 1e9);
        vm.prank(keeper);
        assertEq(gateway.flush(25), 0, "nothing sent with an empty pool");
        gateway.fundFees{value: FEE}();
        vm.recordLogs();
        vm.prank(keeper);
        assertEq(gateway.flush(25), 1, "one release paid for");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool stalled;
        for (uint256 i = 0; i < logs.length; i++) if (logs[i].topics[0] == FLUSH_STALLED) stalled = true;
        assertTrue(stalled, "the flush says where it stopped");
        (uint256 pending, uint256 head,,, uint256 nextFee) = gateway.releaseQueue();
        assertEq(pending, 2);
        assertEq(head, 2);
        assertEq(nextFee, FEE);
        (bool ok,) = address(gateway).call{value: 2 * FEE}(""); // plain ETH funds the pool too
        assertTrue(ok);
        _flushReport(25);
        homeRouter.deliverAll();
        for (uint256 k = 0; k < 3; k++) assertEq(sepEth.balanceOf(who[k]), (k + 1) * 1e9, "each paid once, in full");
        (pending,,,,) = gateway.releaseQueue();
        assertEq(pending, 0);
        assertEq(sepVault.locked(address(sepEth)), 0);
    }

    /// At most once end to end: a sent release is never sent again, and a replayed or duplicated RELEASE pays nothing.
    function test_autoRelease_atMostOnce() public {
        address h = makeAddr("h");
        _outOfEngine(rEth, h, 3e9);
        vm.prank(keeper);
        gateway.flush(25);
        uint256 m = homeRouter.count() - 1;
        homeRouter.deliver(m);
        homeRouter.deliver(m); // CCIP retry / manual re-execution
        assertEq(sepEth.balanceOf(h), 3e9, "paid once");
        vm.prank(keeper);
        assertEq(gateway.flush(25), 0, "nothing to resend");
        vm.expectRevert(abi.encodeWithSelector(HomeGateway.NotQueued.selector, 1));
        gateway.sendQueued{value: FEE}(1);
        assertTrue(sepVault.released(gateway.releaseId(1)), "the vault recorded the id");
        assertTrue(gateway.releaseId(1) != keccak256(abi.encode(block.chainid, address(gateway), uint256(1))), "queue ids never collide with redeem ids");
        // The same id carried by another message from the gateway (e.g. a forged duplicate) pays nothing.
        _lockRemote(rEth, makeAddr("x"), 5e9, true);
        bytes memory rel = CrossChainMessages.encode(CrossChainMessages.RELEASE, gateway.releaseId(1), h, address(sepEth), 3e9);
        sepRouter.execute(HOME, address(gateway), address(sepVault), rel, bytes32("dup"));
        assertEq(sepEth.balanceOf(h), 3e9, "still paid once");
    }

    /// A holder need not wait for the pool or the queue order: sendQueued with its own fee; flush skips it.
    function test_autoRelease_sendQueued_ownFee_outOfOrder() public {
        _drainPool();
        address h1 = makeAddr("h1");
        address h2 = makeAddr("h2");
        _outOfEngine(rEth, h1, 1e9);
        _outOfEngine(rEth, h2, 2e9);
        vm.deal(h2, 1 ether);
        vm.prank(h2);
        gateway.sendQueued{value: 1 ether}(2);
        assertEq(h2.balance, 1 ether - FEE, "excess refunded");
        homeRouter.deliverAll();
        assertEq(sepEth.balanceOf(h2), 2e9);
        gateway.fundFees{value: FEE}();
        vm.prank(keeper);
        assertEq(gateway.flush(25), 1, "only the first is left");
        homeRouter.deliverAll();
        assertEq(sepEth.balanceOf(h1), 1e9);
        assertEq(gateway.releaseHead(), 3, "the head moves past releases sent out of order");
    }

    /// Releases to the same account that are not sent yet add up: dust withdrawals cost the pool one message.
    function test_autoRelease_unsentReleasesToTheSameAccountJoin() public {
        address h = makeAddr("h");
        _outOfEngine(rEth, h, 1e9);
        _outOfEngine(rEth, h, 2e9);
        assertEq(gateway.releasesQueued(), 1, "joined");
        (,,, uint96 amount) = gateway.releases(1);
        assertEq(uint256(amount), 3e9);
        vm.prank(keeper);
        gateway.flush(25);
        _outOfEngine(rEth, h, 4e9); // after the send: a release of its own
        assertEq(gateway.releasesQueued(), 2);
        vm.prank(keeper);
        gateway.flush(25);
        homeRouter.deliverAll();
        assertEq(sepEth.balanceOf(h), 7e9);
    }

    /// A smart wallet that does not exist at the same address on the asset chain names where to be paid.
    function test_autoRelease_releaseAddress() public {
        address safe = makeAddr("safe");
        address dest = makeAddr("dest on Ethereum Sepolia");
        vm.prank(safe);
        gateway.setReleaseAddress(dest);
        _outOfEngine(rEth, safe, 2e9);
        vm.prank(keeper);
        gateway.flush(25);
        homeRouter.deliverAll();
        assertEq(sepEth.balanceOf(dest), 2e9);
        assertEq(sepEth.balanceOf(safe), 0);
    }

    /// The CRE path: only the forwarder; a wrong kind is refused; paused, a report is a no-op (CRE does not retry).
    function test_autoRelease_creReport() public {
        address h = makeAddr("h");
        _outOfEngine(rEth, h, 1e9);
        vm.expectRevert(abi.encodeWithSelector(CreReceiver.InvalidSender.selector, address(this), forwarder));
        gateway.onReport("", abi.encode(uint8(1), uint256(5)));
        vm.prank(forwarder);
        vm.expectRevert(HomeGateway.WrongKind.selector);
        gateway.onReport("", abi.encode(uint8(2), uint256(5)));
        vm.prank(admin);
        gateway.pause();
        _flushReport(5);
        (uint256 pending,,,,) = gateway.releaseQueue();
        assertEq(pending, 1, "paused: nothing sent, still queued");
        vm.prank(admin);
        gateway.unpause();
        _flushReport(5);
        homeRouter.deliverAll();
        assertEq(sepEth.balanceOf(h), 1e9);
        assertTrue(gateway.supportsInterface(type(IReceiver).interfaceId), "a CRE receiver");
        assertTrue(gateway.supportsInterface(type(IAny2EVMMessageReceiver).interfaceId), "a CCIP receiver");
    }

    /// Pause stops outbound messages, never the queue: the engine's transfers keep working while paused.
    function test_autoRelease_pauseKeepsQueueing() public {
        vm.prank(admin);
        gateway.pause();
        address h = makeAddr("h");
        _outOfEngine(rEth, h, 1e9);
        assertEq(gateway.releasesQueued(), 1, "queued while paused");
        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        gateway.flush(25);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        gateway.sendQueued{value: FEE}(1);
        vm.prank(admin);
        gateway.unpause();
        vm.prank(keeper);
        gateway.flush(25);
        homeRouter.deliverAll();
        assertEq(sepEth.balanceOf(h), 1e9);
    }

    function test_autoRelease_onlyReceiptsQueue_receiptsNeverToTheGateway() public {
        vm.expectRevert(HomeGateway.UnknownReceipt.selector);
        gateway.queueRelease(address(this), 1);
        address locker = makeAddr("locker");
        _lockRemote(rEth, locker, 2e9, true);
        vm.prank(locker);
        rEth.transfer(address(engine), 2e9);
        vm.prank(address(engine));
        vm.expectRevert(RemoteReceipt.ReceiptNotTransferable.selector);
        rEth.transfer(address(gateway), 1e9);
        vm.prank(admin);
        vm.expectRevert();
        gateway.withdrawFees(payable(address(0)), 1);
        vm.expectRevert();
        gateway.withdrawFees(payable(address(this)), 1); // owner only
    }

    /// A release whose chain lost its vault (owner reconfiguring) stalls the flush instead of being dropped.
    function test_autoRelease_unconfiguredChainStalls() public {
        address h = makeAddr("h");
        _outOfEngine(rEth, h, 1e9);
        vm.prank(admin);
        gateway.setRemote(SEP, address(0), 0);
        vm.prank(keeper);
        assertEq(gateway.flush(25), 0);
        vm.prank(admin);
        gateway.setRemote(SEP, address(sepVault), 300_000);
        vm.prank(keeper);
        assertEq(gateway.flush(25), 1);
        homeRouter.deliverAll();
        assertEq(sepEth.balanceOf(h), 1e9);
    }
}
