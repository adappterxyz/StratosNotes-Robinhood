/** A labelled number input with an optional unit suffix and hint. */
export function Num({
  id,
  label,
  value,
  onChange,
  hint,
  suffix,
  step = 'any',
  min,
}: {
  id: string;
  label: string;
  value: number | undefined;
  onChange: (v: number) => void;
  hint?: string;
  suffix?: string;
  step?: string;
  min?: number;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="with-suffix">
        <input
          id={id}
          type="number"
          step={step}
          min={min}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
        />
        {suffix && <span className="suffix">{suffix}</span>}
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
