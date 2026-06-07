import { useCallback, useEffect, useState } from 'react';
import { Card, InlineAlert } from '@aramo/fe-foundation';

import { MoveToMenu } from './MoveToMenu';
import {
  getTalentRecord,
  listPipelinesForRequisition,
  transitionPipeline,
} from './pipeline-api';
import { transitionErrorMessage } from './error-messages';
import {
  ACTIVE_FLOW_COLUMNS,
  CLOSED_STATUSES,
  PIPELINE_STATUS_LABELS,
  type PipelineStatus,
  type PipelineView,
  type TalentRecordSummary,
} from './types';

interface KanbanProps {
  readonly requisitionId: string;
  // Called after a successful transition so the parent can refetch
  // the activity timeline (the auto pipeline_status_change activity is
  // emitted with subject_type='pipeline' — see Q6 finding).
  readonly onTransitioned?: () => void;
}

// Q3 ruling — 7 active columns + a collapsed Closed area. `no_status`
// is hidden from the active flow (legacy-import only); it surfaces in
// the Closed area only if a row carries it.
//
// Q5 ruling — the "Move to…" Popover menu (the MoveToMenu) lives per
// card; on confirmed transition the kanban refetches the pipeline set
// (the simple correct path; optimistic-update is later polish).
export function Kanban({ requisitionId, onTransitioned }: KanbanProps) {
  const [pipelines, setPipelines] = useState<readonly PipelineView[]>([]);
  const [talents, setTalents] = useState<Record<string, TalentRecordSummary>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const { items } = await listPipelinesForRequisition(requisitionId);
      setPipelines(items);
      // Fetch talent records in parallel for the cards (the carry note
      // in ./types.ts; a BE denormalization would collapse this).
      const ids = Array.from(new Set(items.map((p) => p.talent_record_id)));
      const fetched = await Promise.allSettled(ids.map((id) => getTalentRecord(id)));
      const map: Record<string, TalentRecordSummary> = {};
      fetched.forEach((result, idx) => {
        const id = ids[idx];
        if (id !== undefined && result.status === 'fulfilled') {
          map[id] = result.value;
        }
      });
      setTalents(map);
    } catch (err) {
      setLoadError(transitionErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [requisitionId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const handleTransition = async (
    pipelineId: string,
    toStatus: PipelineStatus,
    note: string | undefined,
  ) => {
    try {
      await transitionPipeline(pipelineId, { to_status: toStatus, note });
      await refresh();
      onTransitioned?.();
    } catch (err) {
      throw new Error(transitionErrorMessage(err));
    }
  };

  if (loading) {
    return <p>Loading pipeline…</p>;
  }

  if (loadError !== null) {
    return <InlineAlert variant="error">{loadError}</InlineAlert>;
  }

  const grouped = groupByStatus(pipelines);
  const closedCount = CLOSED_STATUSES.reduce(
    (sum, s) => sum + (grouped[s]?.length ?? 0),
    0,
  ) + (grouped.no_status?.length ?? 0);

  return (
    <section className="kanban" aria-label="Pipeline kanban">
      <div className="kanban__columns">
        {ACTIVE_FLOW_COLUMNS.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            pipelines={grouped[status] ?? []}
            talents={talents}
            onTransition={handleTransition}
          />
        ))}
      </div>
      <div className="kanban__closed">
        <button
          type="button"
          className="kanban__closed-toggle"
          aria-expanded={showClosed}
          onClick={() => setShowClosed((s) => !s)}
        >
          {showClosed ? 'Hide' : 'Show'} closed ({closedCount})
        </button>
        {showClosed ? (
          <div className="kanban__closed-columns">
            {CLOSED_STATUSES.map((status) => (
              <KanbanColumn
                key={status}
                status={status}
                pipelines={grouped[status] ?? []}
                talents={talents}
                onTransition={handleTransition}
              />
            ))}
            {(grouped.no_status?.length ?? 0) > 0 ? (
              <KanbanColumn
                key="no_status"
                status="no_status"
                pipelines={grouped.no_status ?? []}
                talents={talents}
                onTransition={handleTransition}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

interface KanbanColumnProps {
  readonly status: PipelineStatus;
  readonly pipelines: readonly PipelineView[];
  readonly talents: Record<string, TalentRecordSummary>;
  readonly onTransition: (
    pipelineId: string,
    toStatus: PipelineStatus,
    note: string | undefined,
  ) => Promise<void>;
}

function KanbanColumn({
  status,
  pipelines,
  talents,
  onTransition,
}: KanbanColumnProps) {
  return (
    <div className="kanban__column" aria-label={PIPELINE_STATUS_LABELS[status]}>
      <h3 className="kanban__column-title">
        {PIPELINE_STATUS_LABELS[status]}{' '}
        <span className="kanban__column-count">{pipelines.length}</span>
      </h3>
      <ul className="kanban__cards">
        {pipelines.map((p) => {
          const talent = talents[p.talent_record_id];
          const label = talent
            ? `${talent.first_name} ${talent.last_name}`
            : `Talent ${p.talent_record_id.slice(-6)}`;
          return (
            <li key={p.id}>
              <Card>
                <div className="kanban-card">
                  <p className="kanban-card__talent">{label}</p>
                  <MoveToMenu
                    from={p.status}
                    onSubmit={(to, note) => onTransition(p.id, to, note)}
                  />
                </div>
              </Card>
            </li>
          );
        })}
        {pipelines.length === 0 ? (
          <li className="kanban__empty" aria-hidden="true" />
        ) : null}
      </ul>
    </div>
  );
}

function groupByStatus(
  pipelines: readonly PipelineView[],
): Record<PipelineStatus, PipelineView[]> {
  const out = {} as Record<PipelineStatus, PipelineView[]>;
  for (const p of pipelines) {
    if (!out[p.status]) out[p.status] = [];
    out[p.status].push(p);
  }
  return out;
}
