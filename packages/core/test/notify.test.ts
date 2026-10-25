import { describe, expect, it } from 'vitest';
import {
  checkNotify,
  compile,
  compileTemplate,
  decodeDef,
  defToIR,
  draftToIR,
  EXAMPLE_PRODUCTS,
  evmCoreLength,
  instantiateProduct,
  irToBpmn,
  irToDraft,
  parseBpmn,
  productNotifications,
  validate,
  type NotifyDecl,
} from '../src';

const prod = instantiateProduct(EXAMPLE_PRODUCTS.phoenix);
const ir = parseBpmn(prod.bpmnXml, prod.assets);

describe('notifications declared on the BPMN', () => {
  it('products declare the payment cycle: funding due, grace, margin call, paid, default, release, strike', () => {
    const on = (id: string) => ir.nodes.find((n) => n.id === id)?.props.notify;
    expect(on('Task_Fund1')).toEqual([
      { on: 'waiting', audience: 'issuer', category: 'due', template: 'payment-due', remind: [86_400, 7_200] },
    ]);
    expect(on('Recv_Grace1')?.[0].template).toBe('payment-missed');
    expect(on('Recv_MarginCure0')?.[0].template).toBe('margin-call');
    expect(on('Task_Pay1')?.[0]).toMatchObject({ on: 'done', audience: 'holders', category: 'payouts' });
    expect(on('Task_Default')?.map((d) => d.audience)).toEqual(['holders', 'issuer']);
    expect(on('Task_Release')?.[0].template).toBe('collateral-released');
    expect(on('Task_FixStrike')?.[0].audience).toBe('subscribers');
    expect(validate(ir).errors).toEqual([]);
  });

  it('round-trips through BPMN, the draft format and the on-chain definition', () => {
    const again = parseBpmn(irToBpmn(draftToIR(irToDraft(ir))).bpmnXml, prod.assets);
    expect(again.nodes.find((n) => n.id === 'Task_Fund2')?.props.notify).toEqual(productNotifications('Task_Fund2'));
    const c = compile(ir, { product: prod.params });
    const fromChain = defToIR(decodeDef(c.bytes));
    expect(fromChain.nodes.find((n) => n.id === 'Task_Default')?.props.notify).toEqual(
      productNotifications('Task_Default'),
    );
  });

  it('lives in META only: the engine runs the same CORE with or without notifications', () => {
    const stripped = { ...ir, nodes: ir.nodes.map((n) => ({ ...n, props: { ...n.props, notify: undefined } })) };
    const a = compile(ir, { product: prod.params }).bytes,
      b = compile(stripped, { product: prod.params }).bytes;
    expect(Buffer.from(a.subarray(0, evmCoreLength(a))).equals(Buffer.from(b.subarray(0, evmCoreLength(b))))).toBe(
      true,
    );
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false); // META differs, so the id does
    expect(compileTemplate({ product: EXAMPLE_PRODUCTS.fcn }).def.meta).toContain('"notify"');
  });

  it('checks declarations', () => {
    const bad = (d: Partial<NotifyDecl>, type: Parameters<typeof checkNotify>[1] = 'userTask') =>
      checkNotify(
        [{ on: 'done', audience: 'issuer', category: 'due', template: 'payment-due', ...d } as NotifyDecl],
        type,
        ['Issuer'],
      );
    expect(bad({})).toEqual([]);
    expect(bad({ audience: 'role:Issuer' })).toEqual([]);
    expect(bad({ audience: 'everyone' })[0]).toMatch(/unknown audience/);
    expect(bad({ on: 'waiting' }, 'serviceTask')[0]).toMatch(/needs a step that waits/);
    expect(bad({ on: 'enter' }, 'serviceTask')[0]).toMatch(/gateways and end events/);
    expect(bad({ template: undefined, subject: 'Hi {{nope}}', body: 'x' })[0]).toMatch(/unknown placeholder/);
    expect(bad({ template: undefined, subject: 'Paid {{amount}}', body: 'On {{note}}' })).toEqual([]);
    expect(bad({ remind: [0] })[0]).toMatch(/remind/);
    expect(bad({ category: 'spam' as never })[0]).toMatch(/unknown category/);
    const withBad = {
      ...ir,
      nodes: ir.nodes.map((n) =>
        n.id === 'Task_Pay1'
          ? {
              ...n,
              props: {
                ...n.props,
                notify: [
                  { on: 'waiting', audience: 'holders', category: 'payouts', template: 'payment-made' } as NotifyDecl,
                ],
              },
            }
          : n,
      ),
    };
    expect(validate(withBad).errors.map((e) => e.code)).toContain('BAD_NOTIFY');
  });
});
