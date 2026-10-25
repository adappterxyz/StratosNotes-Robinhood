/**
 * Model access for the AI pipeline (ported from Flow), behind an interface so it is
 * pure and testable with a fake runner.
 *
 *  - Decisions (route, clarify, coverage checks): Cloudflare Clef — a typed
 *    decision model (noul / choice / score questions over a state) returning
 *    calibrated probabilities. The router uses Clef (precise); clef-flash is
 *    available for cheap checks.
 *  - Generation (term-sheet extraction, workflow drafts, answers): Kimi K2.6
 *    in JSON mode with the schema in the prompt, reasoning off.
 */
export const MODELS = {
  decideFast: '@cf/cloudflare/clef-flash',
  decide: '@cf/cloudflare/clef',
  generate: '@cf/moonshotai/kimi-k2.6',
} as const;

export interface DecisionQuestion {
  type: 'noul' | 'choice' | 'score';
  instructions: string;
  criteria?: Record<string, string> | string[];
}
export interface DecisionAnswer {
  type: string;
  noul?: number;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  score?: number;
}
export type DecisionAnswers = Record<string, DecisionAnswer>;
export type Reasoning = 'none' | 'low' | 'medium' | 'high';
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiRunner {
  /** Typed decisions over `state`. `precise` uses the larger decision model. */
  decide(
    state: string,
    questions: Record<string, DecisionQuestion>,
    opts?: { precise?: boolean },
  ): Promise<DecisionAnswers>;
  /** Structured generation: a JSON value conforming (best effort) to `schema`. */
  json<T>(messages: ChatMessage[], schema: object, name: string, opts?: { reasoning?: Reasoning }): Promise<T>;
  /** Free-text answer. */
  text(messages: ChatMessage[]): Promise<string>;
}

/** Workers AI binding shape used here (kept minimal so tests need no types). */
interface AiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

function contentOf(r: unknown): string {
  const x = r as { choices?: Array<{ message?: { content?: string } }>; response?: string };
  return x?.choices?.[0]?.message?.content ?? x?.response ?? '';
}

/** Parse a model's JSON reply, tolerating code fences or a prose wrapper. */
export function parseModelJson<T>(raw: string): T {
  const s = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  try {
    return JSON.parse(s) as T;
  } catch {
    /* fall through */
  }
  const a = s.indexOf('{'),
    b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1)) as T;
  throw new Error('Model did not return JSON');
}

/** A reply wrapped under one key (e.g. {"term_sheet": {...}}) is unwrapped when the schema's own keys are inside. */
export function unwrap<T>(v: unknown, schema: object, name: string): T {
  const keys = Object.keys((schema as { properties?: object }).properties ?? {});
  const o = v as Record<string, unknown>;
  if (o && typeof o === 'object' && !Array.isArray(o) && !keys.some((k) => k in o)) {
    const inner = Object.keys(o).length === 1 ? Object.values(o)[0] : o[name];
    if (inner && typeof inner === 'object' && keys.some((k) => k in (inner as object))) return inner as T;
  }
  return v as T;
}

export function workersAiRunner(ai: AiBinding): AiRunner {
  return {
    async decide(state, questions, opts) {
      const r = (await ai.run(opts?.precise ? MODELS.decide : MODELS.decideFast, { state, questions })) as {
        answers?: DecisionAnswers;
      };
      if (!r?.answers) throw new Error('Decision model returned no answers');
      return r.answers;
    },
    async json<T>(messages: ChatMessage[], schema: object, name: string, opts?: { reasoning?: Reasoning }) {
      // JSON mode with the schema in the prompt. Schema-constrained decoding (json_schema) was
      // slower (~70 s vs ~18 s per workflow draft) and degenerated: broken decisions, junk strings.
      const reasoning = opts?.reasoning ?? 'none';
      const [first, ...rest] = messages;
      const withSchema: ChatMessage[] =
        first?.role === 'system'
          ? [
              {
                role: 'system',
                content: `${first.content}\n\nReply with the JSON object itself (not wrapped in another key), following this JSON Schema:\n${JSON.stringify(schema)}`,
              },
              ...rest,
            ]
          : [
              {
                role: 'system',
                content: `Reply with the JSON object itself (not wrapped in another key), following this JSON Schema:\n${JSON.stringify(schema)}`,
              },
              ...messages,
            ];
      const r = await ai.run(MODELS.generate, {
        messages: withSchema,
        response_format: { type: 'json_object' },
        reasoning_effort: reasoning,
        max_completion_tokens: reasoning === 'none' ? 8000 : 24000, // reasoning: ~50 tok/s, minutes per draft
      });
      return unwrap<T>(parseModelJson<unknown>(contentOf(r)), schema, name);
    },
    async text(messages) {
      const r = await ai.run(MODELS.generate, { messages, reasoning_effort: 'none', max_completion_tokens: 1500 });
      return contentOf(r).trim();
    },
  };
}
