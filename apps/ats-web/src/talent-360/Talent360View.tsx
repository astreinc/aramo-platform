import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Dialog, InlineAlert, TextArea, hasScope, useSession } from '@aramo/fe-foundation';
import type { Session } from '@aramo/fe-foundation';

import { Button, LoadingState, safeErrorMessage } from '../ui';
import { useEntityCrumb } from '../shell/breadcrumb';
// Non-Overview tabs REUSE the authoritative detail surfaces rather than cloning
// their logic (directive §3.4/§12/§14) — each fetches its own authoritative
// data; the Overview stays a single getTalent360() read.
import { TrustPanel } from '../talent/components/TrustPanel';
import { WorkHistoryPanel } from '../talent/WorkHistoryPanel';
import { CallButton } from '../communications/CallButton';
import { AddToRequisitionDialog } from '../talent/AddToRequisitionDialog';
// Header actions reuse existing authoritative flows (composed workspace, not a
// new workflow authority): Email = requisition-contextual composer (COMM-C4);
// Log activity = the existing POST /v1/activities mutation (activity:create).
import { RequisitionContactEmailComposer } from '../microsoft/RequisitionContactEmailComposer';
import { createNote } from '../activity/activity-api';

import { getTalent360 } from './talent-360-api';
import type {
  ActiveOpportunityView,
  AttentionItemView,
  RecentActivityItemView,
  Talent360View as Talent360ViewModel,
  TalentDocumentView,
} from './talent-360-types';
import './talent-360.css';

// Talent 360 — the ats-web person-centric recruiter workspace (route
// `talent/:talentId`), replacing the Talent Detail experience. A READ/WORK
// PROJECTION of GET /v1/talent-360/:id: the FE renders what the backend composed
// and OWNS ONLY PRESENTATION STATE (collapse, active tab, expanded opportunity).
// It NEVER re-derives server-owned truth — waiting duration, interview-today,
// recruiting-ready, contactability, ownership, identity advisory, signed-doc
// state, and every KPI count come from the payload. Built to the frozen
// prototype (Talent 360.dc.html) at pixel parity using the Aramo design tokens.

type TabKey =
  | 'overview'
  | 'opportunities'
  | 'profile'
  | 'engagement'
  | 'activity'
  | 'documents'
  | 'trust';

const ACTIVITY_FILTERS: readonly { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'communications', label: 'Communications' },
  { key: 'requisitions', label: 'Requisitions' },
  { key: 'client', label: 'Client' },
  { key: 'interviews', label: 'Interviews' },
  { key: 'documents', label: 'Documents' },
  { key: 'tasks', label: 'Tasks' },
];

// The fixed 7-step journey display (prototype). done/current/future are a
// PRESENTATION mapping of the server-composed journey (which stages were
// reached + current_journey_stage) — not a re-derivation of journey meaning.
const JOURNEY_STEPS: readonly { label: string; stages: readonly string[] }[] = [
  { label: 'Added', stages: ['SOURCED'] },
  { label: 'Contacted', stages: ['CONTACTED', 'ENGAGED'] },
  { label: 'Qualified', stages: ['QUALIFYING', 'QUALIFIED'] },
  { label: 'Submitted', stages: ['SUBMITTED', 'CLIENT_REVIEW'] },
  { label: 'Interview', stages: ['INTERVIEW'] },
  { label: 'Offer', stages: ['OFFER', 'ACCEPTED_PLACED'] },
  { label: 'Start', stages: ['PRE_START', 'READY', 'STARTED'] },
];

const CHEVRON = (open: boolean, kind: 'section' | 'row'): JSX.Element => (
  <svg
    className={
      kind === 'section'
        ? `t360-chevron${open ? '' : ' t360-chevron--collapsed'}`
        : `t360-opp-expand${open ? ' t360-opp-expand--open' : ''}`
    }
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={kind === 'section' ? 2.2 : 2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {kind === 'section' ? <polyline points="6 9 12 15 18 9" /> : <polyline points="6 9 12 15 18 9" />}
  </svg>
);

function stageTone(stage: string): 'green' | 'blue' | 'amber' | 'neutral' {
  const s = stage.toUpperCase();
  if (s === 'INTERVIEW' || s === 'QUALIFIED' || s === 'STARTED') return 'green';
  if (s === 'SUBMITTED' || s === 'CLIENT_REVIEW' || s === 'OFFER') return 'blue';
  if (s === 'QUALIFYING' || s === 'ENGAGED' || s === 'CONTACTED') return 'amber';
  return 'neutral';
}

export function Talent360View() {
  const { talentId = '' } = useParams();
  const navigate = useNavigate();
  const sessionState = useSession();
  const session =
    sessionState.status === 'authenticated' ? sessionState.session : null;
  const [model, setModel] = useState<Talent360ViewModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('overview');
  const [openOpp, setOpenOpp] = useState<string | null>(null);
  const [activityFilter, setActivityFilter] = useState('all');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [emailCtx, setEmailCtx] = useState<{ requisitionId: string; pipelineId: string } | null>(null);
  const [emailChooser, setEmailChooser] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  const load = useCallback(() => {
    if (talentId === '') return;
    setLoading(true);
    setError(null);
    getTalent360(talentId)
      .then((v) => setModel(v))
      .catch((e) => setError(safeErrorMessage(e, 'Could not load this Talent right now.')))
      .finally(() => setLoading(false));
  }, [talentId]);
  useEffect(() => load(), [load]);

  // A superseded record redirects to its survivor — never rehydrate stale state.
  useEffect(() => {
    if (model?.header.record_status === 'superseded' && model.header.superseded_by_record_id) {
      navigate(`/talent/${model.header.superseded_by_record_id}`, { replace: true });
    }
  }, [model, navigate]);

  useEntityCrumb(model === null ? undefined : model.header.display_name);

  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  if (loading && model === null) return <LoadingState label="Loading this Talent…" />;
  if (error !== null && model === null) {
    return (
      <InlineAlert variant="error">
        {error}{' '}
        <Button unstyled type="button" className="t360-link" onClick={load}>
          Retry
        </Button>
      </InlineAlert>
    );
  }
  if (model === null) return null;
  if (model.header.record_status === 'superseded') {
    return (
      <div className="t360-superseded">
        This Talent record has been superseded. Redirecting to the current record…
      </div>
    );
  }

  const h = model.header;
  const strip = model.relationship_strip;
  const initials = `${h.first_name[0] ?? ''}${h.last_name[0] ?? ''}`.toUpperCase();

  // Email is requisition-contextual ONLY (no talent-direct path): 1 active
  // opportunity opens the composer directly; multiple opens a lightweight
  // chooser; 0 makes the action unavailable (context required).
  const activeOpps = model.opportunities?.active ?? [];
  const onEmail = () => {
    const only = activeOpps[0];
    if (activeOpps.length === 1 && only !== undefined) {
      setEmailCtx({ requisitionId: only.requisition_id, pipelineId: only.pipeline_id });
    } else if (activeOpps.length > 1) {
      setEmailChooser(true);
    }
  };

  return (
    <div>
      <Header
        model={model}
        initials={initials}
        session={session}
        onAddToRequisition={() => setAddOpen(true)}
        onEmail={onEmail}
        canEmail={h.actions.can_email && activeOpps.length > 0}
        onLogActivity={() => setLogOpen(true)}
      />
      <AddToRequisitionDialog open={addOpen} onClose={() => setAddOpen(false)} talentId={talentId} />
      {emailCtx !== null && (
        <RequisitionContactEmailComposer
          open
          onOpenChange={(o) => {
            if (!o) setEmailCtx(null);
          }}
          talentId={talentId}
          requisitionId={emailCtx.requisitionId}
          pipelineId={emailCtx.pipelineId}
        />
      )}
      {emailChooser && (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o) setEmailChooser(false);
          }}
          title="Email — choose a requisition"
        >
          <div className="t360-chooser">
            {activeOpps.map((o) => (
              <Button
                unstyled
                key={o.pipeline_id}
                type="button"
                className="t360-chooser-row"
                onClick={() => {
                  setEmailCtx({ requisitionId: o.requisition_id, pipelineId: o.pipeline_id });
                  setEmailChooser(false);
                }}
              >
                <span className="t360-opp-reqid">{o.requisition_code}</span>{' '}
                <b>{o.client_name ?? 'Client'}</b> · {o.role_title ?? ''}
              </Button>
            ))}
          </div>
        </Dialog>
      )}
      {logOpen && <LogActivityDialog talentId={talentId} onClose={() => setLogOpen(false)} />}

      <KpiStrip strip={strip} onOpen={(t) => setTab(t)} />

      <Tabs model={model} tab={tab} setTab={setTab} />

      {tab === 'overview' && (
        <div className="t360-body">
          <div className="t360-main">
            <OpportunitiesSection
              model={model}
              openOpp={openOpp}
              setOpenOpp={setOpenOpp}
              collapsed={!!collapsed['opps']}
              onToggle={() => toggle('opps')}
              onSeeAll={() => setTab('opportunities')}
            />
            <RecentActivitySection
              model={model}
              filter={activityFilter}
              setFilter={setActivityFilter}
              collapsed={!!collapsed['act']}
              onToggle={() => toggle('act')}
              onSeeAll={() => setTab('activity')}
            />
            <ProfileSection
              model={model}
              collapsed={!!collapsed['prof']}
              onToggle={() => toggle('prof')}
              onSeeAll={() => setTab('profile')}
            />
            <DocumentsSection
              model={model}
              collapsed={!!collapsed['docs']}
              onToggle={() => toggle('docs')}
              onSeeAll={() => setTab('documents')}
            />
          </div>
          <div className="t360-rail">
            <AttentionCard items={model.attention} authorized={model.authorized_sections.attention} />
            <TasksCard tasks={model.tasks} />
            <ContactabilityCard model={model} />
            <IdentityCard model={model} onTrust={() => setTab('trust')} />
            <RelationshipCard model={model} />
          </div>
        </div>
      )}

      {tab !== 'overview' && (
        <div className="t360-body">
          <div className="t360-main">
            <OtherTabContent
              tab={tab}
              model={model}
              openOpp={openOpp}
              setOpenOpp={setOpenOpp}
              talentId={talentId}
              canResolve={session !== null && hasScope(session, 'identity:resolve')}
            />
          </div>
          <div className="t360-rail">
            <ContactabilityCard model={model} />
            <IdentityCard model={model} onTrust={() => setTab('trust')} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── header ────────────────────────────────────────────────────────────────
function Header({
  model,
  initials,
  session,
  onAddToRequisition,
  onEmail,
  canEmail,
  onLogActivity,
}: {
  model: Talent360ViewModel;
  initials: string;
  session: Session | null;
  onAddToRequisition: () => void;
  onEmail: () => void;
  canEmail: boolean;
  onLogActivity: () => void;
}) {
  const h = model.header;
  const rr = h.recruiting_ready;
  const contactable = h.contactability.recruiting_permitted;
  return (
    <div className="t360-card">
      <div className="t360-head">
        <div className="t360-avatar">{initials}</div>
        <div className="t360-idblock">
          <div className="t360-name-row">
            <span className="t360-name">{h.display_name}</span>
            {h.availability.status !== null && (
              <span className="t360-badge t360-badge--green">{labelize(h.availability.status)}</span>
            )}
            {rr.ready && (
              <span className="t360-badge t360-badge--blue" title={rr.rule}>
                Recruiting ready
              </span>
            )}
            <span
              className={`t360-badge ${contactable ? 't360-badge--green' : 't360-badge--blue'}`}
            >
              {contactable ? 'Contact permitted' : 'Contact restricted'}
            </span>
          </div>
          <div className="t360-subline">
            {[h.title, h.location, h.experience_summary].filter(Boolean).join(' · ')}
          </div>
          <div className="t360-contact-row">
            {h.email !== null && <span className="t360-contact-field">{h.email}</span>}
            {h.phone !== null && <span className="t360-contact-field">{h.phone}</span>}
            {h.work_authorization !== null && (
              <span className="t360-contact-field">{labelize(h.work_authorization)}</span>
            )}
            {h.desired_compensation !== null && (
              <span className="t360-contact-field">
                <span className="t360-mono">{h.desired_compensation}</span>
                {h.engagement_type !== null ? ` desired · ${labelize(h.engagement_type)}` : ' desired'}
              </span>
            )}
          </div>
        </div>
        <div className="t360-actions">
          <div className="t360-actions-primary">
            {h.actions.can_email && (
              <Button
                unstyled
                type="button"
                className="t360-btn t360-btn--secondary"
                onClick={onEmail}
                disabled={!canEmail}
                title={canEmail ? undefined : 'Email needs an active opportunity'}
              >
                Email
              </Button>
            )}
            {h.actions.can_call && (
              <CallButton
                talent={{
                  id: h.talent_id,
                  first_name: h.first_name,
                  last_name: h.last_name,
                  phone_cell: h.phone,
                  phone_work: null,
                  phone_home: null,
                }}
                session={session}
              />
            )}
            {h.actions.can_add_to_requisition && (
              <Button unstyled type="button" className="t360-btn t360-btn--primary" onClick={onAddToRequisition}>
                Add to requisition
              </Button>
            )}
          </div>
          <div className="t360-actions-overflow">
            {h.actions.can_log_activity && (
              <Button unstyled type="button" className="t360-btn t360-btn--ghost" onClick={onLogActivity}>
                Log activity
              </Button>
            )}
            {h.actions.can_edit_profile && (
              <Link to={`/talent/${h.talent_id}/edit`} className="t360-btn t360-btn--ghost">
                Edit profile
              </Link>
            )}
            <Button unstyled type="button" className="t360-btn t360-btn--ghost" title="More">
              ⋯
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── KPI strip ───────────────────────────────────────────────────────────────
function KpiStrip({
  strip,
  onOpen,
}: {
  strip: Talent360ViewModel['relationship_strip'];
  onOpen: (t: TabKey) => void;
}) {
  const num = (n: number | null): string => (n === null ? '—' : n === 0 ? 'None' : String(n));
  const cards: {
    label: string;
    value: string;
    sub: string;
    tone?: 'amber' | 'muted' | 'green';
    onClick?: () => void;
  }[] = [
    {
      label: 'ACTIVE OPPORTUNITIES',
      value: num(strip.active_opportunities),
      sub: 'Across requisitions',
      onClick: () => onOpen('opportunities'),
    },
    {
      label: 'SUBMITTALS',
      value: num(strip.submittals),
      sub: 'In flight',
      onClick: () => onOpen('opportunities'),
    },
    {
      label: 'INTERVIEWS',
      value: strip.interviews_today === null ? '—' : `${strip.interviews_today} today`,
      sub: 'Scheduled today',
      tone: (strip.interviews_today ?? 0) > 0 ? 'amber' : 'muted',
      onClick: () => onOpen('opportunities'),
    },
    {
      label: 'OFFERS',
      value: num(strip.offers),
      sub: (strip.offers ?? 0) > 0 ? 'Live offers' : 'No offers yet',
      tone: (strip.offers ?? 0) === 0 ? 'muted' : undefined,
    },
    {
      label: 'ASSIGNMENTS',
      value: num(strip.assignments),
      sub: (strip.assignments ?? 0) > 0 ? 'Started' : 'No placements yet',
      tone: (strip.assignments ?? 0) === 0 ? 'muted' : undefined,
    },
    {
      label: 'LAST CONTACT',
      value: strip.last_contact === null ? '—' : relativeDay(strip.last_contact.at),
      sub:
        strip.last_contact === null
          ? 'No contact yet'
          : `${labelize(strip.last_contact.channel)} · ${clockTime(strip.last_contact.at)}`,
      tone: strip.last_contact !== null ? 'green' : 'muted',
      onClick: () => onOpen('engagement'),
    },
  ];
  return (
    <div className="t360-kpis">
      {cards.map((c) => (
        <Button unstyled
          key={c.label}
          type="button"
          className={`t360-kpi${c.onClick ? ' t360-kpi--clickable' : ''}`}
          onClick={c.onClick}
          disabled={!c.onClick}
        >
          <div className="t360-kpi-label">{c.label}</div>
          <div
            className={`t360-kpi-num${
              c.tone === 'amber'
                ? ' t360-kpi-num--amber'
                : c.tone === 'muted'
                  ? ' t360-kpi-num--muted'
                  : c.tone === 'green'
                    ? ' t360-kpi-num--green'
                    : ''
            }`}
          >
            {c.value}
          </div>
          <div className="t360-kpi-sub">{c.sub}</div>
        </Button>
      ))}
    </div>
  );
}

// ── tabs ────────────────────────────────────────────────────────────────────
function Tabs({
  model,
  tab,
  setTab,
}: {
  model: Talent360ViewModel;
  tab: TabKey;
  setTab: (t: TabKey) => void;
}) {
  const oppCount = model.opportunities?.active.length ?? null;
  const actCount = model.recent_activity?.items.length ?? null;
  const docCount = model.documents?.total ?? null;
  const tabs: { key: TabKey; label: string; count: number | null }[] = [
    { key: 'overview', label: 'Overview', count: null },
    { key: 'opportunities', label: 'Opportunities', count: oppCount },
    { key: 'profile', label: 'Profile', count: null },
    { key: 'engagement', label: 'Engagement', count: null },
    { key: 'activity', label: 'Activity', count: actCount },
    { key: 'documents', label: 'Documents', count: docCount },
    { key: 'trust', label: 'Trust & Evidence', count: null },
  ];
  return (
    <div className="t360-tabs" role="tablist">
      {tabs.map((t) => (
        <Button unstyled
          key={t.key}
          type="button"
          role="tab"
          aria-selected={tab === t.key}
          className={`t360-tab${tab === t.key ? ' t360-tab--active' : ''}`}
          onClick={() => setTab(t.key)}
        >
          {t.label}
          {t.count !== null && <span className="t360-tab-badge">{t.count}</span>}
        </Button>
      ))}
    </div>
  );
}

// ── opportunities ────────────────────────────────────────────────────────────
function OpportunitiesSection({
  model,
  openOpp,
  setOpenOpp,
  collapsed,
  onToggle,
  onSeeAll,
}: {
  model: Talent360ViewModel;
  openOpp: string | null;
  setOpenOpp: (id: string | null) => void;
  collapsed: boolean;
  onToggle: () => void;
  onSeeAll: () => void;
}) {
  if (model.opportunities === null) return null; // authorization-hidden
  const { active, closed } = model.opportunities;
  return (
    <div className="t360-card">
      <div className="t360-section-head">
        <Button unstyled type="button" className="t360-link" onClick={onToggle} aria-label="Toggle opportunities">
          {CHEVRON(!collapsed, 'section')}
        </Button>
        <span className="t360-section-title">Active opportunities</span>
        <span className="t360-count-badge">{active.length}</span>
        {!collapsed && <span className="t360-hint">Click a row to see its journey</span>}
      </div>
      {!collapsed &&
        active.map((o) => (
          <Opportunity
            key={o.pipeline_id}
            o={o}
            open={openOpp === o.pipeline_id}
            onToggle={() => setOpenOpp(openOpp === o.pipeline_id ? null : o.pipeline_id)}
          />
        ))}
      {!collapsed && active.length === 0 && (
        <div className="t360-section-body">
          <div className="t360-empty">No active opportunities right now.</div>
        </div>
      )}
      {!collapsed && closed.length > 0 && (
        <div className="t360-closed-link">
          {closed.length} closed ·{' '}
          <Button unstyled type="button" className="t360-link" onClick={onSeeAll}>
            View in Opportunities
          </Button>
        </div>
      )}
    </div>
  );
}

function Opportunity({
  o,
  open,
  onToggle,
}: {
  o: ActiveOpportunityView;
  open: boolean;
  onToggle: () => void;
}) {
  const reached = useMemo(() => new Set(o.journey.stages.map((s) => s.stage.toUpperCase())), [o.journey]);
  const currentIdx = JOURNEY_STEPS.findIndex((step) =>
    step.stages.includes(o.journey.current_journey_stage.toUpperCase()),
  );
  return (
    <>
      <div
        className={`t360-opp-row${open ? ' t360-opp-row--open' : ''}`}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <div className="t360-opp-idcol">
          <div className="t360-opp-idline">
            <span className="t360-opp-reqid">{o.requisition_code}</span>
            <span className="t360-opp-client">{o.client_name ?? 'Client'}</span>
          </div>
          {o.role_title !== null && <div className="t360-opp-role">{o.role_title}</div>}
        </div>
        <div className="t360-opp-statecol">
          <div className="t360-opp-stateline">
            <span className={`t360-stage t360-stage--${stageTone(o.stage)}`}>{o.stage.replace(/_/g, ' ')}</span>
            {o.contextual_state !== null && <span className="t360-opp-ctx">{o.contextual_state}</span>}
          </div>
          {o.age_label !== null && <div className="t360-opp-sub">{o.age_label} in stage</div>}
        </div>
        <div className="t360-opp-actioncol">
          {o.owner_label !== null && <span className="t360-opp-owner">{o.owner_label}</span>}
          {o.next_action !== null && (
            <ActionButton action={o.next_action} variant="secondary" />
          )}
          {CHEVRON(open, 'row')}
        </div>
      </div>
      {open && (
        <div className="t360-expansion">
          <div className="t360-journey">
            {JOURNEY_STEPS.map((step, i) => {
              const done = step.stages.some((s) => reached.has(s)) && i < currentIdx;
              const current = i === currentIdx;
              const cls = current ? 'current' : done || i < currentIdx ? 'done' : 'future';
              return (
                <span key={step.label} className={`t360-step t360-step--${cls}`}>
                  {step.label}
                  {cls === 'done' ? ' ✓' : cls === 'current' ? ' · now' : ''}
                </span>
              );
            })}
          </div>
          <div className="t360-facts">
            {o.owner_label !== null && <Fact label="RECRUITER" value={o.owner_label} />}
            <Fact label="STAGE" value={labelize(o.stage)} />
            {o.journey.sub_states.submittal_state !== null && (
              <Fact label="SUBMITTAL" value={labelize(o.journey.sub_states.submittal_state)} />
            )}
            {o.journey.sub_states.selection_state !== null && (
              <Fact label="CLIENT" value={labelize(o.journey.sub_states.selection_state)} />
            )}
            {o.journey.sub_states.offer_state !== null && (
              <Fact label="OFFER" value={labelize(o.journey.sub_states.offer_state)} />
            )}
            {o.journey.sub_states.placement_state !== null && (
              <Fact label="PLACEMENT" value={labelize(o.journey.sub_states.placement_state)} />
            )}
          </div>
          <div className="t360-opp-actions">
            {o.next_action !== null && <ActionButton action={o.next_action} variant="primary" />}
            <Link to={o.open_journey_href} className="t360-btn--secondary-neutral">
              Open journey
            </Link>
          </div>
        </div>
      )}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="t360-fact-label">{label}</div>
      <div className="t360-fact-value">{value}</div>
    </div>
  );
}

function ActionButton({
  action,
  variant,
}: {
  action: { kind: string; label: string; href: string | null };
  variant: 'primary' | 'secondary';
}) {
  const cls =
    variant === 'primary' ? 't360-btn t360-btn--primary t360-btn--sm' : 't360-btn t360-btn--secondary t360-btn--sm';
  if (action.href !== null) {
    return (
      <Link to={action.href} className={cls}>
        {action.label}
      </Link>
    );
  }
  return (
    <Button unstyled type="button" className={cls}>
      {action.label}
    </Button>
  );
}

// ── recent activity ──────────────────────────────────────────────────────────
function RecentActivitySection({
  model,
  filter,
  setFilter,
  collapsed,
  onToggle,
  onSeeAll,
}: {
  model: Talent360ViewModel;
  filter: string;
  setFilter: (f: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  onSeeAll: () => void;
}) {
  if (model.recent_activity === null) return null;
  const { items, category_counts, has_more } = model.recent_activity;
  const shown = filter === 'all' ? items : items.filter((i) => i.category === filter);
  return (
    <div className="t360-card">
      <div className="t360-section-head">
        <Button unstyled type="button" className="t360-link" onClick={onToggle} aria-label="Toggle recent activity">
          {CHEVRON(!collapsed, 'section')}
        </Button>
        <span className="t360-section-title">Recent activity</span>
        {!collapsed && (
          <div className="t360-filters">
            {ACTIVITY_FILTERS.map((f) => {
              const count = f.key === 'all' ? items.length : (category_counts[f.key] ?? 0);
              return (
                <Button unstyled
                  key={f.key}
                  type="button"
                  className={`t360-filter${filter === f.key ? ' t360-filter--active' : ''}`}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                  <span className="t360-filter-count">{count}</span>
                </Button>
              );
            })}
          </div>
        )}
      </div>
      {!collapsed && (
        <div className="t360-section-body">
          {shown.map((a) => (
            <ActivityRow key={a.id} a={a} />
          ))}
          {shown.length === 0 && <div className="t360-empty">No activity of this type yet.</div>}
          {(has_more || shown.length > 0) && (
            <div className="t360-closed-link" style={{ padding: '9px 0 0', border: 'none' }}>
              <Button unstyled type="button" className="t360-link" onClick={onSeeAll}>
                View full activity →
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ a }: { a: RecentActivityItemView }) {
  return (
    <div className="t360-act-row">
      <div className="t360-act-time">
        <span className="t360-act-day">{relativeDay(a.occurred_at)}</span>
        {clockTime(a.occurred_at)}
      </div>
      <div className="t360-act-icon" style={activityIconStyle(a.category)} aria-hidden="true">
        •
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="t360-act-title">
          {a.title}
          {a.requisition_label !== null && <span className="t360-reqtag">{a.requisition_label}</span>}
        </div>
        {a.body !== null && <div className="t360-act-body">{a.body}</div>}
        {a.actor_label !== null && <div className="t360-act-who">{a.actor_label}</div>}
      </div>
    </div>
  );
}

function activityIconStyle(category: string): React.CSSProperties {
  const map: Record<string, [string, string]> = {
    communications: ['#E8EDFB', '#011F8D'],
    requisitions: ['#EEF1F4', '#3A454E'],
    client: ['#FAEFD8', '#946011'],
    interviews: ['#E6F2EA', '#1F7A4D'],
    documents: ['#EEF1F4', '#3A454E'],
    tasks: ['#EEF1F4', '#3A454E'],
  };
  const [bg, color] = map[category] ?? ['#EEF1F4', '#3A454E'];
  return { background: bg, color };
}

// ── profile ──────────────────────────────────────────────────────────────────
function ProfileSection({
  model,
  collapsed,
  onToggle,
  onSeeAll,
}: {
  model: Talent360ViewModel;
  collapsed: boolean;
  onToggle: () => void;
  onSeeAll: () => void;
}) {
  const p = model.profile;
  return (
    <div className="t360-card">
      <div className="t360-section-head">
        <Button unstyled type="button" className="t360-link" onClick={onToggle} aria-label="Toggle profile">
          {CHEVRON(!collapsed, 'section')}
        </Button>
        <span className="t360-section-title">Professional profile</span>
      </div>
      {!collapsed && (
        <div className="t360-section-body">
          {p.summary !== null && <p className="t360-summary">{p.summary}</p>}
          {p.facts.length > 0 && (
            <div className="t360-profile-facts">
              {p.facts.map((f) => (
                <div key={f.label} className="t360-profile-cell">
                  <div className="t360-fact-label">{f.label.toUpperCase()}</div>
                  <div className="t360-cell-value">{labelize(f.value)}</div>
                  {f.source !== null && <div className="t360-cell-source">{f.source}</div>}
                </div>
              ))}
            </div>
          )}
          {p.skills.length > 0 && (
            <>
              <div className="t360-skills-eyebrow">SKILLS</div>
              <div className="t360-skills">
                {p.skills.map((s) => (
                  <span
                    key={s.label}
                    className={`t360-skill${s.verified ? ' t360-skill--verified' : ''}`}
                    title={s.verified ? 'Backed by résumé and a second source' : 'Self-reported'}
                  >
                    {s.label}
                    {s.verified ? ' ✓' : ''}
                  </span>
                ))}
              </div>
            </>
          )}
          <div className="t360-closed-link" style={{ padding: '10px 0 0', marginTop: 10 }}>
            <Button unstyled type="button" className="t360-link" onClick={onSeeAll}>
              Work history & full profile →
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── documents ────────────────────────────────────────────────────────────────
function DocumentsSection({
  model,
  collapsed,
  onToggle,
  onSeeAll,
}: {
  model: Talent360ViewModel;
  collapsed: boolean;
  onToggle: () => void;
  onSeeAll: () => void;
}) {
  if (model.documents === null) return null;
  const docs = model.documents;
  return (
    <div className="t360-card">
      <div className="t360-section-head">
        <Button unstyled type="button" className="t360-link" onClick={onToggle} aria-label="Toggle documents">
          {CHEVRON(!collapsed, 'section')}
        </Button>
        <span className="t360-section-title">Documents</span>
      </div>
      {!collapsed && (
        <div className="t360-section-body">
          {docs.key_documents.map((d) => (
            <DocRow key={d.id} d={d} />
          ))}
          {docs.key_documents.length === 0 && <div className="t360-empty">No documents yet.</div>}
          {docs.total > 0 && (
            <div className="t360-closed-link" style={{ padding: '9px 0 0', border: 'none' }}>
              <Button unstyled type="button" className="t360-link" onClick={onSeeAll}>
                All {docs.total} document{docs.total === 1 ? '' : 's'} →
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DocRow({ d }: { d: TalentDocumentView }) {
  return (
    <div className="t360-doc-row">
      <div className={`t360-doc-icon${d.signed ? ' t360-doc-icon--signed' : ''}`} aria-hidden="true">
        {d.signed ? '✓' : '▤'}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="t360-doc-kind">
          {d.kind}
          {d.requisition_label !== null && <span className="t360-reqtag">{d.requisition_label}</span>}
        </div>
        <div className="t360-doc-meta">
          {d.meta ?? ''}
          {d.signed && d.signed_at !== null ? ` · Signed ${shortDate(d.signed_at)}` : ''}
        </div>
      </div>
    </div>
  );
}

// ── right rail ────────────────────────────────────────────────────────────────
function AttentionCard({
  items,
  authorized,
}: {
  items: readonly AttentionItemView[] | null;
  authorized: boolean;
}) {
  if (items === null || !authorized) return null;
  return (
    <div className="t360-card">
      <div className="t360-rail-head">
        <span className="t360-rail-title">Your attention</span>
        {items.length > 0 && <span className="t360-attn-badge">{items.length}</span>}
      </div>
      <div className="t360-provenance">
        <span className="t360-prov-chip t360-prov-chip--aramo">FROM ARAMO</span>
        Worked out from live state. Clears once resolved.
      </div>
      {items.length === 0 ? (
        <div className="t360-empty">Nothing needs your attention right now.</div>
      ) : (
        items.map((a) => <AttentionItem key={a.id} a={a} />)
      )}
    </div>
  );
}

function AttentionItem({ a }: { a: AttentionItemView }) {
  const tone = a.kind === 'blocking' ? 'red' : a.kind === 'interview' ? 'amber' : a.kind === 'identity' ? 'blue' : 'amber';
  return (
    <div className={`t360-attn-item t360-attn-item--${tone}`}>
      <div className={`t360-attn-kicker t360-attn-kicker--${tone}`}>{a.kicker}</div>
      <div className="t360-attn-title">{a.title}</div>
      <div className="t360-attn-body">
        <span className="t360-attn-sub">{a.subtitle ?? a.requisition_label ?? ''}</span>
        {a.action !== null &&
          (a.action.href !== null ? (
            <Link to={a.action.href} className="t360-attn-action">
              {a.action.label}
            </Link>
          ) : (
            <Button unstyled type="button" className="t360-attn-action">
              {a.action.label}
            </Button>
          ))}
      </div>
    </div>
  );
}

function TasksCard({ tasks }: { tasks: Talent360ViewModel['tasks'] }) {
  if (tasks === null) return null;
  return (
    <div className="t360-card">
      <div className="t360-rail-head">
        <span className="t360-rail-title">Tasks</span>
      </div>
      <div className="t360-provenance">
        <span className="t360-prov-chip t360-prov-chip--people">FROM PEOPLE</span>
        Created deliberately. Done when checked off.
      </div>
      {tasks.length === 0 ? (
        <div className="t360-empty">No open tasks.</div>
      ) : (
        tasks.map((t) => {
          const done = t.status === 'done' || t.status === 'cancelled';
          return (
            <div key={t.id} className="t360-task-row">
              <span className={`t360-check${done ? ' t360-check--done' : ''}`} aria-hidden="true">
                {done ? '✓' : ''}
              </span>
              <div>
                <div className={`t360-task-title${done ? ' t360-task-title--done' : ''}`}>{t.title}</div>
                <div className="t360-task-meta">
                  {t.due_date !== null ? shortDate(t.due_date) : 'No due date'}
                  {t.requisition_label !== null ? ` · ${t.requisition_label}` : ''}
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function ContactabilityCard({ model }: { model: Talent360ViewModel }) {
  const c = model.header.contactability;
  const lc = model.relationship_strip.last_contact;
  const yn = (b: boolean) => (
    <span className={b ? 't360-val-ok' : 't360-val-no'}>{b ? 'Permitted' : 'Not permitted'}</span>
  );
  return (
    <div className="t360-card">
      <span className="t360-rail-title">Contactability</span>
      <div className="t360-rail-rows">
        <div className="t360-rail-row">
          <span>Recruiting contact</span>
          {yn(c.recruiting_permitted)}
        </div>
        <div className="t360-rail-row">
          <span>Email</span>
          {yn(c.email_permitted)}
        </div>
        <div className="t360-rail-row">
          <span>Phone & voice</span>
          {yn(c.phone_permitted)}
        </div>
        <div className="t360-rail-row">
          <span>SMS</span>
          {yn(c.sms_permitted)}
        </div>
        {lc !== null && (
          <div className="t360-rail-row t360-rail-row--divider">
            <span>Last contact</span>
            <span className="t360-val-strong">
              {relativeDay(lc.at)} {clockTime(lc.at)} · {labelize(lc.channel)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function IdentityCard({ model, onTrust }: { model: Talent360ViewModel; onTrust: () => void }) {
  const id = model.identity;
  if (id === null) return null;
  return (
    <div className="t360-card">
      <span className="t360-rail-title">Identity</span>
      <div className="t360-rail-rows">
        {id.primary_email_confirmed && (
          <div className="t360-id-row">
            <span className="t360-val-ok">✓</span> Primary email confirmed
          </div>
        )}
        {id.mobile_confirmed && (
          <div className="t360-id-row">
            <span className="t360-val-ok">✓</span> Mobile confirmed
          </div>
        )}
        {id.advisory !== null ? (
          <div className="t360-id-row t360-id-row--warn">
            <span>⚠</span>
            <span style={{ flex: 1 }}>{id.advisory.label}</span>
            <Button unstyled type="button" className="t360-link" onClick={onTrust}>
              Review
            </Button>
          </div>
        ) : (
          <div className="t360-id-row">
            <span className="t360-val-ok">✓</span> No unresolved duplicate
          </div>
        )}
        <div className="t360-rail-row t360-rail-row--divider">
          <Button unstyled type="button" className="t360-link" onClick={onTrust}>
            Trust & evidence →
          </Button>
        </div>
      </div>
    </div>
  );
}

function RelationshipCard({ model }: { model: Talent360ViewModel }) {
  const r = model.relationship;
  const hist = r.history;
  return (
    <div className="t360-card">
      <span className="t360-rail-title">Relationship & ownership</span>
      <div className="t360-rel-summary" style={{ marginTop: 8 }}>
        {hist.known_since !== null ? `Known since ${monthYear(hist.known_since)} · ` : ''}
        <b>{hist.requisitions} requisitions</b> · {hist.submittals} submittals · {hist.interviews} interviews ·{' '}
        {hist.placements === 0 ? 'no placements yet' : `${hist.placements} placements`}
      </div>
      <div className="t360-rail-rows">
        {r.ownership.owner_provenance !== null && (
          <div className="t360-rail-row">
            <span>Record owner</span>
            <span className="t360-val-strong">{r.ownership.owner_provenance.name ?? '—'}</span>
          </div>
        )}
        {r.ownership.also_working_with.map((w) => (
          <div key={w.user_id} className="t360-rail-row">
            <span>Also working with</span>
            <span className="t360-val-strong">
              {w.name ?? '—'}
              {w.requisition_label !== null ? ` · ${w.requisition_label}` : ''}
            </span>
          </div>
        ))}
        {r.ownership.source !== null && (
          <div className="t360-rail-row">
            <span>Source</span>
            <span className="t360-val-strong">{r.ownership.source}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── non-overview tabs (converged surfaces; full detail is Slice C) ────────────
function OtherTabContent({
  tab,
  model,
  openOpp,
  setOpenOpp,
  talentId,
  canResolve,
}: {
  tab: TabKey;
  model: Talent360ViewModel;
  openOpp: string | null;
  setOpenOpp: (id: string | null) => void;
  talentId: string;
  canResolve: boolean;
}) {
  if (tab === 'opportunities' && model.opportunities !== null) {
    // Selections converge here (HALT-7): the active + closed opportunities ARE
    // the client-selection surface; the authoritative selection detail is
    // reachable via each row's "Open journey".
    return (
      <div className="t360-card">
        <div className="t360-section-head">
          <span className="t360-section-title">Opportunities</span>
          <span className="t360-count-badge">{model.opportunities.active.length}</span>
        </div>
        {model.opportunities.active.map((o) => (
          <Opportunity
            key={o.pipeline_id}
            o={o}
            open={openOpp === o.pipeline_id}
            onToggle={() => setOpenOpp(openOpp === o.pipeline_id ? null : o.pipeline_id)}
          />
        ))}
        {model.opportunities.closed.length > 0 && (
          <>
            <div className="t360-closed-eyebrow">CLOSED</div>
            {model.opportunities.closed.map((c) => (
              <div key={c.pipeline_id} className="t360-closed-row">
                <span className="t360-opp-reqid">{c.requisition_code}</span>
                <span className="t360-opp-client">{c.client_name ?? 'Client'}</span>
                <span>{c.role_title ?? ''}</span>
                <span className="t360-stage t360-stage--neutral">{c.outcome}</span>
                <span className="t360-closed-when">{c.closed_at !== null ? shortDate(c.closed_at) : ''}</span>
              </div>
            ))}
          </>
        )}
      </div>
    );
  }

  // Trust & Evidence — REUSE the authoritative dossier surface (no clone).
  if (tab === 'trust') {
    return (
      <div className="t360-card">
        <div className="t360-section-body" style={{ paddingTop: 14 }}>
          <TrustPanel talentId={talentId} canResolve={canResolve} />
        </div>
      </div>
    );
  }

  // Profile — composed facts/skills (from getTalent360) + the authoritative
  // work-history surface REUSED (the full record, not re-derived).
  if (tab === 'profile') {
    const p = model.profile;
    return (
      <div className="t360-card">
        <div className="t360-section-body" style={{ paddingTop: 14 }}>
          {p.summary !== null && <p className="t360-summary">{p.summary}</p>}
          {p.facts.length > 0 && (
            <div className="t360-profile-facts">
              {p.facts.map((f) => (
                <div key={f.label} className="t360-profile-cell">
                  <div className="t360-fact-label">{f.label.toUpperCase()}</div>
                  <div className="t360-cell-value">{labelize(f.value)}</div>
                  {f.source !== null && <div className="t360-cell-source">{f.source}</div>}
                </div>
              ))}
            </div>
          )}
          {p.skills.length > 0 && (
            <>
              <div className="t360-skills-eyebrow">SKILLS</div>
              <div className="t360-skills">
                {p.skills.map((s) => (
                  <span key={s.label} className={`t360-skill${s.verified ? ' t360-skill--verified' : ''}`}>
                    {s.label}
                    {s.verified ? ' ✓' : ''}
                  </span>
                ))}
              </div>
            </>
          )}
          <div style={{ marginTop: 14 }}>
            <WorkHistoryPanel talentId={talentId} />
          </div>
        </div>
      </div>
    );
  }

  // Engagement — the composed contactability/consent outcome (§6.6).
  if (tab === 'engagement') {
    const c = model.header.contactability;
    const lc = model.relationship_strip.last_contact;
    return (
      <div className="t360-card">
        <div className="t360-section-head">
          <span className="t360-section-title">Engagement</span>
        </div>
        <div className="t360-section-body">
          <div className="t360-rail-rows">
            <div className="t360-rail-row">
              <span>Recruiting contact</span>
              <span className={c.recruiting_permitted ? 't360-val-ok' : 't360-val-no'}>
                {c.recruiting_permitted ? 'Permitted' : 'Not permitted'}
              </span>
            </div>
            <div className="t360-rail-row">
              <span>Consent state</span>
              <span className="t360-val-strong">{labelize(c.summary)}</span>
            </div>
            {lc !== null && (
              <div className="t360-rail-row t360-rail-row--divider">
                <span>Last contact</span>
                <span className="t360-val-strong">
                  {relativeDay(lc.at)} {clockTime(lc.at)} · {labelize(lc.channel)}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Activity — the full composed timeline (all returned events).
  if (tab === 'activity' && model.recent_activity !== null) {
    return (
      <div className="t360-card">
        <div className="t360-section-head">
          <span className="t360-section-title">Activity</span>
          <span className="t360-count-badge">{model.recent_activity.items.length}</span>
        </div>
        <div className="t360-section-body">
          {model.recent_activity.items.map((a) => (
            <ActivityRow key={a.id} a={a} />
          ))}
          {model.recent_activity.items.length === 0 && (
            <div className="t360-empty">No activity yet.</div>
          )}
        </div>
      </div>
    );
  }

  // Documents — the full composed document list.
  if (tab === 'documents' && model.documents !== null) {
    return (
      <div className="t360-card">
        <div className="t360-section-head">
          <span className="t360-section-title">Documents</span>
          <span className="t360-count-badge">{model.documents.total}</span>
        </div>
        <div className="t360-section-body">
          {model.documents.key_documents.map((d) => (
            <DocRow key={d.id} d={d} />
          ))}
          {model.documents.key_documents.length === 0 && (
            <div className="t360-empty">No documents yet.</div>
          )}
        </div>
      </div>
    );
  }

  // A scope-hidden section (null) reached via its tab — honest authorization
  // notice rather than an empty frame.
  return (
    <div className="t360-card">
      <div className="t360-section-head">
        <span className="t360-section-title">{tabLabel(tab)}</span>
      </div>
      <div className="t360-section-body">
        <div className="t360-empty">You don’t have access to this section.</div>
      </div>
    </div>
  );
}

// Thin Log-activity dialog over the EXISTING authoritative mutation
// (POST /v1/activities via createNote, activity:create). Talent-subject note
// only; exposes only CreateActivityRequestDto-supported fields — no new activity
// type, no Talent-specific backend mutation (directive §4; PO ruling).
function LogActivityDialog({ talentId, onClose }: { talentId: string; onClose: () => void }) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const save = () => {
    const text = notes.trim();
    if (text === '') return;
    setBusy(true);
    setErr(null);
    createNote({ type: 'note', subject_type: 'talent_record', subject_id: talentId, notes: text })
      .then(() => {
        setBusy(false);
        setDone(true);
      })
      .catch(() => {
        setBusy(false);
        setErr('We couldn’t log this activity. Please try again.');
      });
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Log activity"
    >
      {done ? (
        <>
          <InlineAlert variant="success">Activity logged.</InlineAlert>
          <div className="talent-detail__dialog-actions">
            <Button variant="secondary" onClick={onClose}>
              Done
            </Button>
          </div>
        </>
      ) : (
        <>
          <label className="talent-detail__dialog-field">
            <span>Note</span>
            <TextArea
              unstyled
              className="t360-textarea"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={5}
              aria-label="Activity note"
              placeholder="What happened?"
            />
          </label>
          {err !== null && <InlineAlert variant="error">{err}</InlineAlert>}
          <div className="talent-detail__dialog-actions">
            <Button variant="primary" onClick={save} disabled={notes.trim() === '' || busy}>
              {busy ? 'Logging…' : 'Log activity'}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

function tabLabel(t: TabKey): string {
  return t === 'trust' ? 'Trust & Evidence' : t.charAt(0).toUpperCase() + t.slice(1);
}

// ── formatting helpers (presentation only) ───────────────────────────────────
function labelize(v: string): string {
  return v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function relativeDay(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (dayDiff === 0) return 'Today';
  if (dayDiff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function monthYear(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
