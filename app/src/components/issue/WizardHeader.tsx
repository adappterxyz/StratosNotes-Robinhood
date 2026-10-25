import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { STEPS } from './wizard-data';

/** Breadcrumbs and the step bar; a step already done can be reopened. */
export function WizardHeader({ title, step, setStep }: { title: string; step: number; setStep: (s: number) => void }) {
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/issue">Issue</Link>
        <span aria-hidden="true">/</span>
        <span>{title}</span>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{STEPS[step]}</span>
      </nav>
      <ol className="iw-progress" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={i < step ? 'done' : i === step ? 'now' : ''}
            aria-current={i === step ? 'step' : undefined}
          >
            <button disabled={i > step} onClick={() => setStep(i)}>
              <span className="n">{i < step ? <Check className="i" /> : i + 1}</span>
              {s}
            </button>
          </li>
        ))}
      </ol>
    </>
  );
}
