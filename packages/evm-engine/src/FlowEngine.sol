// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CreReceiver} from "./cre/CreReceiver.sol";
import {Def} from "./lib/Def.sol";
import {DefCheck} from "./lib/DefCheck.sol";
import {EmailAttest} from "./lib/EmailAttest.sol";
import {SSTORE2} from "./lib/SSTORE2.sol";
import {Units} from "./lib/Units.sol";
import {INoteEngine, NoteToken} from "./NoteToken.sol";

/// @title FlowEngine - runs compiled BPMN workflows (structured notes) on an EVM chain
/// @notice A workflow (e.g. a note's Issuer / Paying Agent / Investor collaboration) is compiled off-chain
///         (packages/core), registered once under the sha256 of its bytes, and run by any number of processes
///         (one per issuance). People act through `executeStep`; Chainlink CRE delivers oracle observations as
///         DON-signed reports through the KeystoneForwarder (`onReport`); everything else runs straight through.
///
///         Semantics are those of the hackathon's Solana engine (StratosNotes solana/programs/flow_engine):
///         a token multiset over step indexes; XOR gateways on fixed-point predicates (min/max included); AND
///         fork/join; timers on fixed times or date fields; repeatable windows (an open book) that close at a
///         date; captures from inputs, oracle reports (bounds-checked) or expressions; and holdings: each note's
///         units are an ERC-20 (NoteToken, created at startProcess), cash sits in a ledger backed by ERC-20
///         vaults, with atomic DvP, distribute-to-every-holder and transfers (lib/Units.sol).
///
///         Payouts scale with nothing: a distribution is one accumulator update (O(1) in the number of holders);
///         holders' shares settle whenever their units move, when they withdraw, or when anyone pushes the payout
///         to their wallets in bounded batches (`pushNext`, `pushPayouts`, `pushTo`). Every payment is logged with
///         a receipt id (PayoutPaid) and every distribution with a commitment hash (docs/ERC20-NOTES.md).
///
///         Escrow: a role the definition marks escrow is held by the engine itself (ESCROW, an address nobody
///         has a key for). Pledged collateral and funded payments sit on its account: nobody can withdraw them
///         or move them; only the workflow's own operations do (pay holders, distribute on default, release).
///         Expressions read accounts (`balance(role, asset)`) and the time (`now`), so a workflow can check that
///         a payment is funded or that collateral covers the note, and wait on a deadline.
///
/// @dev Events (the indexer's whole input; together they rebuild every process from the log alone):
///      - DefinitionRegistered(id, creator, pointer, meta): a workflow; `meta` is the names/term-sheet JSON.
///      - ProcessStarted(pid, definition, creator, ref, roles, assetTokens): a run and who holds each role.
///      - StepRun(pid, step, kind, actor): a step completed (actor = 0 for straight-through and reports).
///      - FieldSet(pid, field, tag, value): a field captured (tag 1 number, 2 text, 3 party).
///      - HoldingChanged(pid, asset, owner, balance): a balance after every change: cash on the ledger, or a
///        holder's units (the note token's balance x 1e4), including holders' own token transfers.
///      - NoteTokenCreated(pid, asset, token): the ERC-20 of a note's units.
///      - DistributionRecorded / PayoutPaid / PayoutDeferred / DistributionSettled: payouts and their receipts.
///      - TokensUpdated(pid, status, stepsRun, tokens): the live BPMN tokens after each transaction.
///      - Deposited / Withdrawn(pid, asset, account, base): ERC-20 into and out of the process vault.
///      - UnitsTransferred(pid, asset, from, to, amount): a holder moved units (also shows as HoldingChanged).
///      - ReportProcessed(pid, step, values, reporter): a report applied; `reporter` is the KeystoneForwarder
///        (Chainlink CRE) or the fallback reporter (a signed keeper, for chains without CRE).
///      - Milestone(pid, code, step, actor): a step the workflow marks as a business event completed:
///        1 collateral pledged, 2 collateral released, 3 funding deposited, 4 margin call, 5 margin call cured,
///        6 payment made, 7 payment missed, 8 defaulted (packages/core types.ts MILESTONES).
///      - FallbackReporterUpdated(previous, next): the owner changed the fallback reporter (0 = off).
///      - ProcessCompleted(pid): no tokens left.
///
///      Caps (each bounds a loop): MAX_ROLES 8, MAX_FIELDS 64, MAX_ASSETS 8, MAX_TOKENS 32 live tokens,
///      MAX_ADVANCE 256 straight-through steps per transaction, MAX_DEPOSITS 4 ERC-20 pulls per step. Holders
///      are not capped: payouts never loop over them on-chain except in a push batch whose size the caller picks.
///
///      Cross-chain (CCIP) is not in v1: report step 0xFFFE is reserved for CRE payout decisions (Phase 5).
contract FlowEngine is CreReceiver, ReentrancyGuard, Pausable, INoteEngine {

    // ---------------------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------------------

    int256 public constant SCALE = 1e10; // fixed point: 10 decimals (Daml's Decimal)
    uint256 public constant MAX_ROLES = 8;
    uint256 public constant MAX_FIELDS = 64;
    uint256 public constant MAX_ASSETS = 8;
    uint256 public constant MAX_TOKENS = 32;
    uint256 public constant MAX_ADVANCE = 256;
    uint256 public constant MAX_DEPOSITS = 4;
    uint16 public constant STEP_ADVANCE = 0xFFFF; // report: just run what is due
    uint16 public constant STEP_PAYOUT = 0xFFFE; // report: reserved for cross-chain payouts
    uint16 public constant NO_CHOICE = 0xFFFF;
    /// The escrow account: held by the engine for each note (no key exists for this address).
    address public constant ESCROW = address(uint160(uint256(keccak256("stratosnotes.flowengine.escrow"))));

    uint8 public constant RUNNING = 0;
    uint8 public constant COMPLETED = 1;

    uint8 internal constant TAG_NUMBER = 1;
    uint8 internal constant TAG_TEXT = 2;
    uint8 internal constant TAG_PARTY = 3;

    // ---------------------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------------------

    /// A step input: tag 1 number (int256, fixed point or plain integer), 2 text (bytes32, left-aligned UTF-8),
    /// 3 party (address, right-aligned).
    struct Input {
        uint8 tag;
        bytes32 data;
    }

    struct Definition {
        address pointer; // SSTORE2 pointer to CORE
        uint32 coreLen;
        address creator;
    }

    struct Proc {
        bytes32 definition;
        address creator;
        uint8 status;
        uint8 nTokens;
        uint32 stepsRun;
        uint40 createdAt;
        uint64 ref; // the creator's own reference (e.g. an issuance number)
        uint40 updatedAt;
        uint128 tags; // 2 bits per field: 0 unset, 1 number, 2 text, 3 party
    }

    /// One transaction's working state: the definition CORE and the process's hot fields, in memory.
    struct Run {
        uint256 pid;
        bytes core;
        uint256[] tokens; // capacity MAX_TOKENS
        uint256 nTokens;
        uint256 tags;
        uint256 status;
        uint256 stepsRun;
        address signer; // 0: a report or straight-through processing
        Input[] inputs;
        int256[] oracle;
        uint256 choice;
        uint256[] depAsset; // capacity MAX_DEPOSITS
        uint256[] depBase;
        uint256 nDeps;
        uint256 step; // the step running now
    }

    // ---------------------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------------------

    mapping(bytes32 => Definition) internal _defs;
    uint256 public processCount;
    mapping(uint256 => Proc) internal _procs;
    mapping(uint256 => uint256[2]) internal _tokenWords; // 32 x uint16, packed
    mapping(uint256 => mapping(uint256 => address)) internal _roles;
    mapping(uint256 => mapping(uint256 => bytes32)) internal _values;
    /// Cash ledger, vaults, note tokens and payout accumulators (lib/Units.sol).
    Units.Book internal _book;
    /// The NoteToken every note's units clone (EIP-1167).
    address public immutable noteImplementation;
    /// Verified emails, bound as a salted hash (EmailAttest): attested by `verifier`, required when `requireEmail`.
    mapping(address => EmailAttest.Email) internal _emails;

    // ---------------------------------------------------------------------------------------------------------
    // Events and errors
    // ---------------------------------------------------------------------------------------------------------

    /// @notice A workflow was registered: `pointer` holds its CORE (SSTORE2), `meta` is its names/term-sheet JSON.
    event DefinitionRegistered(bytes32 indexed id, address indexed creator, address pointer, bytes meta);
    /// @notice A run started; `roles` are as held (escrow roles = ESCROW, open roles = 0).
    event ProcessStarted(
        uint256 indexed pid, bytes32 indexed definition, address indexed creator, uint64 ref, address[] roles, address[] assetTokens
    );
    /// @notice A step completed (`actor` 0 for straight-through steps and reports).
    event StepRun(uint256 indexed pid, uint16 indexed step, uint8 kind, address actor);
    /// @notice A field was captured (tag 1 number, 2 text, 3 party).
    event FieldSet(uint256 indexed pid, uint16 indexed field, uint8 tag, bytes32 value);
    /// @notice A ledger balance after a change.
    event HoldingChanged(uint256 indexed pid, uint8 indexed asset, address indexed owner, int256 balance);
    /// @notice The live BPMN tokens after a transaction.
    event TokensUpdated(uint256 indexed pid, uint8 status, uint32 stepsRun, uint16[] tokens);
    /// @notice ERC-20 pulled into the process vault.
    event Deposited(uint256 indexed pid, uint8 indexed asset, address indexed from, uint256 base);
    /// @notice ERC-20 paid out of the process vault.
    event Withdrawn(uint256 indexed pid, uint8 indexed asset, address indexed to, uint256 base);
    /// @notice A holder moved issued units (through the engine or the note token).
    event UnitsTransferred(uint256 indexed pid, uint8 indexed asset, address indexed from, address to, int256 amount);
    /// Emitted by the Units library (delegatecall, so from this address); declared here for the ABI.
    event NoteTokenCreated(uint256 indexed pid, uint8 indexed asset, address token);
    /// A payout: `asset` per unit of `holding` to every holder but the payer (`retire`: the units are redeemed
    /// with it and read zero from then on). distributionHash =
    /// keccak256(abi.encode(chainid, engine, pid, asset, period, perUnit, supplyAtPayment)).
    event DistributionRecorded(
        uint256 indexed pid,
        uint8 indexed asset,
        uint64 indexed period,
        uint8 holding,
        uint16 step,
        address payer,
        int256 perUnit,
        int256 total,
        uint256 supplyAtPayment,
        bool retire,
        bytes32 distributionHash
    );
    /// A payout reached a wallet. payoutId = keccak256(abi.encode(chainid, engine, pid, asset, period, holder, amount)).
    event PayoutPaid(
        uint256 indexed pid, uint8 indexed asset, uint64 period, address indexed holder, uint256 amount, bytes32 payoutId
    );
    /// A pushed payment failed (or was too small to send): it stays claimable with `withdraw`.
    event PayoutDeferred(uint256 indexed pid, uint8 indexed asset, uint64 period, address indexed holder, uint256 amount);
    /// A push round reached the last holder: rollingHash = keccak chain of its payoutIds in push order.
    event DistributionSettled(
        uint256 indexed pid, uint8 indexed asset, uint64 indexed period, uint256 paidCount, uint256 paidTotal, bytes32 rollingHash
    );
    /// @notice A report was applied; `reporter` is the forwarder (CRE) or the fallback reporter.
    event ReportProcessed(uint256 indexed pid, uint16 indexed step, int256[] values, address reporter);
    /// @notice The owner changed the fallback reporter (0 = off).
    event FallbackReporterUpdated(address indexed previous, address indexed next);
    /// @notice A business event the workflow marks (see the codes in the contract's @dev).
    event Milestone(uint256 indexed pid, uint8 indexed code, uint16 step, address actor);
    /// @notice No tokens left: the run is over.
    event ProcessCompleted(uint256 indexed pid);
    /// Emitted by the EmailAttest library (delegatecall, so from this address); declared here for the ABI.
    event EmailAttested(address indexed holder, bytes32 emailHash, uint64 expiry);
    /// @notice A binding was removed by the verifier or the owner.
    event EmailRevoked(address indexed holder);
    /// @notice The owner changed the verifier or the requireEmail switch.
    event EmailPolicyUpdated(address verifier, bool requireEmail);

    error UnknownDefinition();
    error UnknownProcess();
    error DefinitionTooLarge();
    error BadInputs();
    error WrongStepKind();
    error WrongRole();
    error StepNotActive();
    error WindowClosed();
    error JoinNotReady();
    error NotDue();
    error GuardNotMet();
    error NoBranch();
    error ProcessFinished();
    error OracleOnlyViaReport();
    error OracleOutOfBounds();
    error FieldNotSet();
    error InsufficientBalance();
    error InexactUnits();
    error TooManyTokens();
    error TooManyDeposits();
    error NotCash();
    error NotTransferable();
    error BadToken();
    error BadExpression();
    error DivideByZero();
    error VaultShort();
    error TransferMismatch();
    error PayoutsNotSupported();
    /// requireEmail is on and the address has no current verified-email attestation.
    error IssuerEmailNotVerified(address issuer);
    error SubscriberEmailNotVerified(address subscriber);
    error RecipientEmailNotVerified(address recipient);

    constructor(address initialOwner, address forwarder) CreReceiver(initialOwner, forwarder) {
        noteImplementation = address(new NoteToken());
    }

    // ---------------------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Stop new processes, steps, deposits and transfers. Withdrawals and CRE reports keep working, so
    ///         holders can always exit and running notes keep their dates.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume new processes, steps, deposits and transfers.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice The fallback reporter: one address allowed to submit reports itself, for a chain where Chainlink
    ///         CRE cannot write (e.g. Robinhood Chain mainnet today). Off (zero) by default. Every report it
    ///         submits is recorded with its address in ReportProcessed, so a note shows which agent acted.
    address public fallbackReporter;

    /// @notice Set (or, with zero, turn off) the fallback reporter.
    function setFallbackReporter(address next) external onlyOwner {
        emit FallbackReporterUpdated(fallbackReporter, next);
        fallbackReporter = next;
    }

    /// @notice Verified emails (EmailAttest): `verifier` signs attestations (zero: none accepted); with
    ///         `requireEmail` on, issuing (startProcess), acting in an OPEN role (subscribing) and receiving units
    ///         (a note token transfer) need a current attestation. Reports, CRE and withdrawals never do: holders can
    ///         always exit.
    address public verifier;
    bool public requireEmail;

    /// @notice Set the attestation signer (zero: none accepted) and whether issuing, subscribing and receiving units
    ///         need a verified email.
    function setEmailPolicy(address verifier_, bool requireEmail_) external onlyOwner {
        verifier = verifier_;
        requireEmail = requireEmail_;
        emit EmailPolicyUpdated(verifier_, requireEmail_);
    }

    /// @notice Bind `holder` to a verified email: emailHash = keccak256(abi.encode(salt, email)), signed by the
    ///         verifier (EIP-712, see EmailAttest). Anyone may submit it. A newer attestation replaces the old one.
    function attestEmail(address holder, bytes32 emailHash, uint64 expiry, bytes calldata sig) external {
        EmailAttest.attest(_emails, verifier, holder, emailHash, expiry, sig);
    }

    /// @notice The verifier or the owner removes a binding (e.g. at the person's request).
    function revokeEmail(address holder) external {
        EmailAttest.revoke(_emails, verifier, owner(), holder);
    }

    /// @notice A holder's binding: the salted hash, until when it counts, and the nonce the next attestation signs.
    function emailOf(address holder) external view returns (bytes32 emailHash, uint64 verifiedUntil, uint64 nonce) {
        EmailAttest.Email storage e = _emails[holder];
        return (e.hash, e.verifiedUntil, e.nonce);
    }

    function _needEmail(address who, uint256 why) internal view {
        if (!requireEmail || _emails[who].verifiedUntil >= block.timestamp) return;
        if (why == 0) revert IssuerEmailNotVerified(who);
        if (why == 1) revert SubscriberEmailNotVerified(who);
        revert RecipientEmailNotVerified(who);
    }

    /// @notice Apply a report as the fallback reporter. Same payload and checks as `onReport`.
    function fallbackReport(bytes calldata report) external {
        if (msg.sender == address(0) || msg.sender != fallbackReporter) revert InvalidSender(msg.sender, fallbackReporter);
        _processReport(report);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Definitions
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Register a compiled workflow: `data` = CORE ‖ META (packages/core/src/compile-evm.ts).
    ///         Content-addressed: its id is sha256(data); registering the same bytes again returns the same id.
    function registerDefinition(bytes calldata data) external whenNotPaused returns (bytes32 id) {
        id = sha256(data);
        if (_defs[id].pointer != address(0)) return id;
        if (data.length < Def.HEADER) revert Def.BadDefinition();
        uint256 coreLen = uint256(uint32(bytes4(data[8:12])));
        if (coreLen > data.length || coreLen < Def.HEADER) revert Def.BadDefinition();
        if (coreLen > SSTORE2.MAX_DATA) revert DefinitionTooLarge();
        bytes memory core = data[:coreLen];
        DefCheck.check(core, MAX_ROLES, MAX_FIELDS, MAX_ASSETS);
        address pointer = SSTORE2.write(core);
        // forge-lint: disable-next-line(unsafe-typecast) bounded by Def.check (assets < 8, fields < 64, steps < 0xFFFE, kinds <= 7, core < 24,576) or a two's-complement store
        _defs[id] = Definition(pointer, uint32(coreLen), msg.sender);
        emit DefinitionRegistered(id, msg.sender, pointer, data[coreLen:]);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Processes
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Start a run of a definition. The caller must hold the start step's role.
    /// @param roles one address per role, in definition order; address(0) = an OPEN role anyone may act in.
    /// @param assetTokens one per asset: the ERC-20 behind a cash asset, address(0) for an issued asset.
    /// @param name the ERC-20 name of the note's units (e.g. "notes.markets ETH/BTC Phoenix 26-10")
    /// @param symbol their ERC-20 symbol (e.g. "nmETHBTC1")
    function startProcess(
        bytes32 definition,
        uint64 ref,
        address[] calldata roles,
        address[] calldata assetTokens,
        uint16 startStep,
        Input[] calldata inputs,
        string calldata name,
        string calldata symbol
    ) external nonReentrant whenNotPaused returns (uint256 pid) {
        Definition storage d = _defs[definition];
        if (d.pointer == address(0)) revert UnknownDefinition();
        bytes memory core = SSTORE2.read(d.pointer, d.coreLen);
        if (roles.length != Def.nRoles(core) || assetTokens.length != Def.nAssets(core)) revert BadInputs();
        if (startStep >= Def.nSteps(core)) revert BadInputs();
        Def.Step memory s = Def.step(core, startStep);
        if (s.kind != Def.START) revert WrongStepKind();
        if (roles[s.role] != msg.sender) revert WrongRole();
        _needEmail(msg.sender, 0);

        pid = ++processCount;
        uint256 layout = _layout(pid, core, assetTokens);
        // The roles as held: escrow roles are the engine's ESCROW (the event reports these, not the inputs).
        address[] memory held = roles;
        for (uint256 k = 0; k < roles.length; k++) {
            if (Def.roleFlags(core, k) & Def.R_ESCROW != 0) {
                if (roles[k] != address(0)) revert BadInputs(); // the engine holds escrow: nobody may claim it
                _roles[pid][k] = ESCROW;
                held[k] = ESCROW;
            } else if (roles[k] != address(0)) {
                _roles[pid][k] = roles[k];
            }
        }
        _procs[pid] = Proc({
            definition: definition,
            creator: msg.sender,
            status: RUNNING,
            nTokens: 0,
            stepsRun: 0,
            createdAt: uint40(block.timestamp),
            ref: ref,
            updatedAt: uint40(block.timestamp),
            tags: 0
        });
        emit ProcessStarted(pid, definition, msg.sender, ref, held, assetTokens);
        Units.setup(_book, pid, layout, noteImplementation, name, symbol); // NoteTokenCreated, after the start

        Run memory r = _newRun(pid, core, msg.sender, inputs, new int256[](0), NO_CHOICE);
        r.tokens[0] = startStep;
        r.nTokens = 1;
        _runStep(r, startStep);
        if (r.nDeps != 0) revert BadInputs(); // a start step takes no cash: the process has no vault yet
        _advance(r);
        _save(r);
    }

    /// Which assets are cash and which issued, and their decimals (Units.Book.layout); checks the tokens.
    function _layout(uint256 pid, bytes memory core, address[] calldata assetTokens) internal returns (uint256 layout) {
        for (uint256 a = 0; a < assetTokens.length; a++) {
            bool cash = Def.assetKind(core, a) == Def.A_CASH;
            if (cash ? assetTokens[a].code.length == 0 : assetTokens[a] != address(0)) revert BadToken();
            if (cash) _book.token[pid][a] = assetTokens[a];
            // forge-lint: disable-next-line(incorrect-shift) bit flags: 1 << a
            layout |= (cash ? uint256(1) << a : uint256(1) << (8 + a)) | (Def.assetDecimals(core, a) << (16 + 8 * a));
        }
    }

    /// @notice A role-holder runs a step: a user task, a decision, or a stuck service step. A step that
    ///         deposits cash pulls it from the caller (approve the engine first).
    /// @param choice for an unconditioned XOR gateway decided by a person: index into its outgoing flows.
    function executeStep(uint256 pid, uint16 step, uint16 choice, Input[] calldata inputs)
        external
        nonReentrant
        whenNotPaused
    {
        Run memory r = _load(pid, msg.sender, inputs, new int256[](0), choice);
        if (step >= Def.nSteps(r.core)) revert BadInputs();
        Def.Step memory s = Def.step(r.core, step);
        if (_needs(r.core, s, Def.SRC_ORACLE)) revert OracleOnlyViaReport();
        if (s.kind != Def.USER && s.kind != Def.SERVICE && s.kind != Def.XOR && s.kind != Def.RECEIVE && s.kind != Def.CATCH) {
            revert WrongStepKind();
        }
        address holder = _roles[pid][s.role];
        if (holder != msg.sender && holder != address(0)) revert WrongRole();
        if (holder == address(0)) _needEmail(msg.sender, 1); // acting in an OPEN role: e.g. subscribing
        _runStep(r, step);
        _advance(r);
        _save(r);
        // Interactions last: the cash the step committed to.
        for (uint256 k = 0; k < r.nDeps; k++) {
            Units.pull(_book, pid, r.depAsset[k], msg.sender, r.depBase[k]);
        }
    }

    /// @notice Anyone: run whatever can run now (e.g. a due timer, or a gateway after a top-up).
    function poke(uint256 pid) external nonReentrant whenNotPaused {
        Run memory r = _load(pid, address(0), new Input[](0), new int256[](0), NO_CHOICE);
        _advance(r);
        _save(r);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Ledger
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Put cash into a process on your own account (e.g. an issuer topping up coupons).
    /// @param base the amount in the token's base units, pulled from the caller (approve the engine first).
    function deposit(uint256 pid, uint8 asset, uint256 base) external nonReentrant whenNotPaused {
        Units.deposit(_book, pid, asset, msg.sender, base);
    }

    /// @notice Take your cash (payouts not pushed yet, delivered tokens, ...) out of a process. Works while paused.
    /// @param base the amount in the token's base units. It must convert exactly to the ledger's 10-decimal fixed
    ///        point: for a token with more than 10 decimals a smaller amount would otherwise debit nothing (or
    ///        less than it pays out) and drain other holders' share of the vault.
    function withdraw(uint256 pid, uint8 asset, uint256 base) external nonReentrant {
        Units.withdraw(_book, pid, asset, msg.sender, base);
    }

    /// @notice A note token asks before a holder's own transfer: the recipient must be verified (when
    ///         requireEmail) and the note running and not redeemed. Settles both holders' payouts first.
    function beforeNoteTransfer(uint256 pid, uint256 asset, address from, address to, uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        if (msg.sender != _book.note[pid][asset] || msg.sender == address(0)) revert BadToken();
        if (to == ESCROW || to == address(this)) revert BadInputs();
        if (_procs[pid].status != RUNNING) revert NotTransferable();
        _needEmail(to, 2);
        Units.beforeTransfer(_book, pid, asset, from, to, amount);
        // forge-lint: disable-next-line(unsafe-typecast) asset < 8; token amounts fit int256
        emit UnitsTransferred(pid, uint8(asset), from, to, int256(amount) * 1e4);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Payout push
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Anyone (a keeper, the issuer's bot): pay the latest distribution of cash asset `asset` to holders
    ///         [start, start + count) of the note token's holder set, straight to their wallets; start =
    ///         type(uint256).max continues from the round's cursor (push the next `count`). A failed payment stays
    ///         claimable (PayoutDeferred). Works while paused.
    /// @return left holders after the cursor still to push in this round (0: settled)
    function pushPayouts(uint256 pid, uint8 asset, uint256 start, uint256 count) external nonReentrant returns (uint256 left) {
        return Units.push(_book, pid, asset, start, count);
    }

    /// @notice Anyone: push to these addresses (their accruals plus payouts already on their account, e.g. a
    ///         holder who sold between a distribution and its push, or a deferred payment to retry).
    function pushTo(uint256 pid, uint8 asset, address[] calldata holders) external nonReentrant {
        Units.pushTo(_book, pid, asset, holders);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Chainlink CRE
    // ---------------------------------------------------------------------------------------------------------

    /// @dev report = abi.encode(uint256 pid, uint16 step, int256[] values): run `step` (a service step or timer
    ///      that captures oracle fields) with these values in capture order, then everything that follows.
    ///      step 0xFFFF only advances (due timers).
    function _processReport(bytes calldata report) internal override nonReentrant {
        (uint256 pid, uint16 step, int256[] memory values) = abi.decode(report, (uint256, uint16, int256[]));
        if (step == STEP_PAYOUT) revert PayoutsNotSupported();
        Run memory r = _load(pid, address(0), new Input[](0), values, NO_CHOICE);
        if (step != STEP_ADVANCE) {
            if (step >= Def.nSteps(r.core)) revert BadInputs();
            uint256 kind = Def.step(r.core, step).kind;
            if (kind != Def.SERVICE && kind != Def.CATCH) revert WrongStepKind();
            _runStep(r, step);
        }
        _advance(r);
        _save(r);
        emit ReportProcessed(pid, step, values, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Where a definition's CORE lives, its length and who registered it (zero pointer: unknown).
    function definitionOf(bytes32 id) external view returns (address pointer, uint32 coreLen, address creator) {
        Definition storage d = _defs[id];
        return (d.pointer, d.coreLen, d.creator);
    }

    /// @notice A registered definition's CORE bytes.
    function definitionCore(bytes32 id) external view returns (bytes memory) {
        Definition storage d = _defs[id];
        if (d.pointer == address(0)) revert UnknownDefinition();
        return SSTORE2.read(d.pointer, d.coreLen);
    }

    /// @notice A process's header: definition, creator, status, token count, steps run, times, tags.
    function processOf(uint256 pid) external view returns (Proc memory) {
        return _procs[pid];
    }

    /// @notice The live BPMN tokens (step indexes) of a process.
    function tokensOf(uint256 pid) external view returns (uint16[] memory out) {
        uint256 n = _procs[pid].nTokens;
        out = new uint16[](n);
        uint256[2] storage w = _tokenWords[pid];
        for (uint256 i = 0; i < n; i++) {
            out[i] = uint16(w[i / 16] >> ((i % 16) * 16));
        }
    }

    /// @notice Who holds a role (ESCROW for escrow roles, zero for an open role).
    function roleOf(uint256 pid, uint256 role) external view returns (address) {
        return _roles[pid][role];
    }

    /// @notice The ERC-20 behind an asset: the cash token, or the note token of an issued asset.
    function assetTokenOf(uint256 pid, uint256 asset) external view returns (address) {
        address t = _book.token[pid][asset];
        return t != address(0) ? t : _book.note[pid][asset];
    }

    /// @notice A captured field's value.
    /// @return tag 0 unset, 1 number, 2 text, 3 party
    function valueOf(uint256 pid, uint256 field) external view returns (uint8 tag, bytes32 data) {
        return (uint8((_procs[pid].tags >> (2 * field)) & 3), _values[pid][field]);
    }

    /// @notice A balance in 10-decimal fixed point: an issued asset's units (zero once redeemed), or cash on the
    ///         account plus payouts accrued to it and not settled yet (all withdrawable).
    function balanceOf(uint256 pid, address owner, uint256 asset) external view returns (int256) {
        return Units.balanceOf(_book, pid, owner, asset);
    }

    /// @notice Payouts accrued to `owner` in a cash asset and not settled to its account yet.
    function pendingOf(uint256 pid, address owner, uint256 asset) external view returns (int256) {
        return Units.pending(_book, pid, owner, asset);
    }

    /// @notice ERC-20 base units the engine holds for a process's cash asset.
    function vaultOf(uint256 pid, uint256 asset) external view returns (uint256) {
        return _book.vault[pid][asset];
    }

    // ---------------------------------------------------------------------------------------------------------
    // Run state
    // ---------------------------------------------------------------------------------------------------------

    function _core(uint256 pid) internal view returns (bytes memory) {
        bytes32 id = _procs[pid].definition;
        if (id == bytes32(0)) revert UnknownProcess();
        Definition storage d = _defs[id];
        return SSTORE2.read(d.pointer, d.coreLen);
    }

    function _newRun(uint256 pid, bytes memory core, address signer, Input[] memory inputs, int256[] memory oracle, uint256 choice)
        internal
        pure
        returns (Run memory r)
    {
        r.pid = pid;
        r.core = core;
        r.tokens = new uint256[](MAX_TOKENS);
        r.signer = signer;
        r.inputs = inputs;
        r.oracle = oracle;
        r.choice = choice;
        r.depAsset = new uint256[](MAX_DEPOSITS);
        r.depBase = new uint256[](MAX_DEPOSITS);
    }

    function _load(uint256 pid, address signer, Input[] memory inputs, int256[] memory oracle, uint256 choice)
        internal
        view
        returns (Run memory r)
    {
        r = _newRun(pid, _core(pid), signer, inputs, oracle, choice);
        Proc storage p = _procs[pid];
        r.nTokens = p.nTokens;
        r.tags = p.tags;
        r.status = p.status;
        r.stepsRun = p.stepsRun;
        uint256[2] storage w = _tokenWords[pid];
        uint256 w0 = w[0];
        uint256 w1 = r.nTokens > 16 ? w[1] : 0;
        for (uint256 i = 0; i < r.nTokens; i++) {
            r.tokens[i] = ((i < 16 ? w0 : w1) >> ((i % 16) * 16)) & 0xFFFF;
        }
    }

    function _save(Run memory r) internal {
        Proc storage p = _procs[r.pid];
        bool completedNow = p.status == RUNNING && r.status == COMPLETED;
        uint256 w0;
        uint256 w1;
        uint16[] memory toks = new uint16[](r.nTokens);
        for (uint256 i = 0; i < r.nTokens; i++) {
            toks[i] = uint16(r.tokens[i]);
            if (i < 16) w0 |= r.tokens[i] << (i * 16);
            else w1 |= r.tokens[i] << ((i - 16) * 16);
        }
        _tokenWords[r.pid][0] = w0;
        _tokenWords[r.pid][1] = w1;
        p.nTokens = uint8(r.nTokens);
        p.tags = uint128(r.tags);
        p.status = uint8(r.status);
        p.stepsRun = uint32(r.stepsRun);
        p.updatedAt = uint40(block.timestamp);
        emit TokensUpdated(r.pid, uint8(r.status), uint32(r.stepsRun), toks);
        if (completedNow) emit ProcessCompleted(r.pid);
    }

    // ---------------------------------------------------------------------------------------------------------
    // The state machine (exec.rs)
    // ---------------------------------------------------------------------------------------------------------

    function _tokenCount(Run memory r, uint256 i) internal pure returns (uint256 n) {
        for (uint256 k = 0; k < r.nTokens; k++) {
            if (r.tokens[k] == i) n++;
        }
    }

    /// Remove `n` (at least one) tokens of step `i`, first occurrences first, keeping the others' order.
    function _takeTokens(Run memory r, uint256 i, uint256 n) internal pure {
        if (n == 0) n = 1;
        if (_tokenCount(r, i) < n) revert StepNotActive();
        for (uint256 j = 0; j < n; j++) {
            uint256 k = 0;
            while (r.tokens[k] != i) k++;
            for (uint256 m = k; m + 1 < r.nTokens; m++) {
                r.tokens[m] = r.tokens[m + 1];
            }
            r.nTokens--;
        }
    }

    function _addToken(Run memory r, uint256 i) internal pure {
        if (r.nTokens >= MAX_TOKENS) revert TooManyTokens();
        r.tokens[r.nTokens++] = i;
    }

    function _tag(Run memory r, uint256 f) internal pure returns (uint256) {
        return (r.tags >> (2 * f)) & 3;
    }

    /// When a timed step becomes due: (false, _) while its date field is unset.
    function _due(Run memory r, uint256 o) internal view returns (bool set, int256 t) {
        if (Def.u8(r.core, o) == 0) return (true, Def.i64(r.core, o + 1));
        uint256 f = Def.u16(r.core, o + 9);
        if (_tag(r, f) == 0) return (false, 0);
        t = int256(uint256(_values[r.pid][f]));
        if (t < type(int64).min || t > type(int64).max) return (false, 0);
        return (true, t);
    }

    function _isDue(Run memory r, Def.Step memory s) internal view returns (bool) {
        if (s.timer == 0) return true;
        (bool set, int256 t) = _due(r, s.timer);
        return set && int256(block.timestamp) >= t;
    }

    function _windowOpen(Run memory r, uint256 until) internal view returns (bool) {
        (bool set, int256 t) = _due(r, until);
        return !set || int256(block.timestamp) < t;
    }

    function _needs(bytes memory core, Def.Step memory s, uint256 source) internal pure returns (bool) {
        for (uint256 k = 0; k < s.nCaptures; k++) {
            if (Def.u8(core, s.captures + k * Def.CAPTURE + 2) == source) return true;
        }
        return false;
    }

    function _hasDeposit(bytes memory core, Def.Step memory s) internal pure returns (bool) {
        for (uint256 k = 0; k < s.nOps; k++) {
            if (Def.u8(core, s.ops + k * Def.OP) == Def.OP_DEPOSIT) return true;
        }
        return false;
    }

    // ---- Expressions (expr.rs) --------------------------------------------------------------------------------

    function _mul(int256 a, int256 b) internal pure returns (int256) {
        return (a * b) / SCALE;
    }

    function _div(int256 a, int256 b) internal pure returns (int256) {
        if (b == 0) revert DivideByZero();
        return (a * SCALE) / b;
    }

    /// Evaluate expression `e` (RPN). ok = false when a referenced field is not set yet (callers wait).
    function _eval(Run memory r, uint256 e) internal view returns (bool ok, int256 v) {
        bytes memory c = r.core;
        uint256 o = Def.expr(c, e);
        uint256 n = Def.u8(c, o);
        int256[32] memory st;
        uint256 sp = 0;
        for (uint256 k = 0; k < n; k++) {
            uint256 p = o + 1 + k * Def.EXPR_OP;
            uint256 code = Def.u8(c, p);
            if (code == 0) {
                if (sp >= 32) revert BadExpression();
                st[sp++] = Def.i64(c, p + 3);
                continue;
            }
            if (code == Def.X_BALANCE || code == Def.X_NOW) {
                int256 x;
                if (code == Def.X_NOW) {
                    x = int256(block.timestamp) * SCALE;
                } else {
                    uint256 rf = Def.u16(c, p + 1);
                    address acct = _roles[r.pid][rf >> 8];
                    if (acct == address(0)) return (false, 0); // an open role has no single account
                    x = Units.balanceOf(_book, r.pid, acct, rf & 0xFF);
                }
                if (sp >= 32) revert BadExpression();
                st[sp++] = x;
                continue;
            }
            if (code == 1) {
                uint256 f = Def.u16(c, p + 1);
                uint256 tag = _tag(r, f);
                if (tag == 0) return (false, 0);
                uint256 kind = Def.fieldKind(c, f);
                int256 raw = int256(uint256(_values[r.pid][f]));
                if (kind == Def.F_DECIMAL) {} else if (kind == Def.F_INT || kind == Def.F_DATE || kind == Def.F_BOOL) {
                    raw = raw * SCALE;
                } else {
                    return (false, 0); // text and parties have no number
                }
                if (sp >= 32) revert BadExpression();
                st[sp++] = raw;
                continue;
            }
            if (code == 6 || code == 15) {
                if (sp < 1) revert BadExpression();
                int256 x = st[sp - 1];
                st[sp - 1] = code == 6 ? -x : (x == 0 ? SCALE : int256(0));
                continue;
            }
            if (sp < 2) revert BadExpression();
            int256 y = st[--sp];
            int256 a = st[sp - 1];
            int256 z;
            if (code == 2) z = a + y;
            else if (code == 3) z = a - y;
            else if (code == 4) z = _mul(a, y);
            else if (code == 5) z = _div(a, y);
            else if (code == 7) z = a < y ? SCALE : int256(0);
            else if (code == 8) z = a <= y ? SCALE : int256(0);
            else if (code == 9) z = a > y ? SCALE : int256(0);
            else if (code == 10) z = a >= y ? SCALE : int256(0);
            else if (code == 11) z = a == y ? SCALE : int256(0);
            else if (code == 12) z = a != y ? SCALE : int256(0);
            else if (code == 13) z = (a != 0 && y != 0) ? SCALE : int256(0);
            else if (code == 14) z = (a != 0 || y != 0) ? SCALE : int256(0);
            else if (code == 16) z = a < y ? a : y;
            else if (code == 17) z = a > y ? a : y;
            else revert BadExpression();
            st[sp - 1] = z;
        }
        if (sp != 1) revert BadExpression();
        return (true, st[0]);
    }

    function _holds(Run memory r, uint256 e) internal view returns (bool ok, bool yes) {
        (bool set, int256 v) = _eval(r, e);
        return (set, v != 0);
    }

    function _amount(Run memory r, uint256 e) internal view returns (int256 v) {
        bool ok;
        (ok, v) = _eval(r, e);
        if (!ok) revert FieldNotSet();
        if (v < 0) revert InsufficientBalance();
    }

    // ---- Gateways ---------------------------------------------------------------------------------------------

    function _conditioned(bytes memory c, Def.Step memory s) internal pure returns (bool) {
        for (uint256 k = 0; k < s.nNext; k++) {
            if (Def.u16(c, s.next + k * Def.EDGE + 2) != Def.NO_EXPR) return true;
        }
        return false;
    }

    /// The XOR branch to take, if it can be decided without a person.
    function _xorPick(Run memory r, Def.Step memory s) internal view returns (bool decided, uint256 k) {
        bytes memory c = r.core;
        if (!_conditioned(c, s)) return (s.nNext == 1, 0);
        for (k = 0; k < s.nNext; k++) {
            uint256 p = s.next + k * Def.EDGE;
            uint256 cond = Def.u16(c, p + 2);
            if (cond == Def.NO_EXPR || Def.u8(c, p + 4) != 0) continue;
            (bool ok, bool yes) = _holds(r, cond);
            if (!ok) return (false, 0); // a field is not set yet: wait
            if (yes) return (true, k);
        }
        for (k = 0; k < s.nNext; k++) {
            uint256 p = s.next + k * Def.EDGE;
            if (Def.u8(c, p + 4) != 0 || Def.u16(c, p + 2) == Def.NO_EXPR) return (true, k);
        }
        return (false, 0);
    }

    // ---- Ledger -----------------------------------------------------------------------------------------------

    /// The address acting as role `role`: its holder, or for an OPEN role the signer.
    function _roleKey(Run memory r, uint256 role) internal view returns (address k) {
        k = _roles[r.pid][role];
        if (k == address(0)) {
            if (r.signer == address(0)) revert WrongRole();
            k = r.signer;
        }
    }

    function _applyOp(Run memory r, uint256 o) internal {
        bytes memory c = r.core;
        uint256 kind = Def.u8(c, o);
        if (kind == Def.OP_NONE) return;
        uint256 asset = Def.u8(c, o + 1);
        uint256 amountExpr = Def.u16(c, o + 4);
        uint256 pid = r.pid;
        if (kind == Def.OP_MINT) {
            Units.mint(_book, pid, asset, _roleKey(r, Def.u8(c, o + 3)), _amount(r, amountExpr));
        } else if (kind == Def.OP_BURN) {
            Units.burn(_book, pid, asset, _roleKey(r, Def.u8(c, o + 2)), _amount(r, amountExpr));
        } else if (kind == Def.OP_TRANSFER) {
            Units.move(_book, pid, asset, _roleKey(r, Def.u8(c, o + 2)), _roleKey(r, Def.u8(c, o + 3)), _amount(r, amountExpr));
        } else if (kind == Def.OP_SWAP) {
            // Both legs or neither: the transaction is atomic.
            int256 a = _amount(r, amountExpr);
            int256 b = _amount(r, Def.u16(c, o + 9));
            Units.move(_book, pid, asset, _roleKey(r, Def.u8(c, o + 2)), _roleKey(r, Def.u8(c, o + 3)), a);
            Units.move(_book, pid, Def.u8(c, o + 6), _roleKey(r, Def.u8(c, o + 7)), _roleKey(r, Def.u8(c, o + 8)), b);
        } else if (kind == Def.OP_DEPOSIT) {
            address from = _roleKey(r, Def.u8(c, o + 2));
            if (r.signer != from) revert WrongRole();
            // Credited now; the ERC-20 is pulled after the step (interactions last).
            uint256 base = Units.pledge(_book, pid, asset, from, _amount(r, amountExpr));
            if (r.nDeps >= MAX_DEPOSITS) revert TooManyDeposits();
            r.depAsset[r.nDeps] = asset;
            r.depBase[r.nDeps] = base;
            r.nDeps++;
        } else if (kind == Def.OP_DISTRIBUTE) {
            // Pay every holder of `holding` units x per-unit of `asset`, from the payer role, except the payer's
            // own units (e.g. an issuer's unsold notes would pay itself). O(1): an accumulator (lib/Units.sol).
            Units.distribute(
                _book, pid, Def.u8(c, o + 6), asset, _amount(r, amountExpr), _roleKey(r, Def.u8(c, o + 2)), Def.u8(c, o + 11) != 0, r.step
            );
        } else {
            revert Def.BadDefinition();
        }
    }

    // ---- Steps ------------------------------------------------------------------------------------------------

    function _setCapture(Run memory r, uint256 field, uint8 tag, bytes32 data) internal {
        uint256 kind = Def.fieldKind(r.core, field);
        bool ok = kind == Def.F_TEXT ? tag == TAG_TEXT : kind == Def.F_PARTY ? tag == TAG_PARTY : tag == TAG_NUMBER;
        if (!ok) revert BadInputs();
        _values[r.pid][field] = data;
        r.tags = (r.tags & ~(uint256(3) << (2 * field))) | (uint256(tag) << (2 * field));
        // forge-lint: disable-next-line(unsafe-typecast) bounded by Def.check (assets < 8, fields < 64, steps < 0xFFFE, kinds <= 7, core < 24,576) or a two's-complement store
        emit FieldSet(r.pid, uint16(field), tag, data);
    }

    /// Captures, then the asset operations.
    function _runBody(Run memory r, Def.Step memory s) internal {
        bytes memory c = r.core;
        uint256 ni = 0;
        uint256 no = 0;
        for (uint256 k = 0; k < s.nCaptures; k++) {
            uint256 p = s.captures + k * Def.CAPTURE;
            uint256 field = Def.u16(c, p);
            uint256 source = Def.u8(c, p + 2);
            if (source == Def.SRC_INPUT) {
                if (ni >= r.inputs.length) revert BadInputs();
                Input memory inp = r.inputs[ni++];
                _setCapture(r, field, inp.tag, inp.data);
            } else if (source == Def.SRC_ORACLE) {
                if (no >= r.oracle.length) revert OracleOnlyViaReport();
                int256 v = r.oracle[no++];
                if (v < Def.i64(c, p + 5) || v > Def.i64(c, p + 13)) revert OracleOutOfBounds();
                // forge-lint: disable-next-line(unsafe-typecast) bounded by Def.check (assets < 8, fields < 64, steps < 0xFFFE, kinds <= 7, core < 24,576) or a two's-complement store
                _setCapture(r, field, TAG_NUMBER, bytes32(uint256(v)));
            } else {
                (bool ok, int256 v) = _eval(r, Def.u16(c, p + 3));
                if (!ok) revert FieldNotSet();
                // Expressions compute in fixed point; integer, date and bool fields are stored plain (e.g. a
                // payment date computed as obsDate + lag is unix seconds).
                if (Def.fieldKind(c, field) != Def.F_DECIMAL) v /= SCALE;
                // forge-lint: disable-next-line(unsafe-typecast) bounded by Def.check (assets < 8, fields < 64, steps < 0xFFFE, kinds <= 7, core < 24,576) or a two's-complement store
                _setCapture(r, field, TAG_NUMBER, bytes32(uint256(v)));
            }
        }
        if (ni != r.inputs.length || no != r.oracle.length) revert BadInputs();
        for (uint256 k = 0; k < s.nOps; k++) {
            _applyOp(r, s.ops + k * Def.OP);
        }
    }

    /// Run one step that holds a token.
    function _runStep(Run memory r, uint256 i) internal {
        if (r.status != RUNNING) revert ProcessFinished();
        r.step = i;
        Def.Step memory s = Def.step(r.core, i);
        if (s.until != 0) {
            if (_tokenCount(r, i) == 0) revert StepNotActive();
            if (_windowOpen(r, s.until)) {
                // A run inside the window: capture and apply, keep the token.
                if (r.signer == address(0)) revert WrongRole();
                _runBody(r, s);
                r.stepsRun++;
                // forge-lint: disable-next-line(unsafe-typecast) bounded by Def.check (assets < 8, fields < 64, steps < 0xFFFE, kinds <= 7, core < 24,576) or a two's-complement store
                emit StepRun(r.pid, uint16(i), uint8(s.kind), r.signer);
                _milestone(r, i, s);
                return;
            }
            // The window has closed: pass the token on, nothing else. A person acting in it is too late (a
            // funding call after its deadline must not look done), so only the engine itself closes it.
            if (r.signer != address(0)) revert WindowClosed();
            _takeTokens(r, i, 1);
            _passOn(r, i, s);
            return;
        }
        if (s.join > 0) {
            if (_tokenCount(r, i) < s.join) revert JoinNotReady();
            _takeTokens(r, i, s.join);
        } else {
            _takeTokens(r, i, 1);
        }
        if (!_isDue(r, s)) revert NotDue();
        if (s.guard != Def.NO_EXPR) {
            (bool ok, bool yes) = _holds(r, s.guard);
            if (!ok || !yes) revert GuardNotMet();
        }
        _runBody(r, s);
        _passOn(r, i, s);
    }

    /// Hand the step's tokens to its successors and message targets.
    function _passOn(Run memory r, uint256 i, Def.Step memory s) internal {
        bytes memory c = r.core;
        if (s.kind == Def.END) {
            // a token ends here
        } else if (s.kind == Def.XOR) {
            // A person chooses only at an UNCONDITIONED gateway; a conditioned one waits for its data.
            (bool decided, uint256 k) = _xorPick(r, s);
            if (!decided) {
                if (_conditioned(c, s) || r.choice == NO_CHOICE || r.choice >= s.nNext) revert NoBranch();
                k = r.choice;
            }
            _addToken(r, Def.u16(c, s.next + k * Def.EDGE));
        } else {
            for (uint256 k = 0; k < s.nNext; k++) {
                _addToken(r, Def.u16(c, s.next + k * Def.EDGE));
            }
        }
        for (uint256 k = 0; k < s.nSends; k++) {
            _addToken(r, Def.u16(c, s.sends + 2 * k));
        }
        r.stepsRun++;
        // forge-lint: disable-next-line(unsafe-typecast) bounded by Def.check (assets < 8, fields < 64, steps < 0xFFFE, kinds <= 7, core < 24,576) or a two's-complement store
        emit StepRun(r.pid, uint16(i), uint8(s.kind), r.signer);
        // A window's milestone marks a run inside it (funding deposited), not its closing.
        if (s.until == 0) _milestone(r, i, s);
    }

    function _milestone(Run memory r, uint256 i, Def.Step memory s) internal {
        // forge-lint: disable-next-line(unsafe-typecast) milestone < 16, steps < 0xFFFE (DefCheck)
        if (s.milestone != 0) emit Milestone(r.pid, uint8(s.milestone), uint16(i), r.signer);
    }

    /// Can this token's step run with nobody's input?
    function _runsItself(Run memory r, uint256 i) internal view returns (bool) {
        Def.Step memory s = Def.step(r.core, i);
        if (s.until != 0) return !_windowOpen(r, s.until);
        if (!_isDue(r, s)) return false;
        uint256 kind = s.kind;
        if (kind == Def.END || kind == Def.CATCH) return true;
        if (kind == Def.AND) return s.join == 0 || _tokenCount(r, i) >= s.join;
        if (kind == Def.XOR) {
            (bool decided,) = _xorPick(r, s);
            return decided;
        }
        if (kind == Def.RECEIVE) {
            if (s.guard == Def.NO_EXPR) return true;
            (bool ok, bool yes) = _holds(r, s.guard);
            return ok && yes;
        }
        if (kind == Def.SERVICE) {
            return !_needs(r.core, s, Def.SRC_ORACLE) && !_needs(r.core, s, Def.SRC_INPUT) && !_hasDeposit(r.core, s);
        }
        return false;
    }

    /// Straight-through processing: run every step that needs nobody, until none can.
    function _advance(Run memory r) internal {
        // Nobody signs what runs by itself: no inputs, no oracle values, no choice.
        r.signer = address(0);
        r.inputs = new Input[](0);
        r.oracle = new int256[](0);
        r.choice = NO_CHOICE;
        for (uint256 n = 0; n < MAX_ADVANCE; n++) {
            if (r.status != RUNNING) break;
            bool found;
            uint256 t;
            for (uint256 k = 0; k < r.nTokens; k++) {
                if (_runsItself(r, r.tokens[k])) {
                    t = r.tokens[k];
                    found = true;
                    break;
                }
            }
            if (!found) break;
            _runStep(r, t);
            if (r.nTokens == 0) r.status = COMPLETED;
        }
        if (r.nTokens == 0) r.status = COMPLETED;
    }
}
