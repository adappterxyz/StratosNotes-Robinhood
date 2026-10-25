// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// The engine side of a note token: user transfers ask it first (verified recipient, transferable phase) and it
/// settles both holders' payouts before the balances move.
interface INoteEngine {
    function beforeNoteTransfer(uint256 pid, uint256 asset, address from, address to, uint256 amount) external;
}

/// @title NoteToken - one note's units as a standard ERC-20
/// @notice Deployed per note (an EIP-1167 clone of one implementation) by the FlowEngine when the note starts.
///         Balances live here, in standard ERC-20 storage, so wallets and explorers read the token directly. Only
///         the engine mints and burns (subscriptions, the issuer's unsold units, redemptions) and moves units the
///         workflow moves (DvP).
///
///         A holder's own transfer (transfer / transferFrom / permit + transferFrom) first calls the engine:
///         the recipient must have a verified email (when the engine requires one) and the note must still be
///         transferable (running, units not retired). The engine settles both sides' payouts before the move, so
///         every coupon, redemption, delivery and default payout goes to whoever held the units at that payment.
///
///         Decimals: 6. The engine's ledger is 10-decimal fixed point; one token base unit is 1e4 of it, and the
///         engine only mints, burns or moves whole token base units, so the mapping is exact.
///
///         The current holders (non-zero balances) are enumerable (`holderCount` / `holderAt`) so the engine can
///         push payouts to wallets in bounded batches.
contract NoteToken {
    uint8 public constant decimals = 6;

    INoteEngine public engine;
    uint256 public pid;
    uint8 public asset;
    string public name;
    string public symbol;
    /// Set when the note redeems (or otherwise retires its units): balances then read zero and nothing moves.
    bool public retired;
    uint256 internal _supply;
    mapping(address => uint256) internal _bal;
    mapping(address => mapping(address => uint256)) public allowance;
    /// EIP-2612 permit nonces.
    mapping(address => uint256) public nonces;

    address[] internal _holders;
    mapping(address => uint256) internal _slot; // 1-based index in _holders; 0 = not a holder

    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    /// The units were redeemed: every balance now reads zero (the engine keeps the payouts they earned).
    event Retired();

    error AlreadyInitialized();
    error OnlyEngine();
    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroAddress();
    error PermitExpired();
    error PermitInvalid();

    /// @notice Set up a fresh clone (once). Called by the engine in the same transaction that creates it.
    function initialize(address engine_, uint256 pid_, uint8 asset_, string calldata name_, string calldata symbol_) external {
        if (address(engine) != address(0)) revert AlreadyInitialized();
        if (engine_ == address(0)) revert ZeroAddress();
        engine = INoteEngine(engine_);
        pid = pid_;
        asset = asset_;
        name = name_;
        symbol = symbol_;
    }

    modifier onlyEngine() {
        if (msg.sender != address(engine)) revert OnlyEngine();
        _;
    }

    // ---- ERC-20 ------------------------------------------------------------------------------------------------

    function totalSupply() external view returns (uint256) {
        return retired ? 0 : _supply;
    }

    function balanceOf(address who) external view returns (uint256) {
        return retired ? 0 : _bal[who];
    }

    /// @notice Units `who` held, retired or not: what the engine's payouts are computed on.
    function heldOf(address who) external view returns (uint256) {
        return _bal[who];
    }

    /// @notice The supply, retired or not.
    function supplyHeld() external view returns (uint256) {
        return _supply;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _userMove(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = a - value;
        }
        _userMove(from, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    /// @notice EIP-2612: approve by signature.
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        if (block.timestamp > deadline) revert PermitExpired();
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", DOMAIN_SEPARATOR(), keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))
            )
        );
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, v, r, s);
        if (err != ECDSA.RecoverError.NoError || signer != owner || owner == address(0)) revert PermitInvalid();
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    // forge-lint: disable-next-line(mixed-case-function) EIP-2612 name
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256("1"), block.chainid, address(this)));
    }

    // ---- Holders -----------------------------------------------------------------------------------------------

    /// @notice How many addresses hold units now.
    function holderCount() external view returns (uint256) {
        return _holders.length;
    }

    /// @notice The i-th current holder (order changes as holders come and go).
    function holderAt(uint256 i) external view returns (address) {
        return _holders[i];
    }

    /// @notice Holders [start, start + count), clipped to the end.
    function holders(uint256 start, uint256 count) external view returns (address[] memory out) {
        uint256 n = _holders.length;
        if (start >= n) return new address[](0);
        uint256 end = count >= n - start ? n : start + count;
        out = new address[](end - start);
        for (uint256 i = start; i < end; i++) out[i - start] = _holders[i];
    }

    // ---- Engine ------------------------------------------------------------------------------------------------

    function engineMint(address to, uint256 value) external onlyEngine {
        if (to == address(0)) revert ZeroAddress();
        _supply += value;
        _setBalance(to, _bal[to] + value);
        emit Transfer(address(0), to, value);
    }

    function engineBurn(address from, uint256 value) external onlyEngine {
        uint256 b = _bal[from];
        if (b < value) revert InsufficientBalance();
        _supply -= value;
        _setBalance(from, b - value);
        emit Transfer(from, address(0), value);
    }

    /// A move the workflow makes (e.g. units to an investor against stablecoins): the engine has already applied
    /// its own checks and settled both sides.
    function engineMove(address from, address to, uint256 value) external onlyEngine {
        _move(from, to, value);
    }

    /// The note redeemed: its units stop counting as balances (one write, however many holders).
    function engineRetire() external onlyEngine {
        if (retired) return;
        retired = true;
        emit Retired();
    }

    // ---- Internals ---------------------------------------------------------------------------------------------

    function _userMove(address from, address to, uint256 value) internal {
        if (to == address(0)) revert ZeroAddress();
        if (retired || _bal[from] < value) revert InsufficientBalance();
        // The engine checks the recipient and the note's phase, and settles both holders' payouts first.
        engine.beforeNoteTransfer(pid, asset, from, to, value);
        _move(from, to, value);
    }

    function _move(address from, address to, uint256 value) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 b = _bal[from];
        if (b < value) revert InsufficientBalance();
        if (from != to) {
            _setBalance(from, b - value);
            _setBalance(to, _bal[to] + value);
        }
        emit Transfer(from, to, value);
    }

    function _setBalance(address who, uint256 value) internal {
        _bal[who] = value;
        uint256 slot = _slot[who];
        if (value != 0 && slot == 0) {
            _holders.push(who);
            _slot[who] = _holders.length;
        } else if (value == 0 && slot != 0) {
            address last = _holders[_holders.length - 1];
            _holders[slot - 1] = last;
            _slot[last] = slot;
            _holders.pop();
            _slot[who] = 0;
        }
    }
}
