/** The guided issue flow's note types, steps and the recorded demo's terms. */
import type { ReactNode } from 'react';
import { ArrowLeftRight, Flame, Layers, Repeat, ShieldCheck, Snowflake } from 'lucide-react';
import { EXAMPLE_PRODUCTS, FEEDS, type ProductParams } from '@sn/core';
import type { NoteKind } from '../../lib/readymade';

export type Kind = NoteKind;
export const PRODUCTS: Array<{ kind: Kind; icon: ReactNode; title: string; line: string }> = [
  { kind: 'fcn', icon: <Repeat />, title: 'Fixed coupon note', line: 'Steady income: the same coupon every period.' },
  {
    kind: 'reverse-convertible',
    icon: <ArrowLeftRight />,
    title: 'Reverse convertible',
    line: 'A higher coupon; may pay back in stock.',
  },
  {
    kind: 'phoenix',
    icon: <Flame />,
    title: 'Phoenix',
    line: 'Coupons while the price stays above a barrier, with memory.',
  },
  {
    kind: 'snowball',
    icon: <Snowflake />,
    title: 'Snowball',
    line: 'The payout grows each period until it is called.',
  },
  {
    kind: 'ppn',
    icon: <ShieldCheck />,
    title: 'Principal-protected',
    line: 'Money back at maturity, plus a share of the upside.',
  },
  {
    kind: 'worst-of',
    icon: <Layers />,
    title: 'Worst-of',
    line: 'Any of these on a basket: the weakest asset decides.',
  },
];
export const STEPS = ['Product', 'Terms', 'Schedule', 'Collateral', 'Review & issue'] as const;

/** The recorded demo's note (?product=reverse-convertible&demo=tsla). */
export const DEMO_TSLA: ProductParams = {
  ...EXAMPLE_PRODUCTS['reverse-convertible'],
  name: 'TSLA Reverse Convertible',
  underlyings: [FEEDS.TSLA],
  settlement: 'cash',
  issuePricePct: 100,
  observations: 2,
  couponRatePct: 2.5,
  knockInBarrierPct: 70,
  collateralChain: 'robinhood',
  collateral: [{ symbol: 'TSLA', haircutPct: 60 }],
  collateralRatioPct: 100,
  defaultRule: 'cap-at-owed',
  payouts: 'claim',
};
