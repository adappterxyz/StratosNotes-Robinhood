/**
 * Read a WorkflowDef back from its canonical bytes (see compile-evm.ts): the
 * marketplace renders offerings from it, and the CRE workflow uses it to find
 * the oracle steps that are due.
 */
export { decodeEvmDef as decodeDef } from './compile-evm';
