/**
 * Asset marks: a small neutral circle with the asset's logo, next to its ticker (the ticker always stays as text).
 *
 * Marks come from simple-icons (CC0-1.0): Bitcoin, Ethereum (also for WETH), Solana, Tesla, NVIDIA, Apple, Netflix,
 * AMD, Palantir, Meta, Google, Coinbase, and the catalogue underlyings simple-icons has (Chainlink, Dogecoin, Intel…).
 * They identify the asset (nominative use); trademarks belong to their owners. Where no openly licensed mark exists
 * (AMZN, SPY, MSFT, USDG, HYPE, most catalogue symbols) a plain text badge is shown instead of a lookalike: the
 * currency sign for forex, the element for metals (Au, Ag), else the ticker. Sources: app/public/assets/SOURCES.md.
 *
 * Variants: tUSD (the retired test dollar older notes settle in) carries a small "t" tag; receipts for collateral
 * held on another chain (planned; a token name with a chain suffix, e.g. USDC.eth) carry a small tag.
 */
import {
  siAlibabadotcom,
  siAmd,
  siApple,
  siBitcoin,
  siBnbchain,
  siCardano,
  siChainlink,
  siCircle,
  siCoinbase,
  siDell,
  siDogecoin,
  siEns,
  siEthereum,
  siGmx,
  siGoogle,
  siIntel,
  siLitecoin,
  siMeta,
  siMonero,
  siNear,
  siNetflix,
  siNvidia,
  siOptimism,
  siPalantir,
  siPolkadot,
  siPolygon,
  siSolana,
  siSui,
  siTesla,
  siTon,
  siXrp,
  siZcash,
} from 'simple-icons';

type Mark = { path: string; hex: string; title: string };
const MARKS: Record<string, Mark> = {
  BTC: { path: siBitcoin.path, hex: siBitcoin.hex, title: 'Bitcoin' },
  ETH: { path: siEthereum.path, hex: siEthereum.hex, title: 'Ethereum' },
  SOL: { path: siSolana.path, hex: siSolana.hex, title: 'Solana' },
  TSLA: { path: siTesla.path, hex: siTesla.hex, title: 'Tesla' },
  NVDA: { path: siNvidia.path, hex: siNvidia.hex, title: 'NVIDIA' },
  AAPL: { path: siApple.path, hex: siApple.hex, title: 'Apple' },
  NFLX: { path: siNetflix.path, hex: siNetflix.hex, title: 'Netflix' },
  AMD: { path: siAmd.path, hex: siAmd.hex, title: 'AMD' },
  PLTR: { path: siPalantir.path, hex: siPalantir.hex, title: 'Palantir' },
  META: { path: siMeta.path, hex: siMeta.hex, title: 'Meta' },
  GOOGL: { path: siGoogle.path, hex: siGoogle.hex, title: 'Alphabet (Google)' },
  COIN: { path: siCoinbase.path, hex: siCoinbase.hex, title: 'Coinbase' },
  WETH: { path: siEthereum.path, hex: siEthereum.hex, title: 'Wrapped Ether (WETH)' },
  // Catalogue underlyings (packages/core/src/products/feeds-catalogue.ts) with an openly licensed mark.
  LINK: { path: siChainlink.path, hex: siChainlink.hex, title: 'Chainlink' },
  DOGE: { path: siDogecoin.path, hex: siDogecoin.hex, title: 'Dogecoin' },
  LTC: { path: siLitecoin.path, hex: siLitecoin.hex, title: 'Litecoin' },
  XRP: { path: siXrp.path, hex: siXrp.hex, title: 'XRP' },
  ADA: { path: siCardano.path, hex: siCardano.hex, title: 'Cardano' },
  DOT: { path: siPolkadot.path, hex: siPolkadot.hex, title: 'Polkadot' },
  BNB: { path: siBnbchain.path, hex: siBnbchain.hex, title: 'BNB' },
  POL: { path: siPolygon.path, hex: siPolygon.hex, title: 'Polygon (POL)' },
  OP: { path: siOptimism.path, hex: siOptimism.hex, title: 'Optimism' },
  XMR: { path: siMonero.path, hex: siMonero.hex, title: 'Monero' },
  TON: { path: siTon.path, hex: siTon.hex, title: 'Toncoin' },
  SUI: { path: siSui.path, hex: siSui.hex, title: 'Sui' },
  NEAR: { path: siNear.path, hex: siNear.hex, title: 'NEAR Protocol' },
  ZEC: { path: siZcash.path, hex: siZcash.hex, title: 'Zcash' },
  ENS: { path: siEns.path, hex: siEns.hex, title: 'Ethereum Name Service' },
  GMX: { path: siGmx.path, hex: siGmx.hex, title: 'GMX' },
  INTC: { path: siIntel.path, hex: siIntel.hex, title: 'Intel' },
  BABA: { path: siAlibabadotcom.path, hex: siAlibabadotcom.hex, title: 'Alibaba' },
  DELL: { path: siDell.path, hex: siDell.hex, title: 'Dell Technologies' },
  CRCL: { path: siCircle.path, hex: siCircle.hex, title: 'Circle' },
};
/** No openly licensed mark: a short text badge (never a drawn lookalike). */
const BADGES: Record<string, string> = {
  AMZN: 'AMZN',
  SPY: 'S&P',
  MSFT: 'MSFT',
  USDG: '$G',
  USDC: '$C',
  TUSD: '$t',
  HYPE: 'HY',
  // Forex (the currency's sign) and metals (the element): no logo exists.
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CNY: '元',
  KRW: '₩',
  CHF: 'Fr',
  AUD: 'A$',
  NZD: 'NZ$',
  CAD: 'C$',
  SGD: 'S$',
  HKD: 'HK$',
  SEK: 'kr',
  MXN: 'M$',
  BRL: 'R$',
  TRY: '₺',
  IDR: 'Rp',
  PHP: '₱',
  ARS: 'AR$',
  INR: '₹',
  XAU: 'Au',
  XAG: 'Ag',
};

/** "tUSD" -> { base: TUSD, test }, "USDC.eth" -> { base: USDC, remote }, "USDG" -> { base: USDG }. */
export function parseAsset(sym: string): { base: string; test: boolean; remote: boolean } {
  let s = sym.trim();
  const remote = /\.[a-z]+$/.test(s);
  if (remote) s = s.replace(/\.[a-z]+$/, '');
  if (s === 'tUSD') return { base: 'TUSD', test: true, remote };
  return { base: s.toUpperCase(), test: false, remote };
}

export function AssetIcon({ sym, size = 18, title }: { sym: string; size?: number; title?: string }) {
  const { base, test, remote } = parseAsset(sym);
  const mark = MARKS[base];
  const label =
    title ??
    `${mark?.title ?? base}${test ? ' (retired test dollar)' : ''}${remote ? ' (locked on another chain)' : ''}`;
  return (
    <span className="asset-ic" style={{ width: size, height: size }} role="img" aria-label={label} title={label}>
      {mark ? (
        <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} aria-hidden="true">
          <path d={mark.path} fill={`#${mark.hex}`} />
        </svg>
      ) : (
        <span
          className="asset-badge"
          style={{ fontSize: Math.max(7, size * (BADGES[base]?.length > 2 ? 0.3 : 0.38)) }}
          aria-hidden="true"
        >
          {BADGES[base] ?? base.slice(0, 3)}
        </span>
      )}
      {test && (
        <span className="asset-tag t" aria-hidden="true">
          t
        </span>
      )}
      {remote && (
        <span className="asset-tag t" aria-hidden="true">
          x
        </span>
      )}
    </span>
  );
}

/** Ticker with its mark: the ticker text always stays. */
export function Asset({ sym, size = 18, className }: { sym: string; size?: number; className?: string }) {
  return (
    <span className={`asset ${className ?? ''}`}>
      <AssetIcon sym={sym} size={size} />
      <span className="asset-sym">{sym}</span>
    </span>
  );
}

/** A worst-of basket: overlapping marks, then the tickers. */
export function AssetStack({ syms, size = 20, label = true }: { syms: string[]; size?: number; label?: boolean }) {
  if (!syms.length) return null;
  return (
    <span className="asset-stack">
      <span className="asset-stack-ics" style={{ marginRight: syms.length > 1 ? 2 : 0 }}>
        {syms.map((s, i) => (
          <span key={s} style={{ marginLeft: i ? -size * 0.32 : 0, zIndex: syms.length - i }}>
            <AssetIcon sym={s} size={size} />
          </span>
        ))}
      </span>
      {label && <span className="asset-sym">{syms.length > 1 ? `worst of ${syms.join(', ')}` : syms[0]}</span>}
    </span>
  );
}
