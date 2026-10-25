// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title Def - reads a workflow definition's CORE bytes in memory
/// @notice Layout and rationale: packages/core/src/compile-evm.ts. All integers are big-endian; every offset
///         is absolute from byte 0 of CORE. DefCheck.check validates every offset and index once, when a
///         definition is registered, so the engine's reads afterwards stay inside CORE and inside the
///         definition's own tables.
library Def {
    error BadDefinition();

    uint256 internal constant VERSION = 3;
    uint256 internal constant HEADER = 12;
    uint256 internal constant NO_EXPR = 0xFFFF;

    // Step kinds (BPMN element types).
    uint256 internal constant START = 0;
    uint256 internal constant END = 1;
    uint256 internal constant USER = 2;
    uint256 internal constant SERVICE = 3;
    uint256 internal constant RECEIVE = 4;
    uint256 internal constant XOR = 5;
    uint256 internal constant AND = 6;
    uint256 internal constant CATCH = 7;

    // Field kinds.
    uint256 internal constant F_DECIMAL = 0;
    uint256 internal constant F_INT = 1;
    uint256 internal constant F_DATE = 2;
    uint256 internal constant F_TEXT = 3;
    uint256 internal constant F_PARTY = 4;
    uint256 internal constant F_BOOL = 5;

    // Capture sources.
    uint256 internal constant SRC_INPUT = 0;
    uint256 internal constant SRC_ORACLE = 1;
    uint256 internal constant SRC_EXPR = 2;

    // Asset operations.
    uint256 internal constant OP_NONE = 0;
    uint256 internal constant OP_MINT = 1;
    uint256 internal constant OP_BURN = 2;
    uint256 internal constant OP_TRANSFER = 3;
    uint256 internal constant OP_SWAP = 4;
    uint256 internal constant OP_DEPOSIT = 5;
    uint256 internal constant OP_DISTRIBUTE = 6;

    // Expression operands beyond fields and constants.
    uint256 internal constant X_BALANCE = 18; // field = role << 8 | asset: that role's balance in the note
    uint256 internal constant X_NOW = 19; // block.timestamp

    // Role flags.
    uint256 internal constant R_ESCROW = 1; // an account the engine holds for the note: nobody signs for it

    // Asset kinds.
    uint256 internal constant A_ISSUED = 0;
    uint256 internal constant A_CASH = 1;

    // Record sizes.
    uint256 internal constant STEP_FIXED = 10;
    uint256 internal constant DUE = 11;
    uint256 internal constant CAPTURE = 21;
    uint256 internal constant OP = 12;
    uint256 internal constant EDGE = 5;
    uint256 internal constant EXPR_OP = 11;

    /// A step record, located (offsets into CORE) but not copied.
    struct Step {
        uint256 kind;
        uint256 role;
        uint256 join;
        uint256 guard;
        uint256 nCaptures;
        uint256 nOps;
        uint256 nNext;
        uint256 nSends;
        uint256 milestone; // Milestone code announced when the step completes (0 = none)
        uint256 timer; // offset of the timer Due, 0 = none
        uint256 until; // offset of the until Due, 0 = none
        uint256 captures;
        uint256 ops;
        uint256 next;
        uint256 sends;
    }

    function u8(bytes memory b, uint256 o) internal pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := byte(0, mload(add(add(b, 32), o)))
        }
    }

    function u16(bytes memory b, uint256 o) internal pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := shr(240, mload(add(add(b, 32), o)))
        }
    }

    function u32(bytes memory b, uint256 o) internal pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := shr(224, mload(add(add(b, 32), o)))
        }
    }

    function i64(bytes memory b, uint256 o) internal pure returns (int256 v) {
        assembly ("memory-safe") {
            v := signextend(7, shr(192, mload(add(add(b, 32), o))))
        }
    }

    function nRoles(bytes memory c) internal pure returns (uint256) {
        return u8(c, 1);
    }

    function nFields(bytes memory c) internal pure returns (uint256) {
        return u8(c, 2);
    }

    function nAssets(bytes memory c) internal pure returns (uint256) {
        return u8(c, 3);
    }

    function nExprs(bytes memory c) internal pure returns (uint256) {
        return u16(c, 4);
    }

    function nSteps(bytes memory c) internal pure returns (uint256) {
        return u16(c, 6);
    }

    function coreLen(bytes memory c) internal pure returns (uint256) {
        return u32(c, 8);
    }

    function roleFlags(bytes memory c, uint256 r) internal pure returns (uint256) {
        return u8(c, HEADER + r);
    }

    function fieldKind(bytes memory c, uint256 f) internal pure returns (uint256) {
        return u8(c, HEADER + nRoles(c) + f);
    }

    function assetKind(bytes memory c, uint256 a) internal pure returns (uint256) {
        return u8(c, HEADER + nRoles(c) + nFields(c) + 2 * a);
    }

    function assetDecimals(bytes memory c, uint256 a) internal pure returns (uint256) {
        return u8(c, HEADER + nRoles(c) + nFields(c) + 2 * a + 1);
    }

    /// Offset of expression `e`'s program (its op count byte).
    function expr(bytes memory c, uint256 e) internal pure returns (uint256) {
        return u16(c, HEADER + nRoles(c) + nFields(c) + 2 * nAssets(c) + 2 * e);
    }

    function stepOffset(bytes memory c, uint256 i) internal pure returns (uint256) {
        return u16(c, HEADER + nRoles(c) + nFields(c) + 2 * nAssets(c) + 2 * nExprs(c) + 2 * i);
    }

    function step(bytes memory c, uint256 i) internal pure returns (Step memory s) {
        uint256 o = stepOffset(c, i);
        s.kind = u8(c, o);
        s.role = u8(c, o + 1);
        s.join = u8(c, o + 2);
        uint256 flags = u8(c, o + 3);
        s.guard = u16(c, o + 4);
        s.nCaptures = u8(c, o + 6);
        s.nOps = u8(c, o + 7);
        s.nNext = u8(c, o + 8);
        s.nSends = u8(c, o + 9);
        s.milestone = flags >> 4;
        uint256 p = o + STEP_FIXED;
        if (flags & 1 != 0) {
            s.timer = p;
            p += DUE;
        }
        if (flags & 2 != 0) {
            s.until = p;
            p += DUE;
        }
        s.captures = p;
        s.ops = p + CAPTURE * s.nCaptures;
        s.next = s.ops + OP * s.nOps;
        s.sends = s.next + EDGE * s.nNext;
    }

}
