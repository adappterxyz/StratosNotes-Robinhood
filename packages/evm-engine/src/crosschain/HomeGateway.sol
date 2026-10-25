// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CreReceiver} from "../cre/CreReceiver.sol";
import {IReceiver} from "../cre/IReceiver.sol";
import {CrossChainMessages as M} from "./CrossChainMessages.sol";
import {IReleaseQueue, RemoteReceipt} from "./RemoteReceipt.sol";

/// @title HomeGateway (v2)
/// @notice Sits next to the FlowEngine on a note's home chain (Robinhood Chain) and connects it, over Chainlink CCIP,
///         to RemoteVaults on other chains where collateral stays locked (planned; any CCIP chain is a configuration
///         change: deploy a vault there, then `setRemote` and `registerReceipt` here).
///         Principle: collateral stays on its own chain; the home chain is only the anchor that decides who gets it.
///         - LOCKED from an allow-listed vault: mint RemoteReceipts to the locker (once per lock id).
///         - Auto-release (v2): receipts leaving the engine (a holder's payout after a default, the issuer's
///           collateral at maturity, any withdraw or push) are burned by the receipt and QUEUED here as a RELEASE
///           to the same account (or the release address it set) on the asset chain. `flush` sends queued
///           releases, paying the CCIP fees from this contract's native-ETH fee pool; anyone may call it, and a
///           Chainlink CRE report (onReport through the KeystoneForwarder) does it automatically. `sendQueued`
///           sends one queued release with the caller paying the fee, so no release ever depends on the pool.
///         - `redeem`: burn receipts held in a wallet (a locker's receipts never pledged) and send RELEASE.
///         The engine is not changed: receipts are ordinary collateral assets to it, so pledging, coverage and
///         margin, release at maturity and the default rule all run on the engine's tested paths.
/// @dev Trust: a LOCKED message is accepted only from the vault configured for its source chain selector, and
///      only through the CCIP router (CCIPReceiver.onlyRouter). A queue entry is accepted only from a receipt this
///      gateway created. Each queued release is sent at most once (`sent`), and its id is checked again by the
///      vault (`released`), so a CCIP retry or a manual execution cannot pay twice. Pause stops outbound messages
///      (redeem, flush, sendQueued), never inbound locks nor queueing: the engine's transfers keep working and
///      every queued release is still there after unpause. The owner configures peers and may withdraw the fee
///      pool; nothing here can move a receipt or the locked asset on anyone's behalf.
contract HomeGateway is CCIPReceiver, CreReceiver, ReentrancyGuard, Pausable, IReleaseQueue {
    struct Remote {
        address vault; // the RemoteVault on that chain (0 = not allowed)
        uint32 gasLimit; // gas for the RELEASE execution on that chain
    }

    struct ReceiptInfo {
        uint64 chainSelector;
        address remoteToken;
    }

    /// @notice A queued RELEASE. Two storage slots, so queueing stays cheap inside the engine's push gas cap.
    struct Release {
        address receipt;
        bool sent;
        address to; // recipient on the asset chain
        uint96 amount; // base units of the locked token
    }

    uint256 public constant VERSION = 2;
    /// @notice CRE report kind: flush up to `maxItems` queued releases from the fee pool.
    uint8 public constant REPORT_FLUSH = 1;
    /// @notice Most releases one flush sends (each is one CCIP message, ~100-200k gas on the source chain).
    uint256 public constant MAX_FLUSH = 25;

    /// @notice The engine the receipts may move into and out of.
    address public immutable engine;
    /// @notice Allow-listed vault per remote chain selector.
    mapping(uint64 chainSelector => Remote) public remotes;
    /// @notice The receipt for a locked token on a remote chain.
    mapping(uint64 chainSelector => mapping(address remoteToken => address receipt)) public receiptOf;
    /// @notice What a receipt stands for.
    mapping(address receipt => ReceiptInfo) public receiptInfo;
    /// @notice Lock ids already credited (CCIP delivers at most once; this also covers a replayed manual execution).
    mapping(bytes32 lockId => bool) public credited;
    /// @notice Redemptions sent so far (also the nonce of the next redeem id).
    uint256 public redemptions;

    /// @notice Queued releases, 1-based: index `i` has the id `releaseId(i)`.
    mapping(uint256 index => Release) public releases;
    /// @notice Releases queued so far (the last index).
    uint256 public releasesQueued;
    /// @notice Releases sent so far (by flush or sendQueued).
    uint256 public releasesSent;
    /// @notice Where `flush` starts: every index below it is sent.
    uint256 public releaseHead = 1;
    /// @notice The unsent release a new one for the same (receipt, recipient) adds to (0 = none): dust
    ///         withdrawals between two flushes cost the fee pool one message, not one each.
    mapping(address receipt => mapping(address to => uint256 index)) public openRelease;
    /// @notice Where an account's releases are paid on the asset chains (0 = the same address). For a smart
    ///         wallet that does not exist at the same address on the asset chain.
    mapping(address account => address dest) public releaseAddress;

    event RemoteSet(uint64 indexed chainSelector, address vault, uint32 gasLimit);
    event ReceiptRegistered(uint64 indexed chainSelector, address indexed remoteToken, address receipt);
    /// @notice A remote lock arrived and its receipts were minted.
    event LockCredited(
        bytes32 indexed lockId, uint64 indexed chainSelector, address indexed account, address receipt, uint256 amount, bytes32 messageId
    );
    /// @notice A lock id arrived again and was ignored.
    event DuplicateLock(bytes32 indexed lockId, bytes32 messageId);
    /// @notice Receipts were burned and a RELEASE sent to the vault.
    event RedeemSent(
        bytes32 indexed redeemId, uint64 indexed chainSelector, address indexed from, address to, address receipt, uint256 amount, bytes32 messageId, uint256 fee
    );
    /// @notice Receipts left the engine to `account` and were burned; `added` joined release `index` (now `amount`).
    event ReleaseQueued(
        uint256 indexed index, bytes32 indexed releaseId, address indexed account, address receipt, address to, uint256 added, uint256 amount
    );
    /// @notice A queued release went out over CCIP (`fromPool`: the fee came from the pool, else from `msg.sender`).
    event ReleaseSent(
        uint256 indexed index, bytes32 indexed releaseId, address indexed to, address receipt, uint256 amount, bytes32 messageId, uint256 fee, bool fromPool
    );
    /// @notice A flush stopped at `index`: the pool holds less than its fee, or its chain has no vault. It stays queued.
    event FlushStalled(uint256 indexed index, uint256 fee, uint256 pool);
    event FeesFunded(address indexed from, uint256 amount);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event ReleaseAddressSet(address indexed account, address dest);

    error UnknownSender(uint64 chainSelector, address sender);
    error UnknownReceipt();
    error UnknownToken(uint64 chainSelector, address remoteToken);
    error AlreadyRegistered();
    error WrongKind();
    error BadInputs();
    error FeeTooLow(uint256 fee);
    error RefundFailed();
    error NotQueued(uint256 index);
    error AmountTooLarge();

    constructor(address router, address owner_, address engine_, address forwarder)
        CCIPReceiver(router)
        CreReceiver(owner_, forwarder)
    {
        if (engine_ == address(0)) revert BadInputs();
        engine = engine_;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Configuration (owner)
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Allow (or, with vault = 0, remove) the vault on a remote chain.
    function setRemote(uint64 chainSelector, address vault, uint32 gasLimit) external onlyOwner {
        if (chainSelector == 0 || (vault != address(0) && gasLimit < 50_000)) revert BadInputs();
        remotes[chainSelector] = Remote(vault, gasLimit);
        emit RemoteSet(chainSelector, vault, gasLimit);
    }

    /// @notice Create the receipt for `remoteToken` locked on `chainSelector` (same decimals as that token).
    function registerReceipt(uint64 chainSelector, address remoteToken, uint8 decimals_, string calldata name_, string calldata symbol_)
        external
        onlyOwner
        returns (address receipt)
    {
        if (chainSelector == 0 || remoteToken == address(0) || decimals_ > 18) revert BadInputs();
        if (receiptOf[chainSelector][remoteToken] != address(0)) revert AlreadyRegistered();
        receipt = address(new RemoteReceipt(name_, symbol_, decimals_, engine, chainSelector, remoteToken));
        receiptOf[chainSelector][remoteToken] = receipt;
        receiptInfo[receipt] = ReceiptInfo(chainSelector, remoteToken);
        emit ReceiptRegistered(chainSelector, remoteToken, receipt);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Take ETH out of the fee pool (e.g. moving it to a successor gateway).
    function withdrawFees(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert BadInputs();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert RefundFailed();
        emit FeesWithdrawn(to, amount);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Inbound: LOCKED
    // ---------------------------------------------------------------------------------------------------------

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override nonReentrant {
        Remote memory r = remotes[message.sourceChainSelector];
        address sender = abi.decode(message.sender, (address));
        if (r.vault == address(0) || sender != r.vault) revert UnknownSender(message.sourceChainSelector, sender);
        (uint8 kind, bytes32 lockId, address account, address remoteToken, uint256 amount) = M.decode(message.data);
        if (kind != M.LOCKED) revert WrongKind();
        if (credited[lockId]) {
            emit DuplicateLock(lockId, message.messageId);
            return; // succeed without effect, so a replay is marked done rather than retried
        }
        address receipt = receiptOf[message.sourceChainSelector][remoteToken];
        // Reverting leaves the message executable: register the receipt, then execute it manually.
        if (receipt == address(0)) revert UnknownToken(message.sourceChainSelector, remoteToken);
        credited[lockId] = true;
        RemoteReceipt(receipt).mint(account, amount);
        emit LockCredited(lockId, message.sourceChainSelector, account, receipt, amount, message.messageId);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Outbound: RELEASE of wallet receipts (direct redeem)
    // ---------------------------------------------------------------------------------------------------------

    /// @notice The CCIP fee (native) for redeeming `amount` of `receipt` to `to` on its chain (also the fee of a
    ///         queued release of that size).
    function quoteRedeem(address receipt, uint256 amount, address to) public view returns (uint256) {
        (uint64 chainSelector, Client.EVM2AnyMessage memory m) = _releaseMessage(receipt, bytes32(0), amount, to);
        return IRouterClient(getRouter()).getFee(chainSelector, m);
    }

    /// @notice Burn `amount` of your receipts and have the vault pay the locked asset to `to` on its chain.
    ///         For receipts a locker holds and never pledged (receipts paid out of a note are released
    ///         automatically). Pay the CCIP fee in `msg.value` (see `quoteRedeem`); the excess is refunded.
    function redeem(address receipt, uint256 amount, address to) external payable nonReentrant whenNotPaused returns (bytes32 messageId) {
        if (amount == 0 || to == address(0)) revert BadInputs();
        bytes32 redeemId = keccak256(abi.encode(block.chainid, address(this), ++redemptions));
        (uint64 chainSelector, Client.EVM2AnyMessage memory m) = _releaseMessage(receipt, redeemId, amount, to);
        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(chainSelector, m);
        if (msg.value < fee) revert FeeTooLow(fee);
        RemoteReceipt(receipt).burnFrom(msg.sender, amount);
        messageId = router.ccipSend{value: fee}(chainSelector, m);
        emit RedeemSent(redeemId, chainSelector, msg.sender, to, receipt, amount, messageId, fee);
        _refund(msg.value - fee);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Outbound: the auto-release queue
    // ---------------------------------------------------------------------------------------------------------

    /// @notice The vault-side id of queued release `index` (distinct from every redeem id: a different preimage).
    function releaseId(uint256 index) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), "release", index));
    }

    /// @notice Pay your releases to `dest` on the asset chains instead of your own address (0: your own address
    ///         again). Applies to releases queued from now on.
    function setReleaseAddress(address dest) external {
        releaseAddress[msg.sender] = dest;
        emit ReleaseAddressSet(msg.sender, dest);
    }

    /// @inheritdoc IReleaseQueue
    /// @dev Called by a receipt in the transaction that burned `amount` leaving the engine to `account`. Cheap and
    ///      revert-free for a registered receipt (it runs inside the engine's capped push transfer): no external
    ///      call, two fresh storage slots, or one updated slot when it joins an open release.
    function queueRelease(address account, uint256 amount) external {
        if (receiptInfo[msg.sender].remoteToken == address(0)) revert UnknownReceipt();
        address dest = releaseAddress[account];
        if (dest == address(0)) dest = account;
        uint256 index = openRelease[msg.sender][dest];
        uint256 total;
        if (index != 0) {
            Release storage q = releases[index];
            total = uint256(q.amount) + amount;
            if (total > type(uint96).max) index = 0; // too large to join: a release of its own
            else q.amount = uint96(total);
        }
        if (index == 0) {
            if (amount > type(uint96).max) revert AmountTooLarge();
            index = ++releasesQueued;
            releases[index] = Release(msg.sender, false, dest, uint96(amount));
            openRelease[msg.sender][dest] = index;
            total = amount;
        }
        emit ReleaseQueued(index, releaseId(index), account, msg.sender, dest, amount, total);
    }

    /// @notice Releases waiting, the queue's window, the fee pool and the fee of the next release to send (what a
    ///         keeper reads before it flushes; nextFee is 0 when nothing is waiting or its chain has no vault).
    function releaseQueue() external view returns (uint256 pending, uint256 head, uint256 queued, uint256 pool, uint256 nextFee) {
        pending = releasesQueued - releasesSent;
        queued = releasesQueued;
        pool = address(this).balance;
        head = releaseHead;
        while (head <= queued && releases[head].sent) head++;
        if (head <= queued) {
            Release memory q = releases[head];
            if (remotes[receiptInfo[q.receipt].chainSelector].vault != address(0)) nextFee = quoteRedeem(q.receipt, q.amount, q.to);
        }
    }

    /// @notice Fund the fee pool that pays CCIP fees for queued releases (anyone: the issuer at pledge, the protocol).
    function fundFees() external payable {
        emit FeesFunded(msg.sender, msg.value);
    }

    receive() external payable {
        emit FeesFunded(msg.sender, msg.value);
    }

    /// @notice Anyone: send up to `maxItems` queued releases, oldest first, paying the CCIP fees from the pool.
    ///         Stops (FlushStalled) at a release the pool cannot pay for or whose chain has no vault: it stays
    ///         queued for the next flush. Returns how many were sent.
    function flush(uint256 maxItems) external nonReentrant whenNotPaused returns (uint256 sent) {
        return _flush(maxItems);
    }

    /// @notice Anyone: send queued release `index` now, paying its CCIP fee in `msg.value` (excess refunded).
    ///         A holder never has to wait for the pool or the queue order.
    function sendQueued(uint256 index) external payable nonReentrant whenNotPaused returns (bytes32 messageId) {
        Release storage q = releases[index];
        if (q.receipt == address(0) || q.sent) revert NotQueued(index);
        (uint64 chainSelector, Client.EVM2AnyMessage memory m) = _releaseMessage(q.receipt, releaseId(index), q.amount, q.to);
        uint256 fee = IRouterClient(getRouter()).getFee(chainSelector, m);
        if (msg.value < fee) revert FeeTooLow(fee);
        messageId = _send(index, q, chainSelector, m, fee, false);
        _refund(msg.value - fee);
    }

    function _flush(uint256 maxItems) internal returns (uint256 sent) {
        if (maxItems > MAX_FLUSH) maxItems = MAX_FLUSH;
        uint256 i = releaseHead;
        uint256 last = releasesQueued;
        IRouterClient router = IRouterClient(getRouter());
        while (i <= last) {
            Release storage q = releases[i];
            if (q.sent) {
                i++; // sent out of order with sendQueued
                continue;
            }
            if (sent == maxItems) break;
            uint64 chainSelector = receiptInfo[q.receipt].chainSelector;
            if (remotes[chainSelector].vault == address(0)) {
                emit FlushStalled(i, 0, address(this).balance);
                break;
            }
            (, Client.EVM2AnyMessage memory m) = _releaseMessage(q.receipt, releaseId(i), q.amount, q.to);
            uint256 fee = router.getFee(chainSelector, m);
            if (fee > address(this).balance) {
                emit FlushStalled(i, fee, address(this).balance);
                break;
            }
            _send(i, q, chainSelector, m, fee, true);
            sent++;
            i++;
        }
        releaseHead = i;
    }

    function _send(uint256 index, Release storage q, uint64 chainSelector, Client.EVM2AnyMessage memory m, uint256 fee, bool fromPool)
        internal
        returns (bytes32 messageId)
    {
        q.sent = true;
        releasesSent++;
        if (openRelease[q.receipt][q.to] == index) delete openRelease[q.receipt][q.to];
        messageId = IRouterClient(getRouter()).ccipSend{value: fee}(chainSelector, m);
        emit ReleaseSent(index, releaseId(index), q.to, q.receipt, q.amount, messageId, fee, fromPool);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Chainlink CRE: flush on a DON-signed report
    // ---------------------------------------------------------------------------------------------------------

    /// @dev report = abi.encode(uint8 kind, uint256 maxItems), kind = REPORT_FLUSH. Never reverts on an empty
    ///      queue, an empty pool or a pause (nothing to do is not an error; a revert would only make CRE retry).
    function _processReport(bytes calldata report) internal override nonReentrant {
        (uint8 kind, uint256 maxItems) = abi.decode(report, (uint8, uint256));
        if (kind != REPORT_FLUSH) revert WrongKind();
        if (paused()) return;
        _flush(maxItems);
    }

    function supportsInterface(bytes4 interfaceId) public pure override(CCIPReceiver, CreReceiver) returns (bool) {
        return CCIPReceiver.supportsInterface(interfaceId) || interfaceId == type(IReceiver).interfaceId;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------------------

    function _refund(uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert RefundFailed();
    }

    function _releaseMessage(address receipt, bytes32 redeemId, uint256 amount, address to)
        internal
        view
        returns (uint64 chainSelector, Client.EVM2AnyMessage memory m)
    {
        ReceiptInfo memory info = receiptInfo[receipt];
        if (info.remoteToken == address(0)) revert UnknownReceipt();
        Remote memory r = remotes[info.chainSelector];
        if (r.vault == address(0)) revert UnknownSender(info.chainSelector, address(0));
        chainSelector = info.chainSelector;
        m = M.message(r.vault, M.encode(M.RELEASE, redeemId, to, info.remoteToken, amount), r.gasLimit);
    }
}
