/**
 * FlowEngine v3: the subset of its ABI that differs from v4 (packages/evm-engine before d90b2ad). v3 notes stay on
 * the v3 engine (engines aren't upgradeable, nothing migrates; docs/ERC20-NOTES.md §8), so holders keep acting on
 * them with these entries. Everything else a holder calls (executeStep, withdraw, deposit, poke, balanceOf,
 * processOf, tokensOf, valueOf, roleOf, assetTokenOf, emailOf, requireEmail) and every event has the same
 * signature in v3 and v4, so the v4 ABI (generated.ts) serves both.
 *
 * In v3 a note's units live in the engine's ledger (no ERC-20): `balanceOf(pid, owner, 0)` is the holding and
 * `transferUnits` moves it (engine fixed point, 10 decimals).
 */
import { parseAbi } from 'viem';

export const ENGINE_V3 = 3;
export const ENGINE_V4 = 4;
export type EngineVersion = typeof ENGINE_V3 | typeof ENGINE_V4;

export const flowEngineV3Abi = parseAbi([
  'struct Input { uint8 tag; bytes32 data; }',
  'function startProcess(bytes32 definition, uint64 ref, address[] roles, address[] assetTokens, uint16 startStep, Input[] inputs) returns (uint256 pid)',
  'function transferUnits(uint256 pid, uint8 asset, address to, int256 amount)',
  'function holdersOf(uint256 pid) view returns (address[])',
  'function MAX_HOLDERS() view returns (uint256)',
  'error HoldingsFull()',
]);
