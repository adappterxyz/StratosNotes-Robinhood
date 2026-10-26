/**
 * Properties of the selected element: what the engine does at this step.
 * Fields (entered, computed, or a Chainlink price), timers and subscription
 * windows, the receive guard, asset operations; for a sequence flow out of a
 * gateway, its condition and whether it is the default.
 */
import { useEffect, useState } from 'react';
import {
  ASSET_CLASSES,
  FEED_CATALOGUE,
  FEEDS,
  type AssetOperation,
  type FieldType,
  type NodeProps,
  type TemplateField,
} from '@sn/core';
import { readProps, setDefaultFlow, writeCondition, writeProps } from '../lib/bpmnProps';

/* eslint-disable @typescript-eslint/no-explicit-any */
const TYPES: FieldType[] = ['Decimal', 'Int', 'Date', 'Text', 'Party', 'Bool'];
const OPS: AssetOperation['operation'][] = ['deposit', 'mint', 'transfer', 'swap', 'distribute', 'burn'];

const kindOf = (t: string) => t.replace('bpmn:', '');

export default function PropertiesPanel({
  modeler,
  element,
  fieldNames,
  dateFields,
  pools,
  assets,
  version,
}: {
  modeler: any;
  element: any | null;
  fieldNames: string[];
  dateFields: string[];
  pools: string[];
  assets: string[];
  version: number;
}) {
  const [props, setProps] = useState<NodeProps>({});
  const [name, setName] = useState('');
  const [cond, setCond] = useState('');
  useEffect(() => {
    if (!element) return;
    setProps(readProps(element.businessObject));
    setName(element.businessObject.name ?? '');
    setCond(element.businessObject.conditionExpression?.body ?? '');
  }, [element, version]);

  if (!element)
    return (
      <div className="card small muted">
        Select a step, gateway or flow to edit what it does. Every change is checked against the compiler as you go.
      </div>
    );
  const type = kindOf(element.type);
  const save = (p: NodeProps) => {
    setProps(p);
    writeProps(modeler, element, p);
  };

  if (type === 'SequenceFlow') {
    const src = element.source;
    const isGateway = kindOf(src?.type ?? '') === 'ExclusiveGateway';
    const isDefault = src?.businessObject?.default?.id === element.id;
    return (
      <div className="card stack">
        <span className="label">Sequence flow</span>
        <div className="field">
          <label htmlFor="pp-flow-name">Label</label>
          <input
            id="pp-flow-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => modeler.get('modeling').updateLabel(element, name)}
          />
        </div>
        {isGateway ? (
          <>
            <div className="field">
              <label htmlFor="pp-cond">Condition</label>
              <input
                id="pp-cond"
                className="num"
                value={cond}
                placeholder="obs2 >= initialLevel * 100 / 100"
                onChange={(e) => setCond(e.target.value)}
                onBlur={() => writeCondition(modeler, element, cond)}
              />
              <span className="hint">
                Over workflow fields: + - * /, comparisons, and/or. Fields: {fieldNames.join(', ') || 'none yet'}
              </span>
            </div>
            <label className="row small">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setDefaultFlow(modeler, src, e.target.checked ? element : null)}
              />{' '}
              Default branch (taken when no condition holds)
            </label>
          </>
        ) : (
          <p className="small muted m-0">Conditions apply on flows out of an exclusive gateway.</p>
        )}
      </div>
    );
  }
  if (
    ![
      'UserTask',
      'ServiceTask',
      'ReceiveTask',
      'Task',
      'StartEvent',
      'EndEvent',
      'ExclusiveGateway',
      'ParallelGateway',
      'IntermediateCatchEvent',
    ].includes(type)
  ) {
    return <div className="card small muted">{type}: nothing to configure.</div>;
  }
  const fields = props.templateFields ?? [];
  const ops = [...(props.assetOperation ? [props.assetOperation] : []), ...(props.assetOperations ?? [])];
  const setFields = (f: TemplateField[]) => save({ ...props, templateFields: f });
  const setOps = (o: AssetOperation[]) => {
    const { assetOperation: _a, assetOperations: _b, ...rest } = props;
    save({ ...rest, ...(o.length === 1 ? { assetOperation: o[0] } : o.length ? { assetOperations: o } : {}) });
  };
  const isTask = ['UserTask', 'ServiceTask', 'ReceiveTask', 'Task'].includes(type);

  return (
    <div className="card stack">
      <span className="label">{type.replace(/([a-z])([A-Z])/g, '$1 $2')}</span>
      <div className="field">
        <label htmlFor="pp-name">Name</label>
        <input
          id="pp-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => modeler.get('modeling').updateLabel(element, name)}
        />
      </div>

      {isTask && (
        <section className="stack gap-8">
          <div className="spread">
            <h3>Fields</h3>
            <button
              className="btn ghost small"
              onClick={() => setFields([...fields, { name: `field${fields.length + 1}`, type: 'Decimal' }])}
            >
              Add field
            </button>
          </div>
          {fields.length === 0 && (
            <p className="small muted m-0">
              No fields.{' '}
              {type === 'UserTask'
                ? 'A person enters fields here.'
                : 'Automatic steps compute fields or observe a price.'}
            </p>
          )}
          {fields.map((f, i) => {
            const src = f.oracle ? 'oracle' : f.formula ? 'formula' : 'input';
            const upd = (patch: Partial<TemplateField>) =>
              setFields(fields.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <div key={i} className="stack gap-6 boxed">
                <div className="row field-row flex-nowrap">
                  <input
                    aria-label="Field name"
                    className="num field-name"
                    value={f.name}
                    onChange={(e) => upd({ name: e.target.value })}
                  />
                  <select
                    aria-label="Field type"
                    className="field-type"
                    value={f.type}
                    onChange={(e) => upd({ type: e.target.value as FieldType })}
                  >
                    {TYPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  <button
                    className="btn ghost small"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setFields(fields.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
                <select
                  aria-label="Where the value comes from"
                  value={src}
                  onChange={(e) => {
                    const v = e.target.value;
                    const { formula: _f, oracle: _o, ...base } = f;
                    const next: TemplateField =
                      v === 'formula'
                        ? { ...base, formula: '0' }
                        : v === 'oracle'
                          ? {
                              ...base,
                              type: 'Decimal',
                              oracle: {
                                feed: FEEDS.ETH.feed,
                                feedChain: FEEDS.ETH.feedChain,
                                min: String(FEEDS.ETH.minPrice),
                                max: String(FEEDS.ETH.maxPrice),
                                staleness: 3600,
                              },
                            }
                          : base;
                    setFields(fields.map((x, j) => (j === i ? next : x)));
                  }}
                >
                  <option value="input">Entered by the person running the step</option>
                  <option value="formula">Computed by a formula</option>
                  <option value="oracle">Chainlink price, delivered by CRE</option>
                </select>
                {f.formula !== undefined && (
                  <input
                    aria-label="Formula"
                    className="num"
                    value={f.formula}
                    onChange={(e) => upd({ formula: e.target.value })}
                  />
                )}
                {f.oracle && (
                  <select
                    aria-label="Price feed"
                    value={f.oracle.feed}
                    onChange={(e) => {
                      const k = (Object.keys(FEEDS) as Array<keyof typeof FEEDS>).find(
                        (x) => FEEDS[x].feed === e.target.value,
                      )!;
                      upd({
                        oracle: {
                          ...f.oracle!,
                          feed: FEEDS[k].feed,
                          feedChain: FEEDS[k].feedChain,
                          min: String(FEEDS[k].minPrice),
                          max: String(FEEDS[k].maxPrice),
                          staleness: FEEDS[k].staleness,
                        },
                      });
                    }}
                  >
                    {ASSET_CLASSES.map((c) => (
                      <optgroup key={c} label={c}>
                        {FEED_CATALOGUE.filter((x) => x.assetClass === c).map((x) => (
                          <option key={x.symbol} value={x.feed}>
                            {x.symbol}/USD
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </section>
      )}

      {(isTask || type === 'IntermediateCatchEvent') && (
        <div className="field">
          <label htmlFor="pp-timer">Wait until (Date field)</label>
          <select
            id="pp-timer"
            value={props.timer?.dateField ?? ''}
            onChange={(e) => save({ ...props, timer: e.target.value ? { dateField: e.target.value } : undefined })}
          >
            <option value="">No timer</option>
            {dateFields.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </div>
      )}
      {type === 'UserTask' && (
        <div className="field">
          <label htmlFor="pp-until">Repeatable until (Date field)</label>
          <select
            id="pp-until"
            value={props.until?.dateField ?? ''}
            onChange={(e) => save({ ...props, until: e.target.value ? { dateField: e.target.value } : undefined })}
          >
            <option value="">Runs once</option>
            {dateFields.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
          <span className="hint">
            For a subscription book: anyone holding the role can run it again until that date.
          </span>
        </div>
      )}
      {type === 'ReceiveTask' && (
        <div className="field">
          <label htmlFor="pp-guard">Accept only when</label>
          <input
            id="pp-guard"
            className="num"
            value={props.receiveGuard ?? ''}
            placeholder="notional > 0"
            onChange={(e) => setProps({ ...props, receiveGuard: e.target.value })}
            onBlur={() => save({ ...props, receiveGuard: props.receiveGuard?.trim() || undefined })}
          />
        </div>
      )}

      {isTask && (
        <section className="stack gap-8">
          <div className="spread">
            <h3>Payments</h3>
            <button
              className="btn ghost small"
              onClick={() =>
                setOps([
                  ...ops,
                  {
                    assetId: assets[0] ?? 'cash',
                    operation: 'distribute',
                    params: { amountSource: 'expr', amountExpr: '0' },
                  },
                ])
              }
            >
              Add
            </button>
          </div>
          {ops.map((o, i) => {
            const upd = (patch: Partial<AssetOperation>) =>
              setOps(ops.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            const prm = (patch: Partial<AssetOperation['params']>) => upd({ params: { ...o.params, ...patch } });
            const party = (k: keyof AssetOperation['params'], label: string) => (
              <select
                aria-label={label}
                value={String(o.params[k] ?? '')}
                onChange={(e) => prm({ [k]: e.target.value })}
              >
                <option value="">{label}…</option>
                {pools.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            );
            return (
              <div key={i} className="stack gap-6 boxed">
                <div className="row flex-nowrap">
                  <select
                    aria-label="Operation"
                    value={o.operation}
                    onChange={(e) => upd({ operation: e.target.value as AssetOperation['operation'] })}
                  >
                    {OPS.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                  <select aria-label="Asset" value={o.assetId} onChange={(e) => upd({ assetId: e.target.value })}>
                    {assets.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                  <button
                    className="btn ghost small"
                    aria-label="Remove payment"
                    onClick={() => setOps(ops.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
                <input
                  aria-label="Amount expression"
                  className="num"
                  value={o.params.amountExpr ?? o.params.amountField ?? o.params.amount ?? ''}
                  onChange={(e) =>
                    prm({ amountSource: 'expr', amountExpr: e.target.value, amountField: undefined, amount: undefined })
                  }
                  placeholder={
                    o.operation === 'distribute' ? 'per unit, e.g. 2 / 100' : 'amount, e.g. units * 100 / 100'
                  }
                />
                {o.operation === 'mint' && party('owner', 'To')}
                {o.operation === 'transfer' && (
                  <div className="row">
                    {party('from', 'From')}
                    {party('to', 'To')}
                  </div>
                )}
                {o.operation === 'distribute' && (
                  <div className="row">
                    {party('payer', 'Paid by')}
                    <select
                      aria-label="To holders of"
                      value={o.params.holdingAssetId ?? ''}
                      onChange={(e) => prm({ holdingAssetId: e.target.value })}
                    >
                      <option value="">Holders of…</option>
                      {assets.map((a) => (
                        <option key={a}>{a}</option>
                      ))}
                    </select>
                    <label className="row small">
                      <input
                        type="checkbox"
                        checked={!!o.params.retire}
                        onChange={(e) => prm({ retire: e.target.checked })}
                      />{' '}
                      Redeem units
                    </label>
                  </div>
                )}
                {o.operation === 'swap' && (
                  <div className="stack gap-6">
                    <div className="row">
                      {party('deliveryParty', 'Delivers')}
                      {party('paymentParty', 'Pays')}
                    </div>
                    <div className="row flex-nowrap">
                      <select
                        aria-label="Paid in"
                        value={o.params.counterAssetId ?? ''}
                        onChange={(e) => prm({ counterAssetId: e.target.value })}
                      >
                        <option value="">Paid in…</option>
                        {assets.map((a) => (
                          <option key={a}>{a}</option>
                        ))}
                      </select>
                      <input
                        aria-label="Payment amount"
                        className="num"
                        value={o.params.counterAmountExpr ?? ''}
                        placeholder="payment, e.g. units"
                        onChange={(e) => prm({ counterAmountSource: 'expr', counterAmountExpr: e.target.value })}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
