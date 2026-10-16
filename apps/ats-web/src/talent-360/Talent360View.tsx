import { Dialog, InlineAlert, hasScope, useSession } from '@aramo/fe-foundation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { CallButton } from '../communications/CallButton';
import { RecordConsentDialog } from '../consent/RecordConsentDialog';
import { GeneralTalentContactEmailComposer } from '../microsoft/GeneralTalentContactEmailComposer';
import { RequisitionContactEmailComposer } from '../microsoft/RequisitionContactEmailComposer';
import { ScheduleMeetingDialog } from '../microsoft/ScheduleMeetingDialog';
import { talentRequisition360Path } from '../requisitions/talent-requisition-360/route';
import { useEntityCrumb } from '../shell/breadcrumb';
import { useCompactRailPage } from '../shell/nav-collapse';
import { SectionNav, useSectionNavOpen } from '../shell/section-nav/SectionNav';
import { dismissAdvisory } from '../sourcing/sourcing-api';
import { AddToRequisitionDialog } from '../talent/AddToRequisitionDialog';
import { AddToListDialog } from '../talent/components/AddToListDialog';
import { indexHydration } from '../talent/profile-hydration';
import { withCurrency } from '../talent/stated-fields';
import { getTalent, getTalentProfileHydration, getTalentWorkAuthorizationState, getTalentWorkHistory } from '../talent/talent-api';
import { updateTask } from '../task/task-api';
import { Button, LoadingState, safeErrorMessage } from '../ui';

import { FollowUpDialog, LogActivityDialog, type FollowUpReqOption } from './t360-dialogs';
import { ProfileSection, type ProfileData } from './t360-profile';
import { SECTION_GROUPS, isSection, labelize, monthYear, sectionLabel, workAuthLabel, type T360Section } from './t360-model';
import {
  ActivitySection,
  CiSection,
  DocumentsSection,
  ListsSection,
  NotesSection,
  OpportunitiesSection,
  OverviewSection,
  ScreeningSection,
  TasksCard,
  TasksSection,
  TrustSection,
  WorkAuthSection,
} from './t360-sections';
import { getTalent360 } from './talent-360-api';
import type { ActiveOpportunityView, AttentionItemView, Talent360View as Talent360ViewModel } from './talent-360-types';
import './talent-360.css';
import { availabilityLabel, engagementLabel } from './t360-vocab';

// Talent 360 — the person-centric recruiter workspace (route `talent/:talentId`),
// redesigned to platform/Talent 360 CRM.dc.html: shared main nav + shared talent
// section nav (3 groups, 12 sections) + sticky person header + one view per
// section. A READ/WORK projection of GET /v1/talent-360/:id: the FE renders what
// the backend composed and owns only presentation state (active section, section
// nav collapse). Opportunities open their Talent × Requisition 360; every action
// reuses an existing governed flow. The shell top bar (⌘K search) is kept by PO
// instruction.

const SEC_OPEN_KEY = 'talent360.secOpen';

type ReqPurpose = 'email' | 'schedule';

function useViewportWidth(): number {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  useEffect(() => {
    const onResize = (): void => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
}

export function Talent360View(): JSX.Element | null {
  const { talentId = '' } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const sessionState = useSession();
  const session = sessionState.status === 'authenticated' ? sessionState.session : null;
  const canAddToList = session !== null && hasScope(session, 'saved-list:edit');
  const canTaskWrite = session !== null && hasScope(session, 'task:write');
  const canSchedule = session !== null && hasScope(session, 'communication:meeting:create');
  const canResolveIdentity = session !== null && hasScope(session, 'identity:resolve');
  const canEditTalent = session !== null && hasScope(session, 'talent:edit');
  const canSeePay = session !== null && hasScope(session, 'compensation:view:pay');
  // TIP-E2E INC-3 §11 — the manual Technical Screening workspace (screening:read).
  const canScreen = session !== null && hasScope(session, 'screening:read');
  const myId = session?.sub ?? null;

  const [model, setModel] = useState<Talent360ViewModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const [listsReload, setListsReload] = useState(0);
  // Dialogs (existing components — §10).
  const [addReqOpen, setAddReqOpen] = useState(false);
  const [addListOpen, setAddListOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [generalEmailOpen, setGeneralEmailOpen] = useState(false);
  const [emailCtx, setEmailCtx] = useState<ActiveOpportunityView | null>(null);
  const [scheduleCtx, setScheduleCtx] = useState<ActiveOpportunityView | null>(null);
  const [chooser, setChooser] = useState<ReqPurpose | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  useCompactRailPage();
  const [secOpen, toggleSec] = useSectionNavOpen(SEC_OPEN_KEY);
  const width = useViewportWidth();

  const raw = search.get('section');
  const section: T360Section = isSection(raw) ? raw : 'overview';
  const go = useCallback(
    (s: T360Section) => {
      setSearch(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (s === 'overview') p.delete('section');
          else p.set('section', s);
          return p;
        },
        { replace: true },
      );
      window.scrollTo(0, 0);
    },
    [setSearch],
  );

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

  // §8A — the full record, declared work history and governed work-authorization
  // state, loaded with the page (PO A4: the header's "<title> · <current
  // employer>" shows on every section) — same reads + scope gate as Edit talent.
  // 404/403 on the record → fallback to the Talent 360 read (no banner).
  const [profileData, setProfileData] = useState<ProfileData | null>(null);
  useEffect(() => {
    if (talentId === '') return;
    let live = true;
    setProfileData({ status: 'loading', record: null, workHistory: null, workAuth: null, hydration: null });
    void Promise.allSettled([
      getTalent(talentId),
      getTalentWorkHistory(talentId),
      getTalentWorkAuthorizationState(talentId),
      getTalentProfileHydration(talentId),
    ]).then(
      ([rec, wh, wa, hy]) => {
        if (!live) return;
        setProfileData({
          status: rec.status === 'fulfilled' ? 'ready' : 'fallback',
          record: rec.status === 'fulfilled' ? rec.value : null,
          workHistory: wh.status === 'fulfilled' ? wh.value.work_history : null,
          workAuth: wa.status === 'fulfilled' ? wa.value : null,
          hydration: hy.status === 'fulfilled' ? indexHydration(hy.value) : null,
        });
      },
    );
    return () => {
      live = false;
    };
  }, [talentId]);

  // A superseded record redirects to its survivor — never rehydrate stale state.
  useEffect(() => {
    if (model?.header.record_status === 'superseded' && model.header.superseded_by_record_id) {
      navigate(`/talent/${model.header.superseded_by_record_id}`, { replace: true });
    }
  }, [model, navigate]);
  useEntityCrumb(model === null ? undefined : model.header.display_name);

  // Edge-to-edge content under the kept shell top bar; sticky offsets mirror its height.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.body.classList.add('t360-route');
    return () => document.body.classList.remove('t360-route');
  }, []);
  useLayoutEffect(() => {
    const bar = document.querySelector<HTMLElement>('.rc-topbar');
    const root = rootRef.current;
    if (bar === null || root === null) return;
    const apply = (): void => root.style.setProperty('--page-top', `${bar.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [model]);

  if (loading && model === null) return <LoadingState label="Loading this Talent…" />;
  if (error !== null && model === null) {
    return (
      <InlineAlert variant="error">
        {error}{' '}
        <Button unstyled type="button" className="t360-arrow" onClick={load}>
          Retry
        </Button>
      </InlineAlert>
    );
  }
  if (model === null) return null;
  if (model.header.record_status === 'superseded') {
    return <div className="t360-superseded">This Talent record has been superseded. Redirecting to the current record…</div>;
  }

  const h = model.header;
  const c = h.contactability;
  const first = h.first_name.trim() !== '' ? h.first_name : h.display_name;
  const initials = `${h.first_name[0] ?? ''}${h.last_name[0] ?? ''}`.toUpperCase();
  const active = model.opportunities?.active ?? [];
  const followUpReqOptions: readonly FollowUpReqOption[] = active.map((o) => ({
    requisition_id: o.requisition_id,
    label: o.client_name !== null ? `${o.requisition_code} · ${o.client_name}` : o.requisition_code,
  }));

  // Actions are HIDDEN (not disabled) when contact consent forbids them (§4).
  const showEmail = h.actions.can_email && c.recruiting_permitted && c.email_permitted;
  const showCall = h.actions.can_call && c.recruiting_permitted && c.phone_permitted;
  const showSchedule = canSchedule && c.recruiting_permitted && active.length > 0;
  const scheduleInMenu = showSchedule && width < 1000;
  const canFollowUp = canTaskWrite && c.recruiting_permitted;

  // Email: one active opportunity → its composer; several → choose; none → general contact.
  const onEmail = (): void => {
    const only = active[0];
    if (active.length === 0) setGeneralEmailOpen(true);
    else if (active.length === 1 && only !== undefined) setEmailCtx(only);
    else setChooser('email');
  };
  const onSchedule = (): void => {
    const only = active[0];
    if (active.length === 1 && only !== undefined) setScheduleCtx(only);
    else setChooser('schedule');
  };

  const onAttention = (a: AttentionItemView): void => {
    // Open/Continue → that requisition's Talent × Requisition 360; other kinds keep
    // the projection's own destination.
    if (a.action?.kind !== 'follow_up' && a.requisition_id !== null) {
      navigate(talentRequisition360Path(a.requisition_id, talentId), { state: { tr360From: 'talent-360' } });
      return;
    }
    if (a.action?.href != null) navigate(a.action.href);
  };

  const completeTask = (id: string): void => {
    setBusyTask(id);
    void updateTask(id, { status: 'done' })
      .then(() => load())
      .finally(() => setBusyTask(null));
  };

  const dismissDuplicate = (advisoryId: string): void => {
    void dismissAdvisory(advisoryId)
      .then(() => {
        setNotice('Marked as a different person · advisory closed');
        load();
      })
      .catch(() => setNotice('Couldn’t record that decision. Please try again.'));
  };

  // Section badges (§3.2): counts from the composed read; `!` while identity needs review.
  const openTasks = (model.tasks ?? []).filter((t) => t.status !== 'done' && t.status !== 'cancelled').length;
  const badges: Partial<Record<T360Section, { text: string; tone: 'grey' | 'blue' | 'amber' }>> = {
    ...(model.documents !== null && model.documents.total > 0 ? { docs: { text: String(model.documents.total), tone: 'grey' as const } } : {}),
    ...(active.length > 0 ? { opps: { text: String(active.length), tone: 'blue' as const } } : {}),
    ...(openTasks > 0 ? { tasks: { text: String(openTasks), tone: 'grey' as const } } : {}),
    ...(model.identity?.advisory != null ? { trust: { text: '!', tone: 'amber' as const } } : {}),
  };
  const groups = SECTION_GROUPS.map((g) => ({
    label: g.label,
    items: g.items.map((it) => ({ ...it, ...(badges[it.key] !== undefined ? { badge: badges[it.key] } : {}) })),
  }));

  const contactChip = c.recruiting_permitted ? (c.sms_permitted ? 'Contact permitted' : 'Contact permitted · no SMS') : 'Contact restricted';
  const identity = model.identity;
  // `<title> · <current employer>` once the full record has loaded (§8A).
  const employer = profileData?.record?.current_employer ?? null;
  const titleLine = [h.title, employer].filter((x): x is string => x !== null && x.trim() !== '').join(' · ');
  const line2 = [
    titleLine,
    h.location,
    h.experience_summary,
    (profileData?.record?.work_authorization ?? h.work_authorization) !== null
      ? workAuthLabel(profileData?.record?.work_authorization ?? h.work_authorization ?? '')
      : null,
  ].filter((x): x is string => x !== null && x !== '');
  const hist = model.relationship.history;
  const line3 = [
    h.email,
    h.phone,
    `${hist.known_since !== null ? `Known since ${monthYear(hist.known_since)} · ` : ''}${hist.requisitions} requisitions`,
  ].filter((x): x is string => x !== null && x !== '');

  const tasksProps = {
    tasks: model.tasks,
    canTaskWrite,
    canFollowUp,
    busyId: busyTask,
    onComplete: completeTask,
    onFollowUp: () => setFollowUpOpen(true),
  };

  const body = (): JSX.Element => {
    switch (section) {
      case 'overview':
        return (
          <OverviewSection
            model={model}
            talentId={talentId}
            firstName={first}
            go={go}
            onAttention={onAttention}
            tasks={<TasksCard {...tasksProps} onAll={() => go('tasks')} />}
          />
        );
      case 'opps':
        return (
          <OpportunitiesSection
            model={model}
            talentId={talentId}
            canAddToRequisition={h.actions.can_add_to_requisition}
            onAddToRequisition={() => setAddReqOpen(true)}
          />
        );
      case 'profile':
        return (
          <ProfileSection
            model={model}
            data={profileData ?? { status: 'loading', record: null, workHistory: null, workAuth: null, hydration: null }}
            talentId={talentId}
            canEdit={canEditTalent && h.actions.can_edit_profile}
            canSeePay={canSeePay}
            go={go}
            onRecordSaved={(rec) => setProfileData((p) => (p === null ? p : { ...p, record: rec }))}
            onWorkHistorySaved={(list) => setProfileData((p) => (p === null ? p : { ...p, workHistory: list }))}
            notify={setNotice}
          />
        );
      case 'auth':
        return (
          <WorkAuthSection
            model={model}
            firstName={first}
            editable={canEditTalent && h.actions.can_edit_profile && profileData?.status === 'ready'}
            record={profileData?.record ?? null}
            go={go}
            workAuth={profileData?.workAuth ?? null}
            onRecordSaved={(rec) => setProfileData((p) => (p === null ? p : { ...p, record: rec }))}
            notify={setNotice}
          />
        );
      case 'docs':
        return <DocumentsSection model={model} talentId={talentId} canEdit={canEditTalent} />;
      case 'activity':
        return <ActivitySection model={model} />;
      case 'tasks':
        return <TasksSection {...tasksProps} />;
      case 'lists':
        return (
          <ListsSection
            talentId={talentId}
            firstName={first}
            canAddToList={canAddToList}
            onAddToList={() => setAddListOpen(true)}
            reloadToken={listsReload}
          />
        );
      case 'notes':
        return <NotesSection talentId={talentId} firstName={first} canWrite={h.actions.can_log_activity} />;
      case 'trust':
        return (
          <TrustSection
            model={model}
            talentId={talentId}
            canResolveIdentity={canResolveIdentity}
            onDismissDuplicate={dismissDuplicate}
            onRecordConsent={() => setConsentOpen(true)}
          />
        );
      case 'ci':
        return <CiSection />;
      case 'ts':
        return <ScreeningSection talentId={talentId} canScreen={canScreen} />;
    }
  };

  const menuItems: { label: string; run?: () => void; to?: string }[] = [
    ...(scheduleInMenu ? [{ label: 'Schedule', run: onSchedule }] : []),
    ...(canAddToList ? [{ label: 'Add to list', run: () => setAddListOpen(true) }] : []),
    ...(h.actions.can_edit_profile ? [{ label: 'Edit profile', to: `/talent/${talentId}/edit` }] : []),
    ...(h.actions.can_log_activity ? [{ label: 'Log activity', run: () => setLogOpen(true) }] : []),
    ...(canScreen ? [{ label: 'Technical screening', to: `/talent/${talentId}/screening` }] : []),
  ];

  return (
    <div className="t360" ref={rootRef} data-testid="t360">
      <SectionNav
        variant="talent"
        ariaLabel="Talent sections"
        open={secOpen}
        onToggle={toggleSec}
        backLabel="Back to Talent"
        onBack={() => navigate('/talent')}
        initials={initials}
        name={h.display_name}
        subtitle={h.title ?? undefined}
        pill={h.availability.status !== null ? availabilityLabel(h.availability.status) : undefined}
        groups={groups}
        active={section}
        onSelect={(k) => go(k as T360Section)}
      />

      <div className="t360-main">
        <header className="t360-hd">
          <div className="t360-crumbs">
            <Link to="/talent">Talent</Link>
            <span className="t360-crumbs__sep">/</span>
            <span className="t360-crumbs__here">{h.display_name}</span>
            <span className="t360-crumbs__sep">/</span>
            <span>{sectionLabel(section)}</span>
          </div>
          <div className="t360-hd__row">
            <div className="t360-hd__id">
              <div className="t360-hd__line1">
                <h1 className="t360-h1">{h.display_name}</h1>
                {h.availability.status !== null ? <span className="t360-chip t360-tone--green">{availabilityLabel(h.availability.status)}</span> : null}
                {h.recruiting_ready.ready ? (
                  <span
                    className="t360-chip t360-tone--blue t360-chip--help"
                    title="Required record fields complete + recruiting contact permitted + no blocking identity issue. Worked out by Aramo."
                  >
                    Recruiting ready
                  </span>
                ) : null}
                <Button unstyled type="button" className={`t360-chip t360-chip--btn t360-tone--${c.recruiting_permitted ? 'green' : 'amber'}`} onClick={() => go('trust')}>
                  {contactChip}
                </Button>
                {identity !== null ? (
                  <Button
                    unstyled
                    type="button"
                    className={`t360-chip t360-chip--btn t360-tone--${identity.advisory !== null ? 'amber' : 'green'}`}
                    onClick={() => go('trust')}
                  >
                    {identity.advisory !== null ? 'Identity · 1 to review' : 'Identity confirmed'}
                  </Button>
                ) : null}
              </div>
              <div className="t360-hd__line2">
                {line2.map((x) => (
                  <span key={x}>{x}</span>
                ))}
                {h.desired_compensation !== null ? (
                  <span>
                    <span className="t360-mono t360-ink">{withCurrency(h.desired_compensation)}</span> desired
                    {h.engagement_type !== null ? ` · ${engagementLabel(h.engagement_type)}` : ''}
                  </span>
                ) : null}
              </div>
              <div className="t360-hd__line3">
                {line3.map((x) => (
                  <span key={x}>{x}</span>
                ))}
              </div>
            </div>
            <div className="t360-hd__actions">
              {showEmail ? (
                <Button unstyled type="button" className="t360-btn t360-btn--brandline" onClick={onEmail}>
                  Email
                </Button>
              ) : null}
              {showCall ? (
                <CallButton
                  talent={{ id: h.talent_id, first_name: h.first_name, last_name: h.last_name, phone_cell: h.phone, phone_work: null, phone_home: null }}
                  session={session}
                  className="t360-btn t360-btn--brandline"
                />
              ) : null}
              {showSchedule && !scheduleInMenu ? (
                <Button unstyled type="button" className="t360-btn t360-btn--neutral" onClick={onSchedule}>
                  Schedule
                </Button>
              ) : null}
              {h.actions.can_add_to_requisition ? (
                <Button unstyled type="button" className="t360-btn t360-btn--primary t360-btn--wide" onClick={() => setAddReqOpen(true)}>
                  Add to requisition
                </Button>
              ) : null}
              {menuItems.length > 0 ? (
                <span className="t360-more">
                  <Button
                    unstyled
                    type="button"
                    className="t360-more__btn"
                    title="More: Add to list · Edit profile · Log activity"
                    aria-label="More"
                    aria-haspopup="menu"
                    aria-expanded={moreOpen}
                    onClick={() => setMoreOpen((o) => !o)}
                  >
                    ···
                  </Button>
                  {moreOpen ? (
                    <>
                      <Button unstyled type="button" className="t360-more__scrim" aria-hidden="true" tabIndex={-1} onClick={() => setMoreOpen(false)} />
                      <span className="t360-more__pop" role="menu">
                        {menuItems.map((m) =>
                          m.to !== undefined ? (
                            <Link key={m.label} role="menuitem" className="t360-more__item" to={m.to}>
                              {m.label}
                            </Link>
                          ) : (
                            <Button
                              unstyled
                              key={m.label}
                              type="button"
                              role="menuitem"
                              className="t360-more__item"
                              onClick={() => {
                                setMoreOpen(false);
                                m.run?.();
                              }}
                            >
                              {m.label}
                            </Button>
                          ),
                        )}
                      </span>
                    </>
                  ) : null}
                </span>
              ) : null}
            </div>
          </div>
        </header>

        <main className="t360-body">{body()}</main>
      </div>

      {notice !== null ? (
        <div role="status" className="t360-toast" onAnimationEnd={() => setNotice(null)}>
          <span className="t360-toast__ok">✓</span>
          {notice}
        </div>
      ) : null}

      {/* Existing dialogs / flows (§10). */}
      <AddToRequisitionDialog open={addReqOpen} onClose={() => setAddReqOpen(false)} talentId={talentId} />
      <AddToListDialog
        open={addListOpen}
        onClose={() => setAddListOpen(false)}
        talentIds={[talentId]}
        onDone={(m) => {
          setAddListOpen(false);
          setNotice(m);
          setListsReload((n) => n + 1);
        }}
      />
      {emailCtx !== null ? (
        <RequisitionContactEmailComposer
          open
          onOpenChange={(o) => {
            if (!o) setEmailCtx(null);
          }}
          talentId={talentId}
          requisitionId={emailCtx.requisition_id}
          pipelineId={emailCtx.pipeline_id}
        />
      ) : null}
      {generalEmailOpen ? (
        <GeneralTalentContactEmailComposer
          open
          onOpenChange={(o) => {
            if (!o) setGeneralEmailOpen(false);
          }}
          talentId={talentId}
        />
      ) : null}
      {scheduleCtx !== null ? (
        <ScheduleMeetingDialog
          open
          onOpenChange={(o) => {
            if (!o) setScheduleCtx(null);
          }}
          talentId={talentId}
          talentName={h.display_name}
          talentEmail={h.email ?? undefined}
          requisitionId={scheduleCtx.requisition_id}
          requisitionReference={scheduleCtx.requisition_code}
          requisitionTitle={scheduleCtx.role_title ?? undefined}
          pipelineId={scheduleCtx.pipeline_id}
          onDone={() => setNotice(`Meeting scheduled · invitation sent to ${h.display_name} from your Outlook calendar`)}
        />
      ) : null}
      {chooser !== null ? (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o) setChooser(null);
          }}
          title={chooser === 'email' ? 'Email — choose a requisition' : 'Schedule — choose a requisition'}
        >
          <div className="t360-chooser">
            {active.map((o) => (
              <Button
                unstyled
                key={o.pipeline_id}
                type="button"
                className="t360-chooser__row"
                onClick={() => {
                  if (chooser === 'email') setEmailCtx(o);
                  else setScheduleCtx(o);
                  setChooser(null);
                }}
              >
                <span className="t360-mono">{o.requisition_code}</span> <b>{o.client_name ?? 'Client'}</b> · {o.role_title ?? ''}
              </Button>
            ))}
          </div>
        </Dialog>
      ) : null}
      {logOpen ? <LogActivityDialog talentId={talentId} onClose={() => setLogOpen(false)} /> : null}
      {followUpOpen ? (
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
      ) : null}
      {consentOpen ? <RecordConsentDialog talentRecordId={talentId} open={consentOpen} onOpenChange={setConsentOpen} onRecorded={load} /> : null}
    </div>
  );
}
