// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {IAny2EVMMessageReceiver} from "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

/// A CCIP router per simulated chain, all in one EVM: `ccipSend` queues the message; the test decides when (and in
/// which order, and how often) it is delivered by the destination chain's router. That makes latency, reordering,
/// duplicates and forged senders testable; the Chainlink Local simulators cover the real routers (CrossChainFork).
contract MockCCIPRouter is IRouterClient {
    struct Sent {
        uint64 dest;
        address sender;
        address receiver;
        bytes data;
        bytes32 messageId;
        bool delivered;
    }

    uint64 public immutable selector;
    uint256 public fee;
    Sent[] public sent;
    mapping(uint64 => MockCCIPRouter) public peers;
    uint256 private nonce;

    constructor(uint64 selector_, uint256 fee_) {
        selector = selector_;
        fee = fee_;
    }

    function connect(MockCCIPRouter peer) external {
        peers[peer.selector()] = peer;
    }

    function isChainSupported(uint64 dest) external view returns (bool) {
        return address(peers[dest]) != address(0);
    }

    function getFee(uint64, Client.EVM2AnyMessage memory) external view returns (uint256) {
        return fee;
    }

    function ccipSend(uint64 dest, Client.EVM2AnyMessage calldata message) external payable returns (bytes32 id) {
        if (address(peers[dest]) == address(0)) revert UnsupportedDestinationChain(dest);
        if (msg.value < fee) revert InsufficientFeeTokenAmount();
        id = keccak256(abi.encode(selector, ++nonce));
        sent.push(Sent(dest, msg.sender, abi.decode(message.receiver, (address)), message.data, id, false));
    }

    function count() external view returns (uint256) {
        return sent.length;
    }

    /// Deliver message `i` on its destination chain (again, if `i` was delivered already: a replay).
    function deliver(uint256 i) public {
        Sent storage s = sent[i];
        s.delivered = true;
        peers[s.dest].execute(selector, s.sender, s.receiver, s.data, s.messageId);
    }

    /// Deliver every queued message, in order.
    function deliverAll() external {
        for (uint256 i = 0; i < sent.length; i++) if (!sent[i].delivered) deliver(i);
    }

    /// Run a message on this (destination) chain as the router: what a CCIP off-ramp does.
    function execute(uint64 source, address sender, address receiver, bytes memory data, bytes32 messageId) public {
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: messageId,
            sourceChainSelector: source,
            sender: abi.encode(sender),
            data: data,
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
        IAny2EVMMessageReceiver(receiver).ccipReceive(m);
    }
}
