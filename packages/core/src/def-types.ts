/**
 * The engine's WorkflowDef as TypeScript types (mirrors programs/flow_engine/
 * src/def.rs). Dependency-free so the CRE workflow can bundle it.
 */
import type { Op } from './op';

export interface Due {
  kind: number;
  at: bigint;
  field: number;
}
export interface Capture {
  field: number;
  source: number;
  expr: number;
  min: bigint;
  max: bigint;
}
export interface AssetOpDef {
  kind: number;
  asset: number;
  fromRole: number;
  toRole: number;
  amount: number;
  asset2: number;
  fromRole2: number;
  toRole2: number;
  amount2: number;
  retire: boolean;
}
export interface Edge {
  target: number;
  cond: number;
  isDefault: boolean;
}
export interface StepDef {
  id: string;
  kind: number;
  role: number;
  timer: Due | null;
  guard: number;
  captures: Capture[];
  ops: AssetOpDef[];
  until: Due | null;
  next: Edge[];
  sends: number[];
  join: number;
  /** FlowEngine `Milestone` code announced when the step completes (0 = none; types.ts MILESTONES). */
  milestone: number;
}
export interface WorkflowDef {
  version: number;
  name: string;
  meta: string;
  roles: string[];
  /** Per role: bit 0 = escrow (an account the engine holds for the note; nobody signs for it). */
  roleFlags: number[];
  fields: Array<{ name: string; kind: number }>;
  assets: Array<{ name: string; kind: number; decimals: number }>;
  exprs: Op[][];
  steps: StepDef[];
}
