// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Def} from "./Def.sol";

/// @title DefCheck - validates a workflow definition's CORE once, when it is registered
/// @notice A separate, linked library (its code is not part of FlowEngine's 24 KiB): registration is rare, every
///         other call reads definitions that already passed it. After `check`, reads by offset stay inside CORE
///         and point at real roles, fields, assets, expressions and steps (Def.sol).
library DefCheck {
    function check(bytes memory c, uint256 maxRoles, uint256 maxFields, uint256 maxAssets) public pure {
        uint256 len = c.length;
        if (len < Def.HEADER || Def.u8(c, 0) != Def.VERSION || Def.coreLen(c) != len) revert Def.BadDefinition();
        uint256 roles = Def.nRoles(c);
        uint256 fields = Def.nFields(c);
        uint256 assets = Def.nAssets(c);
        uint256 exprs = Def.nExprs(c);
        uint256 steps = Def.nSteps(c);
        if (roles == 0 || roles > maxRoles || fields > maxFields || assets > maxAssets) revert Def.BadDefinition();
        if (steps == 0 || steps >= 0xFFFE) revert Def.BadDefinition(); // 0xFFFE/0xFFFF are report sentinels
        uint256 tables = Def.HEADER + roles + fields + 2 * assets + 2 * exprs + 2 * steps;
        if (tables > len) revert Def.BadDefinition();
        for (uint256 r = 0; r < roles; r++) {
            if (Def.roleFlags(c, r) > Def.R_ESCROW) revert Def.BadDefinition();
        }
        for (uint256 f = 0; f < fields; f++) {
            if (Def.fieldKind(c, f) > Def.F_BOOL) revert Def.BadDefinition();
        }
        for (uint256 a = 0; a < assets; a++) {
            if (Def.assetKind(c, a) > Def.A_CASH || Def.assetDecimals(c, a) > 36) revert Def.BadDefinition();
        }
        for (uint256 e = 0; e < exprs; e++) {
            uint256 o = Def.expr(c, e);
            if (o < tables || o + 1 > len) revert Def.BadDefinition();
            uint256 n = Def.u8(c, o);
            if (o + 1 + n * Def.EXPR_OP > len) revert Def.BadDefinition();
            for (uint256 k = 0; k < n; k++) {
                uint256 p = o + 1 + k * Def.EXPR_OP;
                uint256 code = Def.u8(c, p);
                uint256 fld = Def.u16(c, p + 1);
                if (code > Def.X_NOW || (code == 1 && fld >= fields)) revert Def.BadDefinition();
                if (code == Def.X_BALANCE && ((fld >> 8) >= roles || (fld & 0xFF) >= assets)) revert Def.BadDefinition();
            }
        }
        for (uint256 i = 0; i < steps; i++) {
            uint256 o = Def.stepOffset(c, i);
            if (o < tables || o + Def.STEP_FIXED > len) revert Def.BadDefinition();
            if (Def.u8(c, o + 3) & 0x0C != 0) revert Def.BadDefinition(); // flags: timer, until, milestone only
            Def.Step memory s = Def.step(c, i);
            if (s.sends + 2 * s.nSends > len) revert Def.BadDefinition();
            if (s.kind > Def.CATCH || s.role >= roles) revert Def.BadDefinition();
            if (Def.roleFlags(c, s.role) & Def.R_ESCROW != 0) revert Def.BadDefinition(); // nobody acts as escrow
            if (s.guard != Def.NO_EXPR && s.guard >= exprs) revert Def.BadDefinition();
            if (s.timer != 0) _checkDue(c, s.timer, fields);
            if (s.until != 0) _checkDue(c, s.until, fields);
            for (uint256 k = 0; k < s.nCaptures; k++) {
                uint256 p = s.captures + k * Def.CAPTURE;
                uint256 src = Def.u8(c, p + 2);
                if (Def.u16(c, p) >= fields || src > Def.SRC_EXPR) revert Def.BadDefinition();
                if (src == Def.SRC_EXPR && Def.u16(c, p + 3) >= exprs) revert Def.BadDefinition();
            }
            for (uint256 k = 0; k < s.nOps; k++) {
                uint256 p = s.ops + k * Def.OP;
                uint256 kind = Def.u8(c, p);
                if (kind > Def.OP_DISTRIBUTE) revert Def.BadDefinition();
                if (kind == Def.OP_NONE) continue;
                if (Def.u8(c, p + 1) >= assets || Def.u8(c, p + 2) >= roles || Def.u8(c, p + 3) >= roles) revert Def.BadDefinition();
                if (Def.u16(c, p + 4) >= exprs) revert Def.BadDefinition();
                if (kind == Def.OP_SWAP || kind == Def.OP_DISTRIBUTE) {
                    if (Def.u8(c, p + 6) >= assets) revert Def.BadDefinition();
                }
                if (kind == Def.OP_SWAP) {
                    if (Def.u8(c, p + 7) >= roles || Def.u8(c, p + 8) >= roles || Def.u16(c, p + 9) >= exprs) revert Def.BadDefinition();
                }
            }
            for (uint256 k = 0; k < s.nNext; k++) {
                uint256 p = s.next + k * Def.EDGE;
                uint256 cond = Def.u16(c, p + 2);
                if (Def.u16(c, p) >= steps || (cond != Def.NO_EXPR && cond >= exprs)) revert Def.BadDefinition();
            }
            for (uint256 k = 0; k < s.nSends; k++) {
                if (Def.u16(c, s.sends + 2 * k) >= steps) revert Def.BadDefinition();
            }
        }
    }

    function _checkDue(bytes memory c, uint256 o, uint256 fields) private pure {
        uint256 kind = Def.u8(c, o);
        if (kind > 1 || (kind == 1 && Def.u16(c, o + 9) >= fields)) revert Def.BadDefinition();
    }
}
