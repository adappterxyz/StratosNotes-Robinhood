// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IReceiver} from "./IReceiver.sol";

/// @title CreReceiver - Chainlink CRE report receiver
/// @notice Chainlink's ReceiverTemplate (CRE consumer-contract guide, section 3.2), unchanged in behaviour,
///         except that ownership is two-step (Ownable2Step) and the constructor takes the initial owner.
/// @dev Only the configured KeystoneForwarder may call onReport. The optional workflow ID, author and name
///      checks stay off for `cre workflow simulate --broadcast`: the MockKeystoneForwarder sends no metadata.
///      Production `KeystoneForwarder` passes 64 bytes of metadata (62 bytes of identity + bytes2 reportId);
///      _decodeMetadata reads only the first 62.
abstract contract CreReceiver is IReceiver, Ownable2Step {
    address private s_forwarderAddress;
    address private s_expectedAuthor;
    bytes10 private s_expectedWorkflowName;
    bytes32 private s_expectedWorkflowId;

    bytes private constant HEX_CHARS = "0123456789abcdef";

    error InvalidForwarderAddress();
    error InvalidSender(address sender, address expected);
    error InvalidAuthor(address received, address expected);
    error InvalidWorkflowName(bytes10 received, bytes10 expected);
    error InvalidWorkflowId(bytes32 received, bytes32 expected);
    error WorkflowNameRequiresAuthorValidation();
    error InvalidMetadata();

    event ForwarderAddressUpdated(address indexed previousForwarder, address indexed newForwarder);
    event ExpectedAuthorUpdated(address indexed previousAuthor, address indexed newAuthor);
    event ExpectedWorkflowNameUpdated(bytes10 indexed previousName, bytes10 indexed newName);
    event ExpectedWorkflowIdUpdated(bytes32 indexed previousId, bytes32 indexed newId);
    event SecurityWarning(string message);

    constructor(address initialOwner, address forwarder) Ownable(initialOwner) {
        if (forwarder == address(0)) revert InvalidForwarderAddress();
        s_forwarderAddress = forwarder;
        emit ForwarderAddressUpdated(address(0), forwarder);
    }

    /// @notice The KeystoneForwarder allowed to call onReport (zero would accept anyone: see setForwarderAddress).
    function getForwarderAddress() external view returns (address) {
        return s_forwarderAddress;
    }

    function getExpectedAuthor() external view returns (address) {
        return s_expectedAuthor;
    }

    function getExpectedWorkflowName() external view returns (bytes10) {
        return s_expectedWorkflowName;
    }

    function getExpectedWorkflowId() external view returns (bytes32) {
        return s_expectedWorkflowId;
    }

    /// @inheritdoc IReceiver
    /// @dev Called by the forwarder with the DON-signed report. When an expected workflow id, author or name is
    ///      configured, the metadata must carry exactly that identity.
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (s_forwarderAddress != address(0) && msg.sender != s_forwarderAddress) {
            revert InvalidSender(msg.sender, s_forwarderAddress);
        }
        if (s_expectedWorkflowId != bytes32(0) || s_expectedAuthor != address(0) || s_expectedWorkflowName != bytes10(0)) {
            // The identity is 62 bytes; shorter metadata would be read past its end.
            if (metadata.length < 62) revert InvalidMetadata();
            (bytes32 workflowId, bytes10 workflowName, address workflowOwner) = _decodeMetadata(metadata);
            if (s_expectedWorkflowId != bytes32(0) && workflowId != s_expectedWorkflowId) {
                revert InvalidWorkflowId(workflowId, s_expectedWorkflowId);
            }
            if (s_expectedAuthor != address(0) && workflowOwner != s_expectedAuthor) {
                revert InvalidAuthor(workflowOwner, s_expectedAuthor);
            }
            // Workflow names are unique per owner only (and truncated to 40 bits): require the author too.
            if (s_expectedWorkflowName != bytes10(0)) {
                if (s_expectedAuthor == address(0)) revert WorkflowNameRequiresAuthorValidation();
                if (workflowName != s_expectedWorkflowName) {
                    revert InvalidWorkflowName(workflowName, s_expectedWorkflowName);
                }
            }
        }
        _processReport(report);
    }

    /// @dev WARNING: address(0) disables forwarder validation (anyone could call onReport).
    function setForwarderAddress(address forwarder) external onlyOwner {
        address previous = s_forwarderAddress;
        if (forwarder == address(0)) emit SecurityWarning("Forwarder address set to zero - contract is now INSECURE");
        s_forwarderAddress = forwarder;
        emit ForwarderAddressUpdated(previous, forwarder);
    }

    /// @notice Only accept reports from workflows owned by `author` (zero: any author).
    function setExpectedAuthor(address author) external onlyOwner {
        address previous = s_expectedAuthor;
        s_expectedAuthor = author;
        emit ExpectedAuthorUpdated(previous, author);
    }

    /// @notice The name is hashed as the CRE engine does: sha256 -> hex -> first 10 chars.
    function setExpectedWorkflowName(string calldata name) external onlyOwner {
        bytes10 previous = s_expectedWorkflowName;
        if (bytes(name).length == 0) {
            s_expectedWorkflowName = bytes10(0);
            emit ExpectedWorkflowNameUpdated(previous, bytes10(0));
            return;
        }
        bytes32 hash = sha256(bytes(name));
        bytes memory hexString = _bytesToHexString(abi.encodePacked(hash));
        bytes memory first10 = new bytes(10);
        for (uint256 i = 0; i < 10; i++) {
            first10[i] = hexString[i];
        }
        // forge-lint: disable-next-line(unsafe-typecast) exactly 10 bytes
        s_expectedWorkflowName = bytes10(first10);
        emit ExpectedWorkflowNameUpdated(previous, s_expectedWorkflowName);
    }

    /// @notice Only accept reports from the workflow with this id (zero: any).
    function setExpectedWorkflowId(bytes32 id) external onlyOwner {
        bytes32 previous = s_expectedWorkflowId;
        s_expectedWorkflowId = id;
        emit ExpectedWorkflowIdUpdated(previous, id);
    }

    function _bytesToHexString(bytes memory data) private pure returns (bytes memory) {
        bytes memory hexString = new bytes(data.length * 2);
        for (uint256 i = 0; i < data.length; i++) {
            // forge-lint: disable-next-line(unsafe-typecast) a nibble
            hexString[i * 2] = HEX_CHARS[uint8(data[i] >> 4)];
            hexString[i * 2 + 1] = HEX_CHARS[uint8(data[i] & 0x0f)];
        }
        return hexString;
    }

    /// @dev metadata = abi.encodePacked(workflowId bytes32, workflowName bytes10, workflowOwner address)[, reportId bytes2]
    function _decodeMetadata(bytes memory metadata)
        internal
        pure
        returns (bytes32 workflowId, bytes10 workflowName, address workflowOwner)
    {
        assembly ("memory-safe") {
            workflowId := mload(add(metadata, 32))
            workflowName := mload(add(metadata, 64))
            workflowOwner := shr(mul(12, 8), mload(add(metadata, 74)))
        }
        return (workflowId, workflowName, workflowOwner);
    }

    function _processReport(bytes calldata report) internal virtual;

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
