/**
 * Email notifications declared on the BPMN (docs/NOTIFICATIONS.md).
 *
 * A step carries `notify`: a list of declarations, each saying WHEN (the step starts waiting, completes, or is
 * entered), WHO (the issuer, the holders, the subscribers, or the address holding a pool's role), WHICH
 * preference category it belongs to, and WHAT to say: a named template (compact, the usual case) or its own
 * subject and body with {{placeholders}}. Reminders are offsets in seconds before the step's deadline.
 *
 * Declarations are for people, never for the engine: they travel in the definition's META (compile.ts), not its
 * CORE, so the engine runs exactly the same steps with or without them. (They are part of the definition's
 * bytes, so adding or changing them gives the workflow a new id, as any META change does.)
 */
import type { NodeType } from './types';

export type NotifyOn = 'waiting' | 'done' | 'enter';
export type NotifyCategory = 'due' | 'payouts' | 'risk' | 'book';
/** issuer | holders | subscribers | role:<pool name> */
export type NotifyAudience = string;

export interface NotifyDecl {
  on: NotifyOn;
  audience: NotifyAudience;
  category: NotifyCategory;
  /** A built-in template (NOTIFY_TEMPLATES in the notifier), or omit it and give subject + body. */
  template?: string;
  subject?: string;
  body?: string;
  /** Reminders, seconds before the step's deadline (a funding window: its payment date). */
  remind?: number[];
}

export const NOTIFY_CATEGORIES: NotifyCategory[] = ['due', 'payouts', 'risk', 'book'];
export const NOTIFY_CATEGORY_LABEL: Record<NotifyCategory, string> = {
  due: 'Payments I must fund (issuers)',
  payouts: 'Payments I receive (holders)',
  risk: 'Margin calls and defaults',
  book: 'Book and strike updates',
};
/** The placeholders a template may use (the notifier fills them per note, period and recipient). */
export const NOTIFY_PLACEHOLDERS = [
  'note',
  'period',
  'amount',
  'deadline',
  'graceEnds',
  'coverage',
  'link',
  'units',
  'chain',
] as const;
/** Built-in template names (their text lives in the notifier, so a definition only carries the name). */
export const NOTIFY_TEMPLATE_NAMES = [
  'payment-due',
  'payment-missed',
  'margin-call',
  'payment-made',
  'default-holder',
  'default-issuer',
  'collateral-released',
  'strike-fixed',
] as const;
const MAX_REMIND = 30 * 86_400;

/** What is wrong with a step's declarations (empty when fine). */
export function checkNotify(decls: NotifyDecl[], type: NodeType, poolNames: string[]): string[] {
  const out: string[] = [];
  if (!Array.isArray(decls)) return ['notify must be a list'];
  if (decls.length > 6) out.push('at most 6 notifications per step');
  const waits = ['userTask', 'receiveTask', 'intermediateCatchEvent'].includes(type);
  for (const d of decls) {
    if (!['waiting', 'done', 'enter'].includes(d.on)) {
      out.push(`unknown trigger '${String(d.on)}' (waiting, done or enter)`);
      continue;
    }
    if (d.on === 'waiting' && !waits)
      out.push(`'waiting' needs a step that waits (a user task, a receive task or a timer); this is a ${type}`);
    if (d.on === 'enter' && !['exclusiveGateway', 'parallelGateway', 'endEvent'].includes(type))
      out.push(`'enter' is for gateways and end events; use 'done' on a ${type}`);
    const a = String(d.audience ?? '');
    if (
      !['issuer', 'holders', 'subscribers'].includes(a) &&
      !(a.startsWith('role:') && poolNames.includes(a.slice(5)))
    ) {
      out.push(`unknown audience '${a}' (issuer, holders, subscribers or role:<pool>)`);
    }
    if (!NOTIFY_CATEGORIES.includes(d.category))
      out.push(`unknown category '${String(d.category)}' (${NOTIFY_CATEGORIES.join(', ')})`);
    if (d.template !== undefined) {
      if (!(NOTIFY_TEMPLATE_NAMES as readonly string[]).includes(d.template))
        out.push(`unknown template '${d.template}'`);
    } else {
      if (!d.subject?.trim() || !d.body?.trim()) out.push('a notification needs a template, or a subject and a body');
      if ((d.subject?.length ?? 0) > 160) out.push('subject: at most 160 characters');
      if ((d.body?.length ?? 0) > 2000) out.push('body: at most 2,000 characters');
      for (const m of `${d.subject ?? ''} ${d.body ?? ''}`.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
        if (!(NOTIFY_PLACEHOLDERS as readonly string[]).includes(m[1]))
          out.push(`unknown placeholder {{${m[1]}}} (${NOTIFY_PLACEHOLDERS.join(', ')})`);
      }
    }
    if (d.remind !== undefined) {
      if (
        !Array.isArray(d.remind) ||
        d.remind.length > 4 ||
        d.remind.some((r) => !Number.isInteger(r) || r <= 0 || r > MAX_REMIND)
      ) {
        out.push('remind: up to 4 offsets, whole seconds between 1 and 30 days');
      }
    }
  }
  return out;
}

const DAY = 86_400,
  HOUR = 3_600;

/**
 * The notifications a product workflow declares, by step id (instantiate.ts adds them to the BPMN; the notifier
 * also uses this for notes whose definitions carry none, e.g. those issued before notifications existed):
 *  - Fund Payment k (issuer, waiting): payment due, with reminders a day and two hours before the payment date
 *  - Grace k (issuer, waiting): the payment was missed, grace ends at …
 *  - Await Top-up (issuer, waiting): a margin call
 *  - Pay … k (holders, done): you were paid
 *  - Default (holders and issuer, done)
 *  - Release Collateral (issuer, done)
 *  - Fix Strike (subscribers, done): the book has closed
 */
export function productNotifications(stepId: string): NotifyDecl[] | undefined {
  if (/^Task_Fund\d+$/.test(stepId))
    return [{ on: 'waiting', audience: 'issuer', category: 'due', template: 'payment-due', remind: [DAY, 2 * HOUR] }];
  if (/^Recv_Grace\d+/.test(stepId))
    return [{ on: 'waiting', audience: 'issuer', category: 'risk', template: 'payment-missed' }];
  if (/^Recv_MarginCure\d+$/.test(stepId))
    return [{ on: 'waiting', audience: 'issuer', category: 'risk', template: 'margin-call' }];
  if (/^Task_Pay\d+/.test(stepId))
    return [{ on: 'done', audience: 'holders', category: 'payouts', template: 'payment-made' }];
  if (stepId === 'Task_Default')
    return [
      { on: 'done', audience: 'holders', category: 'risk', template: 'default-holder' },
      { on: 'done', audience: 'issuer', category: 'risk', template: 'default-issuer' },
    ];
  if (stepId === 'Task_Release')
    return [{ on: 'done', audience: 'issuer', category: 'due', template: 'collateral-released' }];
  if (stepId === 'Task_FixStrike')
    return [{ on: 'done', audience: 'subscribers', category: 'book', template: 'strike-fixed' }];
  return undefined;
}
