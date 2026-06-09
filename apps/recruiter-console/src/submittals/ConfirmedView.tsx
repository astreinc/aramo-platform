import { useEffect, useState } from 'react';
import { Card, InlineAlert } from '@aramo/fe-foundation';

import { getEvidencePackage } from './submittals-api';
import type {
  EvidencePackageView,
  TalentSubmittalRecordView,
} from './types';

interface ConfirmedViewProps {
  readonly submittal: TalentSubmittalRecordView;
}

// ConfirmedView — terminal "Confirmed" state. Reads the immutable
// TalentJobEvidencePackage via GET /v1/submittals/:id/evidence-package
// and displays the canonical summary surfaces. The wizard host
// surfaces the success state above this view.
export function ConfirmedView({ submittal }: ConfirmedViewProps) {
  const [pkg, setPkg] = useState<EvidencePackageView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getEvidencePackage(submittal.id)
      .then((result) => {
        if (!cancelled) setPkg(result);
      })
      .catch(() => {
        if (!cancelled)
          setError('Failed to load the evidence package. Refresh to retry.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [submittal.id]);

  return (
    <Card
      title="Confirmed"
      description={`Submittal confirmed on ${submittal.confirmed_at ?? 'unknown date'}.`}
    >
      <InlineAlert variant="success">
        This submittal is confirmed. The evidence package is preserved
        and read-only.
      </InlineAlert>
      <div style={{ marginTop: '1rem' }}>
        {loading && <p>Loading evidence package…</p>}
        {error !== null && <InlineAlert variant="error">{error}</InlineAlert>}
        {pkg !== null && (
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: '0.25rem 1rem',
            }}
          >
            <dt>Package id</dt>
            <dd>
              <code>{pkg.id}</code>
            </dd>
            <dt>Talent id</dt>
            <dd>
              <code>{pkg.talent_id}</code>
            </dd>
            <dt>Job id</dt>
            <dd>
              <code>{pkg.job_id}</code>
            </dd>
            <dt>Examination id</dt>
            <dd>
              <code>{pkg.examination_id}</code>
            </dd>
            <dt>Created at</dt>
            <dd>{pkg.created_at}</dd>
          </dl>
        )}
      </div>
    </Card>
  );
}
