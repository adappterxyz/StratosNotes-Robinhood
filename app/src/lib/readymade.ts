/**
 * Ready-made notes: the built-in examples (one per note type, plus the worst-of basket) and the ones issuers saved
 * to the library (/api/templates), and the notes issued recently on the current engine (note:<note id>). Each opens
 * the guided issue flow with its terms filled in. A saved note that changes the workflow itself (a custom workflow)
 * opens on its own review instead (/issue?custom=<definition>): the guided flow only issues standard payoffs.
 */
import {
  EXAMPLE_PRODUCTS,
  EXAMPLE_WORST_OF,
  normalizeParams,
  summarize,
  templateOffered,
  type ProductParams,
  type ProductType,
  type AssetDefinition,
  type TemplateEntry,
  type TemplateSummary,
} from '@sn/core';
import type { NoteDetail, NoteItem } from './api';

export type NoteKind = ProductType | 'worst-of';

export interface ReadyMade {
  /** "ex:<note type>" for a built-in, the definition hash for a saved one. */
  id: string;
  name: string;
  description: string;
  params: ProductParams;
  /** Absent for the built-ins (by notes.markets). */
  author?: string;
  /** A saved custom workflow: reviewed and issued from its diagram (/issue?custom=<definition>). */
  custom: boolean;
  summary?: TemplateSummary;
  /** Started from a note already issued: when it was issued, and its size (the new issuance's default). */
  issuedAt?: number;
  size?: number;
}

const DESCRIPTION: Record<NoteKind, string> = {
  fcn: 'The same coupon every quarter; repaid early if ETH is at or above its strike.',
  'reverse-convertible': 'A higher fixed coupon; below 70% of the strike at maturity, repaid in proportion to ETH.',
  phoenix: 'A coupon each quarter ETH holds 70% of its strike, missed ones paid later; can end early from Q2.',
  snowball: 'The payout grows each quarter and is paid in full when the note is called.',
  ppn: 'All your money back at maturity, plus half of any rise in ETH.',
  'worst-of': 'A phoenix on ETH, Bitcoin and Solana: the weakest of the three decides.',
};

/** A built-in note type's example terms (on Robinhood Chain testnet, where every note runs). */
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

/**
 * A note already issued, as a starting point for a new issuance: its terms (a stock product), or, for a custom
 * workflow, the saved workflow in the library it was issued from (none: it can't be reused, null).
 */
export function fromNote(
  n: Pick<NoteItem, 'id' | 'definition' | 'view'>,
): ReadyMade | Promise<ReadyMade | null> | null {
  const v = n.view;
  if (v.custom || !v.hasTerms) return savedReadyMade(n.definition);
  if (!v.params.underlyings.length) return null;
  return {
    id: `note:${n.id}`,
    name: v.name,
    description: '',
    params: normalizeParams(v.params),
    custom: false,
    issuedAt: v.createdAt,
    size: v.notional > 0 ? v.notional : undefined,
  };
}

/** The notes issued most recently on the current engine (newest first), each as a starting point. */
export async function recentReadyMade(
  current: (n: NoteItem) => boolean,
  max = 6,
): Promise<Array<{ note: NoteItem; ready: ReadyMade }>> {
  const r = await fetch('/api/notes?status=all&limit=50');
  if (!r.ok) throw new Error(`The recent notes could not be read (${r.status}).`);
  const { notes } = (await r.json()) as { notes: NoteItem[] };
  const mine = notes.filter(current).sort((a, b) => b.view.createdAt - a.view.createdAt);
  const out: Array<{ note: NoteItem; ready: ReadyMade }> = [];
  for (const note of mine) {
    if (out.length >= max) break;
    const ready = await fromNote(note);
    if (ready) out.push({ note, ready });
  }
  return out;
}

/** By id: a built-in at once, a saved one from the library, a note already issued (note:<note id>). */
export function readyMade(id: string): ReadyMade | Promise<ReadyMade | null> | null {
  if (id.startsWith('ex:')) return BUILT_IN.find((x) => x.id === id) ?? null;
  if (/^0x[0-9a-f]{64}$/i.test(id)) return savedReadyMade(id);
  if (id.startsWith('note:'))
    return fetch(`/api/notes/${encodeURIComponent(id.slice(5))}`)
      .then((r) => (r.ok ? (r.json() as Promise<NoteDetail>) : null))
      .then((d) => (d ? fromNote({ id: d.state.id, definition: d.state.definition, view: d.view }) : null))
      .catch(() => null);
  return null;
}

/** What the AI read from a prompt, handed to the guided flow (?ready=ai). */
export interface AiReading {
  params: ProductParams;
  schedule?: { every: number; unit: 'months' | 'days' | 'minutes'; count: number; size?: number };
  notes?: string[];
}
const AI_KEY = 'sn.ai.reading';
/** The AI's custom workflow (BPMN), handed from "Describe it" to its review and the advanced editor. */
export const AI_DRAFT_KEY = 'sn.ai.workflow';
/** The assets a workflow drawn without a term sheet (an AI draft, an imported file) settles in. */
export const NOTE_ASSETS: AssetDefinition[] = [
  { id: 'note', name: 'Note', kind: 'issued' },
  { id: 'cash', name: 'USDG', kind: 'cash', decimals: 6, token: 'USDG' },
];
export function loadAiDraft(): string | null {
  try {
    return sessionStorage.getItem(AI_DRAFT_KEY);
  } catch {
    return null;
  }
}
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
