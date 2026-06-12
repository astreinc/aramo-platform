import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Card,
  InlineAlert,
  PageHeader,
  useSession,
  type Session,
} from '@aramo/fe-foundation';

import { ActivityTimeline } from '../activity/ActivityTimeline';
import { LogNoteDialog } from '../activity/LogNoteDialog';
import { Kanban } from '../pipeline/Kanban';
import { listPipelinesForRequisition } from '../pipeline/pipeline-api';
import type { PipelineView } from '../pipeline/types';
import { TasksPanel } from '../task/TasksPanel';

import { CockpitFieldRow, type SaveFieldFn } from './cockpit-fields';
import {
  COCKPIT_FIELDS,
  type CockpitSection,
} from './field-affordance';
import { ProfileWorkbenchPanel } from './ProfileWorkbenchPanel';
import { getRequisition, updateRequisition } from './requisitions-api';
import { detailErrorMessage } from './error-messages';
import type { RequisitionView, UpdateRequisitionRequest } from './types';

// PR-A2 P1 — the requisition COCKPIT. The thin 3-field detail view is
// rebuilt into an information-dense, sectioned surface that surfaces the
// FULL requisition field set (the recon bucket map) with per-field inline
// editing gated by the live PR-A1 affordance matrix. The existing Pipeline /
// Activity / Tasks sections are KEPT. The GoldenProfile workbench (P3) is a
// persistent panel. The old /edit route + form-edit-mode + GenerateProfile
// dialog are RETIRED (P4) — editing is now inline here.
//
// MASKING BY ABSENCE (R8): the backend field-masking interceptor DELETEs
// comp/financial fields the actor can't read, so they are ABSENT from the
// payload. The cockpit renders a field ONLY when it's present (`key in req`)
// — a recruiter with no comp scope simply never sees the Compensation
// section. The affordance map governs EDITABILITY; the payload governs
// presence.
//
// BACKEND IS TRUTH (R6): every inline save hits PATCH /v1/requisitions/:id,
// which enforces the per-field gates server-side (status-only / comp / financial).
// The FE affordance is cosmetic; a forced out-of-scope save 403s regardless.

const SECTION_TITLES: Readonly<Record<CockpitSection, string>> = {
  identity: 'Identity',
  classification: 'Classification',
  work_arrangement: 'Work arrangement',
  duration: 'Duration & schedule',
  source: 'Source',
  compensation: 'Compensation',
  financial: 'Financial planning',
  system: 'System',
};

const SECTION_ORDER: readonly CockpitSection[] = [
  'identity',
  'classification',
  'work_arrangement',
  'duration',
  'source',
  'compensation',
  'financial',
];

interface RequisitionDetailViewProps {
  // Test seam (the RequisitionCreateView / TalentDetailView pattern).
  readonly sessionOverride?: Session;
}

export function RequisitionDetailView({
  sessionOverride,
}: RequisitionDetailViewProps = {}) {
  const { reqId } = useParams<{ reqId: string }>();
  const [req, setReq] = useState<RequisitionView | null>(null);
  const [pipelines, setPipelines] = useState<readonly PipelineView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const scopes = useMemo(() => session?.scopes ?? [], [session]);
  const canReadTasks = scopes.includes('task:read');
  const canWriteTasks = scopes.includes('task:write');

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

  const pipelineIds = useMemo(() => pipelines.map((p) => p.id), [pipelines]);

  // The inline-save dispatcher (R6) — hits the A1-gated PATCH and refreshes
  // local state from the masked response (so a save that the actor cannot
  // read back simply doesn't reappear). Errors propagate to the primitive's
  // submitError surface.
  const saveField: SaveFieldFn = async (key, value) => {
    if (req === null) return;
    const body = { [key]: value } as unknown as UpdateRequisitionRequest;
    const updated = await updateRequisition(req.id, body);
    setReq(updated);
  };

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

  const reqRecord = req as unknown as Record<string, unknown>;
  const present = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(reqRecord, key);

  return (
    <section className="req-cockpit">
      <PageHeader title={req.title} description={`Status: ${req.status}`} />
      <div className="req-cockpit__toolbar">
        <Link to="/requisitions">← Back to requisitions</Link>
        <LogNoteDialog
          requisitionId={req.id}
          onSaved={() => setRefreshKey((k) => k + 1)}
        />
      </div>

      <Card>
        <dl className="req-cockpit__meta">
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
          <div>
            <dt>Created</dt>
            <dd>{req.created_at}</dd>
          </div>
        </dl>
      </Card>

      {/* The dense editable cockpit — one Card per section; a section with
          no fields present in the (masked) payload is omitted entirely. */}
      {SECTION_ORDER.map((section) => {
        const fields = COCKPIT_FIELDS.filter(
          (f) => f.section === section && present(f.key),
        );
        if (fields.length === 0) return null;
        return (
          <Card key={section}>
            <h3 className="req-cockpit__section-title">
              {SECTION_TITLES[section]}
            </h3>
            <div className="req-cockpit__grid">
              {fields.map((f) => (
                <CockpitFieldRow
                  key={f.key}
                  field={f}
                  raw={reqRecord[f.key]}
                  scopes={scopes}
                  onSave={saveField}
                />
              ))}
            </div>
          </Card>
        );
      })}

      {/* P3 — the persistent GoldenProfile workbench. */}
      <ProfileWorkbenchPanel
        requisitionId={req.id}
        scopes={scopes}
        onProfileLinked={() => setRefreshKey((k) => k + 1)}
      />

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
