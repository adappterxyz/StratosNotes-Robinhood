// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Test, StdInvariant} from "forge-std/Test.sol";
import {FlowEngine} from "../src/FlowEngine.sol";
import {CreReceiver} from "../src/cre/CreReceiver.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {NoteToken} from "../src/NoteToken.sol";
import {ProductsBase} from "./Products.t.sol";

/// Drives one note (a product fixture) through its real timeline while the fuzzer interleaves everything else a
/// person can do: move units between investors, withdraw part of a balance, deposit, try to take the escrow's
/// collateral, try to report as a stranger, poke. Ghost state records anything that should never happen.
contract NoteHandler is Test {
    FlowEngine public engine;
    MockERC20[5] public tokens;
    bytes internal fixture; // the fixture, ABI-encoded (structs with nested arrays don't copy to storage)
    uint256 public pid;
    address public issuer;
    address public pa;
    address public forwarder;
    address[] public investors;
    uint256 public next; // next timeline action
    uint8 constant NOTE = 0;
    int256 constant SCALE = 1e10;

    // Ghosts: what holders took out (fixed point, per asset), and violations.
    mapping(uint256 => int256) public withdrawnByHolders;
    bool public escrowMovedOutsideWorkflow;
    bool public strangerReported;
    bool public unitsChangedByTransfer;
    bool public strangerDepositLost;
    uint256 public calls;

    constructor(FlowEngine engine_, MockERC20[5] memory tokens_, bytes memory fixture_, uint256 pid_, address issuer_, address pa_, address forwarder_, address[] memory investors_) {
        engine = engine_;
        tokens = tokens_;
        fixture = fixture_;
        pid = pid_;
        issuer = issuer_;
        pa = pa_;
        forwarder = forwarder_;
        investors = investors_;
    }

    function _f() internal view returns (ProductsBase.Fixture memory) {
        return abi.decode(fixture, (ProductsBase.Fixture));
    }

    function investorCount() external view returns (uint256) {
        return investors.length;
    }

    function _escrow() internal view returns (int256[] memory b) {
        address e = engine.ESCROW();
        b = new int256[](_f().tokenOf.length);
        for (uint256 a = 0; a < b.length; a++) b[a] = engine.balanceOf(pid, e, a);
    }

    function _sameEscrow(int256[] memory before) internal {
        int256[] memory nowB = _escrow();
        for (uint256 a = 0; a < nowB.length; a++) if (nowB[a] != before[a]) escrowMovedOutsideWorkflow = true;
    }

    function _units() internal view returns (int256 s) {
        NoteToken t = NoteToken(engine.assetTokenOf(pid, NOTE));
        address[] memory hs = t.holders(0, type(uint256).max);
        for (uint256 k = 0; k < hs.length; k++) s += engine.balanceOf(pid, hs[k], NOTE);
    }

    /// A keeper pushes the latest payouts (any batch size): never more than each holder is owed.
    function push(uint256 assetSeed, uint256 count) external {
        calls++;
        uint8 a = uint8(1 + assetSeed % (_f().tokenOf.length - 1));
        if (_f().tokenOf[a] == 0) return;
        int256[] memory esc = _escrow();
        uint256 d = tokens[_f().tokenOf[a]].decimals();
        uint256[] memory before = new uint256[](investors.length);
        for (uint256 k = 0; k < investors.length; k++) before[k] = tokens[_f().tokenOf[a]].balanceOf(investors[k]);
        try engine.pushPayouts(pid, a, type(uint256).max, bound(count, 1, 8)) {} catch {}
        for (uint256 k = 0; k < investors.length; k++) {
            withdrawnByHolders[a] += int256(tokens[_f().tokenOf[a]].balanceOf(investors[k]) - before[k]) * SCALE / int256(10 ** d);
        }
        _sameEscrow(esc);
    }

    // ---- The workflow's own timeline (reports, keeper advances, the issuer's funding) --------------------------

    function step() external {
        calls++;
        ProductsBase.Fixture memory f = _f();
        if (next >= f.actions.length) return;
        ProductsBase.Action memory a = f.actions[next++];
        if (a.at > block.timestamp) vm.warp(a.at);
        if (a.kind == 1) {
            vm.prank(forwarder);
            engine.onReport("", abi.encode(pid, a.step, a.values));
        } else if (a.kind == 2) {
            vm.prank(forwarder);
            engine.onReport("", abi.encode(pid, uint16(0xFFFF), new int256[](0)));
        } else if (a.kind == 3) {
            tokens[a.token].mint(issuer, a.base);
            vm.prank(issuer);
            engine.executeStep(pid, a.step, 0xFFFF, a.inputs);
        }
        // kind 4 (a scripted transfer) is replaced by the fuzzer's own transfers.
    }

    // ---- Everything else, in any order -------------------------------------------------------------------------

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amountSeed) external {
        calls++;
        address from = investors[fromSeed % investors.length];
        address to = investors[toSeed % investors.length];
        int256 held = engine.balanceOf(pid, from, NOTE);
        if (held <= 0 || from == to) return;
        int256 amount = int256(bound(amountSeed, 1, uint256(held)));
        int256[] memory esc = _escrow();
        int256 before = _units();
        NoteToken t = NoteToken(engine.assetTokenOf(pid, NOTE));
        vm.prank(from);
        try t.transfer(to, uint256(amount) / 1e4) {} catch {}
        if (_units() != before) unitsChangedByTransfer = true;
        _sameEscrow(esc);
    }

    function withdraw(uint256 whoSeed, uint256 assetSeed, uint256 pct) external {
        calls++;
        ProductsBase.Fixture memory f = _f();
        address who = investors[whoSeed % investors.length];
        uint256 a = 1 + assetSeed % (f.tokenOf.length - 1);
        if (f.tokenOf[a] == 0) return;
        int256 bal = engine.balanceOf(pid, who, a);
        if (bal <= 0) return;
        uint256 d = tokens[f.tokenOf[a]].decimals();
        uint256 base = uint256(bal) * (10 ** d) / uint256(SCALE) * bound(pct, 1, 100) / 100;
        if (base == 0) return;
        int256[] memory esc = _escrow();
        vm.prank(who);
        try engine.withdraw(pid, uint8(a), base) {
            withdrawnByHolders[a] += int256(base) * SCALE / int256(10 ** d);
        } catch {}
        _sameEscrow(esc);
    }

    /// The issuer reaches for the pledged collateral (or funded payments): always refused.
    function issuerTakesEscrow(uint256 assetSeed, uint256 base) external {
        calls++;
        ProductsBase.Fixture memory f = _f();
        uint256 a = 1 + assetSeed % (f.tokenOf.length - 1);
        if (f.tokenOf[a] == 0) return;
        int256[] memory esc = _escrow();
        base = bound(base, 1, 1e30);
        vm.prank(issuer);
        try engine.withdraw(pid, uint8(a), base) {} catch {}
        _sameEscrow(esc);
    }

    /// A stranger's deposit stays the stranger's: it can take back exactly what it put in, and nobody else's
    /// balance moves. (Accounts no longer have a cap, so a deposit takes nothing from anyone.)
    function strangerDeposit(uint256 seed, uint256 base) external {
        calls++;
        address s = address(uint160(uint256(keccak256(abi.encode("stranger", seed)))));
        base = bound(base, 1, 1e12);
        tokens[1].mint(s, base);
        uint256 wallet = tokens[1].balanceOf(s);
        int256 account = engine.balanceOf(pid, s, 1);
        int256[] memory esc = _escrow();
        vm.startPrank(s);
        tokens[1].approve(address(engine), base);
        try engine.deposit(pid, 1, base) {
            try engine.withdraw(pid, 1, base) {} catch {
                strangerDepositLost = true;
            }
            if (tokens[1].balanceOf(s) != wallet || engine.balanceOf(pid, s, 1) != account) strangerDepositLost = true;
        } catch {}
        vm.stopPrank();
        _sameEscrow(esc);
    }

    /// Anyone but the forwarder (and the fallback reporter, off here) reporting: refused.
    function strangerReport(uint256 seed, int256 value) external {
        calls++;
        address s = address(uint160(uint256(keccak256(abi.encode("reporter", seed)))));
        if (s == forwarder) return;
        int256[] memory v = new int256[](1);
        v[0] = value;
        int256[] memory esc = _escrow();
        vm.prank(s);
        try engine.onReport("", abi.encode(pid, _f().fixStrikeStep, v)) {
            strangerReported = true;
        } catch {}
        vm.prank(s);
        try engine.fallbackReport(abi.encode(pid, uint16(0xFFFF), new int256[](0))) {
            strangerReported = true;
        } catch {}
        _sameEscrow(esc);
    }

    function poke() external {
        calls++;
        try engine.poke(pid) {} catch {}
    }
}

/// Invariants over a note's whole life, for a note paid in full (FCN, autocalled, funding in two deposits) and for
/// notes that default (a missed coupon; mixed collateral under cap-at-owed).
abstract contract NoteInvariants is StdInvariant, ProductsBase {
    NoteHandler handler;
    uint256 notePid;
    int256 initialUnits;

    function fixtureIndex() internal pure virtual returns (uint256);

    function setUp() public override {
        super.setUp();
        ProductsBase.Fixture memory fx = _fixture(fixtureIndex());
        address issuer = makeAddr("inv_issuer");
        address pa = makeAddr("inv_pa");
        notePid = _issue(fx, issuer, pa);
        address[] memory investors = new address[](fx.investorUnits.length + 1);
        for (uint256 k = 0; k < fx.investorUnits.length; k++) {
            investors[k] = makeAddr(string.concat("inv_", vm.toString(k)));
            _subscribe(fx, notePid, investors[k], fx.investorUnits[k], fx.investorCash[k]);
        }
        investors[investors.length - 1] = makeAddr("inv_buyer"); // receives units only by transfer
        handler = new NoteHandler(engine, tokens, fixtures[fixtureIndex()], notePid, issuer, pa, forwarder, investors);
        initialUnits = int256(_note(notePid).totalSupply()) * 1e4;
        targetContract(address(handler));
    }

    /// A full-length run must reach the note's timeline (so the invariants are checked across real payments and
    /// defaults); shrunk sequences of a few calls are exempt.
    function afterInvariant() public view {
        if (handler.calls() >= 32) assertGt(handler.next(), 0, "the run never advanced the note");
    }

    /// Solvency: for every cash asset, the engine holds exactly the vault it records, and every ledger account
    /// together (holders, issuer, paying agent, escrow) is covered by it.
    function invariant_solvency() public view {
        ProductsBase.Fixture memory fx = _fixture(fixtureIndex());
        address[] memory hs = _accounts();
        for (uint256 a = 1; a < fx.tokenOf.length; a++) {
            if (fx.tokenOf[a] == 0) continue;
            MockERC20 t = tokens[fx.tokenOf[a]];
            uint256 vault = engine.vaultOf(notePid, a);
            int256 sum;
            for (uint256 k = 0; k < hs.length; k++) sum += engine.balanceOf(notePid, hs[k], a);
            assertLe(sum, int256(vault) * SCALE / int256(10 ** t.decimals()), "ledger covered by the vault");
            assertGe(t.balanceOf(address(engine)), vault, "the engine holds its vaults");
        }
    }

    /// Every ledger account the note can have: investors, issuer, paying agent, escrow.
    function _accounts() internal view returns (address[] memory hs) {
        uint256 n = handler.investorCount();
        hs = new address[](n + 3);
        for (uint256 k = 0; k < n; k++) hs[k] = handler.investors(k);
        hs[n] = handler.issuer();
        hs[n + 1] = handler.pa();
        hs[n + 2] = engine.ESCROW();
    }

    /// Note units: only issuance and redemption change their total; transfers conserve it. The token's supply is
    /// exactly the sum of its holders' balances (sold minus burned), and the engine reads the same balances.
    function invariant_unitsConserved() public view {
        assertFalse(handler.unitsChangedByTransfer(), "a transfer changed the total units");
        NoteToken t = _note(notePid);
        address[] memory hs = t.holders(0, type(uint256).max);
        uint256 sum;
        int256 held;
        for (uint256 k = 0; k < hs.length; k++) {
            sum += t.heldOf(hs[k]);
            held += engine.balanceOf(notePid, hs[k], NOTE);
            assertGt(t.heldOf(hs[k]), 0, "the holder set lists only non-zero balances");
        }
        assertEq(sum, t.supplyHeld(), "totalSupply == sum of balances");
        assertLe(held, initialUnits, "no units out of thin air (only redemption retires them)");
    }

    /// Escrow leaves only through the workflow (payments, a default, the release): never through a person's call.
    function invariant_escrowOnlyThroughTheWorkflow() public view {
        assertFalse(handler.escrowMovedOutsideWorkflow(), "escrow moved outside the workflow");
    }

    /// Only the forwarder (or the fallback reporter, when set) reports; strangers never deposit into a note.
    function invariant_accessControl() public view {
        assertFalse(handler.strangerReported(), "a stranger's report was applied");
        assertFalse(handler.strangerDepositLost(), "a stranger's deposit did not come back in full");
    }

    /// Holders, all together, never receive more of any asset than the reference model pays them (in full, or on
    /// a default under the note's rule: cap-at-owed or all-to-holders).
    function invariant_holdersNeverOverpaid() public view {
        ProductsBase.Fixture memory fx = _fixture(fixtureIndex());
        for (uint256 a = 1; a < fx.tokenOf.length; a++) {
            int256 ref;
            for (uint256 k = 0; k < fx.expected.length; k++) ref += fx.expected[k][a];
            int256 got = handler.withdrawnByHolders(a);
            for (uint256 k = 0; k < handler.investorCount(); k++) got += engine.balanceOf(notePid, handler.investors(k), a);
            assertLe(got, ref + int256(TOLERANCE) * int256(fx.expected.length), "holders paid more than the reference");
        }
    }
}

contract PaidNoteInvariants is NoteInvariants {
    function fixtureIndex() internal pure override returns (uint256) {
        return 0; // FCN, autocalled at observation 2, each payment funded in two deposits
    }
}

contract MissedCouponInvariants is NoteInvariants {
    function fixtureIndex() internal pure override returns (uint256) {
        return 13; // phoenix: misses coupon 3, default, collateral to holders
    }
}

contract CappedDefaultInvariants is NoteInvariants {
    function fixtureIndex() internal pure override returns (uint256) {
        return 18; // mixed stablecoin + ETH collateral, misses coupon 2: cap-at-owed
    }
}

/// Property tests the invariants can't express in one place.
contract EngineFuzz is ProductsBase {
    function _patchCashDecimals(bytes memory def, uint8 dec) internal pure returns (bytes memory out) {
        out = bytes.concat(def);
        uint256 o = 12 + uint256(uint8(out[1])) + uint256(uint8(out[2])) + 2 * 1 + 1; // asset 1 (cash) decimals
        out[o] = bytes1(dec);
    }

    /// A strike value inside the definition's bounds is captured; outside it, the whole report is refused.
    function testFuzz_oracleBounds(int256 v) public {
        Fixture memory f = _fixture(0);
        uint256 pid = _issue(f, makeAddr("i"), makeAddr("p"));
        _subscribe(f, pid, makeAddr("h"), 100e10, 100e6);
        vm.warp(f.strikeAt);
        int256[] memory values = new int256[](1);
        values[0] = v;
        bool inside = v >= 1 * SCALE && v <= 1_000_000 * SCALE; // ETH/USD bounds in the fixture
        vm.prank(forwarder);
        if (!inside) vm.expectRevert(FlowEngine.OracleOutOfBounds.selector);
        engine.onReport("", abi.encode(pid, f.fixStrikeStep, values));
    }

    /// Withdrawals must convert exactly: with an 18-decimal token, an amount finer than the ledger's 10 decimals is
    /// refused (it used to debit nothing and pay out the dust from other holders' share of the vault).
    function testFuzz_withdrawConvertsExactly(uint256 base) public {
        Fixture memory f = _fixture(0);
        f.def = _patchCashDecimals(f.def, 18);
        MockERC20 usd18 = new MockERC20("USD18", 18);
        vm.warp(t0);
        bytes32 id = engine.registerDefinition(f.def);
        address issuer = makeAddr("i18");
        address[] memory assetTokens = _assetTokens(f);
        assetTokens[CASH] = address(usd18);
        vm.prank(issuer);
        uint256 pid = engine.startProcess(id, 1, _roles(issuer, makeAddr("p")), assetTokens, f.startStep, _none(), "Note", "NOTE");
        vm.startPrank(issuer);
        for (uint256 t = 1; t < 5; t++) tokens[t].approve(address(engine), type(uint256).max);
        for (uint256 k = 0; k < f.pledges.length; k++) tokens[f.pledges[k].token].mint(issuer, f.pledges[k].base);
        engine.executeStep(pid, f.approveStep, NO, f.approveInputs);
        engine.executeStep(pid, f.mandateStep, NO, _none());
        vm.stopPrank();
        address h = makeAddr("h18");
        usd18.mint(h, 1000e18);
        vm.startPrank(h);
        usd18.approve(address(engine), type(uint256).max);
        engine.executeStep(pid, f.subscribeStep, NO, _num(1000e10));
        vm.stopPrank();

        uint256 vaultBefore = engine.vaultOf(pid, CASH);
        int256 ledgerBefore = engine.balanceOf(pid, issuer, CASH);
        base = bound(base, 1, vaultBefore);
        vm.prank(issuer);
        if (base % 1e8 != 0) vm.expectRevert(FlowEngine.BadInputs.selector);
        engine.withdraw(pid, CASH, base);
        if (base % 1e8 == 0) {
            assertEq(engine.balanceOf(pid, issuer, CASH), ledgerBefore - int256(base / 1e8), "debited exactly");
        }
        // Whatever happened, the ledger is still covered by the vault.
        assertLe(engine.balanceOf(pid, issuer, CASH) * 1e8, int256(engine.vaultOf(pid, CASH)));
    }

    /// Random subscriptions and transfers before the strike: units are conserved, every subscription's cash went to
    /// the issuer, and the vault covers the ledger.
    function testFuzz_subscriptionsAndTransfers(uint256[6] memory amounts, uint256[6] memory moves) public {
        Fixture memory f = _fixture(0);
        address issuer = makeAddr("fi");
        uint256 pid = _issue(f, issuer, makeAddr("fp"));
        address[] memory hs = new address[](6);
        int256 sold;
        int256 paid;
        for (uint256 k = 0; k < 6; k++) {
            hs[k] = makeAddr(string.concat("fh", vm.toString(k)));
            int256 units = int256(bound(amounts[k], 1, 150)) * SCALE;
            _subscribe(f, pid, hs[k], units, uint256(units / SCALE) * 1e6);
            sold += units;
            paid += units; // issued at par
        }
        for (uint256 k = 0; k < 6; k++) {
            address from = hs[k];
            address to = hs[moves[k] % 6];
            int256 held = engine.balanceOf(pid, from, NOTE);
            if (from == to || held == 0) continue;
            int256 amt = int256(bound(moves[k] >> 8, 1, uint256(held) / 1e4)) * 1e4;
            _transferUnits(pid, from, to, amt);
        }
        int256 total;
        for (uint256 k = 0; k < 6; k++) total += engine.balanceOf(pid, hs[k], NOTE);
        assertEq(total, sold, "units conserved");
        assertEq(engine.balanceOf(pid, issuer, CASH), paid, "the issuer received every subscription");
        assertLe(engine.balanceOf(pid, issuer, CASH) / 1e4, int256(engine.vaultOf(pid, CASH)), "vault covers the ledger");
    }

    /// The issuer funds a payment only while its window is open; after the deadline the call is refused and the
    /// engine itself closes the window.
    function testFuzz_fundingOnlyWhileTheWindowIsOpen(uint32 delay) public {
        Fixture memory f = _fixture(0);
        address issuer = makeAddr("wi");
        uint256 pid = _issue(f, issuer, makeAddr("wp"));
        _subscribe(f, pid, makeAddr("wh0"), f.investorUnits[0], f.investorCash[0]);
        _subscribe(f, pid, makeAddr("wh1"), f.investorUnits[1], f.investorCash[1]);
        // Replay up to the first funding call.
        uint256 i;
        for (; i < f.actions.length && f.actions[i].kind != 3; i++) {
            Action memory a = f.actions[i];
            if (a.at > block.timestamp) vm.warp(a.at);
            vm.prank(forwarder);
            if (a.kind == 1) engine.onReport("", abi.encode(pid, a.step, a.values));
            else engine.onReport("", abi.encode(pid, uint16(0xFFFF), new int256[](0)));
        }
        Action memory fund = f.actions[i];
        vm.warp(uint256(fund.at) + bound(delay, 0, 60 days));
        engine.poke(pid); // closes any window whose deadline passed
        uint16[] memory live = engine.tokensOf(pid);
        bool open;
        for (uint256 k = 0; k < live.length; k++) if (live[k] == fund.step) open = true;
        tokens[fund.token].mint(issuer, fund.base);
        int256 escrowBefore = engine.balanceOf(pid, engine.ESCROW(), CASH);
        vm.prank(issuer);
        if (!open) vm.expectRevert(FlowEngine.StepNotActive.selector);
        engine.executeStep(pid, fund.step, NO, fund.inputs);
        if (open) assertGt(engine.balanceOf(pid, engine.ESCROW(), CASH), escrowBefore, "funded into escrow");
    }

    /// With requireEmail on, an address without an attestation can neither subscribe nor receive units.
    function testFuzz_unverifiedAddressesAreGated(address who) public {
        vm.assume(who != address(0) && who.code.length == 0 && who != engine.ESCROW() && who != address(engine));
        Fixture memory f = _fixture(0);
        address issuer = makeAddr("gi");
        uint256 pid = _issue(f, issuer, makeAddr("gp"));
        address inv = makeAddr("gh");
        _subscribe(f, pid, inv, 10e10, 10e6);
        vm.prank(admin);
        engine.setEmailPolicy(makeAddr("verifier"), true);
        vm.assume(who != inv);
        tokens[1].mint(who, 10e6);
        vm.startPrank(who);
        tokens[1].approve(address(engine), 10e6);
        vm.expectRevert(abi.encodeWithSelector(FlowEngine.SubscriberEmailNotVerified.selector, who));
        engine.executeStep(pid, f.subscribeStep, NO, _num(10e10));
        vm.stopPrank();
        NoteToken t = _note(pid);
        vm.prank(inv);
        vm.expectRevert(abi.encodeWithSelector(FlowEngine.RecipientEmailNotVerified.selector, who));
        t.transfer(who, 1e6);
    }

    /// Only the forwarder (and a fallback reporter, once set) may report.
    function testFuzz_onlyTheForwarderReports(address caller) public {
        vm.assume(caller != forwarder);
        Fixture memory f = _fixture(0);
        uint256 pid = _issue(f, makeAddr("ri"), makeAddr("rp"));
        vm.warp(f.strikeAt);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(CreReceiver.InvalidSender.selector, caller, forwarder));
        engine.onReport("", abi.encode(pid, f.fixStrikeStep, f.actions[0].values));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(CreReceiver.InvalidSender.selector, caller, address(0)));
        engine.fallbackReport(abi.encode(pid, uint16(0xFFFF), new int256[](0)));
    }
}
