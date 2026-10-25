/** A stage's heading, with an optional one-line explanation. */
export const Head = ({ title, sub }: { title: string; sub?: string }) => (
  <div className="section">
    <h2>{title}</h2>
    {sub && <p className="xs muted">{sub}</p>}
  </div>
);
