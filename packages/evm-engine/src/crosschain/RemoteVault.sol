// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CrossChainMessages as M} from "./CrossChainMessages.sol";

/// @title RemoteVault
/// @notice On a chain that holds collateral (Robinhood Chain: its tokenized stocks), the asset stays here, locked,
///         while the note that uses it runs on its home chain (Arbitrum). Nothing is bridged.
///         - `lock`: the owner of the tokens locks them and a LOCKED message tells the home gateway, which mints
///           the same amount of receipts to the beneficiary there (who pledges them into a note as collateral).
///         - RELEASE from the home gateway: a receipt was burned there; pay the locked asset to the named account
///           here (the issuer when its collateral is released, or a holder after a default).
/// @dev Invariant: `locked[token]` >= the receipts outstanding at home + RELEASEs in flight, because receipts are
///      minted only after a lock and burned before a release. CRE checks `token.balanceOf(vault) >= locked[token]`
///      (a token that can be paused or clawed back by its issuer is the one way it can break) and reports a
///      shortfall. The owner configures tokens and the home gateway; it has no way to move locked tokens.
contract RemoteVault is CCIPReceiver, Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// @notice The CCIP chain selector of the notes' home chain.
    uint64 public immutable homeChainSelector;
    /// @notice The HomeGateway there: the only sender of RELEASE and the receiver of LOCKED.
    address public homeGateway;
    /// @notice Gas for the LOCKED execution at home.
    uint32 public lockGasLimit = 200_000;
    /// @notice Tokens that may be locked.
    mapping(address token => bool) public allowedToken;
    /// @notice Locked and not yet released, per token.
    mapping(address token => uint256) public locked;
    /// @notice Locks so far (also the nonce of the next lock id).
    uint256 public locks;
    /// @notice RELEASE ids already paid.
    mapping(bytes32 redeemId => bool) public released;
    /// @notice Releases that could not be paid out (the token refused the transfer, e.g. a frozen account): the
    ///         recipient claims them later, so a CCIP message never gets stuck.
    mapping(address account => mapping(address token => uint256)) public unclaimed;
    /// @notice Sum of `unclaimed` per token (still held here, no longer counted in `locked`).
    mapping(address token => uint256) public unclaimedTotal;

    event HomeGatewaySet(address gateway);
    event TokenAllowed(address indexed token, bool allowed);
    event LockGasLimitSet(uint32 gasLimit);
    event Locked(bytes32 indexed lockId, address indexed from, address indexed beneficiary, address token, uint256 amount, bytes32 messageId, uint256 fee);
    event Released(bytes32 indexed redeemId, address indexed to, address indexed token, uint256 amount, bytes32 messageId);
    event ReleaseUnclaimed(bytes32 indexed redeemId, address indexed to, address indexed token, uint256 amount);
    event Claimed(address indexed account, address indexed token, uint256 amount);
    event DuplicateRelease(bytes32 indexed redeemId, bytes32 messageId);

    error UnknownSender(uint64 chainSelector, address sender);
    error TokenNotAllowed(address token);
    error BadInputs();
    error WrongKind();
    error TransferMismatch();
    error OverRelease(address token, uint256 amount, uint256 locked);
    error FeeTooLow(uint256 fee);
    error RefundFailed();
    error NoGateway();

    constructor(address router, address owner_, uint64 homeChainSelector_) CCIPReceiver(router) Ownable(owner_) {
        if (homeChainSelector_ == 0) revert BadInputs();
        homeChainSelector = homeChainSelector_;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Configuration (owner)
    // ---------------------------------------------------------------------------------------------------------

    function setHomeGateway(address gateway) external onlyOwner {
        if (gateway == address(0)) revert BadInputs();
        homeGateway = gateway;
        emit HomeGatewaySet(gateway);
    }

    /// @notice Allow a token to be locked. Disallowing stops new locks only; releases of what is locked still pay.
    function setToken(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert BadInputs();
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function setLockGasLimit(uint32 gasLimit) external onlyOwner {
        if (gasLimit < 100_000) revert BadInputs();
        lockGasLimit = gasLimit;
        emit LockGasLimitSet(gasLimit);
    }

    /// @notice Stops new locks. Releases and claims keep working: holders can always get their asset.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Lock (outbound LOCKED)
    // ---------------------------------------------------------------------------------------------------------

    /// @notice The CCIP fee (native) for locking.
    function quoteLock(address token, uint256 amount, address beneficiary) external view returns (uint256) {
        return IRouterClient(getRouter()).getFee(homeChainSelector, _lockMessage(bytes32(0), token, amount, beneficiary));
    }

    /// @notice Lock `amount` of `token` (approve this vault first); `beneficiary` receives the receipts on the home
    ///         chain (the same EVM address usually). Pay the CCIP fee in `msg.value`; the excess is refunded.
    function lock(address token, uint256 amount, address beneficiary)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (bytes32 lockId, bytes32 messageId)
    {
        if (!allowedToken[token]) revert TokenNotAllowed(token);
        if (amount == 0 || beneficiary == address(0)) revert BadInputs();
        if (homeGateway == address(0)) revert NoGateway();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        // Exact amounts only: a fee-on-transfer token would mint receipts the vault cannot back.
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert TransferMismatch();
        locked[token] += amount;
        lockId = keccak256(abi.encode(block.chainid, address(this), ++locks));
        Client.EVM2AnyMessage memory m = _lockMessage(lockId, token, amount, beneficiary);
        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(homeChainSelector, m);
        if (msg.value < fee) revert FeeTooLow(fee);
        messageId = router.ccipSend{value: fee}(homeChainSelector, m);
        emit Locked(lockId, msg.sender, beneficiary, token, amount, messageId, fee);
        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }

    function _lockMessage(bytes32 lockId, address token, uint256 amount, address beneficiary)
        internal
        view
        returns (Client.EVM2AnyMessage memory)
    {
        return M.message(homeGateway, M.encode(M.LOCKED, lockId, beneficiary, token, amount), lockGasLimit);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Release (inbound RELEASE)
    // ---------------------------------------------------------------------------------------------------------

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override nonReentrant {
        address sender = abi.decode(message.sender, (address));
        if (message.sourceChainSelector != homeChainSelector || sender != homeGateway || sender == address(0)) {
            revert UnknownSender(message.sourceChainSelector, sender);
        }
        (uint8 kind, bytes32 redeemId, address to, address token, uint256 amount) = M.decode(message.data);
        if (kind != M.RELEASE) revert WrongKind();
        if (released[redeemId]) {
            emit DuplicateRelease(redeemId, message.messageId);
            return;
        }
        uint256 held = locked[token];
        // Cannot happen while the invariant holds; reverting keeps the message for a manual execution.
        if (amount > held) revert OverRelease(token, amount, held);
        released[redeemId] = true;
        locked[token] = held - amount;
        if (_tryTransfer(token, to, amount)) {
            emit Released(redeemId, to, token, amount, message.messageId);
        } else {
            unclaimed[to][token] += amount;
            unclaimedTotal[token] += amount;
            emit ReleaseUnclaimed(redeemId, to, token, amount);
        }
    }

    /// @notice Collect a release the token refused at the time (e.g. while the account was frozen).
    function claim(address token) external nonReentrant {
        uint256 amount = unclaimed[msg.sender][token];
        if (amount == 0) revert BadInputs();
        unclaimed[msg.sender][token] = 0;
        unclaimedTotal[token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, token, amount);
    }

    /// @notice Balance minus what the vault owes (locked + unclaimed). Positive: tokens sent here by mistake.
    ///         Negative: the token took some back (paused, frozen or clawed back); CRE reports it as a shortfall.
    function surplus(address token) external view returns (int256) {
        return int256(IERC20(token).balanceOf(address(this))) - int256(locked[token] + unclaimedTotal[token]);
    }

    /// @dev A transfer that reverts or returns false does not revert the release.
    function _tryTransfer(address token, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (ret.length == 0 || abi.decode(ret, (bool))) && token.code.length > 0;
    }
}
