/** The term sheet's validation errors, if any. */
export function TermErrors({ errors }: { errors: string[] }) {
  if (!errors.length) return null;
  return (
    <ul className="issues">
      {errors.map((e) => (
        <li key={e} className="err">
          {e}
        </li>
      ))}
    </ul>
  );
}
