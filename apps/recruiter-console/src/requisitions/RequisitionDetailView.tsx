import { InlineAlert, useSession, type Session } from '@aramo/fe-foundation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ActivityTimeline } from '../activity/ActivityTimeline';
import { LogNoteDialog } from '../activity/LogNoteDialog';
import { Tabs, type TabItem } from '../components/Tabs';
import { getCompany } from '../companies/companies-api';
import { getContact } from '../contacts/contacts-api';
import { MoveToMenu } from '../pipeline/MoveToMenu';
import {
  getTalentRecord,
  listPipelinesForRequisition,
  transitionPipeline,
} from '../pipeline/pipeline-api';
import type {
  PipelineStatus,
  PipelineView,
  TalentRecordSummary,
} from '../pipeline/types';
import { useEntityCrumb } from '../shell/breadcrumb';
import { TasksPanel } from '../task/TasksPanel';
import {
  Card,
  DataTable,
  EntityCell,
  ReservedSeam,
  StatusPill,
  StagePill,
  funnelCounts,
  type PillTone,
  type TableColumn,
} from '../ui';

import { CockpitFieldRow, type SaveFieldFn } from './cockpit-fields';
import { COCKPIT_FIELDS, type CockpitSection } from './field-affordance';
import { ProfileWorkbenchPanel } from './ProfileWorkbenchPanel';
import { getRequisition, updateRequisition } from './requisitions-api';
import { detailErrorMessage } from './error-messages';
import {
  type RequisitionStatus,
  type RequisitionView,
  type UpdateRequisitionRequest,
} from './types';

// Requisition DETAIL + pipeline (2D) — re-skinned to the Confident Blue job-
// detail mockup: header (title + Hot/status pills + company link + REQ code),
// a meta strip, and tabs (Pipeline / Details / Activity / Tasks). The Pipeline
// tab is the signature surface: a funnel RIBBON (the 11-state → 6-bucket
// aggregation) + the candidate table (StagePill + the legal Move-to menu) +
// an at-a-glance sidecard + the RESERVED Match-insight seam (R10 — no scores).
//
// The Details tab keeps the PR-A2 inline-edit cockpit (masking-by-absence +
// per-field affordance) and the GoldenProfile workbench — UNCHANGED behavior,
// just relocated. Breadcrumb: the view publishes its title via useEntityCrumb
// (2D ruling) so the TopBar shows "Requisitions › <title>".
//
// Gap dispositions (DDR §11): per-pipeline Rate/Rating/Last-activity/Owner not
// available → omitted (CARRY). Recruiter name needs a roster → omitted. Company
// + contact ids resolved to names (gap #8); contact omitted if unresolved.

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

const STATUS_LABEL: Record<RequisitionStatus, string> = {
  active: 'Open',
  on_hold: 'On hold',
  full: 'Full',
  closed: 'Closed',
  canceled: 'Canceled',
  lead: 'Intake',
};

const STATUS_TONE: Record<RequisitionStatus, PillTone> = {
  active: 'ok',
  lead: 'neutral',
  on_hold: 'warn',
  full: 'brand',
  closed: 'neutral',
  canceled: 'danger',
};

const SUBMITTED_PLUS: readonly PipelineStatus[] = [
  'submitted',
  'interviewing',
  'offered',
  'placed',
];

interface RequisitionDetailViewProps {
  readonly sessionOverride?: Session;
}

export function RequisitionDetailView({
  sessionOverride,
}: RequisitionDetailViewProps = {}) {
  const { reqId } = useParams<{ reqId: string }>();
  const [req, setReq] = useState<RequisitionView | null>(null);
  const [pipelines, setPipelines] = useState<readonly PipelineView[]>([]);
  const [talents, setTalents] = useState<Record<string, TalentRecordSummary>>({});
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [contactName, setContactName] = useState<string | null>(null);
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

  useEntityCrumb(req?.title);

  useEffect(() => {
    if (reqId === undefined) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getRequisition(reqId), listPipelinesForRequisition(reqId)])
      .then(async ([reqRes, pipelineRes]) => {
        if (cancelled) return;
        setReq(reqRes);
        setPipelines(pipelineRes.items);
        setLoading(false);
        // Resolve names + talent labels best-effort (graceful on 403/404).
        const ids = Array.from(
          new Set(pipelineRes.items.map((p) => p.talent_record_id)),
        );
        const [coRes, contactRes, talentResults] = await Promise.allSettled([
          getCompany(reqRes.company_id),
          reqRes.contact_id !== null
            ? getContact(reqRes.contact_id)
            : Promise.reject(new Error('no contact')),
          Promise.allSettled(ids.map((id) => getTalentRecord(id))),
        ]);
        if (cancelled) return;
        if (coRes.status === 'fulfilled') setCompanyName(coRes.value.name);
        if (contactRes.status === 'fulfilled') {
          setContactName(
            `${contactRes.value.first_name} ${contactRes.value.last_name}`.trim(),
          );
        }
        if (talentResults.status === 'fulfilled') {
          const map: Record<string, TalentRecordSummary> = {};
          talentResults.value.forEach((r, i) => {
            const id = ids[i];
            if (id !== undefined && r.status === 'fulfilled') map[id] = r.value;
          });
          setTalents(map);
        }
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

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const saveField: SaveFieldFn = async (key, value) => {
    if (req === null) return;
    const body = { [key]: value } as unknown as UpdateRequisitionRequest;
    setReq(await updateRequisition(req.id, body));
  };

  const handleTransition = async (
    pipelineId: string,
    toStatus: PipelineStatus,
    note: string | undefined,
  ) => {
    await transitionPipeline(pipelineId, { to_status: toStatus, note });
    refresh();
  };

  if (reqId === undefined) {
    return <InlineAlert variant="error">Missing requisition id in URL.</InlineAlert>;
  }
  if (loading) return <p className="rc-muted-line">Loading requisition…</p>;
  if (error !== null) {
    return (
      <section>
        <InlineAlert variant="error">{error}</InlineAlert>
        <p className="rc-mt-16">
          <Link to="/requisitions" className="rc-link-action">
            ← Back to requisitions
          </Link>
        </p>
      </section>
    );
  }
  if (req === null) return null;

  const reqRecord = req as unknown as Record<string, unknown>;
  const present = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(reqRecord, key);

  const tabs: TabItem[] = [
    {
      id: 'pipeline',
      label: `Pipeline (${pipelines.length})`,
      content: (
        <PipelinePanel
          req={req}
          pipelines={pipelines}
          talents={talents}
          onTransition={handleTransition}
        />
      ),
    },
    {
      id: 'details',
      label: 'Details',
      content: (
        <DetailsPanel
          req={req}
          present={present}
          scopes={scopes}
          saveField={saveField}
          onProfileLinked={refresh}
        />
      ),
    },
    {
      id: 'activity',
      label: 'Activity',
      content: (
        <div className="rc-mt-16">
          <div className="rc-viewhead">
            <h2 className="rc-section-h">Activity</h2>
            <div className="rc-viewhead__actions">
              <LogNoteDialog requisitionId={req.id} onSaved={refresh} />
            </div>
          </div>
          <ActivityTimeline
            requisitionId={req.id}
            pipelineIds={pipelines.map((p) => p.id)}
            refreshKey={refreshKey}
          />
        </div>
      ),
    },
  ];
  if (canReadTasks) {
    tabs.push({
      id: 'tasks',
      label: 'Tasks',
      content: (
        <div className="rc-mt-16">
          <TasksPanel
            ownerType="requisition"
            ownerId={req.id}
            canWrite={canWriteTasks}
          />
        </div>
      ),
    });
  }

  return (
    <section>
      <div className="rc-dhead">
        <div>
          <h1 className="rc-dhead__title">
            {req.title}
            {req.is_hot ? <StatusPill tone="hot">Hot</StatusPill> : null}
            <StatusPill tone={STATUS_TONE[req.status]} dot>
              {STATUS_LABEL[req.status]}
            </StatusPill>
          </h1>
          <div className="rc-dhead__co">
            <Link to={`/companies/${req.company_id}`}>
              {companyName ?? 'Company'}
            </Link>
            {req.external_req_id !== null ? (
              <span className="mono">· {req.external_req_id}</span>
            ) : null}
          </div>
        </div>
      </div>

      <MetaStrip req={req} contactName={contactName} present={present} />

      <div className="rc-mt-16">
        <Tabs items={tabs} ariaLabel="Requisition sections" initialId="pipeline" />
      </div>
    </section>
  );
}

// ── Meta strip ──

function MetaStrip({
  req,
  contactName,
  present,
}: {
  readonly req: RequisitionView;
  readonly contactName: string | null;
  readonly present: (key: string) => boolean;
}) {
  const place = [req.city, req.state].filter(Boolean).join(', ');
  const filled = req.openings - req.openings_available;
  const showRate = present('max_pay_rate') && req.max_pay_rate !== null;
  return (
    <div className="rc-meta">
      <div className="rc-meta__cell">
        <div className="rc-meta__k">Type</div>
        <div className="rc-meta__v">{req.type ?? '—'}</div>
      </div>
      <div className="rc-meta__cell">
        <div className="rc-meta__k">Location</div>
        <div className="rc-meta__v">{place || '—'}</div>
      </div>
      {showRate ? (
        <div className="rc-meta__cell">
          <div className="rc-meta__k">Max rate</div>
          <div className="rc-meta__v num">{req.max_pay_rate}</div>
        </div>
      ) : null}
      <div className="rc-meta__cell">
        <div className="rc-meta__k">Openings</div>
        <div className="rc-meta__v num">
          {filled} of {req.openings}
        </div>
      </div>
      <div className="rc-meta__cell">
        <div className="rc-meta__k">Opened</div>
        <div className="rc-meta__v">{daysAgo(req.created_at)}</div>
      </div>
      {contactName !== null ? (
        <div className="rc-meta__cell">
          <div className="rc-meta__k">Contact</div>
          <div className="rc-meta__v">{contactName}</div>
        </div>
      ) : null}
    </div>
  );
}

// ── Pipeline tab ──

function PipelinePanel({
  req,
  pipelines,
  talents,
  onTransition,
}: {
  readonly req: RequisitionView;
  readonly pipelines: readonly PipelineView[];
  readonly talents: Record<string, TalentRecordSummary>;
  readonly onTransition: (
    id: string,
    to: PipelineStatus,
    note: string | undefined,
  ) => Promise<void>;
}) {
  const cells = funnelCounts(pipelines.map((p) => p.status));
  const submitted = pipelines.filter((p) =>
    SUBMITTED_PLUS.includes(p.status),
  ).length;

  const columns: ReadonlyArray<TableColumn<PipelineView>> = [
    {
      key: 'talent',
      header: 'Talent',
      render: (p) => {
        const t = talents[p.talent_record_id];
        const name = t ? `${t.first_name} ${t.last_name}`.trim() : 'Talent';
        return (
          <Link
            to={`/talent/${p.talent_record_id}`}
            className="rc-link-strong"
          >
            <EntityCell name={name} />
          </Link>
        );
      },
    },
    { key: 'stage', header: 'Stage', render: (p) => <StagePill status={p.status} /> },
    {
      key: 'move',
      header: '',
      align: 'right',
      render: (p) => (
        <MoveToMenu
          from={p.status}
          onSubmit={(to, note) => onTransition(p.id, to, note)}
        />
      ),
    },
  ];

  return (
    <div className="rc-work">
      <div>
        <div className="rc-ribbon">
          <h2 className="rc-ribbon__h">
            Pipeline
            <span className="rc-ribbon__total">
              {pipelines.length} in pipeline · {submitted} submitted
            </span>
          </h2>
          <div className="rc-funnel">
            {cells.map((c) => (
              <div
                key={c.key}
                className={`rc-fstage${c.count > 0 ? ' rc-fstage--has' : ' rc-fstage--dim'}`}
              >
                <div className="rc-fstage__bar" />
                <div className="rc-fstage__n num">{c.count}</div>
                <div className="rc-fstage__l">{c.label}</div>
              </div>
            ))}
          </div>
        </div>
        <Card flush className="rc-mt-16">
          <DataTable<PipelineView>
            columns={columns}
            rows={pipelines}
            rowKey={(p) => p.id}
            emptyMessage="No talent in this pipeline yet."
          />
        </Card>
      </div>

      <aside>
        <div className="rc-sidecard">
          <h3 className="rc-sidecard__h">This req at a glance</h3>
          <div className="rc-kv">
            <span className="rc-kv__k">Days open</span>
            <span className="rc-kv__v num">{daysOpen(req.created_at)}</span>
          </div>
          <div className="rc-kv">
            <span className="rc-kv__k">In pipeline</span>
            <span className="rc-kv__v num">{pipelines.length}</span>
          </div>
          <div className="rc-kv">
            <span className="rc-kv__k">Submitted</span>
            <span className="rc-kv__v num">{submitted}</span>
          </div>
          <div className="rc-kv">
            <span className="rc-kv__k">Openings</span>
            <span className="rc-kv__v num">
              {req.openings - req.openings_available}/{req.openings}
            </span>
          </div>
        </div>
        <ReservedSeam />
      </aside>
    </div>
  );
}

// ── Details tab (the PR-A2 inline-edit cockpit, relocated) ──

function DetailsPanel({
  req,
  present,
  scopes,
  saveField,
  onProfileLinked,
}: {
  readonly req: RequisitionView;
  readonly present: (key: string) => boolean;
  readonly scopes: readonly string[];
  readonly saveField: SaveFieldFn;
  readonly onProfileLinked: () => void;
}) {
  const reqRecord = req as unknown as Record<string, unknown>;
  return (
    <div className="rc-mt-16 rc-stack">
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
      <ProfileWorkbenchPanel
        requisitionId={req.id}
        scopes={scopes}
        onProfileLinked={onProfileLinked}
      />
    </div>
  );
}

// ── date helpers ──

function daysOpen(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

function daysAgo(iso: string): string {
  const d = daysOpen(iso);
  return d === 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
}
