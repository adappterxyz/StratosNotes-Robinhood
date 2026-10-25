import { ExternalLink } from 'lucide-react';
import { ccipLink } from './shared';

/** A transaction's status line, with a link to follow its Chainlink CCIP message once there is one. */
export function CcipStatus({ state }: { state: { text: string; bad?: boolean; msg?: string } }) {
  if (!state.text) return null;
  return (
    <div role="status" className={`xs ${state.bad ? 'bad' : 'muted'}`}>
      {state.text}{' '}
      {state.msg && (
        <a href={ccipLink(state.msg)} target="_blank" rel="noreferrer">
          Follow on CCIP <ExternalLink className="i ic-11" />
        </a>
      )}
    </div>
  );
}
