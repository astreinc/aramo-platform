import { ApiError, InlineAlert, useSession, useToast, type Session } from '@aramo/fe-foundation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Tabs, type TabItem, Button } from '@aramo/fe-foundation';

import { listActivities } from '../activity/activity-api';
import { ActivityTimeline } from '../activity/ActivityTimeline';
import { LogNoteDialog } from '../activity/LogNoteDialog';
import type { ActivityView } from '../activity/types';
import { getCompany } from '../companies/companies-api';
import { getContact } from '../contacts/contacts-api';
import { listPipelinesForRequisition } from '../pipeline/pipeline-api';
import { PIPELINE_STATUS_LABELS, type PipelineView } from '../pipeline/types';
import { listOffers } from '../offers/offers-api';
import { RECRUITING_OFFER_STATE_LABELS } from '../offers/labels';
import type { OfferState, OfferView } from '../offers/types';
import { listPlacements } from '../placement/placement-api';
import {
  PLACEMENT_STATE_LABELS,
  type PlacementView,
} from '../placement/types';
import { AssignmentLifecyclePanel } from '../placement/AssignmentLifecyclePanel';
import { AssignmentCommercialPanel } from '../placement/AssignmentCommercialPanel';
import { getPreStartRequirements } from '../pre-start/pre-start-api';
import type { PreStartPlacementRequirements } from '../pre-start/types';
import { REQUIREMENT_STATUS_LABELS } from '../pre-start/types';
import { findSubmittalForTalentJob } from '../submittals/submittals-api';
import { SUBMITTAL_STATE_LABELS } from '../submittals/types';
import { useEntityCrumb } from '../shell/breadcrumb';
import { getTalent, updateTalent } from '../talent/talent-api';
import type { AttachmentView, TalentRecordView } from '../talent/types';
import { TasksPanel } from '../task/TasksPanel';
import {
  Card,
  DataTable,
  Icons,
  initialsOf,
  StatusPill,
  StagePill,
  type TableColumn,
} from '../ui';

import { GuaranteeTermsPanel } from './GuaranteeTermsPanel';
import { TalentDetailPanel } from './TalentDetailPanel';
import { RequisitionTalentBoard } from './RequisitionTalentBoard';
import { AddTalentDialog } from './AddTalentDialog';
import {
  CLOSE_SUBMITTALS_HELPER,
  SELF_APPROVAL_SOD_LINE,
  lifecycleActionsFor,
  type LifecycleAction,
} from './approval-affordance';
import { RequisitionForm } from './RequisitionForm';
import { RequirementSkills } from './RequirementSkills';
import {
  getRequisition,
  listRequisitionAttachments,
  setRequisitionBookmark,
  updateRequisition,
} from './requisitions-api';
import { detailErrorMessage, lifecycleActionErrorMessage } from './error-messages';
import { RECRUITING_STATUS_TONE as STATUS_TONE } from './status-tone';
import {
  RECRUITING_STATUS_LABELS,
  type RequisitionView,
  type UpdateRequisitionRequest,
} from './types';

// Requisition DETAIL — the role/responsibility-oriented WORKSPACE that composes
// one coherent journey (Snapshot → Attention → tabs → drill-through) over
// several INDEPENDENTLY-GOVERNED lifecycles (pipeline / offer / pre-start /
// assignment / commercial). It composes SUMMARIES + drill-through only: the Offer,
// Pre-Start, Assignment and Commercial transitions live in their OWN governed
// surfaces and are never reimplemented here. Capacity is a DERIVED truth
// (openings/openings_available/capacity_balance), never a RecruitingStatus.
//
// EAGER vs LAZY (ruling #3 — no first-paint per-placement fan-out):
//   EAGER (requisition-grain, one call each): getRequisition,
//   listPipelinesForRequisition, listOffers(req), listPlacements(req, light),
//   resolveUserNames, company/contact, attachments, requisition + per-pipeline
//   activities (the existing allSettled best-effort pattern), tasks.
//   LAZY (issued only when the owning tab is opened — the Tabs primitive mounts
//   only the SELECTED panel): per-placement pre-start requirements, per-placement
//   assignment detail, per-placement commercial proposals, and the talent-journey
//   downstream cells. No per-placement read is issued at first paint.

// G2.5 — the cockpit section table (SECTION_TITLES/SECTION_ORDER) is removed;
// the Overview now renders the shared RequisitionForm, whose sections are the
// New-requisition sections.

// Offer states still in play (FE mirror of the BE OPEN offer position). An offer
// in one of these can be expiring; the terminal states cannot.
const OPEN_OFFER_STATES: ReadonlySet<OfferState> = new Set([
  'DRAFT',
  'SENT',
  'NEGOTIATION',
]);

// Horizon for "expiring soon" — grounded on the offer's own offer_expires_at
// (an existing field), NOT an invented submittal deadline.
const OFFER_EXPIRY_HORIZON_MS = 7 * 86_400_000;

// Scope constants — exact-string, no wildcard. Read/act gates for the
// independently-governed downstream lifecycles the workspace composes.
const PIPELINE_READ = 'pipeline:read';
const PIPELINE_CHANGE_STATUS = 'pipeline:change-status';
const OFFER_READ = 'offer:create'; // read rides create-authority (D7)
const PRE_START_READ = 'pre_start_requirement:read';
const PRE_START_ACT = 'pre_start_requirement:act';
const PLACEMENT_READ = 'placement:read';
const ASSIGNMENT_READ = 'assignment:read';
const ASSIGNMENT_EXTEND = 'assignment:extend';
const COMMERCIAL_READ = 'assignment:commercials:read';
const COMMERCIAL_APPROVE = 'assignment:commercials:approve';
// The submittal discovery read (GET /v1/submittals?talent_id=&job_id=) is
// BE-gated by submittal:create (read rides create-authority, like offers).
const SUBMITTAL_READ = 'submittal:create';

type TabId =
  | 'overview'
  | 'talent'
  | 'offers'
  | 'prestart'
  | 'assignments'
  | 'commercial'
  | 'activity'
  | 'attachments'
  | 'tasks'
  | 'guarantee-terms';

// PRESENTATION-EMPHASIS default tab. Grounded ONLY in the actor's real scopes —
// documented, never persisted, and NEVER a substitute for the per-tab scope
// gate or the BE authority (it only decides which already-permitted tab opens
// first). This is NOT persona impersonation: no persona is inferred or stored;
// the signal is the caller's own scope set. Order per ruling #2:
//   assignment:commercials:approve            → Commercial
//   else pipeline:change-status | pipeline:read → Talent
//   else assignment:extend | pre_start_requirement:act → Assignments
//   else                                       → Overview
// The resolved tab is clamped to the AVAILABLE set (fallback Overview) so the
// default can never point at a tab the actor cannot see.
function defaultTabFor(scopes: readonly string[], available: ReadonlySet<TabId>): TabId {
  // Talent is the default working surface when the actor can read the pipeline
  // (recruiters, owners); Commercial/Assignments are fallbacks for actors whose
  // only relevant scope is approval/assignment.
  let preferred: TabId = 'overview';
  if (scopes.includes(PIPELINE_CHANGE_STATUS) || scopes.includes(PIPELINE_READ))
    preferred = 'talent';
  else if (scopes.includes(COMMERCIAL_APPROVE)) preferred = 'commercial';
  else if (scopes.includes(ASSIGNMENT_EXTEND) || scopes.includes(PRE_START_ACT))
    preferred = 'assignments';
  return available.has(preferred) ? preferred : 'overview';
}

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
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [contactName, setContactName] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<readonly AttachmentView[]>([]);
  const [activities, setActivities] = useState<readonly ActivityView[]>([]);
  const [offers, setOffers] = useState<readonly OfferView[]>([]);
  const [placements, setPlacements] = useState<readonly PlacementView[]>([]);
  // Lazy attention: populated by the Pre-Start tab AFTER it is opened (its
  // per-placement reads are lazy). Keyed so re-opens replace, never accumulate.
  const [preStartBlocked, setPreStartBlocked] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [tab, setTab] = useState<TabId | null>(null);
  // G2.5b — whole-form Overview edit. Entered only via the header Edit button;
  // exited by the sticky edit bar's Cancel/Save.
  const [editing, setEditing] = useState(false);

  const sessionState = useSession();
  const toast = useToast();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const scopes = useMemo(() => session?.scopes ?? [], [session]);
  const canReadTasks = scopes.includes('task:read');
  const canWriteTasks = scopes.includes('task:write');
  // T7-P5 §3.1 — the Guarantee Terms tab is gated on the read scope AND applicability (a
  // PERMANENT-compensation requisition). Exact-string scope, no read issued without it.
  const canReadPermanentTerms = scopes.includes('placement:permanent:read');
  const canEditHot = scopes.includes('talent:edit');
  const canAddTalent = scopes.includes('pipeline:add');
  const canLogNote = scopes.includes('activity:create');
  // Downstream-lifecycle tab availability (least-visibility: no read issued, and
  // no tab shown, without the read scope).
  const canReadPipeline = scopes.includes(PIPELINE_READ);
  const canReadOffers = scopes.includes(OFFER_READ);
  const canReadPreStart = scopes.includes(PRE_START_READ);
  const canReadPlacements =
    scopes.includes(PLACEMENT_READ) || scopes.includes(ASSIGNMENT_READ);
  const canReadCommercial = scopes.includes(COMMERCIAL_READ);

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
        // (graceful on 403/404 — every leg is allSettled). ALL requisition-grain:
        // one call per axis, no per-placement fan-out.
        const ids = Array.from(
          new Set(pipelineRes.items.map((p) => p.talent_record_id)),
        );
        const pids = pipelineRes.items.map((p) => p.id);
        const [
          coRes,
          contactRes,
          talentResults,
          attachRes,
          reqActRes,
          pipeActResults,
          offersRes,
          placementsRes,
        ] = await Promise.allSettled([
          getCompany(reqRes.company_id),
          reqRes.contact_id !== null
            ? getContact(reqRes.contact_id)
            : Promise.reject(new Error('no contact')),
          Promise.allSettled(ids.map((id) => getTalent(id))),
          listRequisitionAttachments(reqId),
          listActivities('requisition', reqId),
          Promise.allSettled(pids.map((id) => listActivities('pipeline', id))),
          canReadOffers
            ? listOffers({ requisitionId: reqId })
            : Promise.reject(new Error('no offer scope')),
          canReadPlacements
            ? listPlacements({ requisition_id: reqId })
            : Promise.reject(new Error('no placement scope')),
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
        if (attachRes.status === 'fulfilled' && Array.isArray(attachRes.value.items)) {
          setAttachments(attachRes.value.items);
        }
        if (offersRes.status === 'fulfilled' && Array.isArray(offersRes.value.items)) {
          setOffers(offersRes.value.items);
        }
        if (
          placementsRes.status === 'fulfilled' &&
          Array.isArray(placementsRes.value.items)
        ) {
          setPlacements(placementsRes.value.items);
        }
        // Merge requisition-level notes + per-pipeline transition activities
        // (Q6 — the auto pipeline_status_change emits subject_type='pipeline').
        // Feeds the Activity-tab count only; the tab itself re-reads via
        // ActivityTimeline.
        const merged: ActivityView[] = [];
        if (reqActRes.status === 'fulfilled' && Array.isArray(reqActRes.value.items)) {
          merged.push(...reqActRes.value.items);
        }
        if (pipeActResults.status === 'fulfilled') {
          pipeActResults.value.forEach((r) => {
            if (r.status !== 'fulfilled' || !Array.isArray(r.value.items)) return;
            merged.push(...r.value.items);
          });
        }
        merged.sort((a, b) => b.created_at.localeCompare(a.created_at));
        setActivities(merged);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(detailErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reqId, refreshKey, canReadOffers, canReadPlacements]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Option A — a governed pipeline transition executed inside the talent side
  // panel returns the updated PipelineView; replace it in place (no full reload,
  // the panel stays open on its talent).
  const handlePipelineUpdated = useCallback((updated: PipelineView) => {
    setPipelines((prev) =>
      prev.map((p) => (p.id === updated.id ? updated : p)),
    );
  }, []);

  // G2.5 — retained ONLY for the governed status transition (lifecycle actions);
  // ordinary field edits now flow through the Overview form's whole-form save.
  const saveField = async (key: string, value: unknown): Promise<void> => {
    if (req === null) return;
    // T1-e (§2.4) — a status change is a governed transition and the server
    // requires the expected version. Send the version we last read alongside
    // the new status (read-then-write); other single-field edits keep the
    // additive, version-optional posture. The response carries the incremented
    // version, so setReq refreshes it for the next transition.
    const body = (
      key === 'status'
        ? { status: value, version: req.version }
        : { [key]: value }
    ) as unknown as UpdateRequisitionRequest;
    setReq(await updateRequisition(req.id, body));
  };

  // G2.5b — the Overview whole-form save. ONE PATCH carrying the changed
  // editable fields + the read-then-write `version` (existing CAS authority);
  // status is NOT included (it stays a governed transition). On success the
  // response's incremented version refreshes the header ("Edited …") and edit
  // mode exits. A CAS conflict throws → DetailsPanel keeps the draft + surfaces it.
  const saveOverviewEdits = async (
    body: UpdateRequisitionRequest,
  ): Promise<void> => {
    if (req === null) return;
    const updated = await updateRequisition(req.id, {
      ...body,
      version: req.version,
    } as UpdateRequisitionRequest);
    setReq(updated);
    setEditing(false);
  };

  // L1-E — run a named lifecycle action. AWAITED + catching (replaces the prior
  // fire-and-forget `void saveField`): a governed transition is a status-changing
  // PATCH the BE may refuse (409/422/403 self-approval/scope/POLICY_DENIED); the
  // typed refusal is surfaced honestly via the toast, never swallowed, never an
  // unhandled rejection. On success saveField refreshes `req` (new version), so
  // the affordance set recomputes for the next transition.
  const runLifecycleAction = async (aff: LifecycleAction): Promise<void> => {
    try {
      await saveField('status', aff.toStatus);
    } catch (err) {
      toast.show(lifecycleActionErrorMessage(err));
    }
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

  // §0 — no owner is derived or shown on the detail header (ownership isn't
  // modeled; creator ≠ owner).
  // Header line-2 clauses (each omitted when absent). WL-B4/R13 — render
  // "City, State ZIP" (e.g. "Washington, DC 20005") with partial values clean:
  // no stray null/undefined, no dangling comma when a part is missing.
  const headerPlace = [[req.city, req.state].filter(Boolean).join(', '), req.postal_code]
    .filter(Boolean)
    .join(' ');
  const headerArrangement = remoteLabel(req.work_arrangement, req.onsite_days_per_week);
  const headerType =
    req.type ?? (req.duration !== null ? `Contract ${req.duration}` : null);

  // ── Tab assembly (scope-gated availability) ──
  const tabs: TabItem[] = [];
  const available = new Set<TabId>(['overview']);

  tabs.push({
    id: 'overview',
    label: 'Overview',
    content: (
      <DetailsPanel
        req={req}
        companyName={companyName}
        contactName={contactName}
        present={present}
        scopes={scopes}
        editing={editing}
        onCancel={() => setEditing(false)}
        onSave={saveOverviewEdits}
      />
    ),
  });

  if (canReadPipeline) {
    available.add('talent');
    tabs.push({
      id: 'talent',
      label: `Talent (${pipelines.length})`,
      content: (
        <TalentJourney
          req={req}
          pipelines={pipelines}
          talents={talents}
          offers={offers}
          placements={placements}
          scopes={scopes}
          canEditHot={canEditHot}
          canReadOffers={canReadOffers}
          canReadPlacements={canReadPlacements}
          onToggleHot={handleToggleHot}
          onPipelineUpdated={handlePipelineUpdated}
          onNavigate={setTab}
        />
      ),
    });
  }

  if (canReadOffers) {
    available.add('offers');
    tabs.push({
      id: 'offers',
      label: `Offers (${offers.length})`,
      content: <OffersTab offers={offers} talents={talents} />,
    });
  }

  if (canReadPreStart) {
    available.add('prestart');
    tabs.push({
      id: 'prestart',
      label: 'Pre-Start',
      content: (
        <PreStartPanel
          placements={placements}
          talents={talents}
          canReadPlacements={canReadPlacements}
          canAct={scopes.includes(PRE_START_ACT)}
          onBlockedChange={setPreStartBlocked}
        />
      ),
    });
  }

  if (canReadPlacements) {
    available.add('assignments');
    tabs.push({
      id: 'assignments',
      label: `Assignments (${placements.length})`,
      content: (
        <AssignmentsTab
          placements={placements}
          talents={talents}
          session={session ?? undefined}
        />
      ),
    });
  }

  if (canReadCommercial) {
    available.add('commercial');
    tabs.push({
      id: 'commercial',
      label: 'Commercial',
      content: (
        <CommercialTab
          placements={placements}
          talents={talents}
          session={session ?? undefined}
        />
      ),
    });
  }

  available.add('activity');
  tabs.push({
    id: 'activity',
    label: `Activity (${activities.length})`,
    content: (
      <div className="rc-mt-16">
        <div className="rc-viewhead">
          <h2 className="rc-section-h">Activity — one timeline, every lifecycle</h2>
          <div className="rc-viewhead__actions">
            <LogNoteDialog
              requisitionId={req.id}
              requisitionCode={`REQ-${req.requisition_number}`}
              requisitionTitle={req.title}
              onSaved={refresh}
            />
          </div>
        </div>
        <ActivityTimeline
          requisitionId={req.id}
          pipelineIds={pipelines.map((p) => p.id)}
          refreshKey={refreshKey}
        />
      </div>
    ),
  });

  available.add('attachments');
  tabs.push({
    id: 'attachments',
    label: `Attachments (${attachments.length})`,
    content: <AttachmentsPanel attachments={attachments} />,
  });

  if (canReadTasks) {
    available.add('tasks');
    tabs.push({
      id: 'tasks',
      label: 'Tasks',
      content: (
        <div className="rc-mt-16">
          <div className="rc-viewhead">
            <h2 className="rc-section-h">Tasks on this requisition</h2>
          </div>
          <TasksPanel
            ownerType="requisition"
            ownerId={req.id}
            canWrite={canWriteTasks}
          />
          <p className="rc-muted-line rc-mt-8">
            Tasks consolidate actionable work across lifecycles.
          </p>
        </div>
      ),
    });
  }
  // T7-P5 §5.5 — the Guarantee Terms tab, only for a PERMANENT-compensation requisition the
  // actor may read (§3.1). The panel itself re-gates read/mutation on the exact permanent scopes.
  if (canReadPermanentTerms && reqRecord['compensation_model'] === 'PERMANENT') {
    available.add('guarantee-terms');
    tabs.push({
      id: 'guarantee-terms',
      label: 'Guarantee Terms',
      content: <GuaranteeTermsPanel requisitionId={req.id} sessionOverride={session ?? undefined} />,
    });
  }

  const defaultTab = defaultTabFor(scopes, available);
  const activeTab: TabId = tab !== null && available.has(tab) ? tab : defaultTab;

  // PR-14 — personal bookmark toggle (optimistic). PERSONAL to the caller;
  // never touches is_hot (the team-wide HOT pill) and never affects another
  // user's view.
  const toggleBookmark = (): void => {
    if (req === null) return;
    const next = !req.bookmarked;
    setReq({ ...req, bookmarked: next });
    void setRequisitionBookmark(req.id, next).catch(() => {
      setReq((prev) => (prev === null ? prev : { ...prev, bookmarked: !next }));
    });
  };

  return (
    <section>
      <div className="rc-dhead">
        <div>
          {/* PR-15 — the internal number is the primary human-readable id,
              rendered as the mono eyebrow (the prototype's top strip). It
              appears BEFORE external_req_id (which renders in line 2). */}
          <div className="rc-dhead__crumb mono">REQ-{req.requisition_number}</div>
          <h1 className="rc-dhead__title">
            {req.title}
            {req.is_hot ? (
              <StatusPill tone="hot" icon={<Icons.IconFlame />}>
                Priority
              </StatusPill>
            ) : null}
            <StatusPill tone={STATUS_TONE[req.status]} dot>
              {RECRUITING_STATUS_LABELS[req.status]}
            </StatusPill>
          </h1>
          {/* Line 2 — company · city, state · arrangement · type/Contract ·
              external. NO company icon (prototype has none); each clause is
              omitted when absent; company is a link. §0 — NO "· Owner <name>"
              (ownership isn't modeled; creator ≠ owner). */}
          <div className="rc-dhead__co">
            <Link to={`/companies/${req.company_id}`}>
              {companyName ?? 'Company'}
            </Link>
            {headerPlace !== '' ? <span> · {headerPlace}</span> : null}
            {headerArrangement !== null ? <span> · {headerArrangement}</span> : null}
            {headerType !== null ? <span> · {headerType}</span> : null}
            {req.external_req_id !== null ? (
              <span className="mono"> · {req.external_req_id}</span>
            ) : null}
          </div>
          {/* §0 — second line shows only aging; the version number and any
              "Created … by <user>" are removed (created-by is an audit fact shown
              only in Activity, never here, and never as "Owner"). An "· Edited
              <when>" clause is appended once the record has been edited. */}
          <div className="rc-dhead__sub">
            Open {daysOpen(req.created_at)} days
            {req.updated_at !== req.created_at ? (
              <span> · Edited {formatDate(req.updated_at)}</span>
            ) : null}
          </div>
        </div>
        <div className="rc-dhead__actions">
          {/* PR-14 — personal bookmark. NOT the team-wide HOT pill; never
              toggles is_hot, invisible to other users. */}
          <Button unstyled
            type="button"
            className={`rc-hbtn${req.bookmarked ? ' rc-hbtn--on' : ''}`}
            aria-pressed={req.bookmarked}
            aria-label={req.bookmarked ? 'Remove bookmark' : 'Bookmark'}
            onClick={toggleBookmark}
          >
            <Icons.IconBookmark />
            {req.bookmarked ? 'Bookmarked' : 'Bookmark'}
          </Button>
          {canLogNote ? (
            <LogNoteDialog
              requisitionId={req.id}
              requisitionCode={`REQ-${req.requisition_number}`}
              requisitionTitle={req.title}
              onSaved={refresh}
            />
          ) : null}
          {/* G2.5b — Edit enters whole-form Overview edit (switching to the
              Overview tab from anywhere); it reads "Editing" while active. */}
          <Button
            unstyled
            className={`rc-hbtn${editing ? ' rc-hbtn--primary' : ''}`}
            aria-pressed={editing}
            onClick={() => {
              setTab('overview');
              setEditing(true);
            }}
          >
            <Icons.IconPencil />
            {editing ? 'Editing' : 'Edit'}
          </Button>
          {/* L1-E — the named LIFECYCLE ACTIONS, gated by (current status × scope
              × submitter-context). Status is DISPLAYED as the pill above; the user
              changes the lifecycle ONLY through these named actions mirroring the
              authoritative transition matrix — never by editing a status enum.
              Cosmetic: the BE policy engine + in-service SoD gate are
              authoritative (an illegal/scope-less/self-approve action is refused
              regardless of what renders). Each drives a status-changing PATCH via
              the AWAITED runLifecycleAction, which surfaces typed refusals. */}
          {lifecycleActionsFor(req.status, scopes, {
            submitterId: req.pending_approval_submitter_id,
            actorId: session?.sub ?? null,
          }).map((aff) => (
            <Button unstyled
              key={aff.action}
              type="button"
              className={`rc-hbtn${aff.action === 'APPROVE' ? ' rc-hbtn--primary' : ''}`}
              title={aff.action === 'CLOSE_SUBMITTALS' ? CLOSE_SUBMITTALS_HELPER : undefined}
              onClick={() => {
                void runLifecycleAction(aff);
              }}
            >
              {aff.label}
            </Button>
          ))}
          {/* SoD — the submitter of a pending_approval requisition (holding the
              approve scope) sees the reason their own Approve is suppressed; Reject
              stays available above. A DIFFERENT approver sees the Approve button. */}
          {req.status === 'pending_approval' &&
          scopes.includes('requisition:approve') &&
          req.pending_approval_submitter_id !== null &&
          req.pending_approval_submitter_id === (session?.sub ?? null) ? (
            <span className="rc-hbtn-sod">{SELF_APPROVAL_SOD_LINE}</span>
          ) : null}
          {canAddTalent ? (
            <AddTalentDialog
              requisitionId={req.id}
              existingTalentIds={pipelines.map((p) => p.talent_record_id)}
              onAdded={refresh}
            />
          ) : null}
        </div>
      </div>

      {/* Snapshot strip (eager, grounded cards) then the attention rail — both
          above the tabs, matching the prototype. */}
      <SnapshotStrip
        req={req}
        pipelines={pipelines}
        offers={offers}
        placements={placements}
        canReadPipeline={canReadPipeline}
        canReadOffers={canReadOffers}
        canReadPreStart={canReadPreStart}
        canReadPlacements={canReadPlacements}
        canReadCommercial={canReadCommercial}
        onNavigate={setTab}
      />

      <AttentionRail
        req={req}
        offers={offers}
        preStartBlocked={preStartBlocked}
        scopes={scopes}
        canReadOffers={canReadOffers}
        canReadPreStart={canReadPreStart}
        onNavigate={setTab}
      />

      <div className="rc-mt-16 rc-ws-tabs">
        <Tabs
          items={tabs}
          ariaLabel="Requisition sections"
          initialId={defaultTab}
          selectedId={activeTab}
          onSelectedChange={(id) => setTab(id as TabId)}
        />
      </div>
    </section>
  );
}

// ── Snapshot strip (eager cards, clickable → tab) ──

function SnapshotCard({
  label,
  value,
  hint,
  onClick,
  warn,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: string;
  readonly onClick?: () => void;
  readonly warn?: boolean;
}) {
  const className = `rc-snapcard${warn ? ' rc-snapcard--warn' : ''}`;
  const inner = (
    <>
      <span className="rc-snapcard__k">
        {warn ? <span aria-hidden="true">⚠</span> : null}
        {label}
      </span>
      <span className="rc-snapcard__v">{value}</span>
      {hint !== undefined ? <span className="rc-snapcard__sub">{hint}</span> : null}
    </>
  );
  if (onClick === undefined) {
    return <div className={className}>{inner}</div>;
  }
  return (
    <Button unstyled type="button" className={className} onClick={onClick}>
      {inner}
    </Button>
  );
}

function clientStatusValue(status: RequisitionView['client_submittal_status']): string {
  // L8-B2 — null ⇒ OPEN (never "Unknown"). paused/closed are the actionable states.
  switch (status) {
    case 'paused':
      return 'Paused';
    case 'closed':
      return 'Closed';
    default:
      return 'Open';
  }
}

function SnapshotStrip({
  req,
  pipelines,
  offers,
  placements,
  canReadPipeline,
  canReadOffers,
  canReadPreStart,
  canReadPlacements,
  canReadCommercial,
  onNavigate,
}: {
  readonly req: RequisitionView;
  readonly pipelines: readonly PipelineView[];
  readonly offers: readonly OfferView[];
  readonly placements: readonly PlacementView[];
  readonly canReadPipeline: boolean;
  readonly canReadOffers: boolean;
  readonly canReadPreStart: boolean;
  readonly canReadPlacements: boolean;
  readonly canReadCommercial: boolean;
  readonly onNavigate: (tab: TabId) => void;
}) {
  const filled = req.openings - req.openings_available;
  const overCapacity = req.capacity_balance < 0;
  const activeOffers = offers.filter((o) => OPEN_OFFER_STATES.has(o.state)).length;
  const expiringOffers = offers.filter((o) => isOfferExpiringSoon(o)).length;
  const startedPlacements = placements.filter((p) => p.state === 'STARTED').length;
  const clientStatus = clientStatusValue(req.client_submittal_status ?? null);
  const clientReason =
    req.client_submittal_reason !== null && req.client_submittal_reason !== undefined
      ? req.client_submittal_reason.replace(/_/g, ' ')
      : undefined;

  return (
    <div className="rc-snap">
      <SnapshotCard
        label="Talent"
        value={pipelines.length}
        hint="in play"
        onClick={canReadPipeline ? () => onNavigate('talent') : undefined}
      />
      <SnapshotCard
        label="Capacity"
        value={overCapacity ? `+${-req.capacity_balance} over` : req.openings_available}
        hint={overCapacity ? 'over capacity' : `${filled}/${req.openings} filled`}
        warn={overCapacity}
        onClick={canReadPipeline ? () => onNavigate('talent') : undefined}
      />
      <SnapshotCard
        label="Client status"
        value={clientStatus}
        hint={clientReason}
        warn={clientStatus !== 'Open'}
        onClick={() => onNavigate('overview')}
      />
      {canReadOffers ? (
        <SnapshotCard
          label="Offers"
          value={activeOffers}
          hint={expiringOffers > 0 ? `${expiringOffers} expiring soon` : undefined}
          warn={expiringOffers > 0}
          onClick={() => onNavigate('offers')}
        />
      ) : null}
      {canReadPreStart ? (
        <SnapshotCard label="Pre-start" value="View" onClick={() => onNavigate('prestart')} />
      ) : null}
      {canReadPlacements ? (
        <SnapshotCard
          label="Assignments"
          value={startedPlacements}
          hint={placements.length > 0 ? `${placements.length} placement rows` : undefined}
          onClick={() => onNavigate('assignments')}
        />
      ) : null}
      {canReadCommercial ? (
        <SnapshotCard label="Commercial" value="View" onClick={() => onNavigate('commercial')} />
      ) : null}
      <SnapshotCard label="Aging" value={`${daysOpen(req.created_at)}d`} hint="since opened" />
    </div>
  );
}

// ── Attention (grounded only) ──
//
// EAGER items are computed from requisition-grain data (offer expiry, capacity,
// client status). LAZY items (pre-start blocked) populate only after their tab
// has been opened and its per-placement reads returned. DELIBERATELY ABSENT:
// "interviews today" and any "submittal deadline countdown" — there is no
// modelled data source for either (masked-by-absence discipline extended to the
// attention feed), so they are OMITTED, never mocked.

type AttnTone = 'blue' | 'red' | 'amber';

function AttnRow({
  tone,
  what,
  detail,
  age,
  linkLabel,
  onClick,
}: {
  readonly tone: AttnTone;
  readonly what: string;
  readonly detail?: string;
  readonly age?: string;
  readonly linkLabel: string;
  readonly onClick: () => void;
}) {
  return (
    <div className="rc-attn__row">
      <span className={`rc-attn__dot rc-attn__dot--${tone}`} aria-hidden="true" />
      <span className="rc-attn__body">
        <b>{what}</b>
        {detail !== undefined ? <span className="rc-attn__detail"> {detail}</span> : null}
      </span>
      {age !== undefined ? <span className="rc-attn__age">{age}</span> : null}
      <Button unstyled type="button" className="rc-attn__link" onClick={onClick}>
        {linkLabel}
      </Button>
    </div>
  );
}

// Presentation-role label for the attention header. Derived ONLY from real
// scopes — the SAME signal as the default-tab emphasis, documented, never
// persisted, and NEVER authority (it does not gate any action; the BE + the
// per-tab scope gates do). This is NOT persona impersonation: nothing is
// assumed or acted-as; it labels the actor's own scope set.
function presentationRole(scopes: readonly string[]): string {
  if (scopes.includes(COMMERCIAL_APPROVE)) return 'commercial approver';
  if (scopes.includes(PIPELINE_CHANGE_STATUS) || scopes.includes(PIPELINE_READ))
    return 'recruiter';
  if (scopes.includes(ASSIGNMENT_EXTEND) || scopes.includes(PRE_START_ACT))
    return 'delivery';
  return 'viewer';
}

function AttentionRail({
  req,
  offers,
  preStartBlocked,
  scopes,
  canReadOffers,
  canReadPreStart,
  onNavigate,
}: {
  readonly req: RequisitionView;
  readonly offers: readonly OfferView[];
  readonly preStartBlocked: number | null;
  readonly scopes: readonly string[];
  readonly canReadOffers: boolean;
  readonly canReadPreStart: boolean;
  readonly onNavigate: (tab: TabId) => void;
}) {
  const rows: ReactNode[] = [];

  if (canReadOffers) {
    const expiring = offers.filter((o) => isOfferExpiringSoon(o));
    if (expiring.length > 0) {
      // Age = the soonest remaining offer window (grounded on offer_expires_at).
      const soonest = Math.min(...expiring.map((o) => offerDaysLeft(o)));
      rows.push(
        <AttnRow
          key="offer-expiring"
          tone="amber"
          what={`${expiring.length} offer${expiring.length === 1 ? '' : 's'} expiring soon`}
          detail="offer window closing"
          age={soonest <= 0 ? 'overdue' : `${soonest}d left`}
          linkLabel="Offers →"
          onClick={() => onNavigate('offers')}
        />,
      );
    }
  }

  if (req.capacity_balance < 0) {
    rows.push(
      <AttnRow
        key="over-capacity"
        tone="red"
        what={`Over capacity by ${-req.capacity_balance}`}
        detail="active placements exceed openings"
        linkLabel="Talent →"
        onClick={() => onNavigate('talent')}
      />,
    );
  }

  const clientStatus = req.client_submittal_status ?? null;
  if (clientStatus === 'paused' || clientStatus === 'closed') {
    rows.push(
      <AttnRow
        key="client-status"
        tone={clientStatus === 'closed' ? 'red' : 'amber'}
        what={`Client submittals ${clientStatus}`}
        detail={
          req.client_submittal_reason !== null && req.client_submittal_reason !== undefined
            ? req.client_submittal_reason.replace(/_/g, ' ')
            : undefined
        }
        linkLabel="Overview →"
        onClick={() => onNavigate('overview')}
      />,
    );
  }

  if (canReadPreStart && preStartBlocked !== null && preStartBlocked > 0) {
    rows.push(
      <AttnRow
        key="prestart-blocked"
        tone="red"
        what={`${preStartBlocked} pre-start item${preStartBlocked === 1 ? '' : 's'} blocked`}
        detail="blocking requirements unresolved"
        linkLabel="Pre-Start →"
        onClick={() => onNavigate('prestart')}
      />,
    );
  }

  if (rows.length === 0) return null;

  return (
    <section className="rc-attn" aria-label="Needs attention">
      <div className="rc-attn__h">
        <b>Your attention</b>
        <small>— as {presentationRole(scopes)}</small>
      </div>
      {rows}
    </section>
  );
}

// ── Talent tab — the Talent-journey GRID (Option A) ──
//
// One row per pipeline episode. Each POPULATED cell is a summary that drills to
// its OWNING surface; a "—" cell is non-actionable. NO cell hosts an inline
// state machine: the pipeline move, HOT triage and log-activity all live in the
// TalentDetailPanel (the owning surface), reached by clicking the talent /
// pipeline / offer cells. Load model — TALENT + PIPELINE eager (PipelineView);
// OFFER an eager JOIN over the requisition-grain offers-by-req list; CLIENT +
// PRE-START lazy (rendered "—" at first paint — no per-talent submittal /
// pre-start read is issued here, so the no-first-paint-fan-out invariant holds);
// ASSIGNMENT an eager join over the requisition-grain placements-by-req list (no
// per-placement fan-out). The prototype's "Full pipeline →" link has NO verified
// route in this app and the grid already IS the full pipeline for the req, so it
// is OMITTED (ruling C — omit, never a broken/mocked target).

// The current (live) offer for a talent — the open one, else the most recent.
function liveOfferFor(
  offers: readonly OfferView[],
  talentId: string,
): OfferView | null {
  const mine = offers.filter((o) => o.talent_record_id === talentId);
  if (mine.length === 0) return null;
  const live = mine.find((o) => OPEN_OFFER_STATES.has(o.state));
  if (live !== undefined) return live;
  return [...mine].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

// The relevant placement for a talent — a STARTED one, else the most recent.
function placementFor(
  placements: readonly PlacementView[],
  talentId: string,
): PlacementView | null {
  const mine = placements.filter((p) => p.talent_record_id === talentId);
  if (mine.length === 0) return null;
  const started = mine.find((p) => p.state === 'STARTED');
  if (started !== undefined) return started;
  return [...mine].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

// Authoritative pre-start summary (BE-derived readiness/blocking), rendered
// verbatim. Null when there is no requirement set for the placement ("—").
function summarizePreStart(r: PreStartPlacementRequirements): string | null {
  if (!r.materialized) return null;
  if (r.blocking_unresolved_count > 0) return `Blocked · ${r.blocking_unresolved_count}`;
  if (r.ready) return 'Ready';
  return 'Pending';
}

// Per-talent lazy cell state for the CLIENT + PRE-START columns. Populated ONLY
// when a talent row is opened; cached for the page lifetime (reopening does not
// refetch) and invalidated for that talent when its pipeline is transitioned.
type JourneyCells =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly client: string | null; readonly prestart: string | null };

// Render text for a lazy CLIENT/PRE-START cell: "—" before open / on absence,
// "…" while the opened row is loading, else the authoritative value.
function journeyCellText(
  cell: JourneyCells | undefined,
  which: 'client' | 'prestart',
): string {
  if (cell === undefined) return '—';
  if (cell.status === 'loading') return '…';
  return (which === 'client' ? cell.client : cell.prestart) ?? '—';
}

function TalentJourney({
  req,
  pipelines,
  talents,
  offers,
  placements,
  scopes,
  canEditHot,
  canReadOffers,
  canReadPlacements,
  onToggleHot,
  onPipelineUpdated,
  onNavigate,
}: {
  readonly req: RequisitionView;
  readonly pipelines: readonly PipelineView[];
  readonly talents: Record<string, TalentRecordView>;
  readonly offers: readonly OfferView[];
  readonly placements: readonly PlacementView[];
  readonly scopes: readonly string[];
  readonly canEditHot: boolean;
  readonly canReadOffers: boolean;
  readonly canReadPlacements: boolean;
  readonly onToggleHot: (talentId: string, next: boolean) => Promise<void>;
  readonly onPipelineUpdated: (updated: PipelineView) => void;
  readonly onNavigate: (tab: TabId) => void;
}) {
  const [selected, setSelected] = useState<PipelineView | null>(null);
  // TB-2 — the Talent surface's List|Board view mode (List is the default working surface).
  const [talentView, setTalentView] = useState<'list' | 'board'>('list');
  // Lazy CLIENT/PRE-START population, keyed by talent_record_id.
  const [cells, setCells] = useState<Record<string, JourneyCells>>({});
  // Find Talent ▾ menu (prototype): the two sourcing entry points.
  const [findOpen, setFindOpen] = useState(false);
  const canSource = scopes.includes('talent:source');

  // Least-visibility: the read rides its existing scope; without it the cell
  // stays "—" and NO fetch is ever issued.
  const canReadClient = scopes.includes(SUBMITTAL_READ);
  const canReadPreStart = scopes.includes(PRE_START_READ);

  // Fetch ONE talent's authoritative CLIENT + PRE-START values. No cross-row
  // fan-out, no speculative values; failures + absences collapse to "—".
  const fetchCells = useCallback(
    (talentId: string) => {
      setCells((m) => ({ ...m, [talentId]: { status: 'loading' } }));
      const clientP: Promise<string | null> = canReadClient
        ? findSubmittalForTalentJob(talentId, req.id)
            .then((r) => (r.submittal !== null ? SUBMITTAL_STATE_LABELS[r.submittal.state] : null))
            .catch(() => null)
        : Promise.resolve(null);
      const placement = canReadPlacements ? placementFor(placements, talentId) : null;
      const preStartP: Promise<string | null> =
        canReadPreStart && placement !== null
          ? getPreStartRequirements(placement.id)
              .then((r) => summarizePreStart(r))
              .catch(() => null)
          : Promise.resolve(null);
      void Promise.all([clientP, preStartP]).then(([client, prestart]) => {
        setCells((m) => ({ ...m, [talentId]: { status: 'loaded', client, prestart } }));
      });
    },
    [canReadClient, canReadPreStart, canReadPlacements, placements, req.id],
  );

  // Open a talent row → open the panel + hydrate its cells (cache hit ⇒ no
  // refetch). This is the ONLY entry point for the per-talent reads: nothing
  // hydrates at first paint or in an effect.
  const openRow = useCallback(
    (p: PipelineView) => {
      setSelected(p);
      // Cache hit (loading or loaded) ⇒ no refetch on reopen.
      if (cells[p.talent_record_id] === undefined) fetchCells(p.talent_record_id);
    },
    [cells, fetchCells],
  );

  // TB-2 — talent display names for the Board (keyed by talent_record_id). Reuses the
  // requisition's already-loaded `talents` enrichment; the Board never re-fetches per card.
  const boardTalentNames = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(talents).map(([id, t]) => [id, `${t.first_name} ${t.last_name}`.trim()]),
      ),
    [talents],
  );

  return (
    <div className="rc-tj">
      <div className="rc-board__toolbar" role="tablist" aria-label="Talent view">
        <Button
          unstyled
          type="button"
          role="tab"
          aria-selected={talentView === 'list'}
          className={`rc-board__toggle${talentView === 'list' ? ' rc-board__toggle--on' : ''}`}
          onClick={() => setTalentView('list')}
        >
          List
        </Button>
        <Button
          unstyled
          type="button"
          role="tab"
          aria-selected={talentView === 'board'}
          className={`rc-board__toggle${talentView === 'board' ? ' rc-board__toggle--on' : ''}`}
          onClick={() => setTalentView('board')}
        >
          Board
        </Button>
      </div>
      {talentView === 'board' ? (
        <RequisitionTalentBoard
          requisitionId={req.id}
          talentNames={boardTalentNames}
          onSelectCard={(pid) => {
            const p = pipelines.find((x) => x.id === pid);
            if (p !== undefined) openRow(p);
          }}
        />
      ) : (
      <div className="rc-tj__inner" role="table" aria-label="Talent journey">
        <div className="rc-tj__head">
          <span className="rc-tj__title">Talent journey</span>
          {/* Find Talent ▾ — the two sourcing entry points (prototype). Gated on
              talent:source (the /sourcing route's scope); no menu without it. */}
          {canSource ? (
            <div className="rc-tj__find">
              <Button
                unstyled
                type="button"
                className="rc-tj__findbtn"
                aria-haspopup="menu"
                aria-expanded={findOpen}
                onClick={() => setFindOpen((o) => !o)}
              >
                Find Talent <Icons.IconChevronDown />
              </Button>
              {findOpen ? (
                <>
                  <Button
                    unstyled
                    type="button"
                    aria-label="Close menu"
                    className="rc-tj__findveil"
                    onClick={() => setFindOpen(false)}
                  >
                    <span aria-hidden="true" />
                  </Button>
                  <div className="rc-tj__findmenu" role="menu">
                    <Link
                      to="/sourcing"
                      role="menuitem"
                      className="rc-tj__finditem"
                      onClick={() => setFindOpen(false)}
                    >
                      <span className="rc-tj__findt">Rediscover existing Talent</span>
                      <span className="rc-tj__findd">
                        Search your tenant&apos;s eligible, known Talent pool for this requisition
                      </span>
                    </Link>
                    <Link
                      to="/sourcing"
                      role="menuitem"
                      className="rc-tj__finditem"
                      onClick={() => setFindOpen(false)}
                    >
                      <span className="rc-tj__findt">Source new Talent</span>
                      <span className="rc-tj__findd">
                        Discover people not yet in your working Talent pool
                      </span>
                    </Link>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
          {/* Full pipeline → the requisitions list (the prototype target). */}
          <Link to="/requisitions" className="rc-tj__full">
            Full pipeline →
          </Link>
        </div>
        <div className="rc-tj__row rc-tj__row--head" role="row">
          {/* Ruling 2 — canonical journey labels: Recruiting / Client / Offer /
              Pre-Start / Employment (never "Onboarding"/"Pipeline"/"Assignment").
              Each cell still reads from its OWNING aggregate; only the column
              header presentation is the unified-journey vocabulary. */}
          <span className="rc-tj__ch">Talent</span>
          <span className="rc-tj__ch">Email</span>
          <span className="rc-tj__ch">Phone</span>
          <span className="rc-tj__ch">Recruiting</span>
          <span className="rc-tj__ch">Client</span>
          <span className="rc-tj__ch">Offer</span>
          <span className="rc-tj__ch">Pre-Start</span>
          <span className="rc-tj__ch">Employment</span>
          <span className="rc-tj__ch">Right to represent</span>
        </div>
        {pipelines.length === 0 ? (
          <div className="rc-tj__row" role="row">
            <span className="rc-tj__empty">No talent in this pipeline yet.</span>
          </div>
        ) : (
          pipelines.map((p) => {
            const t = talents[p.talent_record_id];
            const name = t ? `${t.first_name} ${t.last_name}`.trim() : 'Talent';
            const email = t?.email1 ?? null;
            const phone = t?.phone_cell ?? t?.phone_work ?? t?.phone_home ?? null;
            const offer = canReadOffers
              ? liveOfferFor(offers, p.talent_record_id)
              : null;
            const placement = canReadPlacements
              ? placementFor(placements, p.talent_record_id)
              : null;
            const cell = cells[p.talent_record_id];
            return (
              <div key={p.id} className="rc-tj__row" role="row">
                {/* TALENT → the talent side panel (owning surface). */}
                <Button unstyled
                  type="button"
                  className="rc-tj__talent"
                  onClick={() => openRow(p)}
                >
                  <span className="rc-tj__avatar" aria-hidden="true">
                    {initialsOf(name)}
                  </span>
                  <span className="rc-tj__name">
                    {name}
                    {t?.is_hot ? (
                      <span className="rc-tj__flame" aria-hidden="true">
                        <Icons.IconFlame />
                      </span>
                    ) : null}
                  </span>
                </Button>
                {/* EMAIL — mailto (primary email1); "—" when absent. */}
                {email !== null && email !== '' ? (
                  <a className="rc-tj__mail" href={`mailto:${email}`} title={email}>
                    {email}
                  </a>
                ) : (
                  <span className="rc-tj__cell rc-tj__empty">—</span>
                )}
                {/* PHONE — cell, then work, then home; "—" when absent. */}
                <span className="rc-tj__cell rc-tj__phone">
                  {phone !== null && phone !== '' ? phone : '—'}
                </span>
                {/* PIPELINE → the recruiting stepper in the side panel. */}
                <Button unstyled
                  type="button"
                  className="rc-tj__cell"
                  onClick={() => openRow(p)}
                  aria-label={`Pipeline: ${PIPELINE_STATUS_LABELS[p.status]}`}
                >
                  <StagePill status={p.status} />
                </Button>
                {/* CLIENT — authoritative submittal-state summary for this talent,
                    populated LAZILY when the row is opened (the pipeline→submittal
                    linkage read; never derived from the pipeline stage). */}
                <span className="rc-tj__cell rc-tj__empty">
                  {journeyCellText(cell, 'client')}
                </span>
                {/* OFFER → the offer surface in the side panel. */}
                {offer !== null ? (
                  <Button unstyled
                    type="button"
                    className="rc-tj__cell"
                    onClick={() => openRow(p)}
                  >
                    {RECRUITING_OFFER_STATE_LABELS[offer.state]}
                    {isOfferExpiringSoon(offer) ? (
                      <span className="rc-tj__exp">
                        Expires {Math.max(0, offerDaysLeft(offer))}d
                      </span>
                    ) : null}
                  </Button>
                ) : (
                  <span className="rc-tj__cell rc-tj__empty">—</span>
                )}
                {/* PRE-START — authoritative readiness for this talent's placement,
                    populated LAZILY when the row is opened. */}
                <span className="rc-tj__cell rc-tj__empty">
                  {journeyCellText(cell, 'prestart')}
                </span>
                {/* ASSIGNMENT → the Assignments surface (drill). */}
                {placement !== null ? (
                  <Button unstyled
                    type="button"
                    className="rc-tj__cell"
                    onClick={() => onNavigate('assignments')}
                  >
                    {PLACEMENT_STATE_LABELS[placement.state]}
                  </Button>
                ) : (
                  <span className="rc-tj__cell rc-tj__empty">—</span>
                )}
                {/* RTR — Right to Represent. Send action is being wired in a
                    separate slice; the button is placed (unwired) so the column
                    matches the prototype. No backend call is issued yet. */}
                <span className="rc-tj__rtr">
                  <Button
                    unstyled
                    type="button"
                    className="rc-tj__rtrbtn"
                    title="Send RTR — wiring in progress"
                  >
                    <Icons.IconMail />
                    Send RTR
                  </Button>
                </span>
              </div>
            );
          })
        )}
      </div>
      )}
      {selected !== null ? (
        <TalentDetailPanel
          entry={selected}
          talentName={talentLabel(talents, selected.talent_record_id)}
          isNew={false}
          reqTitle={req.title}
          reqCode={`REQ-${req.requisition_number}`}
          scopes={scopes}
          isHot={talents[selected.talent_record_id]?.is_hot ?? false}
          canEditHot={canEditHot}
          onToggleHot={(next) => void onToggleHot(selected.talent_record_id, next)}
          onClose={() => setSelected(null)}
          onTransitioned={(u) => {
            onPipelineUpdated(u);
            setSelected(u);
            // The owning workflow changed → invalidate this talent's cached
            // CLIENT/PRE-START cells and refetch (the row is still open).
            fetchCells(u.talent_record_id);
          }}
        />
      ) : null}
    </div>
  );
}

// ── Offers tab (summary + drill-through; read rides offer:create) ──

function talentLabel(
  talents: Record<string, TalentRecordView>,
  talentId: string,
): string {
  const t = talents[talentId];
  return t ? `${t.first_name} ${t.last_name}`.trim() : 'Talent';
}

// Shared per-tab empty state — mirrors the prototype's dashed "nothing here yet"
// card (title + explanatory body). Used by the tabs whose prototype view is an
// empty state; the populated tables/lists render instead once data exists.
function TabEmpty({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="rc-mt-16">
      <div className="rc-tabempty">
        <div className="rc-tabempty__t">{title}</div>
        <p className="rc-tabempty__b">{children}</p>
      </div>
    </div>
  );
}

function OffersTab({
  offers,
  talents,
}: {
  readonly offers: readonly OfferView[];
  readonly talents: Record<string, TalentRecordView>;
}) {
  if (offers.length === 0) {
    return (
      <TabEmpty title="No offers on this requisition">
        Create offer becomes available when a Talent reaches Client — Selected.
        Offers carry Talent-facing terms only; employer financials live in
        Commercial.
      </TabEmpty>
    );
  }
  const columns: ReadonlyArray<TableColumn<OfferView>> = [
    {
      key: 'talent',
      header: 'Talent',
      render: (o) => (
        <Link to={`/talent/${o.talent_record_id}`} className="rc-link-strong">
          {talentLabel(talents, o.talent_record_id)}
        </Link>
      ),
    },
    {
      key: 'state',
      header: 'State',
      render: (o) => (
        <span className="rc-pill rc-pill--neutral">
          {RECRUITING_OFFER_STATE_LABELS[o.state]}
        </span>
      ),
    },
    {
      key: 'expires',
      header: 'Expires',
      render: (o) =>
        o.offer_expires_at !== null ? (
          <span className={isOfferExpiringSoon(o) ? 'num rc-metric__hint' : 'num'}>
            {formatDate(o.offer_expires_at)}
            {isOfferExpiringSoon(o) ? ' · soon' : ''}
          </span>
        ) : (
          <span className="rc-muted-line">—</span>
        ),
    },
    {
      key: 'ref',
      header: 'Client ref',
      render: (o) =>
        o.client_offer_reference !== null ? (
          <span className="mono">{o.client_offer_reference}</span>
        ) : (
          <span className="rc-muted-line">—</span>
        ),
    },
  ];
  return (
    <div className="rc-mt-16">
      <Card flush>
        <div className="rc-card__head">
          <h2>Offers</h2>
        </div>
        <p className="rc-muted-line rc-mt-8">
          Offer transitions execute in the talent&apos;s offer surface — open a
          talent to make or advance an offer.
        </p>
        <DataTable<OfferView>
          columns={columns}
          rows={[...offers]}
          rowKey={(o) => o.id}
          emptyMessage="No offers on this requisition yet."
        />
      </Card>
    </div>
  );
}

// ── Pre-Start tab (NEW — lazy per-placement readiness summary) ──
//
// Mounts ONLY when the tab is opened (Tabs renders the selected panel), so its
// per-placement getPreStartRequirements reads are LAZY — never at first paint.
// It is a READ summary (readiness / blocking / days-to-start); the governed
// status/waive/ready actions (pre_start_requirement:act) execute in the owning
// pre-start surface, never here.

interface PreStartRow {
  readonly placement: PlacementView;
  readonly loading: boolean;
  readonly error: boolean;
  readonly ready: boolean;
  readonly blocking: number;
  readonly total: number;
}

function PreStartPanel({
  placements,
  talents,
  canReadPlacements,
  canAct,
  onBlockedChange,
}: {
  readonly placements: readonly PlacementView[];
  readonly talents: Record<string, TalentRecordView>;
  readonly canReadPlacements: boolean;
  readonly canAct: boolean;
  readonly onBlockedChange: (blocked: number | null) => void;
}) {
  const [rows, setRows] = useState<Record<string, PreStartRow>>({});

  useEffect(() => {
    let cancelled = false;
    // Pre-start requirements are materialized once a placement exists (born at
    // PRE_START, downstream of an accepted offer). Read all placements'
    // requirements lazily (this tab is open).
    const targets = placements;
    const init: Record<string, PreStartRow> = {};
    for (const p of targets) {
      init[p.id] = { placement: p, loading: true, error: false, ready: false, blocking: 0, total: 0 };
    }
    setRows(init);

    Promise.allSettled(
      targets.map((p) => getPreStartRequirements(p.id).then((r) => ({ p, r }))),
    ).then((results) => {
      if (cancelled) return;
      const next: Record<string, PreStartRow> = {};
      let totalBlocked = 0;
      results.forEach((res, i) => {
        const p = targets[i];
        if (p === undefined) return;
        if (res.status === 'fulfilled') {
          const r = res.value.r;
          totalBlocked += r.blocking_unresolved_count;
          next[p.id] = {
            placement: p,
            loading: false,
            error: false,
            ready: r.ready,
            blocking: r.blocking_unresolved_count,
            total: r.requirements.length,
          };
        } else {
          next[p.id] = { placement: p, loading: false, error: true, ready: false, blocking: 0, total: 0 };
        }
      });
      setRows(next);
      onBlockedChange(targets.length === 0 ? null : totalBlocked);
    });

    return () => {
      cancelled = true;
      onBlockedChange(null);
    };
  }, [placements, onBlockedChange]);

  const list = Object.values(rows);

  // Empty state mirrors the prototype's "No placements in pre-start" card.
  // ("onboarding readiness" in the mock → "pre-start readiness" here, per the
  // codebase's Pre-Start lifecycle vocabulary.)
  if (canReadPlacements && list.length === 0) {
    return (
      <TabEmpty title="No placements in pre-start">
        When an offer is accepted, pre-start readiness appears here: requirements,
        blockers, and days to start. Readiness is derived from requirement
        completion — never toggled manually.
      </TabEmpty>
    );
  }

  return (
    <div className="rc-mt-16">
      <Card flush>
        <div className="rc-card__head">
          <h2>Pre-start readiness</h2>
        </div>
        {!canReadPlacements ? (
          <p className="rc-muted-line rc-mt-8">
            Placement visibility is required to summarise pre-start readiness.
          </p>
        ) : (
          <ul className="rc-filelist">
            {list.map((row) => (
              <li key={row.placement.id} className="rc-filelist__row">
                <Icons.IconList />
                <span className="rc-filelist__nm">
                  {talentLabel(talents, row.placement.talent_record_id)}
                  <small className="rc-muted-line">
                    {' '}
                    · {PLACEMENT_STATE_LABELS[row.placement.state]}
                    {row.placement.proposed_start_date !== null
                      ? ` · starts ${formatDate(row.placement.proposed_start_date)}`
                      : ''}
                  </small>
                </span>
                <span className="rc-filelist__meta">
                  {row.loading ? (
                    'Loading…'
                  ) : row.error ? (
                    <span className="rc-muted-line">Unavailable</span>
                  ) : row.ready ? (
                    <span className="rc-pill rc-pill--ok">Ready</span>
                  ) : row.blocking > 0 ? (
                    <span className="rc-pill rc-pill--danger">
                      {row.blocking} blocking
                    </span>
                  ) : (
                    <span className="rc-pill rc-pill--neutral">
                      {row.total} item{row.total === 1 ? '' : 's'}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {canAct ? (
          <p className="rc-muted-line rc-mt-8">
            Resolve, waive or mark-ready in the placement&apos;s pre-start surface —
            {REQUIREMENT_STATUS_LABELS.SATISFIED} / {REQUIREMENT_STATUS_LABELS.WAIVED}{' '}
            actions are governed there.
          </p>
        ) : null}
      </Card>
    </div>
  );
}

// ── Assignments tab (list + drill-through to the reused lifecycle panel) ──
//
// Rows come from the EAGER requisition-grain placements read. Each row is an
// accordion: the per-placement AssignmentLifecyclePanel (assignment:read) mounts
// ONLY on expand, so its per-placement read stays lazy. Extend/End/Convert
// affordances live inside that reused panel (gated assignment:extend /
// assignment:end / placement:permanent:transition) — never reimplemented here.

function PlacementDrillList({
  placements,
  talents,
  renderPanel,
  emptyMessage,
}: {
  readonly placements: readonly PlacementView[];
  readonly talents: Record<string, TalentRecordView>;
  readonly renderPanel: (placementId: string) => ReactNode;
  readonly emptyMessage: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (placements.length === 0) {
    return <p className="rc-empty">{emptyMessage}</p>;
  }
  return (
    <ul className="rc-filelist">
      {placements.map((p) => {
        const isOpen = openId === p.id;
        return (
          <li key={p.id} className="rc-filelist__row" style={{ display: 'block' }}>
            <Button unstyled
              type="button"
              className="rc-linkbtn"
              aria-expanded={isOpen}
              onClick={() => setOpenId(isOpen ? null : p.id)}
            >
              {talentLabel(talents, p.talent_record_id)} ·{' '}
              {PLACEMENT_STATE_LABELS[p.state]}
              {isOpen ? ' ▾' : ' ▸'}
            </Button>
            {isOpen ? <div className="rc-mt-8">{renderPanel(p.id)}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}

function AssignmentsTab({
  placements,
  talents,
  session,
}: {
  readonly placements: readonly PlacementView[];
  readonly talents: Record<string, TalentRecordView>;
  readonly session: Session | undefined;
}) {
  if (placements.length === 0) {
    return (
      <TabEmpty title="No assignments yet">
        Started work appears here as assignments — start, expected end,
        extensions, and capacity consumption. Permanent placements show
        guarantee-period tracking instead.
      </TabEmpty>
    );
  }
  return (
    <div className="rc-mt-16">
      <Card flush>
        <div className="rc-card__head">
          <h2>Assignments</h2>
        </div>
        <p className="rc-muted-line rc-mt-8">
          Extend, end or convert an assignment in its own governed surface — open a
          row to drill through.
        </p>
        <PlacementDrillList
          placements={placements}
          talents={talents}
          emptyMessage="No placements on this requisition yet."
          renderPanel={(id) => (
            <AssignmentLifecyclePanel placementId={id} sessionOverride={session} />
          )}
        />
      </Card>
    </div>
  );
}

// ── Commercial tab (assignment:commercials:read; drill-through) ──
//
// The reused AssignmentCommercialPanel enforces the read-vs-approve split
// internally (whole panel follows assignment:commercials:read; propose/decision
// follow write/approve + SoD). It preserves proposal ≠ approval ≠ applied and
// renders Current / Proposed / Impact verbatim.

function CommercialTab({
  placements,
  talents,
  session,
}: {
  readonly placements: readonly PlacementView[];
  readonly talents: Record<string, TalentRecordView>;
  readonly session: Session | undefined;
}) {
  // No placements yet → the prototype's requisition-level scaffold: a "Current
  // terms" card (fields shown as "—" until work starts) + a "Proposals &
  // approvals" card. No values are computed here — the "—"s are literal empties,
  // per masked-by-absence. Real per-assignment terms appear via the drill-through
  // once placements exist.
  if (placements.length === 0) {
    return (
      <div className="rc-mt-16 rc-comm2">
        <div className="rc-commcard">
          <div className="rc-commcard__t">Current terms</div>
          <div className="rc-commgrid">
            <CommTerm label="Pay rate" value="—" />
            <CommTerm label="Bill rate" value="—" />
            <CommTerm label="Margin" value="— · derived" />
            <CommTerm label="Effective date" value="—" />
          </div>
          <p className="rc-commcard__note">
            Commercial terms are recorded per assignment once work starts.
            Requisition-level targets live in Financial planning (Overview).
          </p>
        </div>
        <div className="rc-commcard">
          <div className="rc-commcard__t rc-commcard__t--tight">
            Proposals &amp; approvals
          </div>
          <p className="rc-commcard__body">
            No pending proposals. Rate revisions raised on an assignment will
            appear here for approval, with current → proposed impact.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="rc-mt-16">
      <Card flush>
        <div className="rc-card__head">
          <h2>Commercial</h2>
        </div>
        <p className="rc-muted-line rc-mt-8">
          Current vs proposed vs impact. A proposal is intent, an approval is
          authority, an applied rate is truth — advance each in its governed
          decision surface.
        </p>
        <PlacementDrillList
          placements={placements}
          talents={talents}
          emptyMessage="No placements with commercial terms yet."
          renderPanel={(id) => (
            <AssignmentCommercialPanel placementId={id} sessionOverride={session} />
          )}
        />
      </Card>
    </div>
  );
}

// One read-only "Current terms" field (empty scaffold) — a small muted label
// over a muted plain-text value, per the prototype (not a boxed input).
function CommTerm({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rc-commterm">
      <div className="rc-commterm__l">{label}</div>
      <div className="rc-commterm__v">{value}</div>
    </div>
  );
}

// ── Attachments tab ──

function AttachmentsPanel({
  attachments,
}: {
  readonly attachments: readonly AttachmentView[];
}) {
  // Empty: the prototype's centered dashed "Attach documents" prompt (upload is
  // a separate, unbuilt capability — this is the affordance, no live uploader).
  if (attachments.length === 0) {
    return (
      <div className="rc-mt-16">
        <div className="rc-attdrop">
          <div className="rc-attdrop__t">Attach documents</div>
          <div className="rc-attdrop__s">
            Job description, client requirements, rate card · PDF, DOCX, XLSX ·{' '}
            {attachments.length} files attached
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="rc-mt-16">
      <Card flush>
        <div className="rc-card__head">
          <h2>Attachments</h2>
        </div>
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
      </Card>
    </div>
  );
}

// ── Overview tab (the PR-A2 inline-edit cockpit — grouped Demand/Client/Role/
// Ownership via the existing field-affordance sections). Reuses CockpitFieldRow +
// COCKPIT_FIELDS + ProfileWorkbenchPanel verbatim. Financial planning is gated by
// masked-by-absence: the BE OMITS the requisition:view:financials keys the actor
// cannot read, so present(f.key) is false and the whole 'financial' section
// collapses — no CSS hiding, no sensitive field loaded to hide it. Compensation
// actuals ride the same masked-by-absence discipline. ──

// G2.5 — normalize a RequisitionView into the shared form's string value map.
// Dates reduce to YYYY-MM-DD (the date-input shape); booleans to 'true'/'false';
// everything else to a string ('' for null). Masked fields are simply absent
// from `req` (BE omit) and `present()` skips them — never blanked here.
function toFormValues(req: RequisitionView): Record<string, string> {
  const r = req as unknown as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === null || v === undefined) out[k] = '';
    else if (typeof v === 'boolean') out[k] = v ? 'true' : 'false';
    else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) out[k] = v.slice(0, 10);
    else out[k] = String(v);
  }
  return out;
}

// G2.5a — the Overview tab. Renders the SHARED RequisitionForm in view mode: a
// single full-width column of section cards (§5 — no right rail). The
// per-field click-to-edit cockpit is gone; whole-form edit arrives via the
// header Edit button (G2.5b). Requirement skills stay owned by the existing
// ProfileWorkbenchPanel, dropped into the form's skills slot.
// G2.5b — the Overview form's editable keys (client/contact/status are excluded:
// client/contact reassignment isn't a field edit here, and status is a governed
// transition). Booleans + numbers coerce back from the draft's string map; ''
// clears a field (→ null).
const OVERVIEW_BOOLEAN_KEYS = new Set([
  'is_hot',
  'allow_subcontractors',
  'relocation_offered',
  'extension_possible',
]);
const OVERVIEW_NUMBER_KEYS = new Set([
  'openings',
  'travel_percent',
  'hours_per_week',
  'duration_value',
  'onsite_days_per_week',
]);
// margin_percent / markup_percent are DERIVED downstream — read-only in the form,
// so they are deliberately absent here (never written back).
const OVERVIEW_EDITABLE_KEYS: readonly string[] = [
  'title', 'job_type', 'openings', 'is_hot', 'city', 'state', 'postal_code',
  'work_arrangement', 'onsite_days_per_week', 'duration_value', 'duration_unit',
  'start_date', 'end_date', 'bill_rate_amount', 'pay_rate_amount', 'rate_type',
  'allow_subcontractors', 'description', 'notes',
  'work_authorization', 'labor_category', 'role_family', 'seniority_level',
  'headcount_reason', 'travel_percent', 'relocation_offered', 'hours_per_week',
  'extension_possible', 'source_system', 'external_req_id',
  'target_margin_percent', 'markup_percent_target', 'rate_card_id',
  'min_bill_rate', 'max_bill_rate', 'min_pay_rate', 'max_pay_rate',
];

function coerceOverviewValue(key: string, str: string): unknown {
  if (OVERVIEW_BOOLEAN_KEYS.has(key)) return str === 'true';
  if (str === '') return null;
  if (OVERVIEW_NUMBER_KEYS.has(key)) {
    const n = Number(str);
    return Number.isFinite(n) ? n : null;
  }
  return str;
}

function DetailsPanel({
  req,
  companyName,
  contactName,
  present,
  scopes,
  editing,
  onCancel,
  onSave,
}: {
  readonly req: RequisitionView;
  readonly companyName: string | null;
  readonly contactName: string | null;
  readonly present: (key: string) => boolean;
  readonly scopes: readonly string[];
  readonly editing: boolean;
  readonly onCancel: () => void;
  readonly onSave: (body: UpdateRequisitionRequest) => Promise<void>;
}) {
  const original = toFormValues(req);
  const [draft, setDraft] = useState<Record<string, string>>(original);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // (Re)seed the draft from the current record whenever edit mode is entered.
  useEffect(() => {
    if (editing) {
      setDraft(toFormValues(req));
      setError(null);
      setBusy(false);
    }
  }, [editing, req]);

  const doSave = async (): Promise<void> => {
    // Same required fields as create (client is inherited + display-only here,
    // so it is always satisfied; title is the editable required field).
    if ((draft['title'] ?? '').trim() === '') {
      setError('Job title is required.');
      return;
    }
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {};
    for (const key of OVERVIEW_EDITABLE_KEYS) {
      if (!present(key)) continue; // never write a masked field
      if ((draft[key] ?? '') !== (original[key] ?? '')) {
        body[key] = coerceOverviewValue(key, draft[key] ?? '');
      }
    }
    try {
      await onSave(body as UpdateRequisitionRequest);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? 'This requisition changed since you opened it. Cancel and reopen to edit the latest version.'
          : 'Your changes could not be saved. Please try again.',
      );
      setBusy(false);
    }
  };

  return (
    <div className="rc-mt-16 rc-ov-form">
      {editing ? (
        <div className="rc-editbar" role="region" aria-label="Editing requisition">
          <Icons.IconPencil />
          <span className="rc-editbar__msg">
            <b>Editing REQ-{req.requisition_number}.</b> Saving creates version{' '}
            <span className="mono">v{req.version + 1}</span> and is logged to the
            audit trail. Nothing changes until you save.
          </span>
          <Button
            unstyled
            className="rc-btn rc-btn--sm"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            unstyled
            className="rc-btn rc-btn--sm rc-btn--primary"
            onClick={() => void doSave()}
            disabled={busy}
          >
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      ) : null}
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <RequisitionForm
        mode={editing ? 'edit' : 'view'}
        values={editing ? draft : original}
        present={present}
        scopes={scopes}
        disabled={busy}
        onChange={(k, v) => setDraft((d) => ({ ...d, [k]: v }))}
        clientDisplay={companyName ?? 'Client'}
        contactDisplay={contactName}
        statusDisplay={RECRUITING_STATUS_LABELS[req.status]}
        skillsSlot={
          <RequirementSkills
            requisitionId={req.id}
            mode={editing ? 'edit' : 'view'}
            scopes={scopes}
          />
        }
      />
    </div>
  );
}

// ── helpers ──

// Offer expiry is grounded on the offer's own offer_expires_at (an existing
// field). "Soon" = a non-terminal offer whose expiry falls inside the horizon
// (including already-past, which is the most urgent). NEVER a submittal
// deadline — that field does not exist.
function isOfferExpiringSoon(offer: OfferView): boolean {
  if (offer.offer_expires_at === null) return false;
  if (!OPEN_OFFER_STATES.has(offer.state)) return false;
  const t = new Date(offer.offer_expires_at).getTime();
  if (Number.isNaN(t)) return false;
  return t - Date.now() <= OFFER_EXPIRY_HORIZON_MS;
}

// Whole days remaining on an offer's own expiry window (may be <= 0 when past).
function offerDaysLeft(offer: OfferView): number {
  if (offer.offer_expires_at === null) return 0;
  const t = new Date(offer.offer_expires_at).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

function remoteLabel(
  workArrangement: string | null,
  onsiteDaysPerWeek: number | null,
): string | null {
  if (workArrangement === 'remote') return 'Remote ok';
  if (workArrangement === 'hybrid') {
    // PR-17 — append the onsite frequency ONLY when it is known. When null the
    // label is plain "Hybrid" — never "Hybrid · ? days".
    if (onsiteDaysPerWeek === null) return 'Hybrid';
    return `Hybrid · ${onsiteDaysPerWeek} ${
      onsiteDaysPerWeek === 1 ? 'day' : 'days'
    } on-site`;
  }
  if (workArrangement === 'onsite') return 'On-site';
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  return new Date(t).toLocaleDateString();
}

function daysOpen(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}
