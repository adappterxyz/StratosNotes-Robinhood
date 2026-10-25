// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice What a receipt needs from its gateway: queue the release of receipts that just left the engine.
interface IReleaseQueue {
    function queueRelease(address account, uint256 amount) external;
}

/// @title RemoteReceipt (v2)
/// @notice On a note's home chain, a claim on collateral that stays locked in a RemoteVault on another chain
///         (e.g. TSLA on Robinhood Chain). One receipt contract per (remote chain, remote token).
///         The FlowEngine treats it as any other collateral ERC-20: pledged into escrow, valued with the
///         underlying's Chainlink price and haircut, released to the issuer or paid out to holders on a default,
///         all by the engine's own (tested) rules.
///         v2: receipts never rest in a wallet after the note. Whenever the engine sends receipts to an account
///         (a holder's withdraw or claim after a default, a push, the issuer's collateral coming back at maturity),
///         they are burned in that same transaction and the gateway queues a RELEASE of the same amount to that
///         account on the asset chain, where the vault pays the real token. Collateral stays on its own chain;
///         the home chain is only the anchor that decides who gets it.
///         Receipts minted to a locker and not pledged yet are ordinary: the locker pledges them into a note, or
///         redeems them directly at the gateway (HomeGateway.redeem).
/// @dev Not a bridge: receipts are minted only by the gateway for a CCIP-verified lock, burned only by the
///      gateway (redeem) or on leaving the engine (auto-release), and can move only into the engine. Between
///      people they do not move, so no market forms in a wrapped copy of the asset.
///      Gas: the whole transfer out of the engine, burn and queue included, costs at most ~102k (a new release,
///      all cold; ~9.5k when it joins an open release), under the engine's 150k per-transfer cap for pushed
///      payouts (test_autoRelease_gasFitsThePushCap).
contract RemoteReceipt is ERC20 {
    /// @notice The HomeGateway: the only minter and burner, and the release queue.
    address public immutable gateway;
    /// @notice The FlowEngine: the only counterparty a transfer may have.
    address public immutable engine;
    /// @notice The CCIP chain selector of the chain where the collateral is locked.
    uint64 public immutable remoteChainSelector;
    /// @notice The locked token on that chain.
    address public immutable remoteToken;
    uint8 private immutable _decimals;

    error OnlyGateway();
    /// @notice Receipts move only into the engine (out of it, they are released on the asset chain).
    error ReceiptNotTransferable();

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address engine_,
        uint64 remoteChainSelector_,
        address remoteToken_
    ) ERC20(name_, symbol_) {
        gateway = msg.sender;
        engine = engine_;
        remoteChainSelector = remoteChainSelector_;
        remoteToken = remoteToken_;
        _decimals = decimals_;
    }

    modifier onlyGateway() {
        if (msg.sender != gateway) revert OnlyGateway();
        _;
    }

    /// @notice Same decimals as the locked token, so one receipt base unit is one locked base unit.
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mint receipts for a lock the gateway verified over CCIP.
    function mint(address to, uint256 amount) external onlyGateway {
        _mint(to, amount);
    }

    /// @notice Burn receipts being redeemed for the locked asset (the gateway calls this for the holder).
    function burnFrom(address from, uint256 amount) external onlyGateway {
        _burn(from, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == engine && to != address(0) && to != engine) {
            // The gateway never holds receipts (it burns them itself): sending it some could only strand them.
            if (to == gateway) revert ReceiptNotTransferable();
            // Leaving the engine: burned here, released to the same account on the asset chain.
            super._update(from, address(0), value);
            IReleaseQueue(gateway).queueRelease(to, value);
            return;
        }
        // Mint (from 0) and burn (to 0) pass; any other transfer must go into the engine.
        if (from != address(0) && to != address(0) && to != engine) revert ReceiptNotTransferable();
        super._update(from, to, value);
    }
}
