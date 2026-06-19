import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { InlineAlert } from '@aramo/fe-foundation';

import { getRequisition } from '../requisitions/requisitions-api';

import { listEngagementsForTalent } from './engagement-api';
import { engagementsErrorMessage } from './error-messages';
import { ENGAGEMENT_STATE_LABELS, type EngagementView } from './types';

// The Engagements tab on talent-detail (§1) — clones PipelinesPanel (the
// per-tab fetch: useState + useEffect([talentId]) + cancelled flag +
// error-message). NOTE the filter divergence: engagements filter on
// talent_id (pipelines on talent_record_id).
//
// RULING 4 — the IDs-only view N+1: the row needs the requisition title,
// which EngagementView does not carry. We resolve titles via getRequisition
// per unique requisition_id (the interim resolver; the ?expand=talent,
// requisition backend optimization is a registered carry). A per-requisition
// resolution failure falls back to the raw id (graceful — the row still
// links to the engagement).
export function EngagementsPanel({ talentId }: { talentId: string }) {
  const [items, setItems] = useState<readonly EngagementView[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listEngagementsForTalent(talentId)
      .then(async (res) => {
        if (cancelled) return;
        setItems(res.items);
        setLoading(false);
        // N+1 title resolution (RULING 4) — best-effort, post-list.
        const uniqueReqIds = [
          ...new Set(res.items.map((e) => e.requisition_id)),
        ];
        const resolved = await Promise.all(
          uniqueReqIds.map(async (reqId) => {
            try {
              const req = await getRequisition(reqId);
              return [reqId, req.title] as const;
            } catch {
              return [reqId, reqId] as const;
            }
          }),
        );
        if (cancelled) return;
        setTitles(Object.fromEntries(resolved));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(engagementsErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [talentId]);

  if (loading) return <p>Loading engagements…</p>;
  if (error !== null) return <InlineAlert variant="error">{error}</InlineAlert>;
  if (items.length === 0) {
    return <p>This talent is not on any engagement yet.</p>;
  }
  return (
    <ul className="detail__list">
      {items.map((e) => (
        <li key={e.id}>
          <Link to={`/engagements/${e.id}`}>
            {titles[e.requisition_id] ?? e.requisition_id}
          </Link>{' '}
          — {ENGAGEMENT_STATE_LABELS[e.state]}
        </li>
      ))}
    </ul>
  );
}
