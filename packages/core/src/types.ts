/**
 * Workflow model: the per-node properties authored on the BPMN canvas (Flow's
 * CantonProperties, minus what only Canton needs) and the normalized IR the
 * compiler works on.
 */

import type { NotifyDecl } from './notify';

export type FieldType = 'Decimal' | 'Int' | 'Date' | 'Text' | 'Party' | 'Bool';

export interface TemplateField {
  name: string;
  type: FieldType;
  /** A formula over other fields, computed when the step runs. */
  formula?: string;
  /** Delivered by Chainlink CRE from a price feed, checked against these bounds. */
  oracle?: { feed: string; feedChain?: string; min: string; max: string; staleness?: number };
}

export type AmountSource = 'literal' | 'field' | 'expr';

/**
 * Asset operations. Parties are named by POOL name (each pool is a role).
 *  - mint / burn / transfer: internal ledger moves of `assetId`.
 *  - swap: atomic DvP — `assetId` from deliveryParty to the payment party, and
 *    counterAssetId from paymentParty to the delivery party.
 *  - deposit: SPL cash from the step's own pool into the process vault.
 *  - distribute: pay every holder of holdingAssetId units x per-unit of
 *    assetId, from `payer` (optionally retiring the units).
 */
export interface AssetOperation {
  assetId: string;
  operation: 'mint' | 'burn' | 'transfer' | 'swap' | 'deposit' | 'distribute';
  params: {
    amountSource?: AmountSource;
    amount?: string;
    amountField?: string;
    amountExpr?: string;
    owner?: string; // mint: to
    from?: string; // burn / transfer
    to?: string; // transfer
    deliveryParty?: string; // swap
    paymentParty?: string;
    counterAssetId?: string;
    counterAmountSource?: AmountSource;
    counterAmount?: string;
    counterAmountField?: string;
    counterAmountExpr?: string;
    holdingAssetId?: string; // distribute
    payer?: string;
    retire?: boolean;
  };
}

export interface NodeProps {
  templateFields?: TemplateField[];
  assetOperation?: AssetOperation;
  /** Several operations, applied in order, atomically (after assetOperation). */
  assetOperations?: AssetOperation[];
  /**
   * Repeatable window (e.g. a subscription book): until this time anyone
   * holding the role may run the step again; then it closes and moves on.
   */
  until?: { date?: string; dateField?: string };
  /** Wait until a fixed time (ISO date or unix seconds) or a Date field's value. */
  timer?: { date?: string; dateField?: string };
  /** receiveTask: predicate the incoming message's fields must satisfy. */
  receiveGuard?: string;
  /** Kept from Flow imports; on Solana a step's role is its pool. */
  controllers?: string[];
  /**
   * A business event the engine announces when this step completes (FlowEngine `Milestone`), so an indexer
   * can follow the note's economics without knowing its workflow: collateral pledged or released, a payment
   * funded, made or missed, a margin call opened or cured, a default.
   */
  milestone?: Milestone;
  /** Email notifications declared on this step (notify.ts). For people only: compiled into META, never CORE. */
  notify?: NotifyDecl[];
}

export const MILESTONES = {
  'collateral-pledged': 1,
  'collateral-released': 2,
  'funding-deposited': 3,
  'margin-call': 4,
  'margin-cured': 5,
  'payment-made': 6,
  'payment-missed': 7,
  defaulted: 8,
} as const;
export type Milestone = keyof typeof MILESTONES;
export const MILESTONE_NAMES = Object.fromEntries(Object.entries(MILESTONES).map(([k, v]) => [v, k])) as Record<
  number,
  Milestone
>;

export type PropsMap = Record<string, NodeProps>;

export interface AssetDefinition {
  id: string;
  name: string;
  /** issued: units only in the process ledger (e.g. the note). cash: an SPL token in the vault. */
  kind: 'issued' | 'cash';
  /** cash: the SPL token's decimals (USDC: 6). */
  decimals?: number;
  /**
   * cash: which cross-chain token this is (a symbol in deployments/*-tokens.json,
   * e.g. tUSD, tETH), so an app can map it to its mint on Solana and its
   * address on other CCIP chains. Not part of the compiled definition.
   */
  token?: string;
}

export type NodeType =
  | 'startEvent'
  | 'endEvent'
  | 'userTask'
  | 'serviceTask'
  | 'task'
  | 'receiveTask'
  | 'sendTask'
  | 'exclusiveGateway'
  | 'parallelGateway'
  | 'intermediateCatchEvent';

export interface IrNode {
  id: string;
  type: NodeType;
  name: string;
  pool: string; // participant id
  props: NodeProps;
  incoming: string[];
  outgoing: string[];
  defaultFlow?: string;
}

export interface IrFlow {
  id: string;
  source: string;
  target: string;
  name?: string;
  condition?: string;
}

/**
 * A pool. `escrow`: an account the engine holds for the note itself (pledged collateral, funded payments).
 * Nobody signs for it: no person can run its steps, withdraw from it or move its balances; only the
 * workflow's own operations do (FlowEngine.ESCROW). An escrow pool has no steps.
 */
export interface IrPool {
  id: string;
  name: string;
  escrow?: boolean;
  open?: boolean;
}

/**
 * Pools anyone may act in (OPEN roles: the engine takes address(0) for them), e.g. the investors' book. Marked
 * `open` in the BPMN; workflows without the mark (older drafts) use the old rule: a pool with a repeatable
 * window and no start event.
 */
export function openPoolIds(ir: Pick<WorkflowIR, 'pools' | 'nodes'>): Set<string> {
  if (ir.pools.some((p) => p.open)) return new Set(ir.pools.filter((p) => p.open).map((p) => p.id));
  const windows = new Set(ir.nodes.filter((n) => n.props.until).map((n) => n.pool));
  const starts = new Set(ir.nodes.filter((n) => n.type === 'startEvent').map((n) => n.pool));
  return new Set(ir.pools.filter((p) => windows.has(p.id) && !starts.has(p.id) && !p.escrow).map((p) => p.id));
}

/**
 * A message flow between pools. `notice`: drawn for people (e.g. the issuer's funding window informing the
 * paying agent) but not a token handoff: the receiving pool reads the state it needs (an escrow balance)
 * itself, so the engine ignores it.
 */
export interface IrMessageFlow {
  id: string;
  source: string;
  target: string;
  notice?: boolean;
}

export interface WorkflowIR {
  name: string;
  pools: IrPool[];
  nodes: IrNode[];
  flows: IrFlow[];
  messageFlows: IrMessageFlow[];
  assets: AssetDefinition[];
}

export interface Issue {
  code: string;
  message: string;
  nodeId?: string;
}
