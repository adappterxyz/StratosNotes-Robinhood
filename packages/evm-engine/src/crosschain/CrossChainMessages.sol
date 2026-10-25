// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

/// @title CrossChainMessages
/// @notice The two CCIP payloads between a note's home chain (the engine) and a chain that holds its collateral.
///         Both are `abi.encode(uint8 kind, bytes32 id, address account, address remoteToken, uint256 amount)`:
///         - LOCKED  (vault -> home):  `account` locked `amount` of `remoteToken` in the vault; mint the receipt.
///         - RELEASE (home -> vault):  a receipt was burned at home; pay `amount` of `remoteToken` to `account`.
///         `id` is unique per message source (the vault's lock nonce, the gateway's redeem nonce) and makes each
///         message apply at most once, whatever CCIP retries or a manual execution do.
library CrossChainMessages {
    uint8 internal constant LOCKED = 1;
    uint8 internal constant RELEASE = 2;

    error BadMessage();

    function encode(uint8 kind, bytes32 id, address account, address remoteToken, uint256 amount)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(kind, id, account, remoteToken, amount);
    }

    function decode(bytes memory data)
        internal
        pure
        returns (uint8 kind, bytes32 id, address account, address remoteToken, uint256 amount)
    {
        if (data.length != 160) revert BadMessage();
        (kind, id, account, remoteToken, amount) = abi.decode(data, (uint8, bytes32, address, address, uint256));
        if (account == address(0) || remoteToken == address(0) || amount == 0) revert BadMessage();
    }

    /// @notice A data-only CCIP message (no token transfer) paid in the native gas token.
    function message(address receiver, bytes memory data, uint256 gasLimit)
        internal
        pure
        returns (Client.EVM2AnyMessage memory)
    {
        return Client.EVM2AnyMessage({
            receiver: abi.encode(receiver),
            data: data,
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: address(0),
            // Out-of-order execution: every message is independent (its own id), so one stuck message never
            // blocks the next lock or redemption.
            extraArgs: Client._argsToBytes(Client.GenericExtraArgsV2({gasLimit: gasLimit, allowOutOfOrderExecution: true}))
        });
    }
}
