// Consent state panel — PR-9 §4.1 (restyled to Confident Blue for ats-web).
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
//
// Restyle note: the status chip is StatusPill (the Confident-Blue status
// atom). The tone map is domain mapping that lives WITH the surface (the
// design-system atom stays domain-neutral); it is presentation only, NOT
// aggregation — each scope's server status is shown verbatim as the chip text.

import { ApiError } from '@aramo/fe-foundation';
import { useEffect, useState } from 'react';

import {
  Card,
  CardHead,
  DataTable,
  StatusPill,
  type PillTone,
  type TableColumn,
} from '../ui';

import { getTalentConsentState } from './consent-api';
import {
  CONSENT_SCOPES,
  type ConsentScope,
  type ConsentScopeStatus,
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

const STATUS_TONE: Record<ConsentScopeStatus, PillTone> = {
  granted: 'ok',
  revoked: 'danger',
  expired: 'warn',
  no_grant: 'neutral',
};

interface ScopeRow {
  scope: ConsentScope;
  entry: TalentConsentScopeState | undefined;
}

const SCOPE_COLUMNS: ReadonlyArray<TableColumn<ScopeRow>> = [
  {
    key: 'scope',
    header: 'Scope',
    render: (row) => (
      <span data-testid={`consent-state-scope-${row.scope}`}>{row.scope}</span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (row) => {
      const status = row.entry ? row.entry.status : 'no_grant';
      return (
        <span data-testid={`consent-state-status-${row.scope}`}>
          <StatusPill tone={STATUS_TONE[status]}>{status}</StatusPill>
        </span>
      );
    },
  },
  { key: 'granted_at', header: 'Granted at', render: (row) => row.entry?.granted_at ?? '—' },
  { key: 'revoked_at', header: 'Revoked at', render: (row) => row.entry?.revoked_at ?? '—' },
  { key: 'expires_at', header: 'Expires at', render: (row) => row.entry?.expires_at ?? '—' },
];

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
      <section data-testid="consent-state-panel">
        <Card>
          <CardHead title="Consent state" />
          <p className="rc-muted-line rc-mt-8">Loading consent state…</p>
        </Card>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section data-testid="consent-state-panel">
        <Card>
          <CardHead title="Consent state" />
          <p className="rc-muted-line rc-mt-8">
            Consent state could not be loaded for talent {talentId}.
          </p>
        </Card>
      </section>
    );
  }

  const { data } = state;

  if (data.is_anonymized) {
    return (
      <section data-testid="consent-state-panel">
        <Card>
          <CardHead title="Consent state" />
          <p
            className="rc-muted-line rc-mt-8"
            data-testid="consent-state-anonymized"
          >
            This talent record has been anonymized.
          </p>
        </Card>
      </section>
    );
  }

  const scopeIndex = new Map<ConsentScope, TalentConsentScopeState>();
  for (const entry of data.scopes) {
    scopeIndex.set(entry.scope, entry);
  }
  const rows: ScopeRow[] = CONSENT_SCOPES.map((scope) => ({
    scope,
    entry: scopeIndex.get(scope),
  }));

  return (
    <section data-testid="consent-state-panel">
      <Card>
        <CardHead title="Consent state" />
        <dl className="rc-deflist rc-mt-8">
          <dt>Talent</dt>
          <dd data-testid="consent-state-talent-id">{data.talent_id}</dd>
          <dt>Tenant</dt>
          <dd data-testid="consent-state-tenant-id">{data.tenant_id}</dd>
          <dt>Computed at</dt>
          <dd data-testid="consent-state-computed-at">{data.computed_at}</dd>
        </dl>
        <div className="rc-mt-8">
          <DataTable
            columns={SCOPE_COLUMNS}
            rows={rows}
            rowKey={(row) => row.scope}
          />
        </div>
      </Card>
    </section>
  );
}
