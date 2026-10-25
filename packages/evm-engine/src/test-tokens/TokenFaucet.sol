// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {TestToken} from "./TestToken.sol";

/// Testnet faucet: anyone can claim a fixed amount of each listed test token, once per cooldown per token. The
/// caller pays the gas, so the faucet holds no ETH. Never deploy to a mainnet.
contract TokenFaucet is Ownable2Step {
    struct Drip {
        uint256 amount; // base units per claim; 0 = not listed
        uint64 cooldown; // seconds between claims by one account
    }

    mapping(address => Drip) public drips;
    mapping(address => mapping(address => uint256)) public lastClaim; // token => account => timestamp
    address[] public tokens;

    event DripSet(address indexed token, uint256 amount, uint64 cooldown);
    event Claimed(address indexed token, address indexed to, uint256 amount);

    error NotListed(address token);
    error TooSoon(address token, uint256 nextAt);

    constructor(address owner_) Ownable(owner_) {}

    function setDrip(address token, uint256 amount, uint64 cooldown) external onlyOwner {
        if (drips[token].amount == 0 && amount != 0) tokens.push(token);
        drips[token] = Drip(amount, cooldown);
        emit DripSet(token, amount, cooldown);
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    /// When `account` may next claim `token` (0: now).
    function nextClaimAt(address token, address account) public view returns (uint256) {
        uint256 last = lastClaim[token][account];
        if (last == 0) return 0;
        uint256 at = last + drips[token].cooldown;
        return at > block.timestamp ? at : 0;
    }

    function claim(address token) external {
        Drip memory d = drips[token];
        if (d.amount == 0) revert NotListed(token);
        uint256 next = nextClaimAt(token, msg.sender);
        if (next != 0) revert TooSoon(token, next);
        lastClaim[token][msg.sender] = block.timestamp;
        TestToken(token).mint(msg.sender, d.amount);
        emit Claimed(token, msg.sender, d.amount);
    }
}
