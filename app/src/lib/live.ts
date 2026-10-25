/**
 * Live reads: fetch from the API and re-fetch when the indexer reports a change. One shared poller asks
 * /api/updates?since=<seq> every few seconds (the backend is D1, which has no push), and each hook re-fetches when
 * a change matches it; a slow fallback poll covers anything missed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeEvmDef, type WorkflowDef } from '@sn/core';
import { hexToBytes } from '@sn/sdk';
import { api, type NoteDetail, type NoteFilters, type NoteItem, type PortfolioItem, type PayoutItem } from './api';

const FALLBACK_POLL_MS = 20_000;
const UPDATES_POLL_MS = 4_000;

type Change = { chain: string; notes: string[] | null };
const listeners = new Set<(changes: Change[]) => void>();
let seq: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

async function pollUpdates() {
  timer = null;
  if (!listeners.size) return;
  try {
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
      const r = await fetch(seq === null ? '/api/updates' : `/api/updates?since=${seq}`, { cache: 'no-store' });
      if (r.ok) {
        const u = (await r.json()) as { seq: number; changes: Change[] };
        const first = seq === null;
        seq = u.seq;
        if (!first && u.changes.length) for (const l of listeners) l(u.changes);
      }
    }
  } catch {
    /* offline: try again next tick */
  }
  if (listeners.size && !timer) timer = setTimeout(pollUpdates, UPDATES_POLL_MS);
}

function subscribe(l: (changes: Change[]) => void) {
  listeners.add(l);
  if (!timer) timer = setTimeout(pollUpdates, 0);
  return () => {
    listeners.delete(l);
  };
}

/** A counter that bumps when a change matching `query` is reported (debounced), or on the fallback poll.
 * `query` is '' for "anything", or "?notes=<id>" for one note. */
function useLiveTick(query: string | null) {
  const [tick, setTick] = useState(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (query === null) return;
    const want = new URLSearchParams(query).get('notes');
    const bump = () => {
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => setTick((x) => x + 1), 250);
    };
    const stop = subscribe((changes) => {
      if (!want || changes.some((c) => c.notes === null || c.notes.includes(want))) bump();
    });
    const poll = setInterval(() => setTick((x) => x + 1), FALLBACK_POLL_MS);
    return () => {
      stop();
      clearInterval(poll);
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query]);
  return [tick, useCallback(() => setTick((x) => x + 1), [])] as const;
}

export function useNotes(f: NoteFilters) {
  const key = JSON.stringify(f);
  const [tick, refresh] = useLiveTick('');
  const [notes, setNotes] = useState<NoteItem[] | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api
      .notes({ limit: 100, ...f })
      .then((r) => {
        if (live) {
          setNotes(r.notes);
          setError('');
        }
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [key, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return { notes, error, refresh };
}

/** One note, updated the moment the indexer sees a change to it (a CRE report, a subscription, a transfer). */
export function useNote(id: string | undefined) {
  const [tick, refresh] = useLiveTick(id ? `?notes=${encodeURIComponent(id)}` : null);
  const [note, setNote] = useState<NoteDetail | null | undefined>(undefined);
  const [updatedAt, setUpdatedAt] = useState(0);
  useEffect(() => {
    if (!id) {
      setNote(null);
      return;
    }
    let live = true;
    api
      .note(id)
      .then((n) => {
        if (live) {
          setNote(n);
          setUpdatedAt(Date.now());
        }
      })
      .catch(() => {
        if (live) setNote((prev) => (prev === undefined ? null : prev));
      });
    return () => {
      live = false;
    };
  }, [id, tick]);
  return { note, refresh, updatedAt };
}

export function usePortfolio(address: string | undefined) {
  const [tick, refresh] = useLiveTick(address ? '' : null);
  const [positions, setPositions] = useState<PortfolioItem[] | undefined>(undefined);
  const [payouts, setPayouts] = useState<PayoutItem[] | undefined>(undefined);
  useEffect(() => {
    if (!address) {
      setPositions(undefined);
      setPayouts(undefined);
      return;
    }
    let live = true;
    api
      .portfolio(address)
      .then((r) => {
        if (live) {
          setPositions(r.positions);
          setPayouts(r.payouts ?? []);
        }
      })
      .catch(() => {
        if (live) {
          setPositions([]);
          setPayouts([]);
        }
      });
    return () => {
      live = false;
    };
  }, [address, tick]);
  return { positions, payouts, refresh };
}

/** The current time (unix seconds), re-rendered every `ms`. */
export function useNow(ms = 5000) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const defs = new Map<string, Promise<WorkflowDef>>();

/** A note's workflow definition (content-addressed: fetched once per session). */
export function useDefinition(chain: string | undefined, id: string | undefined) {
  const [def, setDef] = useState<WorkflowDef | null>(null);
  useEffect(() => {
    if (!chain || !id) return;
    const key = `${chain}:${id}`;
    if (!defs.has(key)) {
      defs.set(
        key,
        api.definition(chain, id).then((d) => decodeEvmDef(hexToBytes(d.bytes))),
      );
      defs.get(key)!.catch(() => defs.delete(key));
    }
    let live = true;
    defs
      .get(key)!
      .then((d) => {
        if (live) setDef(d);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [chain, id]);
  return def;
}
