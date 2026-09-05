import { useEffect, useState } from 'react';

import { getEngagementReadiness, type EngagementReadiness } from './engagement-api';

// COMM-C3 — the recruiter Submittal-readiness summary (R19). Provider-neutral,
// truthful per-requirement status; loaded when the drawer opens (no first-paint
// list fan-out, R18). It MUST NOT claim a Talent is Qualified because the gate
// passes — it states only whether the engagement requirements are met.

const STATUS_LABEL: Record<string, string> = {
  satisfied: 'satisfied',
  not_required: 'not required',
  missing: 'missing',
  insufficient_strength: 'stronger evidence required',
  unavailable: 'evidence unavailable',
  no_producer: 'pending capability',
};

const CHANNEL_LABEL: Record<string, string> = { voice: 'Voice conversation', email: 'Email evidence' };

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; readiness: EngagementReadiness }
  | { kind: 'error' };

export function EngagementReadinessSummary({
  talentId,
  requisitionId,
  loadFn = getEngagementReadiness,
}: {
  readonly talentId: string;
  readonly requisitionId: string;
  readonly loadFn?: typeof getEngagementReadiness;
}): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    loadFn(talentId, requisitionId)
      .then((r) => {
        if (!cancelled) setState({ kind: 'ready', readiness: r });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [talentId, requisitionId, loadFn]);

  if (state.kind === 'loading') {
    return <p className="rc-cdp__note" data-testid="engagement-readiness-loading">Loading submittal readiness…</p>;
  }
  if (state.kind === 'error') {
    return <p className="rc-cdp__note" data-testid="engagement-readiness-error">Submittal readiness is unavailable.</p>;
  }

  const r = state.readiness;
  if (!r.policy_present) {
    // Amendment three-state: never-governed tenant is DORMANT (no engagement
    // requirements); a governed tenant with no effective policy is fail-closed.
    if (!r.governed) {
      return (
        <p className="rc-cdp__note" data-testid="engagement-readiness-dormant">
          No engagement policy governs this tenant — client submittal proceeds under the standard gates.
        </p>
      );
    }
    return (
      <p className="rc-cdp__note" data-testid="engagement-readiness-nopolicy">
        No effective engagement policy resolves — client submittal is blocked until a policy is in effect.
      </p>
    );
  }

  return (
    <div data-testid="engagement-readiness">
      <ul className="rc-cjr__checklist" style={{ margin: 0 }}>
        {r.results
          .filter((res) => res.required)
          .map((res) => {
            const done = res.status === 'satisfied';
            return (
              <li key={res.channel} className={`rc-cjr__ci rc-cjr__ci--${done ? 'done' : 'pending'}`}>
                <span className="rc-cjr__idot" aria-hidden="true">{done ? '✓' : ''}</span>
                <span className="rc-cjr__ilabel">
                  {CHANNEL_LABEL[res.channel] ?? res.channel} — {STATUS_LABEL[res.status] ?? res.status}
                </span>
              </li>
            );
          })}
      </ul>
      <p className="rc-cdp__note" data-testid="engagement-readiness-verdict">
        {r.satisfied
          ? 'Engagement requirements met for client submittal.'
          : 'Client submittal is blocked until the engagement requirements are met.'}
      </p>
    </div>
  );
}
