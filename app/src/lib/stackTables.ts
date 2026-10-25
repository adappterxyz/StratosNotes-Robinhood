/**
 * Small screens show every data table (`table.t` with a header row) as a stack of labelled cards. CSS does the
 * layout (styles.css, "Tables as cards"); this copies each column's header text onto its cells as `data-label`,
 * for every table the app renders now or later, so no page has to label its cells by hand.
 */
export function labelTables(root: ParentNode = document) {
  for (const table of root.querySelectorAll<HTMLTableElement>('table.t')) {
    const heads = [...table.querySelectorAll('thead tr:last-child th')].map((th) => th.textContent?.trim() ?? '');
    if (!heads.length) continue;
    table.classList.add('stackable');
    for (const row of table.querySelectorAll('tbody tr')) {
      [...row.children].forEach((cell, i) => {
        const label = heads[i] ?? '';
        if ((cell as HTMLElement).dataset.label !== label) (cell as HTMLElement).dataset.label = label;
      });
    }
  }
}

export function watchTables(): () => void {
  let raf = 0;
  const run = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => labelTables());
  };
  run();
  const mo = new MutationObserver(run);
  mo.observe(document.body, { childList: true, subtree: true });
  return () => {
    mo.disconnect();
    cancelAnimationFrame(raf);
  };
}
