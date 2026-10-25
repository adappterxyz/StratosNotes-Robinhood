/**
 * Ready-made notes: the built-in examples (one per note type, plus the worst-of basket) and the ones issuers saved
 * to the library (/api/templates). Each opens the guided issue flow with its terms filled in. A saved note that
 * changes the workflow itself (a custom workflow) opens in the studio instead: the guided flow only issues
 * standard payoffs.
 */
import {
  EXAMPLE_PRODUCTS,
  EXAMPLE_WORST_OF,
  normalizeParams,
  summarize,
  templateOffered,
  type ProductParams,
  type ProductType,
  type TemplateEntry,
  type TemplateSummary,
} from '@sn/core';

export type NoteKind = ProductType | 'worst-of';

export interface ReadyMade {
  /** "ex:<note type>" for a built-in, the definition hash for a saved one. */
  id: string;
  name: string;
  description: string;
  params: ProductParams;
  /** Absent for the built-ins (by notes.markets). */
  author?: string;
  /** A saved custom workflow: issued from the studio. */
  custom: boolean;
  summary?: TemplateSummary;
}

const DESCRIPTION: Record<NoteKind, string> = {
  fcn: 'The same coupon every quarter; repaid early if ETH is at or above its strike.',
  'reverse-convertible': 'A higher fixed coupon; below 70% of the strike at maturity, repaid in proportion to ETH.',
  phoenix: 'A coupon each quarter ETH holds 70% of its strike, missed ones paid later; can end early from Q2.',
  snowball: 'The payout grows each quarter and is paid in full when the note is called.',
  ppn: 'All your money back at maturity, plus half of any rise in ETH.',
  'worst-of': 'A phoenix on ETH, Bitcoin and Solana: the weakest of the three decides.',
};

/** A built-in note type's example terms (on Arbitrum Sepolia, where every note is issued). */
export const exampleOf = (k: NoteKind): ProductParams => (k === 'worst-of' ? EXAMPLE_WORST_OF : EXAMPLE_PRODUCTS[k]);

export const kindOf = (p: ProductParams): NoteKind => (p.underlyings.length > 1 ? 'worst-of' : p.productType);

export const BUILT_IN: ReadyMade[] = (
  [...(Object.keys(EXAMPLE_PRODUCTS) as ProductType[]), 'worst-of'] as NoteKind[]
).map((k) => {
  const params = exampleOf(k);
  return { id: `ex:${k}`, name: params.name, description: DESCRIPTION[k], params, custom: false };
});

const entries = new Map<string, Promise<ReadyMade | null>>();

function fromEntry(e: TemplateEntry): ReadyMade | null {
  const p = e.product ?? e.basis;
  if (!p) return null; // a custom workflow drawn from scratch has no term sheet to fill the guided flow with
  if (!templateOffered(e)) return null; // saved before the test tokens were retired (e.g. tAAPL delivery)
  const summary = summarize(e);
  return {
    id: e.definition,
    name: e.name,
    description: e.description,
    params: normalizeParams(p),
    author: e.author,
    custom: summary.kind === 'custom',
    summary,
  };
}

/** One saved note, fetched once. */
export function savedReadyMade(definition: string): Promise<ReadyMade | null> {
  let hit = entries.get(definition);
  if (!hit) {
    hit = fetch(`/api/templates/${definition}`)
      .then((r) => (r.ok ? (r.json() as Promise<TemplateEntry>) : null))
      .then((e) => (e ? fromEntry(e) : null))
      .catch(() => null);
    entries.set(definition, hit);
    hit.then((x) => {
      if (!x) entries.delete(definition);
    });
  }
  return hit;
}

/** Every saved note in the library, newest first, with its terms. */
export async function libraryReadyMade(): Promise<ReadyMade[]> {
  const r = await fetch('/api/templates');
  if (!r.ok) throw new Error(`The library could not be read (${r.status}).`);
  const list = (await r.json()) as TemplateSummary[];
  const all = await Promise.all(list.slice(0, 48).map((t) => savedReadyMade(t.definition)));
  return all.filter((x): x is ReadyMade => !!x);
}

/** By id: a built-in at once, a saved one from the library. */
export function readyMade(id: string): ReadyMade | Promise<ReadyMade | null> | null {
  if (id.startsWith('ex:')) return BUILT_IN.find((x) => x.id === id) ?? null;
  if (/^0x[0-9a-f]{64}$/i.test(id)) return savedReadyMade(id);
  return null;
}

/** What the AI read from a prompt, handed to the guided flow (?ready=ai). */
export interface AiReading {
  params: ProductParams;
  schedule?: { every: number; unit: 'months' | 'days' | 'minutes'; count: number; size?: number };
  notes?: string[];
}
const AI_KEY = 'sn.ai.reading';
export const AI_DRAFT_KEY = 'sn.ai.workflow';
export function saveAiReading(r: AiReading) {
  try {
    sessionStorage.setItem(AI_KEY, JSON.stringify(r));
  } catch {
    /* storage blocked */
  }
}
export function loadAiReading(): AiReading | null {
  try {
    const s = sessionStorage.getItem(AI_KEY);
    return s ? (JSON.parse(s) as AiReading) : null;
  } catch {
    return null;
  }
}
