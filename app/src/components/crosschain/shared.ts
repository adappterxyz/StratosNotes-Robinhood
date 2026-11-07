export type { Leg } from '../../lib/engines';

export const ccipLink = (id: string) => `https://ccip.chain.link/msg/${id}`;
export const receiptLabel = (sym: string) => sym.replace(/\.[a-z]+$/, '');

/** The CCIP message id in a vault Locked or gateway Redeemed event (bytes32 after the token/amount words). */
export function messageIdOf(
  logs: ReadonlyArray<{ topics: readonly string[]; data: string; address: string }>,
): string | undefined {
  // The router's onRamp emits CCIPMessageSent with the message id as its last topic; take it from there.
  const sent = logs.find((l) => l.topics.length === 4 && l.topics[0].startsWith('0x371bc2ff'));
  return sent ? sent.topics[3] : undefined;
}
