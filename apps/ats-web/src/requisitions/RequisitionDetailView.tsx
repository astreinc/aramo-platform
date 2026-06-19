import { InlineAlert, useSession, type Session } from '@aramo/fe-foundation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { listActivities } from '../activity/activity-api';
import { ActivityTimeline } from '../activity/ActivityTimeline';
import { LogNoteDialog } from '../activity/LogNoteDialog';
import type { ActivityView } from '../activity/types';
import { Tabs, type TabItem } from '../components/Tabs';
import { getCompany } from '../companies/companies-api';
import { getContact } from '../contacts/contacts-api';
import { MoveToMenu } from '../pipeline/MoveToMenu';
import {
  listPipelinesForRequisition,
  transitionPipeline,
} from '../pipeline/pipeline-api';
import type { PipelineStatus, PipelineView } from '../pipeline/types';
import { useEntityCrumb } from '../shell/breadcrumb';
import { listTasksForOwner, probeTenantUsers } from '../task/task-api';
import { getTalent, updateTalent } from '../talent/talent-api';
import type { AttachmentView, TalentRecordView } from '../talent/types';
import { TasksPanel } from '../task/TasksPanel';
import {
  ActivityFeed,
  Avatar,
  Card,
  DataTable,
  EntityCell,
  FilterChip,
  Icons,
  ProgressMini,
  ReservedSeam,
  HotToggle,
  ScopedSearch,
  StatusPill,
  StagePill,
  Toolbar,
  funnelCounts,
  type ActivityFeedItem,
  type PillTone,
  type TableColumn,
} from '../ui';

import { AddTalentDialog } from './AddTalentDialog';
import { CockpitFieldRow, type SaveFieldFn } from './cockpit-fields';
import { COCKPIT_FIELDS, type CockpitSection } from './field-affordance';
import { ProfileWorkbenchPanel } from './ProfileWorkbenchPanel';
import {
  getRequisition,
  listRequisitionAttachments,
  updateRequisition,
} from './requisitions-api';
import { detailErrorMessage } from './error-messages';
import {
  type RequisitionStatus,
  type RequisitionView,
  type UpdateRequisitionRequest,
} from './types';

// Requisition DETAIL + pipeline — rebuilt to 100% parity with the locked
// "Confident Blue" job-detail mockup. The Pipeline tab is the signature
// surface: a funnel RIBBON (the 11-state → 6-bucket aggregation) + the talent
// table (Talent · Stage · Rate · Hot · Last activity · Owner · Move) +
// an at-a-glance sidecard (Days open / In pipeline / Submitted / Avg submit
// rate / Next action) + the RESERVED Match-insight seam (R10) + a Recent-
// activity feed.
//
// The Hot column is a row-level triage toggle bound to the EXISTING is_hot
// flag — a NON-ordinal preference mark, not an ordinal ranking (a per-talent rating
// was considered and REJECTED; see ADR-0019). Toggling writes is_hot via the
// existing talent edit path (PATCH /v1/talent-records/:id, talent:edit).
// Header actions: Log note · Edit (jumps to the inline-edit Details tab) ·
// Add talent (adds talent to the pipeline). Tabs: Pipeline / Details /
// Activity / Attachments (+ Tasks when scoped).

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

// Terminal (closed) stages — hidden by the "Active only" pipeline filter.
const TERMINAL_STATUSES: readonly PipelineStatus[] = [
  'placed',
  'not_in_consideration',
  'client_declined',
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
  const [talents, setTalents] = useState<Record<string, TalentRecordView>>({});
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [contactName, setContactName] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<readonly AttachmentView[]>([]);
  const [activities, setActivities] = useState<readonly ActivityView[]>([]);
  const [lastByPipeline, setLastByPipeline] = useState<
    Record<string, ActivityView>
  >({});
  const [nextAction, setNextAction] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [tab, setTab] = useState('pipeline');

  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const scopes = useMemo(() => session?.scopes ?? [], [session]);
  const canReadTasks = scopes.includes('task:read');
  const canWriteTasks = scopes.includes('task:write');
  const canEditHot = scopes.includes('talent:edit');
  const canAddTalent = scopes.includes('pipeline:add');
  const canLogNote = scopes.includes('activity:create');

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
        // Resolve names + labels + the secondary surfaces best-effort
        // (graceful on 403/404 — every leg is allSettled).
        const ids = Array.from(
          new Set(pipelineRes.items.map((p) => p.talent_record_id)),
        );
        const pids = pipelineRes.items.map((p) => p.id);
        const [
          coRes,
          contactRes,
          talentResults,
          rosterRes,
          attachRes,
          reqActRes,
          pipeActResults,
          tasksRes,
        ] = await Promise.allSettled([
          getCompany(reqRes.company_id),
          reqRes.contact_id !== null
            ? getContact(reqRes.contact_id)
            : Promise.reject(new Error('no contact')),
          Promise.allSettled(ids.map((id) => getTalent(id))),
          probeTenantUsers(),
          listRequisitionAttachments(reqId),
          listActivities('requisition', reqId),
          Promise.allSettled(pids.map((id) => listActivities('pipeline', id))),
          canReadTasks
            ? listTasksForOwner('requisition', reqId, 'open')
            : Promise.reject(new Error('no task scope')),
        ]);
        if (cancelled) return;
        if (coRes.status === 'fulfilled') setCompanyName(coRes.value.name);
        if (contactRes.status === 'fulfilled') {
          setContactName(
            `${contactRes.value.first_name} ${contactRes.value.last_name}`.trim(),
          );
        }
        if (talentResults.status === 'fulfilled') {
          const map: Record<string, TalentRecordView> = {};
          talentResults.value.forEach((r, i) => {
            const id = ids[i];
            if (id !== undefined && r.status === 'fulfilled') map[id] = r.value;
          });
          setTalents(map);
        }
        if (rosterRes.status === 'fulfilled' && rosterRes.value.available) {
          const names: Record<string, string> = {};
          for (const u of rosterRes.value.items) {
            names[u.user_id] = u.display_name ?? u.email;
          }
          setUserNames(names);
        }
        if (attachRes.status === 'fulfilled' && Array.isArray(attachRes.value.items)) {
          setAttachments(attachRes.value.items);
        }
        // Merge requisition-level notes + per-pipeline transition activities
        // (Q6 — the auto pipeline_status_change emits subject_type='pipeline').
        const merged: ActivityView[] = [];
        const lastMap: Record<string, ActivityView> = {};
        if (reqActRes.status === 'fulfilled' && Array.isArray(reqActRes.value.items)) {
          merged.push(...reqActRes.value.items);
        }
        if (pipeActResults.status === 'fulfilled') {
          pipeActResults.value.forEach((r) => {
            if (r.status !== 'fulfilled' || !Array.isArray(r.value.items)) return;
            for (const a of r.value.items) {
              merged.push(a);
              const pid = a.subject_id;
              if (pid === null) continue;
              const cur = lastMap[pid];
              if (cur === undefined || a.created_at > cur.created_at) {
                lastMap[pid] = a;
              }
            }
          });
        }
        merged.sort((a, b) => b.created_at.localeCompare(a.created_at));
        setActivities(merged);
        setLastByPipeline(lastMap);
        if (tasksRes.status === 'fulfilled' && Array.isArray(tasksRes.value.items)) {
          const open = tasksRes.value.items.length;
          setNextAction(
            open === 0
              ? 'All clear'
              : `${open} follow-up${open === 1 ? '' : 's'} due`,
          );
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
  }, [reqId, refreshKey, canReadTasks]);

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

  // Row-level is_hot triage. Optimistic toggle on the talents map with
  // rollback on failure (writes via the existing talent edit path).
  const handleToggleHot = async (talentId: string, next: boolean) => {
    const prev = talents[talentId];
    if (prev === undefined) return;
    setTalents((m) => ({ ...m, [talentId]: { ...prev, is_hot: next } }));
    try {
      await updateTalent(talentId, { is_hot: next });
    } catch {
      setTalents((m) => ({ ...m, [talentId]: prev }));
    }
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
          userNames={userNames}
          activities={activities}
          lastByPipeline={lastByPipeline}
          nextAction={nextAction}
          canEditHot={canEditHot}
          onTransition={handleTransition}
          onToggleHot={handleToggleHot}
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
      label: `Activity (${activities.length})`,
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
    {
      id: 'attachments',
      label: `Attachments (${attachments.length})`,
      content: <AttachmentsPanel attachments={attachments} />,
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
            {req.is_hot ? (
              <StatusPill tone="hot" icon={<Icons.IconFlame />}>
                Hot
              </StatusPill>
            ) : null}
            <StatusPill tone={STATUS_TONE[req.status]} dot>
              {STATUS_LABEL[req.status]}
            </StatusPill>
          </h1>
          <div className="rc-dhead__co">
            <Icons.IconCompanies />
            <Link to={`/companies/${req.company_id}`}>
              {companyName ?? 'Company'}
            </Link>
            {req.external_req_id !== null ? (
              <span className="mono">· {req.external_req_id}</span>
            ) : null}
          </div>
        </div>
        <div className="rc-dhead__actions">
          {canLogNote ? (
            <LogNoteDialog requisitionId={req.id} onSaved={refresh} />
          ) : null}
          <button className="rc-hbtn" onClick={() => setTab('details')}>
            <Icons.IconPencil />
            Edit
          </button>
          {canAddTalent ? (
            <AddTalentDialog
              requisitionId={req.id}
              existingTalentIds={pipelines.map((p) => p.talent_record_id)}
              onAdded={refresh}
            />
          ) : null}
        </div>
      </div>

      <MetaStrip
        req={req}
        contactName={contactName}
        recruiterName={
          req.recruiter_id !== null ? (userNames[req.recruiter_id] ?? null) : null
        }
        present={present}
      />

      <div className="rc-mt-16">
        <Tabs
          items={tabs}
          ariaLabel="Requisition sections"
          initialId="pipeline"
          selectedId={tab}
          onSelectedChange={setTab}
        />
      </div>
    </section>
  );
}

// ── Meta strip ──

function MetaStrip({
  req,
  contactName,
  recruiterName,
  present,
}: {
  readonly req: RequisitionView;
  readonly contactName: string | null;
  readonly recruiterName: string | null;
  readonly present: (key: string) => boolean;
}) {
  const place = [req.city, req.state].filter(Boolean).join(', ');
  const remote = remoteLabel(req.work_arrangement);
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
        <div className="rc-meta__v">
          <span>{place || '—'}</span>
          {remote !== null ? <small>· {remote}</small> : null}
        </div>
      </div>
      {showRate ? (
        <div className="rc-meta__cell">
          <div className="rc-meta__k">Max rate</div>
          <div className="rc-meta__v num">{req.max_pay_rate}</div>
        </div>
      ) : null}
      <div className="rc-meta__cell">
        <div className="rc-meta__k">Openings</div>
        <div className="rc-meta__v">
          <ProgressMini
            value={filled}
            max={req.openings}
            ariaLabel={`${filled} of ${req.openings} openings filled`}
          />
          <span className="num">
            {filled} of {req.openings}
          </span>
        </div>
      </div>
      {recruiterName !== null ? (
        <div className="rc-meta__cell">
          <div className="rc-meta__k">Recruiter</div>
          <div className="rc-meta__v">{recruiterName}</div>
        </div>
      ) : null}
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
  userNames,
  activities,
  lastByPipeline,
  nextAction,
  canEditHot,
  onTransition,
  onToggleHot,
}: {
  readonly req: RequisitionView;
  readonly pipelines: readonly PipelineView[];
  readonly talents: Record<string, TalentRecordView>;
  readonly userNames: Record<string, string>;
  readonly activities: readonly ActivityView[];
  readonly lastByPipeline: Record<string, ActivityView>;
  readonly nextAction: string | null;
  readonly canEditHot: boolean;
  readonly onTransition: (
    id: string,
    to: PipelineStatus,
    note: string | undefined,
  ) => Promise<void>;
  readonly onToggleHot: (talentId: string, next: boolean) => Promise<void>;
}) {
  const [activeOnly, setActiveOnly] = useState(false);
  const [query, setQuery] = useState('');

  const cells = funnelCounts(pipelines.map((p) => p.status));
  const submitted = pipelines.filter((p) =>
    SUBMITTED_PLUS.includes(p.status),
  ).length;
  const avgRate = averageStatedRate(pipelines, talents);

  const rows = pipelines.filter((p) => {
    if (activeOnly && TERMINAL_STATUSES.includes(p.status)) return false;
    if (query.trim() !== '') {
      const t = talents[p.talent_record_id];
      const name = t ? `${t.first_name} ${t.last_name}` : '';
      if (!name.toLowerCase().includes(query.trim().toLowerCase())) return false;
    }
    return true;
  });

  const columns: ReadonlyArray<TableColumn<PipelineView>> = [
    {
      key: 'talent',
      header: 'Talent',
      render: (p) => {
        const t = talents[p.talent_record_id];
        const name = t ? `${t.first_name} ${t.last_name}`.trim() : 'Talent';
        return (
          <Link to={`/talent/${p.talent_record_id}`} className="rc-link-strong">
            <EntityCell
              name={name}
              hot={t?.is_hot ?? false}
              subtitle={t?.key_skills ?? undefined}
            />
          </Link>
        );
      },
    },
    { key: 'stage', header: 'Stage', render: (p) => <StagePill status={p.status} /> },
    {
      // Talent-STATED rate freetext (gap #3) — the talent's stated pay.
      key: 'rate',
      header: 'Rate',
      render: (p) => (
        <span className="rate num">{talents[p.talent_record_id]?.current_pay ?? '—'}</span>
      ),
    },
    {
      // Row-level triage — the EXISTING is_hot flag as a toggle. A non-ordinal
      // "this one matters" mark, not an ordinal ranking (ADR-0019 rejected ratings).
      key: 'hot',
      header: 'Hot',
      render: (p) => {
        const t = talents[p.talent_record_id];
        const name = t ? `${t.first_name} ${t.last_name}`.trim() : 'this talent';
        return (
          <HotToggle
            hot={t?.is_hot ?? false}
            label={name}
            disabled={!canEditHot || t === undefined}
            onToggle={(next) => void onToggleHot(p.talent_record_id, next)}
          />
        );
      },
    },
    {
      key: 'last',
      header: 'Last activity',
      render: (p) => {
        const la = lastByPipeline[p.id];
        if (la !== undefined) {
          const text = la.notes != null && la.notes !== '' ? la.notes : activityLabel(la.type);
          return (
            <span className="last">
              {truncate(text, 32)} · <span className="mono">{relativeTime(la.created_at)}</span>
            </span>
          );
        }
        return (
          <span className="last">
            <span className="mono">{relativeTime(p.updated_at)}</span>
          </span>
        );
      },
    },
    {
      key: 'owner',
      header: 'Owner',
      render: (p) => {
        const ownerId = talents[p.talent_record_id]?.owner_id ?? null;
        const ownerName = ownerId !== null ? (userNames[ownerId] ?? null) : null;
        if (ownerName === null) return <span className="rc-muted-line">—</span>;
        return (
          <span className="owner">
            <Avatar name={ownerName} size="sm" />
            {ownerName}
          </span>
        );
      },
    },
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

  const feedItems: ActivityFeedItem[] = activities.slice(0, 6).map((a) => ({
    id: a.id,
    text:
      a.notes != null && a.notes !== '' ? truncate(a.notes, 64) : activityLabel(a.type),
    when: relativeTime(a.created_at),
  }));

  return (
    <div className="rc-work rc-work--detail">
      <div>
        <div className="rc-ribbon">
          <h2 className="rc-ribbon__h">
            Pipeline
            <span className="rc-ribbon__total">
              {pipelines.length} talent · {req.openings - req.openings_available}{' '}
              placed of {req.openings} openings
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
          <div className="rc-card__head">
            <h2>Talent</h2>
          </div>
          <Toolbar>
            <FilterChip active={!activeOnly} onClick={() => setActiveOnly(false)}>
              All stages
            </FilterChip>
            <FilterChip active={activeOnly} onClick={() => setActiveOnly(true)}>
              Active only
            </FilterChip>
            <ScopedSearch
              placeholder="In this pipeline"
              value={query}
              onChange={setQuery}
            />
          </Toolbar>
          <DataTable<PipelineView>
            columns={columns}
            rows={rows}
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
            <span className="rc-kv__k">Avg. submit rate</span>
            <span className="rc-kv__v num">{avgRate ?? '—'}</span>
          </div>
          {nextAction !== null ? (
            <div className="rc-kv">
              <span className="rc-kv__k">Next action</span>
              <span
                className="rc-kv__v"
                style={
                  nextAction === 'All clear' ? undefined : { color: 'var(--hot)' }
                }
              >
                {nextAction}
              </span>
            </div>
          ) : null}
        </div>

        <ReservedSeam />

        <div className="rc-sidecard">
          <h3 className="rc-sidecard__h">Recent activity</h3>
          {feedItems.length === 0 ? (
            <p className="rc-muted-line">No activity yet.</p>
          ) : (
            <ActivityFeed items={feedItems} />
          )}
        </div>
      </aside>
    </div>
  );
}

// ── Attachments tab ──

function AttachmentsPanel({
  attachments,
}: {
  readonly attachments: readonly AttachmentView[];
}) {
  return (
    <div className="rc-mt-16">
      <Card flush>
        <div className="rc-card__head">
          <h2>Attachments</h2>
        </div>
        {attachments.length === 0 ? (
          <p className="rc-empty">No attachments on this requisition yet.</p>
        ) : (
          <ul className="rc-filelist">
            {attachments.map((a) => (
              <li key={a.id} className="rc-filelist__row">
                <Icons.IconList />
                <span className="rc-filelist__nm">{a.file_name}</span>
                <span className="rc-filelist__meta mono">
                  {formatBytes(a.size_bytes)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
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

// ── helpers ──

function remoteLabel(workArrangement: string | null): string | null {
  if (workArrangement === 'remote') return 'Remote ok';
  if (workArrangement === 'hybrid') return 'Hybrid';
  if (workArrangement === 'onsite') return 'On-site';
  return null;
}

function activityLabel(type: ActivityView['type']): string {
  switch (type) {
    case 'pipeline_status_change':
      return 'Stage changed';
    case 'note':
      return 'Note logged';
    case 'call':
      return 'Call logged';
    case 'email_logged':
      return 'Email logged';
  }
}

// Average of the talents' STATED pay across this pipeline (gap #3). Parses the
// first number out of the freetext rate (e.g. "$74/hr" → 74). Returns a
// "$NN/hr" string or null when nothing parses.
function averageStatedRate(
  pipelines: readonly PipelineView[],
  talents: Record<string, TalentRecordView>,
): string | null {
  const nums: number[] = [];
  for (const p of pipelines) {
    const raw = talents[p.talent_record_id]?.current_pay;
    if (raw == null) continue;
    const m = raw.replace(/,/g, '').match(/\d+(\.\d+)?/);
    if (m) nums.push(Number(m[0]));
  }
  if (nums.length === 0) return null;
  const avg = nums.reduce((s, n) => s + n, 0) / nums.length;
  return `$${Math.round(avg)}/hr`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function daysOpen(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

function daysAgo(iso: string): string {
  const d = daysOpen(iso);
  return d === 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
}
