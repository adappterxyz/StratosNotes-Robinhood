/**
 * The term sheet of a real note from /api/notes, shown only when it is a fair example to verify: issued on Robinhood
 * Chain testnet, settled in USDG, and on a real schedule (not a compressed demo of minutes or days). An open
 * book first, then a running note. Without one (or while the API is down) it shows the same rows as an illustrative
 * sheet with no numbers in it. The coupon is annualised the way
 * the app does it (app/src/lib/listing.ts): coupon per period times the periods in a year, where a compressed demo
 * schedule uses the designed term from the name ("12M …", 12 months by default).
 */
import { useEffect, useState } from 'react';

const MONTH = 30.44 * 86400;
const YEAR = 365.25 * 86400;

type Underlying = { symbol: string };
type Params = {
  name: string;
  productType: string;
  observations: number;
  underlyings: Underlying[];
  couponRatePct?: number;
  autocallLevelPct?: number;
  knockInBarrierPct?: number;
  protectionPct?: number;
  participationPct?: number;
};
type NoteView = {
  id: string;
  chain: string;
  name: string;
  phase: string;
  label?: string;
  params: Params;
  strikeDate?: number;
  obsDates?: number[];
  economics?: { ratio?: number; collateral?: Array<{ symbol: string; amount: number }> };
  cashToken?: string;
};
/** Paxos USDG on Robinhood Chain testnet: the only cash a showcased note may settle in. */
const USDG_ROBINHOOD = '0x7e955252e15c84f5768b83c41a71f9eba181802f';
type Chain = { key: string; explorer?: string; engine?: string };

const STATUS: Record<string, string> = {
  book: 'Open for subscription',
  redeemed: 'Paid in full',
  defaulted: 'Defaulted',
};

function schedule(v: NoteView) {
  const p = v.params,
    n = Math.max(1, p.observations);
  const end = v.obsDates?.[v.obsDates.length - 1];
  const term = v.strikeDate && end ? end - v.strikeDate : null;
  if (term && term >= MONTH) return { periodSec: term / n, termSec: term, demo: false };
  const m = /(\d+)\s*M\b/i.exec(p.name);
  const months = m ? Number(m[1]) : 12;
  return { periodSec: (months * MONTH) / n, termSec: term ?? months * MONTH, demo: !!term };
}

const pct = (x: number) => `${Number(x.toFixed(2))}%`;
const fmtDate = (s: number) =>
  new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
function every(sec: number) {
  const m = Math.round(sec / MONTH);
  if (sec / MONTH >= 0.9)
    return m === 1 ? 'monthly' : m === 3 ? 'quarterly' : m === 12 ? 'yearly' : `every ${m} months`;
  const d = Math.round(sec / 86400);
  return d <= 1 ? 'daily' : `every ${d} days`;
}
function term(sec: number, demo: boolean) {
  if (demo) {
    const d = sec / 86400;
    return d >= 1
      ? `About ${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'} (demo schedule)`
      : `About ${Math.max(1, Math.round(sec / 3600))} hours (demo schedule)`;
  }
  const m = Math.round(sec / MONTH);
  return m === 1 ? '1 month' : `${m} months`;
}
const cashName = (s: string) => (s === 'USD' ? 'USDG' : s.replace(/\.rh$/i, ''));

type Row = [string, string];

function rowsOf(v: NoteView, now: number): { rows: Row[]; next: string | null } {
  const p = v.params,
    s = schedule(v);
  const rows: Row[] = [];
  if (p.productType === 'ppn')
    rows.push(['Protection', `${p.protectionPct ?? 100}% + ${p.participationPct ?? 0}% of the upside`]);
  else if (p.couponRatePct)
    rows.push([
      'Coupon',
      `${pct(p.couponRatePct * (YEAR / s.periodSec))} p.a.${s.demo ? ' (est.)' : ` · ${p.productType === 'snowball' ? 'paid at redemption' : every(s.periodSec)}`}`,
    ]);
  rows.push(['Tenor', term(s.termSec, s.demo)]);
  if (p.autocallLevelPct) rows.push(['Autocall level', `${p.autocallLevelPct}% of strike`]);
  if (p.knockInBarrierPct) rows.push(['Knock-in barrier', `${p.knockInBarrierPct}% of strike`]);
  const col = v.economics?.collateral ?? [];
  if (col.length) {
    const ratio = v.economics?.ratio;
    rows.push([
      'Collateral pledged',
      col
        .map((c) => `${c.amount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${cashName(c.symbol)}`)
        .join(' + ') + (ratio ? ` · ${Math.round(ratio * 100)}% ratio` : ''),
    ]);
  }
  const nxt = v.obsDates?.find((d) => d > now);
  return { rows, next: nxt ? fmtDate(nxt) : null };
}

/** A note worth showing: on Robinhood Chain, in USDG, on a real schedule (at least a month to maturity). */
const showcase = (n: NoteView) =>
  n.chain === 'robinhood-testnet' &&
  n.cashToken?.toLowerCase() === USDG_ROBINHOOD &&
  !schedule(n).demo &&
  !!n.strikeDate &&
  !!n.obsDates?.length;

function pick(notes: NoteView[]) {
  const ok = notes.filter(showcase);
  return (
    ok.find((n) => n.phase === 'book') ?? ok.find((n) => !['book', 'redeemed', 'defaulted'].includes(n.phase)) ?? null
  );
}

export default function TermSheet() {
  const [note, setNote] = useState<NoteView | null>(null);
  const [verify, setVerify] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch('/api/notes');
        if (!r.ok) return;
        const d = (await r.json()) as { notes?: Array<{ view?: NoteView }> };
        const v = pick((d.notes ?? []).map((n) => n.view).filter((x): x is NoteView => !!x?.params));
        if (!live || !v) return;
        setNote(v);
        setVerify(`/app/note/${encodeURIComponent(v.id)}`);
        const c = (await fetch('/api/config')
          .then((x) => (x.ok ? x.json() : null))
          .catch(() => null)) as { chains?: Chain[] } | null;
        const ch = c?.chains?.find((x) => x.key === v.chain);
        const engine = v.id.split(':')[1];
        if (live && ch?.explorer && engine) setVerify(`${ch.explorer}/address/${engine}`);
      } catch {
        /* the illustrative sheet stands */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (!note) {
    const rows: Row[] = [
      ['Coupon', 'Fixed by the issuer, % p.a.'],
      ['Tenor', 'Set by the issuer'],
      ['Autocall level', '% of strike'],
      ['Knock-in barrier', '% of strike'],
      ['Collateral pledged', 'Amount, token and ratio'],
    ];
    return (
      <article className="ts-card" aria-label="Term sheet, illustrative">
        <div className="ts-top">
          <span className="ts-label">Term sheet · Illustrative</span>
        </div>
        <h3>Fixed Coupon Note</h3>
        <dl className="ts-rows">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className="ts-ill">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="ts-foot">
          <span>Next observation · on the note's schedule</span>
          <a href="/app/">Browse live notes →</a>
        </div>
      </article>
    );
  }
  const { rows, next } = rowsOf(note, Date.now() / 1000);
  const status = STATUS[note.phase] ?? 'Running';
  return (
    <article className="ts-card" aria-label={`Term sheet: ${note.name}`}>
      <div className="ts-top">
        <span className="ts-label">Term sheet · Live</span>
        <span className={`ts-pill${note.phase === 'book' ? ' open' : ''}`}>{status}</span>
      </div>
      <h3>{note.name}</h3>
      <dl className="ts-rows">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="num">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="ts-foot">
        <span>Next observation · {next ?? 'none left'}</span>
        {verify && (
          <a href={verify} target={verify.startsWith('http') ? '_blank' : undefined} rel="noopener">
            Verify onchain →
          </a>
        )}
      </div>
    </article>
  );
}
