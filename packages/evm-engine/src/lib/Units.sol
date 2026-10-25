// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {NoteToken} from "../NoteToken.sol";

/// @title Units - the engine's ledger, note tokens and scale-free payouts
/// @notice A separate, linked library (like DefCheck and EmailAttest), so this code does not count against
///         FlowEngine's 24 KiB. FlowEngine keeps one `Book` in its storage and passes it by reference.
///
///         Units of a note (an ISSUED asset) are an ERC-20, NoteToken, one clone per note. Cash, delivered tokens
///         and collateral (CASH assets) stay in the engine's ledger (`bal`, 10-decimal fixed point) backed by
///         ERC-20 vaults.
///
///         Payouts (a workflow's DISTRIBUTE: coupons, redemption, delivery, default) do not loop over holders.
///         Each adds to a cumulative per-unit accumulator, magnified by MAG:
///             acc[holding][asset] += total * MAG / eligibleUnits
///         and a holder's share is settled lazily, whenever their units change (mint, burn, transfer), when they
///         withdraw, or when a payout push reaches them:
///             owed = units * (acc - checkpoint[holder]) / MAG      (then checkpoint := acc)
///         Rounding floors in the protocol's favour: the holders' shares never add up to more than `total`; the
///         difference stays in the vault as dust.
///         The payer's own units (e.g. an issuer holding units) take no share: the payer is settled before the
///         payout, excluded from `eligibleUnits`, and its checkpoint is moved past the payout.
///
///         Push: after a payout, anyone may push it to holders' wallets in bounded batches over the token's
///         enumerable holder set. A transfer that fails (a frozen or paused stablecoin, a blocked address) leaves
///         the amount in the ledger, claimable with `withdraw`, and logs PayoutDeferred. Every payment is logged
///         with a receipt id, every distribution with a commitment hash; a round's rolling hash chains its
///         receipt ids in push order (docs/ERC20-NOTES.md).
library Units {
    using SafeERC20 for IERC20;

    int256 internal constant SCALE = 1e10;
    /// Engine fixed point per NoteToken base unit (NoteToken has 6 decimals).
    int256 internal constant UNIT = 1e4;
    uint256 internal constant UUNIT = 1e4;
    uint256 internal constant MAG = 1e30;
    /// Gas a pushed ERC-20 transfer may use: a token that burns more defers that payment, not the batch.
    uint256 internal constant PUSH_GAS = 150_000;
    /// `start` for push: continue from the round's cursor.
    uint256 internal constant NEXT = type(uint256).max;

    /// A payout push round for one cash asset of one note: its latest distribution and how far its push has got.
    struct Round {
        uint64 period; // the n-th distribution of this asset on this note (1-based)
        uint32 cursor; // next holder index to push
        uint32 paid; // payments made in this round
        bool open; // the push has not reached the end of the holder set (nor been superseded) yet
        uint8 holding; // the issued asset whose holders the distribution pays
        uint256 paidTotal; // ERC-20 base units paid in this round
        bytes32 rolling; // keccak chain of this round's payout ids, in push order
    }

    struct Book {
        /// Cash ledger: pid => account => asset => balance (10-decimal fixed point).
        mapping(uint256 => mapping(address => mapping(uint256 => int256))) bal;
        /// ERC-20 base units the engine holds per process cash asset.
        mapping(uint256 => mapping(uint256 => uint256)) vault;
        /// The ERC-20 behind each cash asset.
        mapping(uint256 => mapping(uint256 => address)) token;
        /// pid => bits 0..7 cash assets, bits 8..15 issued assets, then 8 bits of decimals per asset from bit 16.
        mapping(uint256 => uint256) layout;
        /// The NoteToken of each issued asset.
        mapping(uint256 => mapping(uint256 => address)) note;
        /// pid => holding => asset => cumulative payout per unit, x MAG.
        mapping(uint256 => mapping(uint256 => mapping(uint256 => uint256))) acc;
        /// pid => holding => asset => holder => the accumulator value already settled for them.
        mapping(uint256 => mapping(uint256 => mapping(uint256 => mapping(address => uint256)))) ck;
        /// pid => asset => the push round of its latest distribution.
        mapping(uint256 => mapping(uint256 => Round)) round;
        /// pid => asset => account => payouts on the account's ledger balance not pushed yet (settled when its
        /// units moved, or deferred): what `pushTo` may send. Never more than the ledger balance.
        mapping(uint256 => mapping(uint256 => mapping(address => int256))) unpushed;
    }

    event HoldingChanged(uint256 indexed pid, uint8 indexed asset, address indexed owner, int256 balance);
    event Deposited(uint256 indexed pid, uint8 indexed asset, address indexed from, uint256 base);
    event Withdrawn(uint256 indexed pid, uint8 indexed asset, address indexed to, uint256 base);
    event NoteTokenCreated(uint256 indexed pid, uint8 indexed asset, address token);
    event DistributionRecorded(
        uint256 indexed pid,
        uint8 indexed asset,
        uint64 indexed period,
        uint8 holding,
        uint16 step,
        address payer,
        int256 perUnit,
        int256 total,
        uint256 supplyAtPayment,
        bool retire,
        bytes32 distributionHash
    );
    event PayoutPaid(
        uint256 indexed pid, uint8 indexed asset, uint64 period, address indexed holder, uint256 amount, bytes32 payoutId
    );
    event PayoutDeferred(uint256 indexed pid, uint8 indexed asset, uint64 period, address indexed holder, uint256 amount);
    event DistributionSettled(
        uint256 indexed pid, uint8 indexed asset, uint64 indexed period, uint256 paidCount, uint256 paidTotal, bytes32 rollingHash
    );

    error InsufficientBalance();
    error NotCash();
    error NotTransferable();
    error InexactUnits();
    error VaultShort();
    error BadInputs();
    error TransferMismatch();

    // ---- Layout ------------------------------------------------------------------------------------------------

    function isCash(uint256 layout, uint256 a) internal pure returns (bool) {
        return a < 8 && (layout >> a) & 1 != 0;
    }

    function isIssued(uint256 layout, uint256 a) internal pure returns (bool) {
        return a < 8 && (layout >> (8 + a)) & 1 != 0;
    }

    function decimalsOf(uint256 layout, uint256 a) internal pure returns (uint256) {
        return (layout >> (16 + 8 * a)) & 0xFF;
    }

    /// Fixed point to ERC-20 base units (truncated).
    function toBase(int256 amount, uint256 decimals) internal pure returns (uint256) {
        // forge-lint: disable-next-line(unsafe-typecast) amounts are >= 0 here; decimals <= 36 (DefCheck)
        return uint256((amount * int256(10 ** decimals)) / SCALE);
    }

    function fromBase(uint256 base, uint256 decimals) internal pure returns (int256) {
        if (base > uint256(uint128(type(int128).max))) revert BadInputs();
        // forge-lint: disable-next-line(unsafe-typecast) bounded above; decimals <= 36 (DefCheck)
        return (int256(base) * SCALE) / int256(10 ** decimals);
    }

    /// Engine fixed point to whole NoteToken base units (reverts when not exact).
    function tokenUnits(int256 amount) internal pure returns (uint256) {
        if (amount < 0 || amount % UNIT != 0) revert InexactUnits();
        // forge-lint: disable-next-line(unsafe-typecast) checked non-negative above
        return uint256(amount / UNIT);
    }

    // ---- Setup -------------------------------------------------------------------------------------------------

    /// @notice A process starts: record its asset layout and create a NoteToken (a clone of `impl`) per issued
    ///         asset. (The engine records the cash tokens.)
    function setup(Book storage b, uint256 pid, uint256 layout, address impl, string calldata name, string calldata symbol)
        external
    {
        b.layout[pid] = layout;
        for (uint256 a = 0; a < 8; a++) {
            if (isIssued(layout, a)) {
                address t = Clones.clone(impl);
                // forge-lint: disable-next-line(unsafe-typecast) a < 8
                NoteToken(t).initialize(address(this), pid, uint8(a), name, symbol);
                b.note[pid][a] = t;
                // forge-lint: disable-next-line(unsafe-typecast) a < 8
                emit NoteTokenCreated(pid, uint8(a), t);
            }
        }
    }

    // ---- Ledger ------------------------------------------------------------------------------------------------

    function _setBal(Book storage b, uint256 pid, address owner, uint256 asset, int256 v) private {
        b.bal[pid][owner][asset] = v;
        // forge-lint: disable-next-line(unsafe-typecast) asset < 8
        emit HoldingChanged(pid, uint8(asset), owner, v);
    }

    function _credit(Book storage b, uint256 pid, address owner, uint256 asset, int256 amt) private {
        if (amt == 0) return;
        _setBal(b, pid, owner, asset, b.bal[pid][owner][asset] + amt);
    }

    function _debit(Book storage b, uint256 pid, address owner, uint256 asset, int256 amt) private {
        if (amt == 0) return;
        int256 v = b.bal[pid][owner][asset];
        if (v < amt) revert InsufficientBalance();
        v -= amt;
        _setBal(b, pid, owner, asset, v);
        mapping(address => int256) storage u = b.unpushed[pid][asset];
        if (u[owner] > v) u[owner] = v;
    }

    /// A payout lands on an account's ledger instead of its wallet.
    function _creditPayout(Book storage b, uint256 pid, address owner, uint256 asset, int256 amt) private {
        _credit(b, pid, owner, asset, amt);
        b.unpushed[pid][asset][owner] += amt;
    }

    /// Units `who` holds of issued asset `h` (fixed point), retired or not.
    function _units(Book storage b, uint256 pid, uint256 h, address who) private view returns (uint256) {
        return NoteToken(b.note[pid][h]).heldOf(who) * UUNIT;
    }

    /// Settle one holding/asset pair for `who`, who holds `units` (fixed point): move the accumulator checkpoint
    /// and return what accrued since (not yet credited anywhere).
    function _accrue(Book storage b, uint256 pid, uint256 h, uint256 a, address who, uint256 units) private returns (int256) {
        uint256 accNow = b.acc[pid][h][a];
        mapping(address => uint256) storage c = b.ck[pid][h][a];
        uint256 seen = c[who];
        if (seen == accNow) return 0;
        c[who] = accNow;
        if (units == 0) return 0;
        // forge-lint: disable-next-line(unsafe-typecast) at most the payouts' totals, which are int256
        return int256(Math.mulDiv(units, accNow - seen, MAG));
    }

    /// Credit everything that accrued to `who`, on every cash asset, from every holding.
    function _settle(Book storage b, uint256 pid, address who) private {
        uint256 layout = b.layout[pid];
        for (uint256 h = 0; h < 8; h++) {
            if (!isIssued(layout, h)) continue;
            uint256 units = _units(b, pid, h, who);
            for (uint256 a = 0; a < 8; a++) {
                if (!isCash(layout, a)) continue;
                int256 owed = _accrue(b, pid, h, a, who, units);
                if (owed > 0) _creditPayout(b, pid, who, a, owed);
            }
        }
    }

    /// @notice Put cash into a process on `who`'s own account, pulled from `who`.
    function deposit(Book storage b, uint256 pid, uint256 asset, address who, uint256 base) external {
        uint256 layout = b.layout[pid];
        if (!isCash(layout, asset)) revert NotCash();
        _settleCredit(b, pid, who, asset, fromBase(base, decimalsOf(layout, asset)));
        _pull(b, pid, asset, who, base);
    }

    /// A workflow credit: the account's payouts are settled first, so every ledger balance an event reports
    /// includes everything accrued to it (an off-chain model then tracks the account exactly).
    function _settleCredit(Book storage b, uint256 pid, address owner, uint256 asset, int256 amt) private {
        if (amt == 0) return;
        _settle(b, pid, owner);
        _credit(b, pid, owner, asset, amt);
    }

    function _spend(Book storage b, uint256 pid, address owner, uint256 asset, int256 amt) private {
        if (amt == 0) return;
        _settle(b, pid, owner);
        _debit(b, pid, owner, asset, amt);
    }

    /// @notice A workflow deposit step: credit `amount` (truncated to the token's base units) to `who`'s account
    ///         now and return the base units the engine must pull from `who` once the step is done.
    function pledge(Book storage b, uint256 pid, uint256 asset, address who, int256 amount) external returns (uint256 base) {
        uint256 layout = b.layout[pid];
        if (!isCash(layout, asset)) revert NotCash();
        uint256 decimals = decimalsOf(layout, asset);
        base = toBase(amount, decimals);
        _settleCredit(b, pid, who, asset, fromBase(base, decimals));
    }

    /// @notice Pull ERC-20 into a process vault (no fee-on-transfer tokens).
    function pull(Book storage b, uint256 pid, uint256 asset, address from, uint256 base) external {
        _pull(b, pid, asset, from, base);
    }

    function _pull(Book storage b, uint256 pid, uint256 asset, address from, uint256 base) private {
        if (base == 0) return;
        IERC20 token = IERC20(b.token[pid][asset]);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), base);
        if (token.balanceOf(address(this)) - before != base) revert TransferMismatch(); // no fee-on-transfer tokens
        b.vault[pid][asset] += base;
        // forge-lint: disable-next-line(unsafe-typecast) asset < 8
        emit Deposited(pid, uint8(asset), from, base);
    }

    /// @notice Take cash (or delivered tokens, or collateral paid out on a default) out of a process: settles the
    ///         caller's payouts first. `base` must convert exactly to the 10-decimal ledger: for a token with more
    ///         than 10 decimals a smaller amount would otherwise debit nothing and drain other holders' share.
    function withdraw(Book storage b, uint256 pid, uint256 asset, address who, uint256 base) external {
        uint256 layout = b.layout[pid];
        if (!isCash(layout, asset)) revert NotCash();
        _settle(b, pid, who);
        uint256 decimals = decimalsOf(layout, asset);
        int256 amt = fromBase(base, decimals);
        if (amt <= 0 || toBase(amt, decimals) != base) revert BadInputs();
        _debit(b, pid, who, asset, amt);
        uint256 held = b.vault[pid][asset];
        if (held < base) revert VaultShort();
        b.vault[pid][asset] = held - base;
        // forge-lint: disable-next-line(unsafe-typecast) asset < 8
        emit Withdrawn(pid, uint8(asset), who, base);
        IERC20(b.token[pid][asset]).safeTransfer(who, base);
    }

    // ---- Units -------------------------------------------------------------------------------------------------

    function _unitsChanged(uint256 pid, uint256 h, address who, uint256 tokenBalance) private {
        // forge-lint: disable-next-line(unsafe-typecast) h < 8; token balances fit int256
        emit HoldingChanged(pid, uint8(h), who, int256(tokenBalance) * UNIT);
    }

    /// @notice Issue `amount` of asset `h` to `to`: note units (whole token base units), or cash on the ledger.
    function mint(Book storage b, uint256 pid, uint256 h, address to, int256 amount) external {
        if (!isIssued(b.layout[pid], h)) return _settleCredit(b, pid, to, h, amount);
        uint256 v = tokenUnits(amount);
        if (v == 0) return;
        NoteToken t = NoteToken(b.note[pid][h]);
        if (t.retired()) revert NotTransferable();
        _settle(b, pid, to);
        t.engineMint(to, v);
        _unitsChanged(pid, h, to, t.heldOf(to));
    }

    /// @notice Cancel `amount` of asset `h` held by `from`: note units, or cash on the ledger (payouts settled
    ///         first, so an account can spend what it has been paid).
    function burn(Book storage b, uint256 pid, uint256 h, address from, int256 amount) external {
        if (!isIssued(b.layout[pid], h)) return _spend(b, pid, from, h, amount);
        uint256 v = tokenUnits(amount);
        if (v == 0) return;
        NoteToken t = NoteToken(b.note[pid][h]);
        if (t.retired()) revert NotTransferable();
        _settle(b, pid, from);
        t.engineBurn(from, v);
        _unitsChanged(pid, h, from, t.heldOf(from));
    }

    /// @notice Move `amount` of asset `h` for the workflow (a transfer or a DvP leg): note units, or cash on the
    ///         ledger. (A holder's own transfer goes through the note token and `beforeTransfer`.)
    function move(Book storage b, uint256 pid, uint256 h, address from, address to, int256 amount) external {
        if (!isIssued(b.layout[pid], h)) {
            _spend(b, pid, from, h, amount);
            return _settleCredit(b, pid, to, h, amount);
        }
        uint256 v = tokenUnits(amount);
        if (v == 0) return;
        NoteToken t = NoteToken(b.note[pid][h]);
        if (t.retired()) revert NotTransferable();
        _settle(b, pid, from);
        _settle(b, pid, to);
        t.engineMove(from, to, v);
        _unitsChanged(pid, h, from, t.heldOf(from));
        if (to != from) _unitsChanged(pid, h, to, t.heldOf(to));
    }

    /// @notice A holder's own token transfer is about to move `value` units: settle both sides at their current
    ///         balances (so payouts already made stay with whoever held the units then), and log the balances the
    ///         token is about to write.
    function beforeTransfer(Book storage b, uint256 pid, uint256 h, address from, address to, uint256 value) external {
        _settle(b, pid, from);
        if (to == from) return;
        _settle(b, pid, to);
        NoteToken t = NoteToken(b.note[pid][h]);
        _unitsChanged(pid, h, from, t.heldOf(from) - value);
        _unitsChanged(pid, h, to, t.heldOf(to) + value);
    }

    // ---- Payouts -----------------------------------------------------------------------------------------------

    /// @notice A DISTRIBUTE at step `step`: pay every holder of issued asset `h` `perUnit` of cash asset `a`, from
    ///         `payer`'s account. O(1): the payer is debited the total now; holders' shares accrue through the
    ///         accumulator. `retire` (a redemption) retires the units: no further payouts accrue on them.
    function distribute(
        Book storage b,
        uint256 pid,
        uint256 h,
        uint256 a,
        int256 perUnit,
        address payer,
        bool retire,
        uint256 step
    ) external {
        uint256 layout = b.layout[pid];
        if (!isIssued(layout, h) || !isCash(layout, a)) revert NotCash();
        NoteToken t = NoteToken(b.note[pid][h]);
        _settle(b, pid, payer); // the payer's own earlier share, before its units are excluded below
        uint256 payerUnits = t.heldOf(payer) * UUNIT;
        uint256 eligible = t.retired() ? 0 : t.supplyHeld() * UUNIT - payerUnits;
        // forge-lint: disable-next-line(unsafe-typecast) eligible fits int256 (a token supply x 1e4)
        int256 total = (int256(eligible) * perUnit) / SCALE;
        _debit(b, pid, payer, a, total);
        if (total > 0) {
            // forge-lint: disable-next-line(unsafe-typecast) total > 0
            uint256 accNow = b.acc[pid][h][a] + Math.mulDiv(uint256(total), MAG, eligible);
            b.acc[pid][h][a] = accNow;
            if (payerUnits != 0) b.ck[pid][h][a][payer] = accNow; // the payer takes no share of its own payout
        }
        Round storage prev = b.round[pid][a];
        uint64 period = prev.period + 1;
        // A round superseded before its push reached the end closes here (what it did not push carries over:
        // the next push pays everything accrued).
        // forge-lint: disable-next-line(unsafe-typecast) a < 8
        if (prev.open) emit DistributionSettled(pid, uint8(a), prev.period, prev.paid, prev.paidTotal, prev.rolling);
        // forge-lint: disable-next-line(unsafe-typecast) h < 8
        b.round[pid][a] = Round(period, 0, 0, true, uint8(h), 0, bytes32(0));
        emit DistributionRecorded(
            pid,
            // forge-lint: disable-next-line(unsafe-typecast) a < 8
            uint8(a),
            period,
            // forge-lint: disable-next-line(unsafe-typecast) h < 8
            uint8(h),
            // forge-lint: disable-next-line(unsafe-typecast) steps < 0xFFFE (DefCheck)
            uint16(step),
            payer,
            perUnit,
            total,
            eligible,
            retire,
            distributionHash(pid, a, period, perUnit, eligible)
        );
        if (retire) t.engineRetire();
    }

    /// @notice The commitment a DistributionRecorded log carries.
    function distributionHash(uint256 pid, uint256 a, uint64 period, int256 perUnit, uint256 supply) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), pid, a, period, perUnit, supply));
    }

    /// @notice A payment's receipt id (amount in the token's base units).
    function payoutId(uint256 pid, uint256 a, uint64 period, address holder, uint256 amount) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), pid, a, period, holder, amount));
    }

    /// The running totals of one push batch, written back to the round once.
    struct Batch {
        uint256 pid;
        uint256 a;
        uint256 h;
        uint64 period;
        uint256 decimals;
        address token;
        NoteToken note;
        uint256 vault;
        uint256 paid;
        uint256 total;
        bytes32 rolling;
    }

    function _begin(Book storage b, uint256 pid, uint256 a, Round storage r) private view returns (Batch memory x) {
        x.pid = pid;
        x.a = a;
        x.h = r.holding;
        x.period = r.period;
        x.decimals = decimalsOf(b.layout[pid], a);
        x.token = b.token[pid][a];
        x.note = NoteToken(b.note[pid][x.h]);
        x.vault = b.vault[pid][a];
        x.rolling = r.rolling;
    }

    function _end(Book storage b, Round storage r, Batch memory x) private {
        b.vault[x.pid][x.a] = x.vault;
        // forge-lint: disable-next-line(unsafe-typecast) payment counts fit uint32
        r.paid += uint32(x.paid);
        r.paidTotal += x.total;
        r.rolling = x.rolling;
    }

    /// @notice Push what holders [start, start + count) of the latest distribution's holding have accrued on cash
    ///         asset `a` straight to their wallets (start = NEXT: from the round's cursor). Anyone may call it: it
    ///         only pays holders their own accruals. The round settles (DistributionSettled) when the cursor
    ///         passes the last holder.
    /// @return left holders after the cursor still to push (0: settled, or nothing to push)
    function push(Book storage b, uint256 pid, uint256 a, uint256 start, uint256 count) external returns (uint256 left) {
        Round storage r = b.round[pid][a];
        if (r.period == 0) return 0;
        Batch memory x = _begin(b, pid, a, r);
        uint256 n = x.note.holderCount();
        uint256 cursor = r.cursor;
        uint256 i = start == NEXT ? cursor : start;
        uint256 end = i >= n || count >= n - i ? n : i + count;
        for (uint256 k = i; k < end; k++) {
            _payOne(b, x, x.note.holderAt(k));
        }
        _end(b, r, x);
        if (i <= cursor && end > cursor) {
            cursor = end;
            // forge-lint: disable-next-line(unsafe-typecast) holder counts fit uint32
            r.cursor = uint32(end);
        }
        if (!r.open) return 0;
        if (cursor < n) return n - cursor;
        r.open = false;
        // forge-lint: disable-next-line(unsafe-typecast) a < 8
        emit DistributionSettled(pid, uint8(a), x.period, r.paid, r.paidTotal, r.rolling);
        return 0;
    }

    /// @notice Push to these addresses: their accruals plus payouts already on their account (e.g. a holder that
    ///         sold out between a distribution and its push, whose share was settled into the ledger then, or a
    ///         deferred payment to retry). Other cash on the account (the workflow's own) is never swept.
    function pushTo(Book storage b, uint256 pid, uint256 a, address[] calldata who) external {
        Round storage r = b.round[pid][a];
        if (r.period == 0) return;
        Batch memory x = _begin(b, pid, a, r);
        for (uint256 k = 0; k < who.length; k++) {
            address w = who[k];
            int256 held = b.unpushed[pid][a][w];
            _send(b, x, w, _accrue(b, pid, x.h, a, w, x.note.heldOf(w) * UUNIT), held > 0 ? held : int256(0));
        }
        _end(b, r, x);
    }

    function _payOne(Book storage b, Batch memory x, address who) private {
        _send(b, x, who, _accrue(b, x.pid, x.h, x.a, who, x.note.heldOf(who) * UUNIT), 0);
    }

    /// Pay `owed` (accrued, already off the accumulator) plus `swept` (payouts waiting on the account's ledger) to
    /// `who`'s wallet; if that cannot happen, `owed` lands on the account (claimable) and `swept` stays there.
    /// Events keep an off-chain model exact: PayoutPaid first, then the account's new ledger balance if it moved.
    function _send(Book storage b, Batch memory x, address who, int256 owed, int256 swept) private {
        int256 amt = owed + swept;
        if (amt <= 0) return;
        uint256 base = toBase(amt, x.decimals);
        // Under one base unit (it stays on the account until it adds up), or the vault cannot cover it.
        if (base == 0 || x.vault < base) return _creditPayout(b, x.pid, who, x.a, owed);
        // A failing transfer (a frozen or paused stablecoin, a blocked address) must not stop the batch.
        if (!_tryTransfer(x.token, who, base)) {
            _creditPayout(b, x.pid, who, x.a, owed);
            // forge-lint: disable-next-line(unsafe-typecast) a < 8
            emit PayoutDeferred(x.pid, uint8(x.a), x.period, who, base);
            return;
        }
        x.vault -= base;
        bytes32 id = payoutId(x.pid, x.a, x.period, who, base);
        x.rolling = keccak256(abi.encode(x.rolling, id));
        x.paid += 1;
        x.total += base;
        // forge-lint: disable-next-line(unsafe-typecast) a < 8
        emit PayoutPaid(x.pid, uint8(x.a), x.period, who, base, id);
        // What did not fit in whole base units stays on the account, as a payout. The account's balance is logged
        // either way: with PayoutPaid it keeps an off-chain model of what each holder can withdraw exact.
        int256 rest = amt - fromBase(base, x.decimals);
        int256 ledger = b.bal[x.pid][who][x.a];
        if (rest != swept) {
            b.unpushed[x.pid][x.a][who] += rest - swept;
            ledger += rest - swept;
        }
        _setBal(b, x.pid, who, x.a, ledger);
    }

    /// An ERC-20 transfer that cannot revert the caller: bounded gas, and at most 32 bytes of return data copied
    /// (a token returning a huge buffer cannot make the copy eat the batch's gas). True as SafeERC20 would accept.
    function _tryTransfer(address token, address to, uint256 amount) private returns (bool good) {
        bytes memory data = abi.encodeCall(IERC20.transfer, (to, amount));
        bool ok;
        uint256 size;
        uint256 word;
        assembly ("memory-safe") {
            ok := call(PUSH_GAS, token, 0, add(data, 0x20), mload(data), 0, 0x20)
            size := returndatasize()
            word := mload(0)
        }
        good = ok && (size == 0 ? token.code.length != 0 : (size >= 32 && word == 1));
    }

    // ---- Views -------------------------------------------------------------------------------------------------

    /// @notice What `who` has accrued on cash asset `a` and not yet settled (fixed point).
    function pending(Book storage b, uint256 pid, address who, uint256 a) public view returns (int256 owed) {
        uint256 layout = b.layout[pid];
        if (!isCash(layout, a)) return 0;
        for (uint256 h = 0; h < 8; h++) {
            if (!isIssued(layout, h)) continue;
            uint256 accNow = b.acc[pid][h][a];
            uint256 seen = b.ck[pid][h][a][who];
            if (accNow == seen) continue;
            // forge-lint: disable-next-line(unsafe-typecast) at most the payouts' totals
            owed += int256(Math.mulDiv(_units(b, pid, h, who), accNow - seen, MAG));
        }
    }

    /// @notice A balance as a holder sees it: units for an issued asset (zero once retired); ledger plus accrued
    ///         for a cash asset.
    function balanceOf(Book storage b, uint256 pid, address who, uint256 a) external view returns (int256) {
        uint256 layout = b.layout[pid];
        if (isIssued(layout, a)) {
            NoteToken t = NoteToken(b.note[pid][a]);
            // forge-lint: disable-next-line(unsafe-typecast) token balances fit int256
            return t.retired() ? int256(0) : int256(t.heldOf(who)) * UNIT;
        }
        return b.bal[pid][who][a] + pending(b, pid, who, a);
    }
}
