/**
 * ChainAdapter: the one interface the app and the services use to read and act on notes, whatever chain runs
 * them. EvmAdapter (evm/adapter.ts) implements it for FlowEngine on Arbitrum Sepolia and Robinhood Chain; another
 * chain family would implement it over its own API, with its own credential as its
 * signer.
 *
 * Reads here go to the chain directly (for scripts, keepers and verification). The app reads notes from the
 * indexer's API instead, which serves the same NoteState shape for every chain.
 */
import type { WorkflowDef } from '@sn/core';
import type { EngineEvent } from './events';
import type { InputValue, IssuePlan } from './issue';
import type { ChainInfo, NoteId, NoteState } from './model';

export interface IssueRequest {
  /** The definition's canonical bytes (CORE ‖ META); registered first if the chain does not have it yet. */
  definition: Uint8Array;
  def: WorkflowDef;
  plan: IssuePlan;
  /** The issuer's own reference for this issuance (e.g. an issuance number). */
  ref: bigint;
  /** The token behind each cash asset (EVM: an ERC-20 address), by asset index. */
  cashTokens: Record<number, string>;
  /** Inputs for the start step and each pre-trade step: step index -> field index -> value. */
  inputs: Record<number, Record<number, InputValue>>;
  /** The ERC-20 name and symbol of the note's units (sdk noteTokenMeta); derived from the workflow if absent. */
  token?: { name: string; symbol: string };
}

export type Progress = (message: string) => void;

export interface Submitted {
  tx: string[];
}

/** A claim's outcome: what reached the wallet with a receipt, and whether a payment could not be sent. */
export interface Claimed extends Submitted {
  /** Paid with a receipt, in the token's base units (0n on an engine without receipts). */
  paid: bigint;
  /** The receipts (PayoutPaid payoutIds) of this claim. */
  payoutIds: string[];
  /** Other cash withdrawn after the claim (base units): not a payout, so no receipt (e.g. a refund). */
  withdrawn: bigint;
  /** The token refused the transfer (a frozen or paused stablecoin): the amount stays claimable. */
  deferred: boolean;
}

export interface ChainAdapter<Signer> {
  readonly chain: ChainInfo;

  /** A definition by id, decoded (null when this chain does not have it). */
  getDefinition(id: string): Promise<WorkflowDef | null>;
  /** Every note this engine runs (direct chain read; the indexer is the scalable path). */
  listNotes(): Promise<NoteState[]>;
  getNote(id: NoteId): Promise<NoteState | null>;
  /** A note's events in chain order. */
  history(id: NoteId): Promise<Array<{ block: number; tx: string; event: EngineEvent }>>;

  /** Publish a workflow (idempotent). */
  registerDefinition(
    signer: Signer,
    bytes: Uint8Array,
    onProgress?: Progress,
  ): Promise<Submitted & { definition: string }>;
  /** Start an issuance and run its pre-trade steps (terms, reserves); the book opens at the end. */
  issue(signer: Signer, req: IssueRequest, onProgress?: Progress): Promise<Submitted & { id: NoteId }>;
  /**
   * Complete a waiting user task or decision: its inputs by field index, and for a decision the chosen
   * outgoing flow. Deposits the step takes are approved and pulled from the signer.
   */
  executeStep(
    signer: Signer,
    id: NoteId,
    step: number,
    inputs: Record<number, InputValue>,
    choice?: number,
    onProgress?: Progress,
  ): Promise<Submitted>;
  /** Buy `units` (engine fixed point) from an open book, paying in the note's stablecoin. */
  subscribe(signer: Signer, id: NoteId, units: bigint, onProgress?: Progress): Promise<Submitted>;
  /**
   * Move note units (engine fixed point, whole token base units), in whole or in part: a transfer of the note's
   * ERC-20. The recipient must have a verified email when the engine requires one; payouts made before the
   * transfer stay with the sender.
   */
  transferUnits(signer: Signer, id: NoteId, to: string, units: bigint, onProgress?: Progress): Promise<Submitted>;
  /**
   * Claim the holder's payouts of a cash asset (coupons, the redemption): everything accrued until now, in one
   * transaction with a receipt (PayoutPaid), then any other cash left on the account. The holder pays the gas.
   * On an engine without receipts (v3) it is a plain withdrawal.
   */
  claimPayouts(signer: Signer, id: NoteId, asset: number, onProgress?: Progress): Promise<Claimed>;
  /** Withdraw a cash or delivered-token balance to the holder's wallet (all of it by default). */
  withdraw(signer: Signer, id: NoteId, asset: number, amount?: bigint, onProgress?: Progress): Promise<Submitted>;
  /** What `owner` can claim or withdraw of an asset now: payouts not claimed yet plus other cash (fixed point). */
  claimable(id: NoteId, owner: string, asset: number): Promise<bigint>;
  /** The ERC-20 of the note's units (null for notes from an engine without note tokens). */
  noteToken(id: NoteId): Promise<string | null>;
  /**
   * Push the latest payout of `asset` to the next `count` holders' wallets (anyone may; the caller pays gas). Not
   * the default: holders claim (claimPayouts). Used by issuers who chose to pay holders automatically.
   * Returns how many holders are still to push in this round.
   */
  pushPayouts(
    signer: Signer,
    id: NoteId,
    asset: number,
    count: number,
    onProgress?: Progress,
  ): Promise<Submitted & { left: number }>;
}
