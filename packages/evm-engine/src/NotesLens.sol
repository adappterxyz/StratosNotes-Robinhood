// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {FlowEngine} from "./FlowEngine.sol";
import {SSTORE2} from "./lib/SSTORE2.sol";
import {NoteToken} from "./NoteToken.sol";

/// @title NotesLens - one-call reads of a FlowEngine for keepers, plus full definition bytes on-chain
/// @notice The engine stores only a definition's executable CORE; its META (names, oracle feeds, term sheet)
///         is emitted once in an event. A keeper that reads chain state at a finalized block (Chainlink CRE)
///         needs META too, so `publish` stores the full definition bytes here, content-addressed and checked
///         against the engine. `running` returns every running process's state in one call; `position` and
///         `claimable` read a holder's note tokens, accrued payouts and what is left to withdraw.
/// @dev Holds no funds and has no owner: anyone may publish, and only bytes whose sha256 is a definition
///      registered on the engine are accepted.
contract NotesLens {
    FlowEngine public immutable engine;

    /// SSTORE2 contracts hold at most 24,575 bytes each.
    uint256 internal constant CHUNK = 24_000;

    struct Stored {
        uint32 length;
        address[] chunks;
    }

    struct Snapshot {
        uint256 pid;
        bytes32 definition;
        uint8 status;
        uint40 updatedAt;
        uint16[] tokens;
        /// 2 bits per field: 0 unset, 1 number, 2 text, 3 party (FlowEngine.Proc.tags).
        uint128 tags;
        /// One per field up to the highest set field.
        bytes32[] values;
        /// Every role's account, every asset: balances[role * nAssets + asset] (engine fixed point; 0 for an
        /// open role). Keepers read the escrow's balances to see what a guard such as "Funded?" sees.
        int256[] balances;
    }

    mapping(bytes32 => Stored) internal _published;

    event DefinitionPublished(bytes32 indexed id, uint256 length);

    error NotRegistered();

    constructor(FlowEngine engine_) {
        engine = engine_;
    }

    /// @notice Store a registered definition's full bytes (CORE ‖ META). Idempotent.
    function publish(bytes calldata data) external returns (bytes32 id) {
        id = sha256(data);
        if (_published[id].length != 0) return id;
        (address pointer,,) = engine.definitionOf(id);
        if (pointer == address(0)) revert NotRegistered();
        Stored storage s = _published[id];
        s.length = uint32(data.length);
        for (uint256 o = 0; o < data.length; o += CHUNK) {
            uint256 end = o + CHUNK < data.length ? o + CHUNK : data.length;
            s.chunks.push(SSTORE2.write(data[o:end]));
        }
        emit DefinitionPublished(id, data.length);
    }

    /// @return data the full definition bytes, or empty if not published
    function definitionBytes(bytes32 id) external view returns (bytes memory data) {
        Stored storage s = _published[id];
        data = new bytes(s.length);
        uint256 o = 0;
        for (uint256 k = 0; k < s.chunks.length; k++) {
            uint256 n = s.length - o < CHUNK ? s.length - o : CHUNK;
            bytes memory part = SSTORE2.read(s.chunks[k], n);
            for (uint256 i = 0; i < n; i++) data[o + i] = part[i];
            o += n;
        }
    }

    function isPublished(bytes32 id) external view returns (bool) {
        return _published[id].length != 0;
    }

    /// @notice One process's state.
    function snapshot(uint256 pid) public view returns (Snapshot memory s) {
        FlowEngine.Proc memory p = engine.processOf(pid);
        s.pid = pid;
        s.definition = p.definition;
        s.status = p.status;
        s.updatedAt = p.updatedAt;
        s.tokens = engine.tokensOf(pid);
        s.tags = p.tags;
        uint256 n = 0;
        for (uint256 f = 0; f < 64; f++) {
            if ((p.tags >> (2 * f)) & 3 != 0) n = f + 1;
        }
        s.values = new bytes32[](n);
        for (uint256 f = 0; f < n; f++) {
            if ((p.tags >> (2 * f)) & 3 != 0) (, s.values[f]) = engine.valueOf(pid, f);
        }
        bytes memory core = engine.definitionCore(p.definition);
        uint256 roles = uint8(core[1]);
        uint256 assets = uint8(core[3]);
        s.balances = new int256[](roles * assets);
        for (uint256 r = 0; r < roles; r++) {
            address acct = engine.roleOf(pid, r);
            if (acct == address(0)) continue;
            for (uint256 a = 0; a < assets; a++) s.balances[r * assets + a] = engine.balanceOf(pid, acct, a);
        }
    }

    /// @notice Running processes among pids [from, from + scan), at most `max` of them.
    /// @return out their snapshots
    /// @return next the first pid not scanned (pass it as `from` to continue); 0 when the scan reached the end
    function running(uint256 from, uint256 scan, uint256 max) external view returns (Snapshot[] memory out, uint256 next) {
        uint256 count = engine.processCount();
        if (from == 0) from = 1;
        uint256 end = from + scan > count + 1 ? count + 1 : from + scan;
        Snapshot[] memory buf = new Snapshot[](max);
        uint256 n = 0;
        uint256 pid = from;
        for (; pid < end && n < max; pid++) {
            if (engine.processOf(pid).status == 0) buf[n++] = snapshot(pid);
        }
        out = new Snapshot[](n);
        for (uint256 i = 0; i < n; i++) out[i] = buf[i];
        next = pid > count ? 0 : pid;
    }

    /// @notice A holder's position in a note, per asset: the ERC-20 behind it (the note token for issued units),
    ///         the balance (units, or cash withdrawable: on the account plus accrued) and, of that, the payouts
    ///         accrued and not settled yet (engine fixed point).
    function position(uint256 pid, address holder)
        external
        view
        returns (address[] memory tokens, int256[] memory balances, int256[] memory accrued)
    {
        bytes memory core = engine.definitionCore(engine.processOf(pid).definition);
        uint256 assets = uint8(core[3]);
        tokens = new address[](assets);
        balances = new int256[](assets);
        accrued = new int256[](assets);
        for (uint256 a = 0; a < assets; a++) {
            tokens[a] = engine.assetTokenOf(pid, a);
            balances[a] = engine.balanceOf(pid, holder, a);
            accrued[a] = engine.pendingOf(pid, holder, a);
        }
    }

    /// @notice What each address can withdraw of a cash asset now (payouts not pushed or deferred, plus any other
    ///         cash on its account), in engine fixed point. A keeper pushes to the non-zero ones with `pushTo`.
    function claimable(uint256 pid, uint256 asset, address[] calldata accounts) external view returns (int256[] memory out) {
        out = new int256[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) out[i] = engine.balanceOf(pid, accounts[i], asset);
    }

    /// @notice The current holders of a note's units [start, start + count), with their balances (token base
    ///         units, 6 decimals).
    function holders(uint256 pid, uint256 asset, uint256 start, uint256 count)
        external
        view
        returns (address[] memory who, uint256[] memory units, uint256 total)
    {
        NoteToken t = NoteToken(engine.assetTokenOf(pid, asset));
        total = t.holderCount();
        who = t.holders(start, count);
        units = new uint256[](who.length);
        for (uint256 i = 0; i < who.length; i++) units[i] = t.balanceOf(who[i]);
    }

    /// @notice Verified-email bindings for many addresses at once: the salted hash and until when it counts
    ///         (zero: none). The email and its salt are never on-chain.
    function emails(address[] calldata accounts) external view returns (bytes32[] memory hashes, uint64[] memory verifiedUntil) {
        hashes = new bytes32[](accounts.length);
        verifiedUntil = new uint64[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) (hashes[i], verifiedUntil[i],) = engine.emailOf(accounts[i]);
    }
}
