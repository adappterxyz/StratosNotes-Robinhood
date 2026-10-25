// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Vm, console2} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {FlowEngine} from "../src/FlowEngine.sol";
import {NoteToken} from "../src/NoteToken.sol";
import {NotesLens} from "../src/NotesLens.sol";
import {MockERC20, FreezableERC20} from "./mocks/MockERC20.sol";
import {ProductsBase} from "./Products.t.sol";

/// A stablecoin whose transfer calls back into the engine (as an ERC-777-style hook or a malicious token could):
/// every re-entry must fail, so the push defers that payment and nobody is paid twice.
contract ReentrantERC20 is ERC20 {
    FlowEngine public engine;
    uint256 public pid;
    bool public armed;
    uint256 public reentries;
    uint256 public reentriesSucceeded;

    constructor() ERC20("RE", "RE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(FlowEngine engine_, uint256 pid_) external {
        engine = engine_;
        pid = pid_;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (armed && from == address(engine)) {
            reentries++;
            try engine.pushPayouts(pid, 1, type(uint256).max, 10) {
                reentriesSucceeded++;
            } catch {}
            try engine.withdraw(pid, 1, value) {
                reentriesSucceeded++;
            } catch {}
        }
        super._update(from, to, value);
    }
}

/// Note units as ERC-20s (NoteToken) and scale-free payouts: the token is the single source of truth for units,
/// payouts are an O(1) accumulator settled on every balance change, and pushes pay holders' wallets in batches
/// with receipts (payoutId) and a per-round rolling hash.
contract NoteTokensTest is ProductsBase {
    bytes32 constant RECORDED = keccak256("DistributionRecorded(uint256,uint8,uint64,uint8,uint16,address,int256,int256,uint256,bool,bytes32)");
    bytes32 constant PAID = keccak256("PayoutPaid(uint256,uint8,uint64,address,uint256,bytes32)");
    bytes32 constant DEFERRED = keccak256("PayoutDeferred(uint256,uint8,uint64,address,uint256)");
    bytes32 constant SETTLED = keccak256("DistributionSettled(uint256,uint8,uint64,uint256,uint256,bytes32)");

    function _investors(Fixture memory f, uint256 pid, string memory tag, uint256 n) internal returns (address[] memory hs) {
        hs = new address[](n);
        for (uint256 k = 0; k < n; k++) {
            hs[k] = makeAddr(string.concat(tag, vm.toString(k)));
            if (k < f.investorUnits.length) _subscribe(f, pid, hs[k], f.investorUnits[k], f.investorCash[k]);
        }
    }

    // ---- The ERC-20 ---------------------------------------------------------------------------------------------

    function test_noteTokenIsAStandardErc20() public {
        Fixture memory f = _fixture(0);
        vm.warp(t0);
        bytes32 id = engine.registerDefinition(f.def);
        address issuer = makeAddr("i");
        vm.recordLogs();
        vm.prank(issuer);
        uint256 pid = engine.startProcess(
            id, 1, _roles(issuer, makeAddr("p")), _assetTokens(f), f.startStep, _none(), "notes.markets ETH Phoenix 26-10", "nmETH1"
        );
        NoteToken t = _note(pid);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool created;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == FlowEngine.NoteTokenCreated.selector) {
                created = true;
                assertEq(abi.decode(logs[i].data, (address)), address(t));
            }
        }
        assertTrue(created, "NoteTokenCreated");
        assertEq(t.name(), "notes.markets ETH Phoenix 26-10");
        assertEq(t.symbol(), "nmETH1");
        assertEq(t.decimals(), 6);
        assertEq(address(t.engine()), address(engine));
        assertEq(t.pid(), pid);
        // A clone of one implementation (EIP-1167: 45 bytes).
        assertEq(address(t).code.length, 45);
        vm.expectRevert(NoteToken.AlreadyInitialized.selector);
        t.initialize(address(this), 1, 0, "x", "y");
        // Only the engine mints, burns and moves.
        vm.expectRevert(NoteToken.OnlyEngine.selector);
        t.engineMint(address(this), 1);
        vm.expectRevert(NoteToken.OnlyEngine.selector);
        t.engineBurn(issuer, 1);
        vm.expectRevert(NoteToken.OnlyEngine.selector);
        t.engineMove(issuer, address(this), 1);
        vm.expectRevert(NoteToken.OnlyEngine.selector);
        t.engineRetire();
        // The engine's hook answers only the note's own token.
        vm.expectRevert(FlowEngine.BadToken.selector);
        engine.beforeNoteTransfer(pid, 0, issuer, address(this), 1);

        // Subscriptions mint; the holder set enumerates current holders.
        vm.startPrank(issuer);
        for (uint256 x = 1; x < 5; x++) tokens[x].approve(address(engine), type(uint256).max);
        for (uint256 k = 0; k < f.pledges.length; k++) tokens[f.pledges[k].token].mint(issuer, f.pledges[k].base);
        engine.executeStep(pid, f.approveStep, NO, f.approveInputs);
        engine.executeStep(pid, f.mandateStep, NO, _none());
        vm.stopPrank();
        address a = makeAddr("a");
        address b = makeAddr("b");
        _subscribe(f, pid, a, 600e10, 600e6);
        _subscribe(f, pid, b, 400e10, 400e6);
        assertEq(t.balanceOf(a), 600e6);
        assertEq(engine.balanceOf(pid, a, NOTE), 600e10, "the engine reads the token");
        assertEq(t.holderCount(), 2, "a and b (subscriptions mint)");

        // EIP-2612 permit, then transferFrom.
        uint256 pk = 0xBEEF;
        address owner = vm.addr(pk);
        _transferUnits(pid, a, owner, 50e10);
        address spender = makeAddr("spender");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                t.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                        owner,
                        spender,
                        20e6,
                        uint256(0),
                        deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        t.permit(owner, spender, 20e6, deadline, v, r, s);
        assertEq(t.allowance(owner, spender), 20e6);
        assertEq(t.nonces(owner), 1);
        vm.expectRevert(NoteToken.PermitInvalid.selector);
        t.permit(owner, spender, 20e6, deadline, v, r, s); // replay
        vm.prank(spender);
        t.transferFrom(owner, b, 20e6);
        assertEq(t.balanceOf(b), 420e6);
        assertEq(t.allowance(owner, spender), 0);
        vm.prank(spender);
        vm.expectRevert(NoteToken.InsufficientAllowance.selector);
        t.transferFrom(owner, b, 1);
        // Moving out everything leaves the holder set.
        _transferUnits(pid, owner, b, 30e10);
        assertEq(t.balanceOf(owner), 0);
        address[] memory hs = t.holders(0, 10);
        for (uint256 k = 0; k < hs.length; k++) assertTrue(hs[k] != owner, "zero balances leave the set");
        assertEq(t.totalSupply(), 1000e6);
    }

    // ---- Accumulator correctness --------------------------------------------------------------------------------

    /// Random transfers interleaved with a product's real timeline: each holder ends with exactly
    /// sum over payouts of (units held at that payout x per-unit), whether pushed or withdrawn; holders together
    /// never get more than was distributed, and the dust left is at most one base unit per holder per payout.
    function testFuzz_payoutsFollowBalancesAtPaymentTime(uint256 fixtureSeed, uint256[12] memory moves, bool push) public {
        uint256[6] memory pick = [uint256(0), 3, 7, 13, 15, 19];
        uint256 idx = pick[fixtureSeed % pick.length];
        Fixture memory f = _fixture(idx);
        address issuer = makeAddr("fi");
        uint256 pid = _issue(f, issuer, makeAddr("fp"));
        address[] memory hs = _investors(f, pid, "fh", 4); // two subscribers, two who only buy
        NoteToken t = _note(pid);
        uint256 nA = f.tokenOf.length;
        int256[][] memory expected = new int256[][](hs.length);
        for (uint256 k = 0; k < hs.length; k++) expected[k] = new int256[](nA);
        int256[] memory distributed = new int256[](nA);
        uint256 payouts;
        uint256 m;
        for (uint256 i = 0; i < f.actions.length; i++) {
            Action memory a = f.actions[i];
            if (a.kind == 4) continue; // the fuzzer moves units instead
            // A random transfer between holders before each action.
            uint256 mv = moves[m++ % moves.length];
            address from = hs[mv % hs.length];
            address to = hs[(mv >> 8) % hs.length];
            uint256 held = t.balanceOf(from);
            if (from != to && held > 0) {
                vm.prank(from);
                t.transfer(to, bound(mv >> 16, 1, held));
            }
            if (a.at > block.timestamp) vm.warp(a.at);
            vm.recordLogs();
            if (a.kind == 1) {
                _report(pid, a.step, a.values);
            } else if (a.kind == 2) {
                _report(pid, NO, new int256[](0));
            } else if (a.kind == 3) {
                tokens[a.token].mint(issuer, a.base);
                vm.prank(issuer);
                engine.executeStep(pid, a.step, NO, a.inputs);
            }
            // Expected shares at the balances of the moment (no transfer happens inside an action).
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 j = 0; j < logs.length; j++) {
                if (logs[j].topics[0] != RECORDED) continue;
                uint256 asset = uint256(logs[j].topics[2]);
                (,,, int256 perUnit, int256 total,,,) = abi.decode(logs[j].data, (uint8, uint16, address, int256, int256, uint256, bool, bytes32));
                distributed[asset] += total;
                payouts++;
                for (uint256 k = 0; k < hs.length; k++) {
                    expected[k][asset] += int256(t.heldOf(hs[k])) * 1e4 * perUnit / SCALE;
                }
            }
            if (push) _pushAll(f, pid, hs);
        }
        assertEq(engine.processOf(pid).status, engine.COMPLETED());
        for (uint8 c = CASH; c < nA; c++) {
            int256 got;
            for (uint256 k = 0; k < hs.length; k++) {
                int256 have = engine.balanceOf(pid, hs[k], c) + pushedTo[pid][hs[k]][c];
                // Per payout, a holder loses under one fixed-point unit to the accumulator's floor and, pushed,
                // under one base unit of the token.
                uint256 tol = payouts * (push ? uint256(SCALE) / (10 ** decimals[f.tokenOf[c]]) + 1 : 1);
                assertApproxEqAbs(have, expected[k][c], tol, "holder paid by its balance at each payment");
                assertLe(have, expected[k][c] + int256(payouts), "never more than its share");
                got += have;
            }
            assertLe(got, distributed[c], "claimable + pushed <= distributed");
            assertLe(distributed[c] - got, int256(hs.length * payouts) * SCALE / int256(10 ** decimals[f.tokenOf[c]]) + int256(hs.length * payouts), "dust <= holders x 1 unit per payout");
        }
        assertEq(t.totalSupply(), 0, "retired at the end");
    }

    /// totalSupply == sold - burned throughout: subscriptions mint, the strike cancels the unsold units, the
    /// redemption retires the rest.
    function test_supplyIsSoldMinusBurned() public {
        Fixture memory f = _fixture(2); // reverse convertible: 100 unsold units are cancelled at the strike
        address issuer = makeAddr("si");
        uint256 pid = _issue(f, issuer, makeAddr("sp"));
        NoteToken t = _note(pid);
        address[] memory hs = _investors(f, pid, "sh", f.investorUnits.length);
        int256 sold;
        for (uint256 k = 0; k < hs.length; k++) sold += f.investorUnits[k];
        assertGe(int256(t.totalSupply()) * 1e4, sold, "the book holds at least what was sold");
        _play(f, pid, issuer, hs, 0, 1); // the strike
        assertEq(int256(t.totalSupply()) * 1e4, sold, "after the strike: exactly what was sold");
        assertEq(t.balanceOf(issuer), 0, "the issuer's unsold units are burned");
        _play(f, pid, issuer, hs, 1, type(uint256).max);
        assertEq(t.totalSupply(), 0, "redeemed: retired");
        assertEq(t.supplyHeld(), uint256(sold / 1e4), "the record of what was held stays for the payouts");
    }

    /// The issuer's unsold units never accrue: an undersubscribed note pays coupons on what was sold only.
    function test_issuerUnsoldUnitsDoNotAccrue() public {
        Fixture memory f = _fixture(3); // phoenix: 250 + 750, coupons at 1 and 3
        address issuer = makeAddr("ui");
        uint256 pid = _issue(f, issuer, makeAddr("up"));
        address h = makeAddr("uh");
        _subscribe(f, pid, h, 300e10, 300e6); // 300 of 1,000 sold
        address[] memory hs = new address[](1);
        hs[0] = h;
        vm.recordLogs();
        _play(f, pid, issuer, hs, 0, type(uint256).max);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 j = 0; j < logs.length; j++) {
            if (logs[j].topics[0] != RECORDED) continue;
            (,,,,, uint256 supply,,) = abi.decode(logs[j].data, (uint8, uint16, address, int256, int256, uint256, bool, bytes32));
            assertEq(supply, 300e10, "eligible supply = units sold");
            seen++;
        }
        assertGt(seen, 0);
        assertEq(engine.pendingOf(pid, issuer, CASH), 0, "nothing accrues to the issuer");
    }

    // ---- Push ---------------------------------------------------------------------------------------------------

    /// 1,000 holders, the default's payout pushed in uneven batches: every wallet gets its share, the round settles
    /// once, and every payoutId and the rolling hash are recomputable from the logs alone.
    function test_pushThousandHoldersInBatchesWithReceipts() public {
        Fixture memory f = _fixture(19); // mixed collateral, all to holders
        address issuer = makeAddr("bi");
        uint256 pid = _issue(f, issuer, makeAddr("bp"));
        uint256 n = 1000;
        address[] memory hs = new address[](n);
        for (uint256 k = 0; k < n; k++) {
            hs[k] = makeAddr(string.concat("bh", vm.toString(k)));
            _subscribe(f, pid, hs[k], 1e10, 1e6);
        }
        vm.recordLogs();
        _play(f, pid, issuer, hs, 0, type(uint256).max);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // The last stablecoin distribution: its per-unit and period.
        int256 perUnit;
        uint64 period;
        for (uint256 j = 0; j < logs.length; j++) {
            if (logs[j].topics[0] != RECORDED || uint256(logs[j].topics[2]) != CASH) continue;
            period = uint64(uint256(logs[j].topics[3]));
            (,,, perUnit,,,,) = abi.decode(logs[j].data, (uint8, uint16, address, int256, int256, uint256, bool, bytes32));
            (,,,,, uint256 supply,, bytes32 h) = abi.decode(logs[j].data, (uint8, uint16, address, int256, int256, uint256, bool, bytes32));
            assertEq(h, keccak256(abi.encode(block.chainid, address(engine), pid, uint256(CASH), period, perUnit, supply)), "distributionHash");
        }
        // Holders were also owed the earlier coupon (not pushed): everything they accrued goes out with this push.
        int256 owedEach = engine.balanceOf(pid, hs[0], CASH);
        assertGt(owedEach, 0);

        vm.recordLogs();
        uint256 left = n;
        uint256[4] memory sizes = [uint256(137), 1, 400, 1000];
        for (uint256 b = 0; left > 0; b++) {
            vm.prank(keeper);
            left = engine.pushPayouts(pid, CASH, type(uint256).max, sizes[b % 4]);
        }
        logs = vm.getRecordedLogs();
        bytes32 rolling;
        uint256 paid;
        uint256 paidTotal;
        bool settled;
        for (uint256 j = 0; j < logs.length; j++) {
            if (logs[j].topics[0] == PAID) {
                address holder = address(uint160(uint256(logs[j].topics[3])));
                (uint64 p, uint256 amount, bytes32 pidHash) = abi.decode(logs[j].data, (uint64, uint256, bytes32));
                assertEq(p, period);
                assertEq(pidHash, keccak256(abi.encode(block.chainid, address(engine), pid, uint256(CASH), p, holder, amount)), "payoutId");
                rolling = keccak256(abi.encode(rolling, pidHash));
                paid++;
                paidTotal += amount;
                assertEq(tokens[1].balanceOf(holder), amount, "in the wallet");
            } else if (logs[j].topics[0] == SETTLED) {
                assertFalse(settled, "settles once");
                settled = true;
                (uint256 count, uint256 total, bytes32 rh) = abi.decode(logs[j].data, (uint256, uint256, bytes32));
                assertEq(count, n);
                assertEq(total, paidTotal);
                assertEq(rh, rolling, "rollingHash = keccak chain of the payoutIds");
            }
        }
        assertTrue(settled);
        assertEq(paid, n);
        for (uint256 k = 0; k < n; k += 97) {
            assertEq(engine.balanceOf(pid, hs[k], CASH), 0, "nothing left to withdraw");
            assertApproxEqAbs(int256(tokens[1].balanceOf(hs[k])) * 1e4, owedEach, 1e4, "each wallet got its share");
        }
        // Pushing again pays nobody twice.
        vm.recordLogs();
        engine.pushPayouts(pid, CASH, 0, n);
        logs = vm.getRecordedLogs();
        for (uint256 j = 0; j < logs.length; j++) assertTrue(logs[j].topics[0] != PAID, "no double pay");
        console2.log("1,000 holders pushed; payoutId + rollingHash verified from logs");
    }

    /// A frozen recipient does not stop the batch: its payment is deferred and stays claimable; push and claim
    /// never pay twice.
    function test_failedRecipientsAreDeferredAndClaimable() public {
        FreezableERC20 usd = new FreezableERC20("fUSD", 6);
        tokens[1] = MockERC20(address(usd)); // same mint/approve surface
        Fixture memory f = _fixture(0); // FCN: coupon 1 and the call at 2
        address issuer = makeAddr("di");
        uint256 pid = _issue(f, issuer, makeAddr("dp"));
        address[] memory hs = _investors(f, pid, "dh", 2);
        usd.freeze(hs[1], true);
        _playToPayout(f, pid, issuer, hs, CASH);
        int256 owed0 = engine.balanceOf(pid, hs[0], CASH);
        int256 owed1 = engine.balanceOf(pid, hs[1], CASH);
        assertGt(owed1, 0);
        vm.recordLogs();
        uint256 left = engine.pushPayouts(pid, CASH, type(uint256).max, 10);
        assertEq(left, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool deferred;
        for (uint256 j = 0; j < logs.length; j++) {
            if (logs[j].topics[0] == DEFERRED) {
                deferred = true;
                assertEq(address(uint160(uint256(logs[j].topics[3]))), hs[1]);
            }
        }
        assertTrue(deferred, "PayoutDeferred");
        assertEq(int256(usd.balanceOf(hs[0])) * 1e4, owed0, "the other holder was paid");
        assertEq(engine.balanceOf(pid, hs[1], CASH), owed1, "the frozen holder's payment stays claimable");
        // Pushing again (a retry) still fails while frozen; claimed after unfreezing, then nothing is left to push.
        address[] memory retry = new address[](1);
        retry[0] = hs[1];
        engine.pushTo(pid, CASH, retry);
        assertEq(engine.balanceOf(pid, hs[1], CASH), owed1);
        usd.freeze(hs[1], false);
        vm.prank(hs[1]);
        engine.withdraw(pid, CASH, uint256(owed1 / 1e4));
        assertEq(int256(usd.balanceOf(hs[1])) * 1e4, owed1);
        vm.recordLogs();
        engine.pushTo(pid, CASH, retry);
        engine.pushPayouts(pid, CASH, 0, 10);
        logs = vm.getRecordedLogs();
        for (uint256 j = 0; j < logs.length; j++) assertTrue(logs[j].topics[0] != PAID, "claimed: never pushed as well");
        vm.prank(hs[0]);
        vm.expectRevert(FlowEngine.InsufficientBalance.selector);
        engine.withdraw(pid, CASH, 1); // pushed: never claimable as well
    }

    /// A holder who sells between a distribution and its push keeps that payout (it was theirs at payment time);
    /// the buyer gets nothing from it. The push skips the seller (no longer a holder); pushTo pays it.
    function test_transferBetweenDistributionAndPushPaysTheHolderAtPaymentTime() public {
        Fixture memory f = _fixture(0);
        address issuer = makeAddr("ti");
        uint256 pid = _issue(f, issuer, makeAddr("tp"));
        address[] memory hs = _investors(f, pid, "th", 2);
        address buyer = makeAddr("tbuyer");
        uint256 i = _playToPayout(f, pid, issuer, hs, CASH);
        int256 sellerOwed = engine.balanceOf(pid, hs[0], CASH);
        assertGt(sellerOwed, 0);
        NoteToken t = _note(pid);
        uint256 all = t.balanceOf(hs[0]);
        vm.prank(hs[0]);
        t.transfer(buyer, all);
        assertEq(engine.balanceOf(pid, buyer, CASH), 0, "the buyer gets nothing from a payout made before it bought");
        assertEq(engine.balanceOf(pid, hs[0], CASH), sellerOwed, "the seller keeps it");
        engine.pushPayouts(pid, CASH, type(uint256).max, 10);
        assertEq(tokens[1].balanceOf(buyer), 0);
        address[] memory seller = new address[](1);
        seller[0] = hs[0];
        engine.pushTo(pid, CASH, seller);
        assertEq(int256(tokens[1].balanceOf(hs[0])) * 1e4, sellerOwed, "pushed to the seller");
        assertEq(engine.balanceOf(pid, hs[0], CASH), 0);
        // The later payments follow the units to the buyer.
        _play(f, pid, issuer, hs, i + 1, type(uint256).max);
        assertGt(engine.balanceOf(pid, buyer, CASH), 0, "the buyer is paid from then on");
    }

    /// pushTo never sweeps cash the workflow put on an account (only payouts): the issuer's subscription
    /// proceeds stay where the workflow left them.
    function test_pushToSweepsOnlyPayouts() public {
        Fixture memory f = _fixture(0);
        address issuer = makeAddr("wi");
        uint256 pid = _issue(f, issuer, makeAddr("wp"));
        address[] memory hs = _investors(f, pid, "wh", 2);
        int256 proceeds = engine.balanceOf(pid, issuer, CASH);
        assertGt(proceeds, 0);
        _playToPayout(f, pid, issuer, hs, CASH);
        address[] memory who = new address[](1);
        who[0] = issuer;
        engine.pushTo(pid, CASH, who);
        assertEq(engine.balanceOf(pid, issuer, CASH), proceeds, "not swept");
        assertEq(tokens[1].balanceOf(issuer), 0);
    }

    /// Redemption retires the units: balances read zero and nothing moves, yet the redemption itself (paid in
    /// the same step that retires) is still pushed in full.
    function test_redemptionRetiresButStillPays() public {
        Fixture memory f = _fixture(0);
        address issuer = makeAddr("ri");
        uint256 pid = _issue(f, issuer, makeAddr("rp"));
        address[] memory hs = _investors(f, pid, "rh", 2);
        _play(f, pid, issuer, hs, 0, type(uint256).max);
        NoteToken t = _note(pid);
        assertTrue(t.retired());
        assertEq(t.balanceOf(hs[0]), 0);
        assertEq(engine.balanceOf(pid, hs[0], NOTE), 0);
        vm.prank(hs[0]);
        vm.expectRevert(NoteToken.InsufficientBalance.selector);
        t.transfer(hs[1], 1);
        int256 owed = engine.balanceOf(pid, hs[0], CASH);
        assertApproxEqAbs(owed, f.expected[0][CASH], uint256(TOLERANCE));
        engine.pushPayouts(pid, CASH, 0, 10);
        assertEq(int256(tokens[1].balanceOf(hs[0])) * 1e4, owed, "redemption and coupons pushed after retirement");
    }

    /// A note that has completed cannot be transferred, even before its redemption retires the units (e.g. a
    /// default whose last distribution has no retire): the phase is checked on every transfer.
    function test_transfersRefusedAfterCompletion() public {
        Fixture memory f = _fixture(13); // phoenix default
        address issuer = makeAddr("ci");
        uint256 pid = _issue(f, issuer, makeAddr("cp"));
        address[] memory hs = _investors(f, pid, "ch", 2);
        _play(f, pid, issuer, hs, 0, type(uint256).max);
        NoteToken t = _note(pid);
        vm.prank(hs[0]);
        vm.expectRevert(); // retired (InsufficientBalance) or completed (NotTransferable)
        t.transfer(hs[1], 1);
    }

    /// Physical delivery with an 18-decimal deliverable: holders receive it through the accumulator, pushed or
    /// withdrawn, to the reference amount.
    function test_physicalDeliveryWith18DecimalToken() public {
        Fixture memory f = _fixture(10); // FCN on ETH, physical: knocked in, delivers tETH
        uint8 ethId = 2;
        // tETH becomes an 18-decimal token: the definition's asset decimals and every base amount follow.
        MockERC20 eth18 = new MockERC20("tETH18", 18);
        tokens[ethId] = eth18;
        decimals[ethId] = 18;
        for (uint256 a = 0; a < f.tokenOf.length; a++) {
            if (f.tokenOf[a] != ethId) continue;
            uint256 o = 12 + uint256(uint8(f.def[1])) + uint256(uint8(f.def[2])) + 2 * a + 1;
            f.def[o] = bytes1(uint8(18));
        }
        for (uint256 i = 0; i < f.actions.length; i++) if (f.actions[i].token == ethId) f.actions[i].base *= 1e9;
        for (uint256 k = 0; k < f.pledges.length; k++) if (f.pledges[k].token == ethId) f.pledges[k].base *= 1e9;
        address issuer = makeAddr("pi");
        uint256 pid = _issue(f, issuer, makeAddr("pp"));
        address[] memory hs = _investors(f, pid, "ph", 2);
        pushAll = true;
        _play(f, pid, issuer, hs, 0, type(uint256).max);
        assertEq(engine.processOf(pid).status, engine.COMPLETED());
        bool delivered;
        for (uint8 a = CASH; a < f.tokenOf.length; a++) {
            if (f.tokenOf[a] != ethId) continue;
            for (uint256 k = 0; k < hs.length; k++) {
                int256 got = int256(eth18.balanceOf(hs[k]) / 1e8) + engine.balanceOf(pid, hs[k], a);
                assertApproxEqAbs(got, f.expected[k][a], uint256(TOLERANCE), "18-decimal delivery");
                if (eth18.balanceOf(hs[k]) > 0) delivered = true;
            }
        }
        assertTrue(delivered, "pushed in kind");
    }

    /// A cash token that calls back into the engine on transfer cannot re-enter: the nested push and withdraw
    /// fail (the outer payment then goes through, or is deferred if the hook ran out of gas); nobody is paid twice.
    function test_noReentrancyThroughTokenHooks() public {
        ReentrantERC20 re = new ReentrantERC20();
        tokens[1] = MockERC20(address(re));
        Fixture memory f = _fixture(0);
        address issuer = makeAddr("ei");
        uint256 pid = _issue(f, issuer, makeAddr("ep"));
        address[] memory hs = _investors(f, pid, "eh", 2);
        _play(f, pid, issuer, hs, 0, type(uint256).max);
        re.arm(engine, pid);
        uint256 vault = engine.vaultOf(pid, CASH);
        int256 owed = engine.balanceOf(pid, hs[0], CASH);
        engine.pushPayouts(pid, CASH, 0, 10);
        assertGt(re.reentries(), 0, "the hook ran");
        assertEq(re.reentriesSucceeded(), 0, "every re-entry refused");
        assertEq(engine.vaultOf(pid, CASH) + re.balanceOf(hs[0]) + re.balanceOf(hs[1]), vault, "vault + paid conserved");
        assertEq(engine.balanceOf(pid, hs[0], CASH) + int256(re.balanceOf(hs[0])) * 1e4, owed, "no double pay");
    }

    /// Gas of the holder-side operations once payouts have accrued: a transfer (settles both sides), a push to one
    /// holder, a claim.
    function test_gasTransferPushClaim() public {
        Fixture memory f = _fixture(0);
        address issuer = makeAddr("gi");
        uint256 pid = _issue(f, issuer, makeAddr("gp"));
        address[] memory hs = _investors(f, pid, "gh", 3);
        _playToPayout(f, pid, issuer, hs, CASH);
        NoteToken t = _note(pid);
        vm.prank(hs[0]);
        uint256 g = gasleft();
        t.transfer(hs[2], 100e6); // to a new holder
        uint256 transferNew = g - gasleft();
        vm.prank(hs[0]);
        g = gasleft();
        t.transfer(hs[1], 100e6); // to an existing holder
        uint256 transferExisting = g - gasleft();
        address[] memory one = new address[](1);
        one[0] = hs[1];
        g = gasleft();
        engine.pushTo(pid, CASH, one);
        uint256 pushOne = g - gasleft();
        int256 owed = engine.balanceOf(pid, hs[0], CASH);
        vm.prank(hs[0]);
        g = gasleft();
        engine.withdraw(pid, CASH, uint256(owed / 1e4));
        uint256 claim = g - gasleft();
        console2.log("note token transfer, payouts settled (new holder) gas", transferNew);
        console2.log("note token transfer, payouts settled (existing holder) gas", transferExisting);
        console2.log("pushTo one holder gas", pushOne);
        console2.log("claim (withdraw) gas", claim);
        assertLt(transferNew, 300_000); // isolated (a real transaction, cold storage): about 263k
    }

    /// The lens: token addresses, balances, accrued payouts and claimable amounts in one call.
    function test_lensExposesTokensAccruedAndClaimable() public {
        NotesLens lens = new NotesLens(engine);
        Fixture memory f = _fixture(0);
        address issuer = makeAddr("li");
        uint256 pid = _issue(f, issuer, makeAddr("lp"));
        address[] memory hs = _investors(f, pid, "lh", 2);
        _playToPayout(f, pid, issuer, hs, CASH);
        (address[] memory toks, int256[] memory bals, int256[] memory accrued) = lens.position(pid, hs[0]);
        assertEq(toks[NOTE], address(_note(pid)));
        assertEq(toks[CASH], address(tokens[1]));
        assertEq(bals[NOTE], f.investorUnits[0]);
        assertGt(accrued[CASH], 0, "accrued, not settled");
        assertEq(bals[CASH], accrued[CASH]);
        int256[] memory c = lens.claimable(pid, CASH, hs);
        assertEq(c[0], accrued[CASH]);
        (address[] memory who, uint256[] memory units, uint256 total) = lens.holders(pid, NOTE, 0, 10);
        assertEq(total, 2);
        assertEq(who.length, 2);
        assertEq(units[0] + units[1], 1000e6);
        engine.pushPayouts(pid, CASH, type(uint256).max, 10);
        c = lens.claimable(pid, CASH, hs);
        assertEq(c[0], 0, "pushed: nothing to withdraw");
    }

    /// Replay the timeline up to (and including) the first action that distributes `asset`.
    function _playToPayout(Fixture memory f, uint256 pid, address issuer, address[] memory hs, uint256 asset)
        internal
        returns (uint256 i)
    {
        for (; i < f.actions.length; i++) {
            vm.recordLogs();
            _play(f, pid, issuer, hs, i, i + 1);
            Vm.Log[] memory l = vm.getRecordedLogs();
            for (uint256 j = 0; j < l.length; j++) {
                if (l[j].topics[0] == RECORDED && uint256(l[j].topics[2]) == asset) return i;
            }
        }
        revert("no payout");
    }
}
