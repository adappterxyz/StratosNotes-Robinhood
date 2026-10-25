/**
 * The FlowEngine and NotesLens ABI the platform uses (packages/evm-engine). Pure data: safe to bundle into
 * the CRE workflow's WASM.
 */
import { parseAbi } from 'viem';

export const engineAbi = parseAbi([
  'struct Input { uint8 tag; bytes32 data; }',
  'struct Proc { bytes32 definition; address creator; uint8 status; uint8 nTokens; uint32 stepsRun; uint40 createdAt; uint64 ref; uint40 updatedAt; uint128 tags; }',
  'function registerDefinition(bytes data) returns (bytes32 id)',
  'function startProcess(bytes32 definition, uint64 ref, address[] roles, address[] assetTokens, uint16 startStep, Input[] inputs, string name, string symbol) returns (uint256 pid)',
  'function executeStep(uint256 pid, uint16 step, uint16 choice, Input[] inputs)',
  'function poke(uint256 pid)',
  'function withdraw(uint256 pid, uint8 asset, uint256 base)',
  'function pushPayouts(uint256 pid, uint8 asset, uint256 start, uint256 count) returns (uint256 left)',
  'function pushTo(uint256 pid, uint8 asset, address[] holders)',
  'function onReport(bytes metadata, bytes report)',
  'function fallbackReport(bytes report)',
  'function setFallbackReporter(address next)',
  'function fallbackReporter() view returns (address)',
  'function getForwarderAddress() view returns (address)',
  'function processCount() view returns (uint256)',
  'function processOf(uint256 pid) view returns (Proc)',
  'function tokensOf(uint256 pid) view returns (uint16[])',
  'function valueOf(uint256 pid, uint256 field) view returns (uint8 tag, bytes32 data)',
  'function balanceOf(uint256 pid, address owner, uint256 asset) view returns (int256)',
  'function pendingOf(uint256 pid, address owner, uint256 asset) view returns (int256)',
  'function assetTokenOf(uint256 pid, uint256 asset) view returns (address)',
  'function vaultOf(uint256 pid, uint256 asset) view returns (uint256)',
  'event ProcessStarted(uint256 indexed pid, bytes32 indexed definition, address indexed creator, uint64 ref, address[] roles, address[] assetTokens)',
  'event ReportProcessed(uint256 indexed pid, uint16 indexed step, int256[] values, address reporter)',
  'event ProcessCompleted(uint256 indexed pid)',
  'event Milestone(uint256 indexed pid, uint8 indexed code, uint16 step, address actor)',
  'event NoteTokenCreated(uint256 indexed pid, uint8 indexed asset, address token)',
  'event DistributionRecorded(uint256 indexed pid, uint8 indexed asset, uint64 indexed period, uint8 holding, uint16 step, address payer, int256 perUnit, int256 total, uint256 supplyAtPayment, bool retire, bytes32 distributionHash)',
  'event PayoutPaid(uint256 indexed pid, uint8 indexed asset, uint64 period, address indexed holder, uint256 amount, bytes32 payoutId)',
  'event PayoutDeferred(uint256 indexed pid, uint8 indexed asset, uint64 period, address indexed holder, uint256 amount)',
  'event DistributionSettled(uint256 indexed pid, uint8 indexed asset, uint64 indexed period, uint256 paidCount, uint256 paidTotal, bytes32 rollingHash)',
  'function ESCROW() view returns (address)',
]);

export const lensAbi = parseAbi([
  'struct Snapshot { uint256 pid; bytes32 definition; uint8 status; uint40 updatedAt; uint16[] tokens; uint128 tags; bytes32[] values; int256[] balances; }',
  'function publish(bytes data) returns (bytes32 id)',
  'function isPublished(bytes32 id) view returns (bool)',
  'function definitionBytes(bytes32 id) view returns (bytes)',
  'function snapshot(uint256 pid) view returns (Snapshot)',
  'function running(uint256 from, uint256 scan, uint256 max) view returns (Snapshot[] out, uint256 next)',
  'function position(uint256 pid, address holder) view returns (address[] tokens, int256[] balances, int256[] accrued)',
  'function claimable(uint256 pid, uint256 asset, address[] accounts) view returns (int256[] out)',
  'function holders(uint256 pid, uint256 asset, uint256 start, uint256 count) view returns (address[] who, uint256[] units, uint256 total)',
]);

export const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);
