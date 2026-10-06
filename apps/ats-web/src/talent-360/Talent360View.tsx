import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Dialog, InlineAlert, Input, Select, TextArea, hasScope, useSession } from '@aramo/fe-foundation';
import type { Session } from '@aramo/fe-foundation';

import { Button, LoadingState, safeErrorMessage } from '../ui';
import { useEntityCrumb } from '../shell/breadcrumb';
// Non-Overview tabs REUSE the authoritative detail surfaces rather than cloning
// their logic (directive §3.4/§12/§14) — each fetches its own authoritative
// data; the Overview stays a single getTalent360() read. Trust & Evidence reads
// the SAME dossier authority (getDossier) through a recruiter-facing adapter.
import { getDossier, type DossierHead } from '../talent/dossier-api';
import { CallButton } from '../communications/CallButton';
import { AddToRequisitionDialog } from '../talent/AddToRequisitionDialog';
import { AddToListDialog } from '../talent/components/AddToListDialog';
import {
  listTalentMemberships,
  type SavedListVisibility,
} from '../talent/saved-list-api';
// Header actions reuse existing authoritative flows (composed workspace, not a
// new workflow authority): Email = requisition-contextual composer (COMM-C4);
// Log activity = the existing POST /v1/activities mutation (activity:create).
import { RequisitionContactEmailComposer } from '../microsoft/RequisitionContactEmailComposer';
import { GeneralTalentContactEmailComposer } from '../microsoft/GeneralTalentContactEmailComposer';
import { createNote } from '../activity/activity-api';
import { createTask, updateTask } from '../task/task-api';
import { fetchAssignableUsers, type AssignableUser } from '../users/users-api';
import { submittalEntryHref, entryActionLabel } from '../submittal-workspace/present';
import { RecordConsentDialog } from '../consent/RecordConsentDialog';

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

// Icon glyphs mirror the frozen prototype's stroke paths (Talent 360.dc.html).
// Presentation only — no new iconography system; the paths are the prototype's.
const ICON_PATHS: Record<string, string> = {
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
  shield: 'M12 3l8 3v6c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V6z',
  reqs: 'M3 9h18M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  client: 'M4 21V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15M14 10h5a1 1 0 0 1 1 1v10M2 21h20',
  cal: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  doc: 'M6 2h9l5 5v15H6zM14 2v6h6',
  tasks: 'M9 5h9M9 12h9M9 19h9M4 5l1.4 1.4L8 4M4 12l1.4 1.4L8 11M4 19l1.4 1.4L8 18',
};

function Icon({
  name,
  size = 13,
  stroke = 'currentColor',
  width,
}: {
  name: keyof typeof ICON_PATHS;
  size?: number;
  stroke?: string;
  width?: number;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={width ?? 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: 'none' }}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

// The money/compensation glyph (circle + $ stroke) is the prototype's dedicated
// mark — kept separate because it is not a single path.
function MoneyIcon(): JSX.Element {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#93A0A8"
      strokeWidth={1.7}
      strokeLinecap="round"
      aria-hidden="true"
      style={{ flex: 'none' }}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M14.5 9.5c-.4-.9-1.4-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.1 0-2.1-.6-2.5-1.5M12 6.5V8M12 16v1.5" />
    </svg>
  );
}

// Activity category → icon name + tile colours (mirrors the prototype CAT map).
const ACTIVITY_CATEGORY_ICON: Record<string, keyof typeof ICON_PATHS> = {
  communications: 'mail',
  requisitions: 'reqs',
  client: 'client',
  interviews: 'cal',
  documents: 'doc',
  tasks: 'tasks',
};

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
  // CRM-5 — "Add to list" affordance requires saved-list:edit (CRM-1 seeded).
  const canAddToList = session !== null && hasScope(session, 'saved-list:edit');
  // CRM-5 — task-write authority (FE-derived from scopes, consistent with every
  // other task control in the app: RequisitionDetail/MyTasks/CompanyDetail).
  const canTaskWrite = session !== null && hasScope(session, 'task:write');
  const myId = session?.sub ?? null;
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
  // COMM-RECRUITER-W1 (W1-A3) — General Talent Contact composer (Talent-only, no requisition).
  const [generalEmailOpen, setGeneralEmailOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);

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
  // CRM-6 — the Talent's OWN active opportunities are the valid follow-up
  // requisition contexts (backend validates the Talent↔Requisition pipeline).
  const followUpReqOptions: readonly FollowUpReqOption[] = (model.opportunities?.active ?? []).map((o) => ({
    requisition_id: o.requisition_id,
    label: o.client_name !== null ? `${o.requisition_code} · ${o.client_name}` : o.requisition_code,
  }));

  // COMM-RECRUITER-W1 (W1-A3) — Email now has BOTH paths. With a requisition
  // context (active opportunities) it stays Requisition Talent Contact: 1 opens
  // the composer directly; multiple open the chooser. With NO active opportunity
  // it opens the General Talent Contact composer (Talent-only). A requisition-
  // contextual action is NEVER silently converted to general contact.
  const activeOpps = model.opportunities?.active ?? [];
  const onEmail = () => {
    const only = activeOpps[0];
    if (activeOpps.length === 0) {
      setGeneralEmailOpen(true);
    } else if (activeOpps.length === 1 && only !== undefined) {
      setEmailCtx({ requisitionId: only.requisition_id, pipelineId: only.pipeline_id });
    } else {
      setEmailChooser(true);
    }
  };

  return (
    <div className="t360-root">
      <div className="t360-breadcrumb">
        <Link to="/talent" className="t360-crumb-link">
          Talent
        </Link>
        <span className="t360-crumb-sep">/</span>
        {h.display_name}
      </div>
      <Header
        model={model}
        initials={initials}
        session={session}
        onAddToRequisition={() => setAddOpen(true)}
        onEmail={onEmail}
        canEmail={h.actions.can_email && h.contactability.recruiting_permitted}
        onLogActivity={() => setLogOpen(true)}
        onFollowUp={() => setFollowUpOpen(true)}
        canFollowUp={canTaskWrite && h.contactability.recruiting_permitted}
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
      {generalEmailOpen && (
        <GeneralTalentContactEmailComposer
          open
          onOpenChange={(o) => {
            if (!o) setGeneralEmailOpen(false);
          }}
          talentId={talentId}
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
      {followUpOpen && (
        <FollowUpDialog
          talentId={talentId}
          myId={myId}
          reqOptions={followUpReqOptions}
          onClose={() => setFollowUpOpen(false)}
          onDone={() => {
            setFollowUpOpen(false);
            load();
          }}
        />
      )}
      {consentOpen && (
        <RecordConsentDialog
          talentRecordId={talentId}
          open={consentOpen}
          onOpenChange={setConsentOpen}
          onRecorded={load}
        />
      )}

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
            <ListsCard talentId={talentId} canAddToList={canAddToList} />
            <TasksCard
              tasks={model.tasks}
              talentId={talentId}
              myId={myId}
              reqOptions={followUpReqOptions}
              canTaskWrite={canTaskWrite}
              canFollowUp={canTaskWrite && model.header.contactability.recruiting_permitted}
              onChanged={load}
            />
            <ContactabilityCard model={model} onRecordConsent={() => setConsentOpen(true)} />
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
              filter={activityFilter}
              setFilter={setActivityFilter}
            />
          </div>
          <div className="t360-rail">
            <AttentionCard items={model.attention} authorized={model.authorized_sections.attention} />
            <ListsCard talentId={talentId} canAddToList={canAddToList} />
            <TasksCard
              tasks={model.tasks}
              talentId={talentId}
              myId={myId}
              reqOptions={followUpReqOptions}
              canTaskWrite={canTaskWrite}
              canFollowUp={canTaskWrite && model.header.contactability.recruiting_permitted}
              onChanged={load}
            />
            <ContactabilityCard model={model} onRecordConsent={() => setConsentOpen(true)} />
            <IdentityCard model={model} onTrust={() => setTab('trust')} />
            <RelationshipCard model={model} />
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
  onFollowUp,
  canFollowUp,
}: {
  model: Talent360ViewModel;
  initials: string;
  session: Session | null;
  onAddToRequisition: () => void;
  onEmail: () => void;
  canEmail: boolean;
  onLogActivity: () => void;
  onFollowUp: () => void;
  canFollowUp: boolean;
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
            {h.email !== null && (
              <span className="t360-contact-field">
                <Icon name="mail" stroke="#93A0A8" />
                {h.email}
              </span>
            )}
            {h.phone !== null && (
              <span className="t360-contact-field">
                <Icon name="phone" stroke="#93A0A8" />
                {h.phone}
              </span>
            )}
            {h.work_authorization !== null && (
              <span className="t360-contact-field">
                <Icon name="shield" stroke="#93A0A8" />
                {labelize(h.work_authorization)}
              </span>
            )}
            {h.desired_compensation !== null && (
              <span className="t360-contact-field">
                <MoneyIcon />
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
                title={canEmail ? undefined : 'Emailing this talent is not permitted'}
              >
                <Icon name="mail" width={2} />
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
                className="t360-btn t360-btn--secondary"
                leadingIcon={<Icon name="phone" width={2} />}
              />
            )}
            {/* CRM-5 §9.1 — Follow up: task authority ∧ contact permission;
                HIDDEN (not disabled) when consent absent (contact-restricted). */}
            {canFollowUp && (
              <Button unstyled type="button" className="t360-btn t360-btn--secondary" onClick={onFollowUp}>
                Follow up
              </Button>
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
          {/* Fact grid — prototype's six slots and labels, preserved exactly.
              RECRUITER + IN STAGE are authoritative in the Talent 360 contract;
              ACCOUNT MANAGER / RTR / RÉSUMÉ SUBMITTED are not composed into this
              read, and BILL RATE is deliberately excluded (ruling R3). Those four
              render an honest em-dash — the slot geometry is kept, the value is
              never fabricated. (Journey sub-states are shown by the 7-step strip
              above, matching the prototype.) */}
          <div className="t360-facts">
            <Fact label="RECRUITER" value={o.owner_label} />
            <Fact label="ACCOUNT MANAGER" value={null} />
            <Fact label="RTR" value={null} />
            <Fact label="RÉSUMÉ SUBMITTED" value={null} />
            <Fact label="BILL RATE" value={null} />
            <Fact label="IN STAGE" value={o.age_label} />
          </div>
          <div className="t360-opp-actions">
            {o.next_action !== null && <ActionButton action={o.next_action} variant="primary" />}
            {/* SW-5 — the Submittal Workspace entry, shown only when a submittal
                already exists (authoritative sub-state); the lifecycle label follows
                the submittal state. No invented "Prepare" affordance where the server
                has not signalled one (its next_action owns qualification-driven CTAs). */}
            {o.journey.sub_states.submittal_state !== null && (
              <Link
                to={submittalEntryHref(o.journey.talent_record_id, o.requisition_id, o.journey.sub_states.submittal_state)}
                className="t360-btn--secondary-neutral"
              >
                {entryActionLabel(o.journey.sub_states.submittal_state)}
              </Link>
            )}
            <Link to={o.open_journey_href} className="t360-btn--secondary-neutral">
              Open journey
            </Link>
          </div>
        </div>
      )}
    </>
  );
}

// A fact slot. A null value renders an honest em-dash in a muted tone so the
// fixed grid geometry is preserved even when the contract does not supply it.
function Fact({ label, value }: { label: string; value: string | null }) {
  const empty = value === null || value === '';
  return (
    <div>
      <div className="t360-fact-label">{label}</div>
      <div className={`t360-fact-value${empty ? ' t360-fact-value--empty' : ''}`}>
        {empty ? '—' : value}
      </div>
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
        <Icon name={ACTIVITY_CATEGORY_ICON[a.category] ?? 'reqs'} size={14} width={1.8} />
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

// CRM-5 — Lists rail card (prototype Talent 360 CRM.dc.html §Lists): the saved
// lists this talent belongs to (reverse membership, visibility-scoped server-
// side — another actor's PRIVATE list never surfaces), plus a governed "+ Add
// to list" reusing the CRM-2/3 AddToListDialog. Composition only: no new BE.
function ListsCard({ talentId, canAddToList }: { talentId: string; canAddToList: boolean }) {
  const [lists, setLists] = useState<
    readonly { id: string; name: string; visibility: SavedListVisibility }[]
  >([]);
  const [addOpen, setAddOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (talentId === '') return;
    try {
      const rows = await listTalentMemberships([talentId]);
      setLists(rows[0]?.lists ?? []);
    } catch {
      // Fail-soft: a lists-read fault must not break the Talent 360 page.
    }
  }, [talentId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="t360-card">
      <div className="t360-rail-head">
        <span className="t360-rail-title">Lists</span>
        {canAddToList ? (
          <Button unstyled type="button" className="t360-link" onClick={() => setAddOpen(true)}>
            + Add to list
          </Button>
        ) : null}
      </div>
      <div className="t360-provenance">Where they’ve been grouped to come back to.</div>
      {lists.length === 0 ? (
        <div className="t360-empty">Not on any list yet.</div>
      ) : (
        <div className="t360-rail-rows">
          {lists.map((l) => (
            <div key={l.id} className="t360-rail-row">
              <span>{l.name}</span>
              <span className="t360-val-strong">
                {l.visibility === 'tenant' ? 'Shared' : 'Private'}
              </span>
            </div>
          ))}
        </div>
      )}
      {notice !== null ? (
        <div className="t360-empty" role="status">
          {notice}
        </div>
      ) : null}
      <AddToListDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        talentIds={[talentId]}
        onDone={(m) => {
          setAddOpen(false);
          setNotice(m);
          void load();
        }}
      />
    </div>
  );
}

function TasksCard({
  tasks,
  talentId,
  myId,
  reqOptions,
  canTaskWrite,
  canFollowUp,
  onChanged,
}: {
  tasks: Talent360ViewModel['tasks'];
  talentId: string;
  myId: string | null;
  reqOptions: readonly FollowUpReqOption[];
  canTaskWrite: boolean;
  canFollowUp: boolean;
  onChanged: () => void;
}) {
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  if (tasks === null) return null;

  // CRM-5 §9.3 — complete a person-task (task:write). Read-only actors keep the
  // display-only indicator (no toggle), per Ruling 4. Authoritative PATCH; the
  // whole model reloads so counts/sections stay truthful (never locally faked).
  async function complete(id: string): Promise<void> {
    setBusyId(id);
    try {
      await updateTask(id, { status: 'done' });
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="t360-card">
      <div className="t360-rail-head">
        <span className="t360-rail-title">Tasks</span>
        {canFollowUp ? (
          <Button unstyled type="button" className="t360-link" onClick={() => setFollowUpOpen(true)}>
            + Follow up
          </Button>
        ) : null}
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
              {canTaskWrite && !done ? (
                <Button
                  unstyled
                  type="button"
                  className="t360-check"
                  aria-label={`Complete: ${t.title}`}
                  disabled={busyId === t.id}
                  onClick={() => void complete(t.id)}
                />
              ) : (
                <span className={`t360-check${done ? ' t360-check--done' : ''}`} aria-hidden="true">
                  {done ? '✓' : ''}
                </span>
              )}
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
      {followUpOpen && (
        <FollowUpDialog
          talentId={talentId}
          myId={myId}
          reqOptions={reqOptions}
          onClose={() => setFollowUpOpen(false)}
          onDone={() => {
            setFollowUpOpen(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

// §9.3/§10 — the follow-up create affordance (shared by the header "Follow up"
// action and the Tasks card). A REAL task: owner_type talent_record, type
// follow_up. CRM-6 — full modal: Reason + When + Assign-to (defaults to the
// ACTOR here on the FE so the task lands on their My Desk — the backend does
// NOT default a missing assignee) + optional Requisition context.
// CRM-6 req-option: the Talent's OWN active opportunities are the only valid
// requisition contexts (the backend validates the Talent↔Requisition pipeline
// relationship and 422s otherwise), so the picker is fed from them — no all-reqs
// fetch, no invalid choices.
interface FollowUpReqOption {
  readonly requisition_id: string;
  readonly label: string;
}

function FollowUpDialog({
  talentId,
  myId,
  reqOptions,
  onClose,
  onDone,
}: {
  talentId: string;
  myId: string | null;
  reqOptions: readonly FollowUpReqOption[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [due, setDue] = useState('');
  // CRM-6 — assignee defaults to the actor (prototype "Me"); this is what makes
  // the follow-up land on the creator's My Desk (the CRM-5 path left it null).
  const [assigneeId, setAssigneeId] = useState<string>(myId ?? '');
  const [reqId, setReqId] = useState<string>('');
  const [roster, setRoster] = useState<readonly AssignableUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchAssignableUsers()
      .then((u) => {
        if (!cancelled) setRoster(u);
      })
      .catch(() => {
        // Fail-soft: assignee defaults to self even if the roster can't load.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(): Promise<void> {
    if (reason.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await createTask({
        title: reason.trim(),
        owner_type: 'talent_record',
        owner_id: talentId,
        type: 'follow_up',
        ...(due === '' ? {} : { due_date: due }),
        ...(assigneeId === '' ? {} : { assignee_id: assigneeId }),
        ...(reqId === '' ? {} : { requisition_id: reqId }),
      });
      onDone();
    } catch {
      setError('Couldn’t create the follow-up. Please try again.');
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Follow up"
      description="Create a follow-up task for this person."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || reason.trim() === ''} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create follow-up'}
          </Button>
        </>
      }
    >
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <label className="talent-detail__dialog-field">
        <span>Reason</span>
        <TextArea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="What's the next step?"
          rows={2}
          className="t360-textarea"
          aria-label="Follow-up reason"
        />
      </label>
      <label className="talent-detail__dialog-field">
        <span>When (optional)</span>
        <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Follow-up due date" />
      </label>
      <label className="talent-detail__dialog-field">
        <span>Assign to</span>
        <Select
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
          aria-label="Follow-up assignee"
        >
          <option value={myId ?? ''}>Me</option>
          {roster
            .filter((u) => u.user_id !== myId)
            .map((u) => (
              <option key={u.user_id} value={u.user_id}>
                {u.display_name}
              </option>
            ))}
        </Select>
      </label>
      {reqOptions.length > 0 ? (
        <label className="talent-detail__dialog-field">
          <span>Requisition (optional)</span>
          <Select
            value={reqId}
            onChange={(e) => setReqId(e.target.value)}
            aria-label="Follow-up requisition"
          >
            <option value="">None</option>
            {reqOptions.map((r) => (
              <option key={r.requisition_id} value={r.requisition_id}>
                {r.label}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
    </Dialog>
  );
}

function ContactabilityCard({
  model,
  onRecordConsent,
}: {
  model: Talent360ViewModel;
  onRecordConsent: () => void;
}) {
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
      <div
        className="t360-rail-row--divider"
        style={{ display: 'grid', gap: 8, marginTop: 10, paddingTop: 10 }}
      >
        {c.recruiting_permitted ? (
          <span className="t360-val-ok">Consent recorded</span>
        ) : (
          <>
            <span className="t360-val-no">No recruiting-contact consent recorded.</span>
            <div>
              <Button variant="secondary" type="button" onClick={onRecordConsent}>
                Record consent
              </Button>
            </div>
          </>
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
            {/* CRM-5 §9.4 — provenance only; there is NO Talent-level owner (HALT-2). */}
            <span>Record added by</span>
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
        {/* CRM-5 §9.4 — historical recruiter relationships (closed episodes). */}
        {r.ownership.worked_with_before.map((w) => (
          <div key={`wb-${w.user_id}`} className="t360-rail-row">
            <span>Worked with before</span>
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
  filter,
  setFilter,
}: {
  tab: TabKey;
  model: Talent360ViewModel;
  openOpp: string | null;
  setOpenOpp: (id: string | null) => void;
  talentId: string;
  filter: string;
  setFilter: (f: string) => void;
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
                {/* CRM-5 §9.5 — authoritative reason or honest "reason not recorded". */}
                <span className="t360-closed-reason">
                  {c.reason !== null ? labelize(c.reason) : 'reason not recorded'}
                </span>
                <span className="t360-closed-when">{c.closed_at !== null ? shortDate(c.closed_at) : ''}</span>
              </div>
            ))}
          </>
        )}
      </div>
    );
  }

  // Trust & Evidence — the recruiter-facing projection of the SAME authoritative
  // dossier (getDossier), rendered as claim → evidence → named state, never an
  // opaque number (prototype parity). The admin/internal TrustPanel is not shown
  // here; this is a presentation adapter over the identical data, not a new state
  // model (no trust recomputation, no ordinal, no invented verification).
  if (tab === 'trust') {
    return <Talent360TrustPanel talentId={talentId} model={model} />;
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
          {/* WORK HISTORY — rendered from the composed read (profile.work_history,
              role/organization/span/source), matching the prototype rows; not a
              parallel authority. Honest empty when the résumé hasn't populated it. */}
          <div className="t360-skills-eyebrow" style={{ marginTop: 16 }}>
            WORK HISTORY
          </div>
          {p.work_history.length === 0 ? (
            <div className="t360-empty">No work history yet — it’s captured from the résumé at creation.</div>
          ) : (
            p.work_history.map((w, i) => (
              <div key={`${w.role}-${i}`} className="t360-wh-row">
                <span className="t360-wh-main">
                  <b>{w.role}</b> · {w.organization}
                </span>
                <span className="t360-wh-span">{w.span}</span>
                {w.source !== null && <span className="t360-wh-src">{w.source}</span>}
              </div>
            ))
          )}
          {p.skills.length > 0 && (
            <div className="t360-profile-note">
              ✓ Backed by résumé and a second source. Other skills are self-reported.
            </div>
          )}
        </div>
      </div>
    );
  }

  // Engagement — the prototype's Contact-requirement section geometry, driven by
  // authoritative data only. Per-requisition email/voice evidence is NOT in the
  // composed read; rather than fabricate ✓Email/✓Voice/Satisfied states, the
  // per-requisition evidence is shown as an honest unavailable state (recorded
  // as a data-contract follow-up). The authoritative overall contactability /
  // consent / last-contact IS shown where available.
  if (tab === 'engagement') {
    const c = model.header.contactability;
    const lc = model.relationship_strip.last_contact;
    const active = model.opportunities?.active ?? [];
    const comms = (model.recent_activity?.items ?? []).filter((i) => i.category === 'communications');
    return (
      <>
        <div className="t360-card">
          <div className="t360-section-body" style={{ paddingTop: 16 }}>
            <div className="t360-section-title">Contact requirement</div>
            <div className="t360-subnote">
              Aramo checks captured email and voice evidence for each requisition — nothing to prove by hand.
            </div>
            {/* One row per active requisition (authoritative from opportunities).
                Structured per-requisition email/voice evidence is NOT in the
                composed read, so each row shows an honest "—" / unavailable — the
                prototype row geometry is preserved, the evidence is never
                fabricated (no ✓Email/✓Voice/Satisfied). Recorded as a data-
                contract follow-up. */}
            {active.length === 0 ? (
              <div className="t360-empty" style={{ marginTop: 10 }}>
                No active requisitions to show contact evidence for.
              </div>
            ) : (
              <div style={{ marginTop: 6 }}>
                {active.map((o) => (
                  <div key={o.pipeline_id} className="t360-creq-row">
                    <span className="t360-creq-id">
                      <span className="t360-opp-reqid">{o.requisition_code}</span> ·{' '}
                      <b>{o.client_name ?? 'Client'}</b>
                    </span>
                    <span className="t360-creq-ev">
                      Email <span className="t360-fact-value--empty">—</span>
                    </span>
                    <span className="t360-creq-ev">
                      Voice <span className="t360-fact-value--empty">—</span>
                    </span>
                    <span className="t360-creq-state">Evidence unavailable</span>
                  </div>
                ))}
              </div>
            )}
            <div className="t360-rail-rows" style={{ marginTop: 14 }}>
              <div className="t360-rail-row">
                <span>Recruiting contact</span>
                <span className={c.recruiting_permitted ? 't360-val-ok' : 't360-val-no'}>
                  {c.recruiting_permitted ? 'Permitted' : 'Not permitted'}
                </span>
              </div>
              <div className="t360-rail-row">
                <span>Email</span>
                <span className={c.email_permitted ? 't360-val-ok' : 't360-val-no'}>
                  {c.email_permitted ? 'Permitted' : 'Not permitted'}
                </span>
              </div>
              <div className="t360-rail-row">
                <span>Phone &amp; voice</span>
                <span className={c.phone_permitted ? 't360-val-ok' : 't360-val-no'}>
                  {c.phone_permitted ? 'Permitted' : 'Not permitted'}
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
        {model.recent_activity !== null && (
          <div className="t360-card">
            <div className="t360-section-head">
              <span className="t360-section-title">Communications</span>
              <span className="t360-count-badge">{comms.length}</span>
            </div>
            <div className="t360-section-body">
              {comms.map((a) => (
                <ActivityRow key={a.id} a={a} />
              ))}
              {comms.length === 0 && <div className="t360-empty">No communications yet.</div>}
            </div>
          </div>
        )}
      </>
    );
  }

  // Activity — the full composed timeline with the prototype's category filter
  // chips (counts from the authoritative category_counts) + icon-tile rows.
  if (tab === 'activity' && model.recent_activity !== null) {
    const { items, category_counts } = model.recent_activity;
    const shown = filter === 'all' ? items : items.filter((i) => i.category === filter);
    return (
      <div className="t360-card">
        <div className="t360-section-head">
          <span className="t360-section-title">Activity</span>
          <span className="t360-count-badge">{items.length}</span>
          <div className="t360-filters">
            {ACTIVITY_FILTERS.map((f) => {
              const count = f.key === 'all' ? items.length : (category_counts[f.key] ?? 0);
              return (
                <Button
                  unstyled
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
        </div>
        <div className="t360-section-body">
          {shown.map((a) => (
            <ActivityRow key={a.id} a={a} />
          ))}
          {shown.length === 0 && <div className="t360-empty">No activity of this type yet.</div>}
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

// ── Trust & Evidence (recruiter-facing presentation adapter) ─────────────────
// Projects the SAME authoritative dossier (getDossier) + the composed identity
// facts into recruiter-facing claim → evidence → named-state rows. No opaque
// number, no ordinal, no new state model, no trust recomputation. The admin
// contradiction-resolve / verification-anchor / evidence-timeline surfaces stay
// in the internal TrustPanel; this view is read-only.
interface TrustClaim {
  readonly claim: string;
  readonly evidence: string;
  readonly state: string;
  readonly tone: 'ok' | 'warn' | 'neutral';
}

function bandTone(band: string): 'ok' | 'warn' | 'neutral' {
  if (/support|verif|strong|valid|confirm|resolv/i.test(band)) return 'ok';
  if (/review|pend|thin|weak|await|expir/i.test(band)) return 'warn';
  return 'neutral';
}

function Talent360TrustPanel({ talentId, model }: { talentId: string; model: Talent360ViewModel }) {
  const [head, setHead] = useState<DossierHead | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let live = true;
    getDossier(talentId)
      .then((h) => {
        if (live) {
          setHead(h);
          setPhase('ready');
        }
      })
      .catch(() => {
        if (live) setPhase('error');
      });
    return () => {
      live = false;
    };
  }, [talentId]);

  const id = model.identity;
  const claims: TrustClaim[] = [];
  if (id !== null) {
    const both = id.primary_email_confirmed && id.mobile_confirmed;
    claims.push({
      claim: 'Identity · email and mobile',
      evidence: both
        ? 'Email control confirmed · mobile confirmed'
        : id.primary_email_confirmed
          ? 'Email confirmed · mobile not yet confirmed'
          : 'Not yet confirmed',
      state: both ? 'Supported' : 'Partial',
      tone: both ? 'ok' : 'warn',
    });
    claims.push(
      id.advisory !== null
        ? {
            claim: 'Duplicate check',
            evidence: id.advisory.label,
            state: 'Review needed',
            tone: 'warn',
          }
        : {
            claim: 'Duplicate check',
            evidence: 'No unresolved duplicate for this record',
            state: 'Resolved',
            tone: 'ok',
          },
    );
  }
  if (model.header.work_authorization !== null) {
    claims.push({
      claim: `Work authorization · ${labelize(model.header.work_authorization)}`,
      evidence: 'Self-reported · no document on file yet',
      state: 'Self-reported',
      tone: 'neutral',
    });
  }
  // Enrich with the authoritative dossier dimensions (recruiter-labelled). These
  // are the SAME bands the internal panel reads — rendered as named states, not
  // the raw dimension/anchor dump.
  if (head !== null && head.ledger_established) {
    const dims: readonly { key: 'claims' | 'continuity' | 'eligibility'; label: string }[] = [
      { key: 'claims', label: 'Claims on record' },
      { key: 'continuity', label: 'Employment continuity' },
      { key: 'eligibility', label: 'Eligibility' },
    ];
    for (const d of dims) {
      const band = head.dimensions?.[d.key]?.band;
      if (band !== undefined && band !== null) {
        claims.push({
          claim: d.label,
          evidence: 'From the evidence ledger',
          state: labelize(String(band)),
          tone: bandTone(String(band)),
        });
      }
    }
  }

  return (
    <div className="t360-card">
      <div className="t360-section-body" style={{ paddingTop: 14 }}>
        <div className="t360-section-title">Trust &amp; evidence</div>
        <div className="t360-subnote">
          Each claim shows what supports it — named, explainable states, never an opaque number.
        </div>
        {phase === 'loading' && claims.length === 0 ? (
          <div className="t360-empty" style={{ marginTop: 10 }}>
            Loading trust &amp; evidence…
          </div>
        ) : claims.length === 0 ? (
          <div className="t360-empty" style={{ marginTop: 10 }}>
            No trust evidence recorded for this record yet.
          </div>
        ) : (
          <div className="t360-trust-rows">
            {claims.map((c) => (
              <div key={c.claim} className="t360-trust-row">
                <div className="t360-trust-main">
                  <div className="t360-trust-claim">{c.claim}</div>
                  <div className="t360-trust-ev">{c.evidence}</div>
                </div>
                <span className={`t360-trust-state t360-trust-state--${c.tone}`}>{c.state}</span>
              </div>
            ))}
          </div>
        )}
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
