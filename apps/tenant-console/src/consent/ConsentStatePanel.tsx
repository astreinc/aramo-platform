// Consent state panel — PR-9 §4.1.
//
// Displays GET /v1/consent/state/:talent_id verbatim:
//   - talent_id, tenant_id, computed_at (R6 honest staleness display)
//   - the 5 fixed scopes from the server response, each rendered
//     individually with the server-resolved status
//   - is_anonymized: true ⇒ neutral "anonymized" state (PR-9 §4.4)
//
// Faithful-display discipline (PR-9 §7):
//   - No client-side derivation, summarization, or aggregation
//   - No "overall consent" summary across scopes (R5 mitigation)
//   - The panel renders what the server returns, at the granularity
//     the server returns it
//
// The 5 scopes are always returned by the server (PR-5 Decision D:
// always-5-scopes deterministic response). We render in the
// CONSENT_SCOPES order for stable presentation regardless of the
// server's array order — purely cosmetic, not aggregation.

import { useEffect, useState } from 'react';

import { ApiError } from '../api/client';

import { getTalentConsentState } from './consent-api';
import {
  CONSENT_SCOPES,
  type ConsentScope,
  type TalentConsentScopeState,
  type TalentConsentStateResponse,
} from './types';

interface ConsentStatePanelProps {
  talentId: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; data: TalentConsentStateResponse }
  | { status: 'error'; statusCode: number | null };

export function ConsentStatePanel({ talentId }: ConsentStatePanelProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    getTalentConsentState(talentId)
      .then((data) => {
        if (cancelled) return;
        setState({ status: 'loaded', data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const code = err instanceof ApiError ? err.status : null;
        setState({ status: 'error', statusCode: code });
      });
    return () => {
      cancelled = true;
    };
  }, [talentId]);

  if (state.status === 'loading') {
    return (
      <section
        className="aramo-consent-state"
        data-testid="consent-state-panel"
      >
        <h2>Consent state</h2>
        <p>Loading consent state…</p>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section
        className="aramo-consent-state"
        data-testid="consent-state-panel"
      >
        <h2>Consent state</h2>
        <p>Consent state could not be loaded for talent {talentId}.</p>
      </section>
    );
  }

  const { data } = state;

  if (data.is_anonymized) {
    return (
      <section
        className="aramo-consent-state"
        data-testid="consent-state-panel"
      >
        <h2>Consent state</h2>
        <p data-testid="consent-state-anonymized">
          This talent record has been anonymized.
        </p>
      </section>
    );
  }

  const scopeIndex = new Map<ConsentScope, TalentConsentScopeState>();
  for (const entry of data.scopes) {
    scopeIndex.set(entry.scope, entry);
  }

  return (
    <section className="aramo-consent-state" data-testid="consent-state-panel">
      <h2>Consent state</h2>
      <dl className="aramo-consent-state__meta">
        <dt>Talent</dt>
        <dd data-testid="consent-state-talent-id">{data.talent_id}</dd>
        <dt>Tenant</dt>
        <dd data-testid="consent-state-tenant-id">{data.tenant_id}</dd>
        <dt>Computed at</dt>
        <dd data-testid="consent-state-computed-at">{data.computed_at}</dd>
      </dl>
      <table className="aramo-consent-state__scopes">
        <thead>
          <tr>
            <th>Scope</th>
            <th>Status</th>
            <th>Granted at</th>
            <th>Revoked at</th>
            <th>Expires at</th>
          </tr>
        </thead>
        <tbody>
          {CONSENT_SCOPES.map((scope) => {
            const entry = scopeIndex.get(scope);
            return (
              <tr key={scope} data-testid={`consent-state-scope-${scope}`}>
                <td>{scope}</td>
                <td data-testid={`consent-state-status-${scope}`}>
                  {entry ? entry.status : 'no_grant'}
                </td>
                <td>{entry?.granted_at ?? '—'}</td>
                <td>{entry?.revoked_at ?? '—'}</td>
                <td>{entry?.expires_at ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
