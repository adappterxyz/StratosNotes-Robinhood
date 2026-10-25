// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// A testnet-only token (tUSD, tETH, tBTC, tTSLA…): no value, minted by its minters (the TokenFaucet, and the
/// owner for demo setup). Never deploy to a mainnet.
contract TestToken is ERC20, Ownable2Step {
    uint8 private immutable _decimals;
    mapping(address => bool) public minter;

    event MinterSet(address indexed account, bool allowed);

    error NotMinter(address caller);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address owner_)
        ERC20(name_, symbol_)
        Ownable(owner_)
    {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function setMinter(address account, bool allowed) external onlyOwner {
        minter[account] = allowed;
        emit MinterSet(account, allowed);
    }

    function mint(address to, uint256 amount) external {
        if (!minter[msg.sender] && msg.sender != owner()) revert NotMinter(msg.sender);
        _mint(to, amount);
    }
}
