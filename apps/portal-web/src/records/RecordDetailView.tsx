import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, Card, InlineAlert } from '@aramo/fe-foundation';

import { portalApi, type PortalRecordProfile } from '../portal-api';

import { ConsentPanel } from './ConsentPanel';

// Portal P1 PR-3 / P2 P2b — the per-record profile view. The R10-filtered
// PortalProfile for one record reachable through the caller's chain. A record id
// NOT in the chain (or unknown/malformed) resolves to a uniform 404 — surfaced
// here as an honest "not found" notice, no "exists but not yours" distinction.
// P2b adds the consent management panel (state / grant / revoke / history).

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function RecordDetailView() {
  const { id } = useParams<{ id: string }>();
  const [profile, setProfile] = useState<PortalRecordProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (id === undefined) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    portalApi
      .getRecordProfile(id)
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(
            e instanceof ApiError ? e.message : 'Failed to load this record.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className="po-page">
      <div className="po-page__head">
        <h1 className="po-page__title">Record</h1>
        <Link className="rc-link-strong" to="/">
          ← Your records
        </Link>
      </div>

      {loading && <p className="po-page__lede">Loading…</p>}
      {error !== null && <InlineAlert variant="error">{error}</InlineAlert>}

      {profile !== null && (
        <>
          <Card title="Profile">
            <dl className="po-facts">
              <dt>Organization</dt>
              <dd>{profile.tenant_name ?? profile.tenant_id}</dd>
              <dt>Status</dt>
              <dd>{profile.tenant_status}</dd>
              <dt>How you joined</dt>
              <dd>{profile.source_channel}</dd>
              <dt>On record since</dt>
              <dd>{fmtDate(profile.created_at)}</dd>
            </dl>
          </Card>
          {id !== undefined && (
            <ConsentPanel recordId={id} tenantName={profile.tenant_name} />
          )}
        </>
      )}
    </div>
  );
}
