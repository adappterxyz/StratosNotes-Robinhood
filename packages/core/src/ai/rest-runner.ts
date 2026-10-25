/**
 * Workers AI over its REST API, for Node services (services/api) and evals. Kept out of the package index:
 * it needs fetch and AbortSignal, and the CRE workflow (which imports this package's keeper) has neither.
 */
import { workersAiRunner, type AiRunner } from './runner';

/** The token needs only the "Workers AI: Read" permission on the account. */
export function restAiRunner(accountId: string, token: string, opts: { timeoutMs?: number } = {}): AiRunner {
  return workersAiRunner({
    async run(model: string, input: unknown) {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
      const j = (await r.json().catch(() => null)) as { success?: boolean; result?: unknown; errors?: unknown } | null;
      if (!j?.success) throw new Error(`Workers AI ${model}: ${r.status} ${JSON.stringify(j?.errors ?? null)}`);
      return j.result;
    },
  });
}
