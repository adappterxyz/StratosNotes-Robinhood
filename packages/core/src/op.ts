/** One engine RPN instruction (programs/flow_engine/src/def.rs `Op`). */
export interface Op {
  code: number;
  field: number;
  value: bigint;
}
