import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Card,
  InlineAlert,
  PageHeader,
  hasScope,
  useSession,
} from '@aramo/fe-foundation';

import { ActivityTimeline } from '../activity/ActivityTimeline';
import { LogNoteDialog } from '../activity/LogNoteDialog';
import { Kanban } from '../pipeline/Kanban';
import { listPipelinesForRequisition } from '../pipeline/pipeline-api';
import type { PipelineView } from '../pipeline/types';
import { TasksPanel } from '../task/TasksPanel';

import { getRequisition } from './requisitions-api';
import { detailErrorMessage } from './error-messages';
import type { RequisitionView } from './types';

// Composer for the req-detail surface: the requisition header + the
// kanban + the activity timeline + the "Log note" action.
//
// Pipeline IDs are fetched here so the ActivityTimeline knows which
// per-pipeline activity streams to merge (Q6 finding).

export function RequisitionDetailView() {
  const { reqId } = useParams<{ reqId: string }>();
  const [req, setReq] = useState<RequisitionView | null>(null);
  const [pipelines, setPipelines] = useState<readonly PipelineView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const sessionState = useSession();
  const canEdit =
    sessionState.status === 'authenticated' &&
    hasScope(sessionState.session, 'requisition:edit');
  // Tasks FE (Ruling 2) — req-detail is flat-sectioned (not tabbed), so the
  // Tasks surface is a scope-gated section (the tab idiom adapted to the
  // host's layout); same posture as the Pipeline/Activity sections.
  const canReadTasks =
    sessionState.status === 'authenticated' &&
    hasScope(sessionState.session, 'task:read');
  const canWriteTasks =
    sessionState.status === 'authenticated' &&
    hasScope(sessionState.session, 'task:write');

  useEffect(() => {
    if (reqId === undefined) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getRequisition(reqId), listPipelinesForRequisition(reqId)])
      .then(([reqRes, pipelineRes]) => {
        if (cancelled) return;
        setReq(reqRes);
        setPipelines(pipelineRes.items);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(detailErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reqId, refreshKey]);

  const pipelineIds = useMemo(
    () => pipelines.map((p) => p.id),
    [pipelines],
  );

  if (reqId === undefined) {
    return <InlineAlert variant="error">Missing requisition id in URL.</InlineAlert>;
  }

  if (loading) return <p>Loading requisition…</p>;
  if (error !== null) {
    return (
      <section>
        <PageHeader title="Requisition" />
        <InlineAlert variant="error">{error}</InlineAlert>
        <p>
          <Link to="/requisitions">Back to requisitions</Link>
        </p>
      </section>
    );
  }
  if (req === null) return null;

  return (
    <section>
      <PageHeader title={req.title} description={`Status: ${req.status}`} />
      <div className="req-detail__toolbar">
        <Link to="/requisitions">← Back to requisitions</Link>
        {canEdit ? (
          <Link to={`/requisitions/${req.id}/edit`} className="req-detail__edit-link">
            Edit
          </Link>
        ) : null}
        <LogNoteDialog
          requisitionId={req.id}
          onSaved={() => setRefreshKey((k) => k + 1)}
        />
      </div>
      <Card>
        <dl className="req-detail__meta">
          <div>
            <dt>Openings</dt>
            <dd>
              {req.openings_available} / {req.openings}
            </dd>
          </div>
          <div>
            <dt>Company</dt>
            <dd>{req.company_id}</dd>
          </div>
          {req.start_date !== null ? (
            <div>
              <dt>Start date</dt>
              <dd>{req.start_date}</dd>
            </div>
          ) : null}
        </dl>
      </Card>
      <h2>Pipeline</h2>
      <Kanban
        requisitionId={req.id}
        onTransitioned={() => setRefreshKey((k) => k + 1)}
      />
      <h2>Activity</h2>
      <ActivityTimeline
        requisitionId={req.id}
        pipelineIds={pipelineIds}
        refreshKey={refreshKey}
      />
      {canReadTasks ? (
        <>
          <h2>Tasks</h2>
          <TasksPanel
            ownerType="requisition"
            ownerId={req.id}
            canWrite={canWriteTasks}
          />
        </>
      ) : null}
    </section>
  );
}
