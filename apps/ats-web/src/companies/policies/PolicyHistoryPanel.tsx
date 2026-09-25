import { useEffect, useState } from 'react';

import { StatusPill } from '../../ui';
import {
  getClientSubmittalHistory,
  getEngagementHistory,
  getPreStartHistory,
  type PolicyVersionHistoryEntry,
} from '../policies-api';

import { PolicyEditorHeader } from './PolicyEditorHeader';
import type { PolicyDomain } from './CompanyPoliciesOverview';
import { DOMAIN_TITLES } from './labels';

// CSP PA-3 (§10/§34) — the read-only client-scope version history. Immutable: each
// version is a published record; changing policy is a NEW version, never an in-place
// edit. Ordered newest-first by the backend.

function historyFor(domain: PolicyDomain, companyId: string): Promise<{ versions: readonly PolicyVersionHistoryEntry[] }> {
  if (domain === 'client-submittal') return getClientSubmittalHistory('CLIENT', companyId);
  if (domain === 'engagement') return getEngagementHistory('CLIENT', companyId);
  return getPreStartHistory('CLIENT', companyId);
}

function fmtDate(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

const STATUS_TONE = { current: 'ok', scheduled: 'info', superseded: 'neutral' } as const;

export function PolicyHistoryPanel({
  domain,
  companyId,
  onBack,
}: {
  domain: PolicyDomain;
  companyId: string;
  onBack: () => void;
}): JSX.Element {
  const [versions, setVersions] = useState<readonly PolicyVersionHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    historyFor(domain, companyId)
      .then((r) => {
        if (live) setVersions(r.versions);
      })
      .catch(() => {
        if (live) setError('History could not be loaded.');
      });
    return () => {
      live = false;
    };
  }, [domain, companyId]);

  return (
    <div className="rc-pol">
      <PolicyEditorHeader
        onBack={onBack}
        title={`${DOMAIN_TITLES[domain]} · history`}
        subtitle="Every published version is kept. Items already in progress keep the version they started under."
        legend={false}
      />
      {error !== null ? <p className="rc-muted-line">{error}</p> : null}
      {versions !== null && versions.length === 0 ? (
        <p className="rc-muted-line">No client-scope versions — this client inherits the tenant defaults.</p>
      ) : null}
      {versions !== null && versions.length > 0 ? (
        <ul className="rc-history-list">
          {versions.map((v) => (
            <li key={`${v.version}-${v.published_at ?? ''}`} className="rc-history-row">
              <div className="rc-history-row__main">
                <span className="rc-history-row__ver">Version {v.version}</span>
                <StatusPill tone={STATUS_TONE[v.status]}>{v.status}</StatusPill>
              </div>
              <div className="rc-muted-line">
                Published {fmtDate(v.published_at)}
                {v.published_by !== null ? ` · ${v.published_by}` : ''}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
