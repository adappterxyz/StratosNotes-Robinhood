// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Test token: anyone can mint (USDC and the deliverable tokens in tests only).
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory symbol_, uint8 decimals_) ERC20(symbol_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// A token that keeps 1% of every transfer: the engine must refuse it.
contract FeeOnTransferERC20 is ERC20 {
    constructor() ERC20("FEE", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xdead), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// A stablecoin-style token with an issuer who can freeze accounts and take tokens back (as Paxos USDG and
/// tokenized-stock issuers can): a frozen recipient makes transfers to it revert.
contract FreezableERC20 is ERC20 {
    uint8 private immutable _decimals;
    mapping(address => bool) public frozen;

    constructor(string memory symbol_, uint8 decimals_) ERC20(symbol_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function freeze(address who, bool yes) external {
        frozen[who] = yes;
    }

    /// The issuer seizes tokens (e.g. a court order): the holder's balance drops without its consent.
    function seize(address from, uint256 amount) external {
        _burn(from, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!frozen[from] && !frozen[to], "frozen");
        super._update(from, to, value);
    }
}
