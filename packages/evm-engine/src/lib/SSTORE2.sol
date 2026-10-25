// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Immutable byte storage in contract code: one CREATE per blob, read back with EXTCODECOPY
///         (200 gas/byte once, then ~3 gas/word to read, against 20,000 gas per 32-byte storage slot).
/// @dev The pointer's runtime code is 0x00 (STOP, so it can never be called) followed by the data.
library SSTORE2 {
    error WriteFailed();
    error TooLarge();

    /// EIP-170: runtime code is at most 24,576 bytes, one of which is the STOP prefix.
    uint256 internal constant MAX_DATA = 24_575;

    function write(bytes memory data) internal returns (address pointer) {
        if (data.length > MAX_DATA) revert TooLarge();
        // Creation code (14 bytes): PUSH4 len+1, DUP1, PUSH1 14, PUSH1 0, CODECOPY, PUSH1 0, RETURN
        bytes memory creation = abi.encodePacked(
            hex"63", uint32(data.length + 1), hex"80600e6000396000f3", hex"00", data
        );
        assembly ("memory-safe") {
            pointer := create(0, add(creation, 32), mload(creation))
        }
        if (pointer == address(0)) revert WriteFailed();
    }

    function read(address pointer, uint256 length) internal view returns (bytes memory data) {
        data = new bytes(length);
        assembly ("memory-safe") {
            extcodecopy(pointer, add(data, 32), 1, length)
        }
    }
}
