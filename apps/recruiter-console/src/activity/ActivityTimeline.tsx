import { useCallback, useEffect, useState } from 'react';
import { Card, InlineAlert } from '@aramo/fe-foundation';

import { listActivities } from './activity-api';
import { timelineErrorMessage } from './error-messages';
import type { ActivityView } from './types';

interface ActivityTimelineProps {
  readonly requisitionId: string;
  // Pipeline IDs visible on the kanban for this req — the per-pipeline
  // transition activities are fetched in parallel (Q6 branch (c) — the
  // auto pipeline_status_change emits with subject_type='pipeline').
  // A BE aggregation endpoint would collapse the N+1; filed as a
  // follow-up.
  readonly pipelineIds: readonly string[];
  // A bump counter the parent increments to force a refetch (after a
  // transition or a logged note).
  readonly refreshKey?: number;
}

export function ActivityTimeline({
  requisitionId,
  pipelineIds,
  refreshKey,
}: ActivityTimelineProps) {
  const [items, setItems] = useState<readonly ActivityView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const reqReq = listActivities('requisition', requisitionId);
      const pipelineReqs = pipelineIds.map((id) => listActivities('pipeline', id));
      const [reqResult, ...pipelineResults] = await Promise.allSettled([
        reqReq,
        ...pipelineReqs,
      ]);
      const merged: ActivityView[] = [];
      if (reqResult.status === 'fulfilled') {
        merged.push(...reqResult.value.items);
      }
      for (const r of pipelineResults) {
        if (r.status === 'fulfilled') {
          merged.push(...r.value.items);
        }
      }
      merged.sort((a, b) => b.created_at.localeCompare(a.created_at));
      setItems(merged);
    } catch (err) {
      setError(timelineErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [requisitionId, pipelineIds]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  if (loading) {
    return <p>Loading activity…</p>;
  }

  if (error !== null) {
    return <InlineAlert variant="error">{error}</InlineAlert>;
  }

  if (items.length === 0) {
    return <p className="timeline__empty">No activity yet.</p>;
  }

  return (
    <ul className="timeline">
      {items.map((a) => (
        <li key={a.id} className="timeline__item">
          <Card>
            <div className="timeline__entry">
              <p className="timeline__kind">{labelFor(a.type)}</p>
              {a.notes !== null && a.notes !== '' ? (
                <p className="timeline__notes">{a.notes}</p>
              ) : null}
              <time className="timeline__time" dateTime={a.created_at}>
                {a.created_at}
              </time>
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function labelFor(type: ActivityView['type']): string {
  switch (type) {
    case 'pipeline_status_change':
      return 'Status change';
    case 'note':
      return 'Note';
    case 'call':
      return 'Call';
    case 'email_logged':
      return 'Email';
  }
}
