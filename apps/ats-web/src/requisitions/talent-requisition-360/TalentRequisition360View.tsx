import { Button, useOptionalToast, useSession, type Session } from '@aramo/fe-foundation';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { getCompany } from '../../companies/companies-api';
import { CallButton } from '../../communications/CallButton';
import { RecordTalentResponseModal } from '../../communications/RecordTalentResponseModal';
import { VoiceEvidenceSummary } from '../../communications/VoiceEvidenceSummary';
import { getVoiceEngagementEvidence } from '../../communications/communications-api';
import type { VoiceEngagementEvidence } from '../../communications/types';
import { EngagementReadinessSummary } from '../../engagement/EngagementReadinessSummary';
import { FEATURE_FLAGS } from '../../feature-flags';
import { RequisitionContactEmailComposer } from '../../microsoft/RequisitionContactEmailComposer';
import { ScheduleMeetingDialog } from '../../microsoft/ScheduleMeetingDialog';
import { UpcomingMeetings } from '../../microsoft/UpcomingMeetings';
import { getMicrosoftBindingStatus, type MicrosoftBindingStatus } from '../../microsoft/microsoft-api';
import { OfferPanelContainer } from '../../offers/OfferPanelContainer';
import { listPipelinesForRequisition, transitionPipeline, voidPipelineEpisode } from '../../pipeline/pipeline-api';
import { getTalentJourney, type TalentRequisitionJourney } from '../../pipeline/talent-journey-api';
import type { PipelineStatus, PipelineView } from '../../pipeline/types';
import { SendRtrLauncher } from '../../rtr/SendRtrLauncher';
import { getTalent, updateTalent } from '../../talent/talent-api';
import type { TalentRecordView } from '../../talent/types';
import { useCompactRailPage } from '../../shell/nav-collapse';
import { getTalent360 } from '../../talent-360/talent-360-api';
import type { AttentionItemView, Talent360View } from '../../talent-360/talent-360-types';
import { RemoveFromRequisitionModal } from '../RemoveFromRequisitionModal';
import { ResumeSelectionSection } from '../ResumeSelectionSection';
import { getRequisition, getRequisitionProfile } from '../requisitions-api';
import { getRequisitionTalentBoard, type RequisitionTalentBoardView } from '../requisition-talent-board-api';
import { voidErrorMessage } from '../requisition-talent-actions';
import type { RequisitionProfileView } from '../golden-profile';
import { RECRUITING_STATUS_TONE } from '../status-tone';
import { RECRUITING_STATUS_LABELS, type RequisitionView } from '../types';

import { Tr360Overview, type QualRow, type RecruiterFact } from './Tr360Overview';
import { talentRequisition360Path, type Tr360NavState } from './route';
import { Tr360TechScreening } from './Tr360TechScreening';
import {
  PRIMARY_ACTION_COPY,
  STEPS,
  currentStepIndex,
  findCard,
  firstName,
  formatLongDate,
  formatShortDate,
  initials,
  isViewKey,
  pipelineOrder,
  rateLabel,
  requisitionSkills,
  rtrPresentation,
  sectionForView,
  stepState,
  tabForView,
  type PillTone,
  type SectionKey,
  type StepKey,
  type TabKey,
  type ViewKey,
} from './tr360-model';
import './tr360.css';

// Talent × Requisition 360 — ONE talent on ONE requisition, full page. Replaces the
// former right-side talent drawer. Design authority:
// platform/Talent Requisition 360.dc.html. Every fact is read from its owning
// endpoint; the header primary action is the server-offered recruiting action
// (journey.recruiting_available_actions) and the page never computes stage
// eligibility or writes a stage the owning domain did not offer.

const UI_TONE: Record<string, PillTone> = { ok: 'green', warn: 'amber', brand: 'blue', danger: 'red', neutral: 'grey' };

// Section-nav icons (stroke paths from the design authority).
const IC = {
  back: 'M19 12H5M11 18l-6-6 6-6',
  ov: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  exp: 'M4 7h16v13H4zM9 7V4h6v3',
  skills: 'M12 3l2.5 5.5L20 9l-4 4 1 6-5-2.7L7 19l1-6-4-4 5.5-.5z',
  auth: 'M12 3l8 3v6c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V6zM9 12l2 2 4-4',
  opp: 'M3 9h18M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  act: 'M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  docs: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5',
  comm: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-5.1A8 8 0 1 1 21 12z',
  trust: 'M12 3l8 3v6c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V6z',
  ci: 'M12 3a4 4 0 0 0-4 4v5a4 4 0 0 0 8 0V7a4 4 0 0 0-4-4zM5 11a7 7 0 0 0 14 0M12 18v3',
  screen: 'M9 5h9M9 12h9M9 19h9M4 5l1.4 1.4L8 4M4 12l1.4 1.4L8 11M4 19l1.4 1.4L8 18',
  notes: 'M4 4h16v16H4zM8 9h8M8 13h5',
} as const;

const SECTION_DEF: readonly { key: SectionKey; label: string; icon: string }[] = [
  { key: 'overview', label: 'Overview', icon: IC.ov },
  { key: 'exp', label: 'Experience', icon: IC.exp },
  { key: 'skills', label: 'Skills', icon: IC.skills },
  { key: 'auth', label: 'Work authorization', icon: IC.auth },
  { key: 'opp', label: 'Opportunities', icon: IC.opp },
  { key: 'act', label: 'Activity', icon: IC.act },
  { key: 'docs', label: 'Documents', icon: IC.docs },
  { key: 'comm', label: 'Communication', icon: IC.comm },
  { key: 'trust', label: 'Talent Trust', icon: IC.trust },
  { key: 'ci', label: 'Conversation Intelligence', icon: IC.ci },
  { key: 'screening', label: 'Technical Screening', icon: IC.screen },
  { key: 'notes', label: 'Notes', icon: IC.notes },
];

const TAB_DEF: readonly { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'ci', label: 'Conversation Intelligence' },
  { key: 'screening', label: 'Technical Screening' },
  { key: 'submittal', label: 'Submittal' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'notes', label: 'Notes' },
];

// Server journey stage reached by each stepper step (for the "reached <date>" summary).
const STEP_STAGES: Record<StepKey, readonly string[]> = {
  no_contact: ['SOURCED'],
  contacted: ['CONTACTED'],
  responded: ['ENGAGED'],
  qualifying: ['QUALIFYING'],
  qualified: ['QUALIFIED'],
  submitted: ['SUBMITTED', 'CLIENT_REVIEW'],
  interview: ['INTERVIEW'],
  offer: ['OFFER'],
};

// The decision copy shown on a DISABLED primary action, by Pipeline status. Label
// only — whether the action is offered is the server's call.
const NEXT_RECRUITING_LABEL: Partial<Record<PipelineStatus, string>> = {
  no_contact: 'Contact Talent',
  contacted: 'Record response',
  talent_responded: 'Start qualifying',
  qualifying: 'Mark qualified',
};

function Glyph({ d, size = 16, width = 1.8 }: { d: string; size?: number; width?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function useNarrow(breakpoint: number): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < breakpoint);
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return narrow;
}

export interface TalentRequisition360ViewProps {
  /** Test seam (mirrors the other views): a session instead of the live one. */
  readonly sessionOverride?: Session;
}

export function TalentRequisition360View({ sessionOverride }: TalentRequisition360ViewProps = {}): JSX.Element {
  const { reqId = '', talentId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const toast = useOptionalToast();
  const sessionState = useSession();
  const scopes = useMemo(
    () =>
      sessionOverride?.scopes ??
      (sessionState.status === 'authenticated' ? sessionState.session.scopes : []),
    [sessionOverride, sessionState],
  );
  const navState = (location.state ?? {}) as Tr360NavState;

  // ── Loaded facts ──
  const [req, setReq] = useState<RequisitionView | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<PipelineView | null>(null);
  const [board, setBoard] = useState<RequisitionTalentBoardView | null>(null);
  const [talent, setTalent] = useState<TalentRecordView | null>(null);
  const [t360, setT360] = useState<Talent360View | null>(null);
  const [profile, setProfile] = useState<RequisitionProfileView | null>(null);
  const [journey, setJourney] = useState<TalentRequisitionJourney | null>(null);
  const [voice, setVoice] = useState<VoiceEngagementEvidence | null>(null);
  const [binding, setBinding] = useState<MicrosoftBindingStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notOnReq, setNotOnReq] = useState(false);
  const [reload, setReload] = useState(0);

  // ── UI state ──
  const [secOpenPref, setSecOpenPref] = useState(true);
  const narrow = useNarrow(900);
  const secOpen = secOpenPref && !narrow;
  const [moreOpen, setMoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [meetingsReload, setMeetingsReload] = useState(0);
  const [responseOpen, setResponseOpen] = useState(false);
  const [rtrOpen, setRtrOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState('');

  const rawView = search.get('view');
  const view: ViewKey = isViewKey(rawView) ? rawView : 'overview';
  const go = useCallback(
    (next: ViewKey) => {
      setSearch(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next === 'overview') p.delete('view');
          else p.set('view', next);
          return p;
        },
        { replace: true, state: location.state },
      );
      window.scrollTo(0, 0);
    },
    [setSearch, location.state],
  );

  const canAdvance = scopes.includes('pipeline:change-status');
  const canSendEmail = scopes.includes('communication:email:send');
  const canSchedule = scopes.includes('communication:meeting:create');
  const canReadMeetings = scopes.includes('communication:meeting:read');
  const canCall = scopes.includes('communication:voice:call');
  const canEditTalent = scopes.includes('talent:edit');
  const canSendRtr = scopes.includes('document:create');

  // Route chrome: edge-to-edge content (the app shell — main nav + top bar — is
  // unchanged). The sticky section nav / header sit below the shell's sticky top
  // bar, so its live height is mirrored into --tr360-top.
  const rootRef = useRef<HTMLDivElement>(null);
  // Section-nav page: under 1280px the shared main nav opens collapsed (rail spec §6).
  useCompactRailPage();
  useEffect(() => {
    document.body.classList.add('tr360-route');
    return () => document.body.classList.remove('tr360-route');
  }, []);
  useLayoutEffect(() => {
    const bar = document.querySelector<HTMLElement>('.rc-topbar');
    const root = rootRef.current;
    if (bar === null || root === null) return;
    const apply = (): void => root.style.setProperty('--tr360-top', `${bar.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [loadError]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [reqId, talentId]);

  // ── Load (requisition × talent) ──
  useEffect(() => {
    let live = true;
    setLoadError(null);
    setNotOnReq(false);
    void (async () => {
      const [reqRes, pipesRes, boardRes, talentRes, t360Res, profileRes, voiceRes] = await Promise.allSettled([
        getRequisition(reqId),
        listPipelinesForRequisition(reqId),
        getRequisitionTalentBoard(reqId),
        getTalent(talentId),
        getTalent360(talentId),
        getRequisitionProfile(reqId),
        getVoiceEngagementEvidence(talentId, reqId),
      ]);
      if (!live) return;
      if (reqRes.status === 'rejected') {
        setLoadError('This requisition is unavailable.');
        return;
      }
      setReq(reqRes.value);
      setBoard(boardRes.status === 'fulfilled' ? boardRes.value : null);
      setTalent(talentRes.status === 'fulfilled' ? talentRes.value : null);
      setT360(t360Res.status === 'fulfilled' ? t360Res.value : null);
      setProfile(profileRes.status === 'fulfilled' ? profileRes.value : null);
      setVoice(voiceRes.status === 'fulfilled' ? voiceRes.value : null);
      const episodes =
        pipesRes.status === 'fulfilled'
          ? pipesRes.value.items.filter((p) => p.talent_record_id === talentId && p.status !== 'voided')
          : [];
      // The current episode = the most recently updated non-void one.
      const episode = [...episodes].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
      setPipeline(episode);
      if (episode === null) setNotOnReq(pipesRes.status === 'fulfilled');
      void getCompany(reqRes.value.company_id)
        .then((c) => {
          if (live) setCompanyName(c.name);
        })
        .catch(() => {
          /* client name best-effort */
        });
      if (episode !== null) {
        void getTalentJourney(episode.id)
          .then((j) => {
            if (live) setJourney(j);
          })
          .catch(() => {
            if (live) setJourney(null);
          });
      }
    })();
    return () => {
      live = false;
    };
  }, [reqId, talentId, reload]);

  useEffect(() => {
    if (!canSendEmail && !canSchedule) return;
    let live = true;
    void getMicrosoftBindingStatus()
      .then((b) => {
        if (live) setBinding(b);
      })
      .catch(() => {
        if (live) setBinding(null);
      });
    return () => {
      live = false;
    };
  }, [canSendEmail, canSchedule]);

  // ── Derived display values ──
  const reqCode = req !== null ? `REQ-${req.requisition_number}` : 'REQ';
  const talentName =
    talent !== null
      ? `${talent.first_name} ${talent.last_name}`.trim()
      : (t360?.header.display_name ?? 'Talent');
  const first = firstName(talentName);
  const card = findCard(board, talentId);
  const order = pipelineOrder(board);
  const pos = order.indexOf(talentId);
  const current = currentStepIndex(pipeline?.status ?? null, journey);
  const rtr = rtrPresentation(card);
  const subtitle = [talent?.title ?? t360?.header.title ?? null, talent?.current_employer ?? null]
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    .join(' · ');
  const clientLabel = companyName ?? 'the client';
  const reqAttention = (t360?.attention ?? []).filter((a) => a.requisition_id === reqId);
  const reqActivity = (t360?.recent_activity?.items ?? []).filter((a) => a.requisition_id === reqId);
  const reqTasks = (t360?.tasks ?? []).filter((t) => t.requisition_id === reqId);
  const reqDocs = (t360?.documents?.key_documents ?? []).filter((d) => d.requisition_id === reqId);
  const reqNotes = reqActivity.filter((a) => a.category === 'note');
  const activeOpps = t360?.opportunities?.active.length ?? null;
  const voidAction = card?.next_actions.find((a) => a.key === 'pipeline.void' && scopes.includes(a.required_scope));
  const selectionState = journey?.sub_states['selection_state'] ?? null;
  const offerRelevant = selectionState === 'SELECTED' || (journey?.stages.some((s) => s.owner === 'offer') ?? false);
  const submittalState = journey?.sub_states['submittal_state'] ?? null;

  // ── Domain primary action (server-offered) ──
  const offered = journey?.recruiting_available_actions[0];
  const primaryCopy = offered !== undefined ? PRIMARY_ACTION_COPY[offered] : null;
  const pendingLabel = pipeline !== null ? NEXT_RECRUITING_LABEL[pipeline.status] : undefined;
  let primary: { label: string; enabled: boolean; tip: string } | null = null;
  if (primaryCopy !== null) {
    const blocked = !canAdvance
      ? "Your role can't change this Talent's stage"
      : primaryCopy.dispatch === 'contact' && !canSendEmail
        ? "Sending email isn't enabled for your account"
        : null;
    primary = { label: primaryCopy.label, enabled: blocked === null && !busy, tip: blocked ?? primaryCopy.tip };
  } else if (pendingLabel !== undefined && journey !== null) {
    primary = {
      label: pendingLabel,
      enabled: false,
      tip: 'Not available yet — the recruiting workflow has not offered this step',
    };
  }

  const runPrimary = (): void => {
    if (primaryCopy === null || primary === null || !primary.enabled || pipeline === null) return;
    if (primaryCopy.dispatch === 'contact') {
      setComposerOpen(true);
      return;
    }
    if (primaryCopy.dispatch === 'record_response') {
      setResponseOpen(true);
      return;
    }
    const to = primaryCopy.to;
    if (to === undefined) return;
    setBusy(true);
    setActionError(null);
    void transitionPipeline(pipeline.id, { to_status: to as PipelineStatus, expected_version: pipeline.version })
      .then(() => {
        toast.show(to === 'qualified' ? 'Qualified · recorded as your decision' : 'Qualifying started');
        setReload((n) => n + 1);
      })
      .catch(() => setActionError('Could not advance — the backend rejected this action.'))
      .finally(() => setBusy(false));
  };

  const goTalent = (nextId: string | undefined): void => {
    if (nextId === undefined) return;
    const qs = search.toString();
    navigate(`${talentRequisition360Path(reqId, nextId)}${qs !== '' ? `?${qs}` : ''}`, {
      replace: true,
      state: location.state,
    });
  };

  const back = (): void => {
    if (navState.tr360From !== undefined && window.history.length > 1) navigate(-1);
    else navigate(`/requisitions/${reqId}`);
  };

  const onAttention = (a: AttentionItemView): void => {
    const href = a.action?.href ?? null;
    if (href !== null) navigate(href);
  };

  const toggleHot = (): void => {
    if (talent === null) return;
    const next = !talent.is_hot;
    setMoreOpen(false);
    setTalent({ ...talent, is_hot: next });
    void updateTalent(talent.id, { is_hot: next }).catch(() => {
      setTalent((t) => (t === null ? t : { ...t, is_hot: !next }));
      toast.show('Could not update HOT.');
    });
  };

  const confirmVoid = async (): Promise<void> => {
    if (pipeline === null) return;
    setVoidBusy(true);
    setVoidError('');
    try {
      await voidPipelineEpisode(pipeline.id, { reason: 'ADDED_BY_MISTAKE', expected_version: pipeline.version });
      setVoidOpen(false);
      navigate(`/requisitions/${reqId}`, { replace: true });
    } catch (e) {
      setVoidError(voidErrorMessage(e));
    } finally {
      setVoidBusy(false);
    }
  };

  // ── Overview inputs ──
  const qualRows: QualRow[] = [];
  if (rtr !== null) {
    const rtrDoc = reqDocs.find((d) => d.signed && /rtr|represent/i.test(d.kind));
    const signedOn = rtrDoc?.signed_at != null ? formatShortDate(rtrDoc.signed_at) : null;
    qualRows.push({
      key: 'rtr',
      label: 'Right to Represent',
      sub:
        card?.rtr_status === 'NOT_REQUIRED'
          ? `Not required by ${clientLabel}`
          : `Required by ${clientLabel}${signedOn !== null ? ` · signed ${signedOn}` : ''}`,
      done: rtr.done,
      glyph: rtr.done ? '✓' : '1',
      pill: rtr.pill,
      tone: rtr.tone,
      cta: card?.rtr_status === 'NOT_SENT' && canSendRtr ? 'Send RTR' : 'View',
      ctaPrimary: card?.rtr_status === 'NOT_SENT' && canSendRtr,
      onCta: card?.rtr_status === 'NOT_SENT' && canSendRtr ? () => setRtrOpen(true) : () => go('docs'),
    });
  }
  const desired = card?.desired_pay ?? t360?.header.desired_compensation ?? null;
  qualRows.push({
    key: 'rate',
    label: 'Rate & availability confirmed',
    sub: [
      desired !== null && desired.trim() !== '' ? `Desired ${desired}` : null,
      t360?.header.availability.detail ?? t360?.header.availability.status ?? null,
    ]
      .filter((s): s is string => s !== null && s !== '')
      .join(' · ') || 'No rate or availability confirmation on record',
    done: false,
    glyph: String(qualRows.length + 1),
    pill: 'Not recorded',
    tone: 'grey',
    cta: 'Notes',
    ctaPrimary: false,
    onCta: () => go('notes'),
  });

  const facts: RecruiterFact[] = [
    { k: 'Right to Represent', v: rtr?.fact ?? 'Not governed', green: card?.rtr_status === 'CONFIRMED' },
    { k: 'Email engagement', v: card?.email_evidence === true ? 'Contacted' : 'None yet' },
    {
      k: 'Voice engagement',
      v: voice === null ? '—' : voice.two_way_conversation ? 'Conversation' : voice.attempted ? 'Attempted' : 'None yet',
    },
    { k: 'Desired rate', v: desired !== null && desired.trim() !== '' ? desired : '—' },
    { k: 'Work authorization', v: t360?.header.work_authorization != null ? 'On record' : 'Not on record' },
    { k: 'Availability', v: t360?.header.availability.status ?? '—' },
  ];

  const m365Ready = binding !== null && !binding.needs_reauthorization;
  const m365: ReactNode = (
    <div className="tr360-card tr360-card--pad" data-testid="tr360-m365">
      <div className="tr360-m365__hd">
        <span className="tr360-card__title">Microsoft 365</span>
        <span className="tr360-card__note">as you</span>
      </div>
      {binding !== null && binding.needs_reauthorization ? (
        <div className="tr360-empty">
          Connect your Microsoft account to send email and schedule meetings.{' '}
          <Link to="/settings/me">Connect your account in My Settings →</Link>
        </div>
      ) : (
        <div className="tr360-m365__row">
          {canSendEmail && m365Ready ? (
            <Button unstyled type="button" className="tr360-btn tr360-btn--brand-outline" onClick={() => setComposerOpen(true)}>
              Send email
            </Button>
          ) : null}
          {canSchedule && m365Ready ? (
            <Button unstyled type="button" className="tr360-btn" onClick={() => setScheduleOpen(true)}>
              Schedule meeting
            </Button>
          ) : null}
          {talent !== null && pipeline !== null ? (
            <CallButton
              talent={talent}
              session={null}
              canCall={canCall}
              regarding={{ requisition_id: reqId, pipeline_id: pipeline.id }}
              onCompleted={() => setReload((n) => n + 1)}
              className="tr360-btn"
            />
          ) : null}
        </div>
      )}
      <div className="tr360-m365__cap">Sent from your connected account · logged to this opportunity automatically.</div>
      {canReadMeetings && pipeline !== null ? (
        <UpcomingMeetings
          talentId={talentId}
          talentName={talentName}
          requisitionId={reqId}
          canEdit={scopes.includes('communication:meeting:edit')}
          canCancel={scopes.includes('communication:meeting:cancel')}
          reloadToken={meetingsReload}
          onReschedule={() => setScheduleOpen(true)}
        />
      ) : null}
    </div>
  );

  // ── Content for a non-Overview view ──
  const summary = (title: string, body: ReactNode, cta?: { label: string; to: string }, embed?: ReactNode): JSX.Element => (
    <div className="tr360-card tr360-sum" data-testid="tr360-summary">
      <div className="tr360-sum__title">{title}</div>
      <div className="tr360-sum__body">{body}</div>
      {embed !== undefined ? <div className="tr360-sum__embed">{embed}</div> : null}
      {cta !== undefined ? (
        <Link className="tr360-sum__cta" to={cta.to}>
          {cta.label} →
        </Link>
      ) : null}
    </div>
  );

  const stepSummary = (key: StepKey): JSX.Element => {
    const idx = STEPS.findIndex((s) => s.key === key);
    const step = STEPS[idx];
    const label = step?.label ?? '';
    const reached = journey?.stages.find((s) => STEP_STAGES[key].includes(s.stage));
    const when = formatShortDate(reached?.occurred_at);
    const state = stepState(idx, current);
    let body: string;
    if (state === 'future') {
      body =
        key === 'qualified'
          ? `Qualified is a recruiter decision — Aramo never sets it.${primary?.label === 'Mark qualified' && primary.enabled ? ' Ready: use "Mark qualified" in the header.' : ''}`
          : `${first} has not reached ${label} on ${reqCode} yet.`;
    } else {
      body = `${state === 'current' ? 'Current stage' : 'Reached'}${when !== null ? ` · ${when}` : ''}${reached !== undefined ? ` · owned by ${reached.owner}` : ''}.`;
    }
    if (key === 'offer') {
      return summary(
        label,
        offerRelevant ? body : `Offer & start lives in its own journey once the client selects ${first}.`,
        pipeline !== null && (offerRelevant || (journey?.sub_states['placement_state'] ?? null) !== null)
          ? { label: 'Open Offer & Start', to: `/offer-start/${pipeline.id}` }
          : undefined,
        offerRelevant ? <OfferPanelContainer requisitionId={reqId} talentRecordId={talentId} scopes={scopes} /> : undefined,
      );
    }
    if (key === 'submitted' && submittalState !== null) {
      return summary(label, body, { label: 'Open Submittal Workspace', to: `/talent/${talentId}/submittal/${reqId}/workspace` });
    }
    return summary(label, body);
  };

  const renderView = (): ReactNode => {
    if (view.startsWith('step:')) return stepSummary(view.slice(5) as StepKey);
    switch (view) {
      case 'overview':
        return (
          <Tr360Overview
            talentFirstName={first}
            reqCode={reqCode}
            attention={reqAttention}
            onAttention={onAttention}
            qualRows={qualRows}
            activity={reqActivity}
            facts={facts}
            m365={m365}
            skills={requisitionSkills(profile)}
          />
        );
      case 'screening':
        return (
          <Tr360TechScreening
            enabled={FEATURE_FLAGS.techScreening360}
            session={null}
            talentFirstName={first}
            reqCode={reqCode}
          />
        );
      case 'ci':
        return (
          <div className="tr360-card tr360-ci" data-testid="tr360-ci">
            <div className="tr360-ci__hd">
              <span className="tr360-sum__title">Conversation Intelligence</span>
              <span className="tr360-card__note">transcripts from consented recordings on this requisition only</span>
            </div>
            <div className="tr360-ci__empty">
              No transcripts yet. A transcript is created only when {first} consents to recording on a Teams call
              scheduled from this opportunity.
            </div>
          </div>
        );
      case 'exp': {
        const wh = t360?.profile.work_history ?? [];
        return summary(
          'Experience',
          wh.length === 0
            ? 'No work history on record.'
            : `${wh.map((w) => [w.organization, w.role, w.span].filter(Boolean).join(' · ')).join('. ')}. Full history lives on the Talent record; this view shows what is relevant to ${reqCode}.`,
          { label: 'Open Talent 360', to: `/talent/${talentId}` },
        );
      }
      case 'skills': {
        const sk = t360?.profile.skills ?? [];
        return summary(
          'Skills',
          sk.length === 0
            ? 'No skills on record.'
            : `${sk.map((s) => s.label).join(', ')}. Client must-haves for ${reqCode} are highlighted on Overview.`,
        );
      }
      case 'auth':
        return summary(
          'Work authorization',
          t360?.header.work_authorization != null
            ? `On record · ${t360.header.work_authorization}.`
            : 'No work authorization on record.',
        );
      case 'opp':
        return summary(
          'Opportunities',
          activeOpps === null
            ? `This page is scoped to ${reqCode}; switch opportunities from Talent 360.`
            : `${first} is in play on ${activeOpps} requisition${activeOpps === 1 ? '' : 's'}. This page is scoped to ${reqCode}; switch opportunities from Talent 360.`,
          { label: 'Open Talent 360', to: `/talent/${talentId}` },
        );
      case 'act':
        return summary(
          'Activity',
          `The activity feed for ${reqCode} is shown on Overview. Cross-requisition activity lives on the Talent record.`,
        );
      case 'docs':
        return summary(
          'Documents',
          reqDocs.length === 0
            ? `No documents linked to ${reqCode} yet.`
            : reqDocs
                .map((d) => `${d.kind}${d.meta !== null ? ` · ${d.meta}` : ''}${d.signed && d.signed_at !== null ? ` · signed ${formatShortDate(d.signed_at) ?? ''}` : ''}`)
                .join(' · '),
          undefined,
          pipeline !== null ? (
            <ResumeSelectionSection pipelineId={pipeline.id} canSetSelection={scopes.includes('pipeline:resume:set')} />
          ) : undefined,
        );
      case 'comm':
        return summary(
          'Communication',
          `Email, calls and meetings with ${first} on ${reqCode} are logged to this opportunity.`,
          undefined,
          <VoiceEvidenceSummary evidence={voice} />,
        );
      case 'trust': {
        const id = t360?.identity ?? null;
        return summary(
          'Talent Trust',
          id === null
            ? 'Trust details are not available for your role.'
            : `${id.advisory !== null ? `Identity advisory · ${id.advisory.label}` : 'No identity advisories'} · email ${id.primary_email_confirmed ? 'verified' : 'not verified'} and phone ${id.mobile_confirmed ? 'verified' : 'not verified'}.`,
        );
      }
      case 'notes':
        return summary(
          'Notes',
          reqNotes.length === 0 ? 'No notes on this opportunity yet.' : reqNotes.map((n) => n.body ?? n.title).join(' · '),
        );
      case 'tasks':
        return summary(
          'Tasks',
          reqTasks.length === 0
            ? `No open tasks for ${first} on ${reqCode}.`
            : reqTasks.map((t) => `${t.title}${t.due_date !== null ? ` · due ${formatShortDate(t.due_date) ?? ''}` : ''}`).join(' · '),
        );
      case 'submittal':
        return summary(
          'Submittal',
          submittalState !== null
            ? `Submittal to ${clientLabel} is in progress. The Submittal Workspace is the review step of this opportunity.`
            : `Submittal to ${clientLabel} opens once ${first} is marked Qualified. The Submittal Workspace becomes the review step of this opportunity.`,
          submittalState !== null
            ? { label: 'Open Submittal Workspace', to: `/talent/${talentId}/submittal/${reqId}/workspace` }
            : undefined,
          <EngagementReadinessSummary talentId={talentId} requisitionId={reqId} />,
        );
      default:
        return null;
    }
  };

  if (loadError !== null) {
    return (
      <div className="tr360">
        <p className="tr360-status" role="alert">
          {loadError}
        </p>
      </div>
    );
  }

  const activeSection = sectionForView(view);
  const activeTab = tabForView(view);
  const sectionBadge = (k: SectionKey): string =>
    k === 'opp' && activeOpps !== null && activeOpps > 0
      ? String(activeOpps)
      : k === 'docs' && reqDocs.length > 0
        ? String(reqDocs.length)
        : '';
  const backLabel = `Back to ${reqCode} pipeline`;
  const placeLabel = req !== null ? [req.city, req.state].filter(Boolean).join(', ') : '';
  const arrangement =
    req?.work_arrangement === 'hybrid'
      ? 'Hybrid'
      : req?.work_arrangement === 'remote'
        ? 'Remote'
        : req?.work_arrangement === 'onsite'
          ? 'On-site'
          : null;
  const pay = req !== null ? rateLabel(req.pay_rate_amount, req.pay_rate_period) : null;
  const bill = req !== null ? rateLabel(req.bill_rate_amount, req.bill_rate_period) : null;
  const start = req !== null ? formatLongDate(req.start_date) : null;
  const statusTone = req !== null ? UI_TONE[RECRUITING_STATUS_TONE[req.status]] ?? 'grey' : 'grey';

  return (
    <div className="tr360" data-testid="tr360" ref={rootRef}>
      <aside className={`tr360-sec${secOpen ? '' : ' tr360-sec--collapsed'}`} aria-label="Talent sections">
        <div className="tr360-sec__top">
          {secOpen ? (
            <Button unstyled type="button" className="tr360-sec__back" title={backLabel} onClick={back}>
              <Glyph d={IC.back} size={13} width={2.2} />
              <span>{backLabel}</span>
            </Button>
          ) : null}
          <Button
            unstyled
            type="button"
            className="tr360-sec__toggle"
            title={secOpen ? 'Collapse talent sections' : 'Expand talent sections'}
            aria-label={secOpen ? 'Collapse talent sections' : 'Expand talent sections'}
            aria-expanded={secOpen}
            onClick={() => setSecOpenPref(!secOpen)}
          >
            <Glyph
              d={secOpen ? 'M4 4h16v16H4zM9 4v16M15 10l-2 2 2 2' : 'M4 4h16v16H4zM9 4v16M13 10l2 2-2 2'}
              size={14}
              width={2}
            />
          </Button>
        </div>
        <div className="tr360-sec__who">
          <span className="tr360-sec__avatar" aria-hidden="true">
            {initials(talentName)}
          </span>
          {secOpen ? (
            <span className="tr360-sec__whotext">
              <span className="tr360-sec__name">{talentName}</span>
              {subtitle !== '' ? <span className="tr360-sec__subtitle">{subtitle}</span> : null}
              {pipeline !== null ? <span className="tr360-sec__active tr360-tone--green">Active</span> : null}
            </span>
          ) : null}
        </div>
        <nav className="tr360-sec__list">
          {!secOpen ? (
            <Button unstyled type="button" className="tr360-sec__item tr360-sec__item--back" title={backLabel} aria-label={backLabel} onClick={back}>
              <Glyph d={IC.back} />
            </Button>
          ) : null}
          {SECTION_DEF.map((s) => {
            const on = activeSection === s.key;
            const badge = sectionBadge(s.key);
            return (
              <Button
                unstyled
                key={s.key}
                type="button"
                className={`tr360-sec__item${on ? ' tr360-sec__item--on' : ''}`}
                title={s.label}
                aria-label={secOpen ? undefined : s.label}
                aria-current={on ? 'page' : undefined}
                onClick={() => go(s.key)}
              >
                <Glyph d={s.icon} />
                {secOpen ? <span className="tr360-sec__label">{s.label}</span> : null}
                {secOpen && badge !== '' ? <span className="tr360-badge tr360-tone--grey">{badge}</span> : null}
              </Button>
            );
          })}
        </nav>
      </aside>

      <main className="tr360-main">
        <div className="tr360-hd">
          <div className="tr360-crumbs">
            <Link to="/requisitions">Requisitions</Link>
            <span className="tr360-crumbs__sep">/</span>
            <Link to={`/requisitions/${reqId}`} className="tr360-mono">
              {reqCode}
            </Link>
            <span className="tr360-crumbs__sep">/</span>
            <span className="tr360-crumbs__here">{talentName}</span>
            {pos >= 0 ? (
              <span className="tr360-pos">
                <Button
                  unstyled
                  type="button"
                  className="tr360-pos__btn"
                  title="Previous talent in this pipeline"
                  aria-label="Previous talent in this pipeline"
                  disabled={pos <= 0}
                  onClick={() => goTalent(order[pos - 1])}
                >
                  <Glyph d="M18 15l-6-6-6 6" size={12} width={2.4} />
                </Button>
                <span className="tr360-pos__txt">
                  {pos + 1} of {order.length} in pipeline
                </span>
                <Button
                  unstyled
                  type="button"
                  className="tr360-pos__btn"
                  title="Next talent in this pipeline"
                  aria-label="Next talent in this pipeline"
                  disabled={pos >= order.length - 1}
                  onClick={() => goTalent(order[pos + 1])}
                >
                  <Glyph d="M6 9l6 6 6-6" size={12} width={2.4} />
                </Button>
              </span>
            ) : null}
          </div>

          <div className="tr360-title">
            <div className="tr360-title__main">
              <div className="tr360-title__row">
                <h1 className="tr360-h1">
                  {req?.title ?? ''} <span className="tr360-h1__req">({reqCode})</span>
                </h1>
                {req !== null ? (
                  <span className={`tr360-pill tr360-tone--${statusTone}`}>{RECRUITING_STATUS_LABELS[req.status]}</span>
                ) : null}
                {req?.is_hot === true ? <span className="tr360-pill tr360-tone--amber">Priority</span> : null}
              </div>
              <div className="tr360-meta">
                {req !== null && companyName !== null ? <Link to={`/companies/${req.company_id}`}>{companyName}</Link> : null}
                {placeLabel !== '' || arrangement !== null ? (
                  <span>{[placeLabel, arrangement].filter((s) => s !== null && s !== '').join(' · ')}</span>
                ) : null}
                {req?.compensation_model === 'CONTRACT' ? <span>Contract</span> : null}
                {req?.compensation_model === 'PERMANENT' ? <span>Permanent</span> : null}
                {pay !== null || bill !== null ? (
                  <span>{[pay !== null ? `pay ${pay}` : null, bill !== null ? `bill ${bill}` : null].filter(Boolean).join(' · ')}</span>
                ) : null}
                {start !== null ? <span>Start {start}</span> : null}
              </div>
            </div>
            <div className="tr360-actions">
              {primary !== null ? (
                <>
                  <Button
                    unstyled
                    type="button"
                    className="tr360-primary"
                    aria-disabled={!primary.enabled}
                    aria-describedby="tr360-primary-reason"
                    title={primary.tip}
                    data-testid="tr360-primary"
                    onClick={runPrimary}
                  >
                    {primary.label}
                    <Glyph d="M6 9l6 6 6-6" size={12} width={2.4} />
                  </Button>
                  <span id="tr360-primary-reason" hidden>
                    {primary.tip}
                  </span>
                </>
              ) : null}
              <Link to={`/talent/${talentId}`} className="tr360-t360" title="Open Talent 360 (this person across all requisitions)">
                Talent 360 ↗
              </Link>
              <span className="tr360-more">
                <Button
                  unstyled
                  type="button"
                  className="tr360-more__btn"
                  title="More"
                  aria-label="More"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen((o) => !o)}
                >
                  ···
                </Button>
                {moreOpen ? (
                  <>
                    <Button unstyled type="button" className="tr360-more__scrim" aria-hidden="true" tabIndex={-1} onClick={() => setMoreOpen(false)} />
                    <span className="tr360-more__pop" role="menu">
                      {canEditTalent ? (
                        <Link role="menuitem" className="tr360-more__item" to={`/talent/${talentId}/edit`}>
                          Edit talent details
                        </Link>
                      ) : null}
                      {canEditTalent && talent !== null ? (
                        <Button unstyled type="button" role="menuitem" className="tr360-more__item" onClick={toggleHot}>
                          {talent.is_hot ? 'Remove HOT' : 'Mark as HOT'}
                        </Button>
                      ) : null}
                      {voidAction !== undefined ? (
                        <>
                          <span className="tr360-more__div" />
                          <Button
                            unstyled
                            type="button"
                            role="menuitem"
                            className="tr360-more__item tr360-more__item--danger"
                            title={voidAction.command_route}
                            onClick={() => {
                              setMoreOpen(false);
                              setVoidError('');
                              setVoidOpen(true);
                            }}
                          >
                            {voidAction.label}
                          </Button>
                        </>
                      ) : null}
                      {!canEditTalent && voidAction === undefined ? (
                        <span className="tr360-more__item">No more actions</span>
                      ) : null}
                    </span>
                  </>
                ) : null}
              </span>
            </div>
          </div>
          {actionError !== null ? (
            <p className="tr360-empty" role="alert">
              {actionError}
            </p>
          ) : null}

          <div className="tr360-steps" role="list" aria-label="Stage">
            {STEPS.map((st, i) => {
              const state = stepState(i, current);
              return (
                <span key={st.key} className={`tr360-step tr360-step--${state}`} role="listitem">
                  <Button
                    unstyled
                    type="button"
                    className="tr360-step__btn"
                    title={`${st.label}${state === 'current' ? ' · current' : ''}`}
                    aria-current={state === 'current' ? 'step' : undefined}
                    onClick={() => go(st.key === 'qualifying' && state === 'current' ? 'overview' : `step:${st.key}`)}
                  >
                    <span className="tr360-step__dot">{state === 'done' ? '✓' : String(i + 1)}</span>
                    <span className="tr360-step__label">{st.label}</span>
                  </Button>
                  {i < STEPS.length - 1 ? <span className="tr360-step__line" aria-hidden="true" /> : null}
                </span>
              );
            })}
          </div>

          <div className="tr360-tabs" role="tablist">
            {TAB_DEF.map((t) => {
              const on = activeTab === t.key;
              return (
                <Button
                  unstyled
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  className={`tr360-tab${on ? ' tr360-tab--on' : ''}`}
                  onClick={() => go(t.key)}
                >
                  {t.label}
                </Button>
              );
            })}
          </div>
        </div>

        <div className="tr360-body">
          {notOnReq ? (
            <p className="tr360-empty" role="status">
              {talentName} is not in play on {reqCode}.
            </p>
          ) : null}
          {req === null ? <p className="tr360-empty">Loading…</p> : renderView()}
        </div>
      </main>

      {/* Dialogs — launched from the header / Overview; they are dialogs, not panels. */}
      {canSendEmail ? (
        <RequisitionContactEmailComposer
          open={composerOpen}
          onOpenChange={setComposerOpen}
          talentId={talentId}
          requisitionId={reqId}
          pipelineId={pipeline?.id}
          onSent={() => setReload((n) => n + 1)}
        />
      ) : null}
      {canSchedule && scheduleOpen ? (
        <ScheduleMeetingDialog
          open={scheduleOpen}
          onOpenChange={setScheduleOpen}
          talentId={talentId}
          talentName={talentName}
          talentEmail={talent?.email1 ?? undefined}
          requisitionId={reqId}
          requisitionReference={reqCode}
          requisitionTitle={req?.title}
          pipelineId={pipeline?.id}
          onDone={(m) => {
            setMeetingsReload((n) => n + 1);
            toast.show(
              m.idempotent_replay
                ? 'This meeting was already scheduled on your Outlook calendar.'
                : `Meeting scheduled · invitation sent to ${talentName} from your Outlook calendar`,
            );
          }}
        />
      ) : null}
      {responseOpen && pipeline !== null ? (
        <RecordTalentResponseModal
          open
          pipelineId={pipeline.id}
          talentName={talentName}
          reqCode={reqCode}
          onRecorded={() => {
            setResponseOpen(false);
            setReload((n) => n + 1);
          }}
          onClose={() => setResponseOpen(false)}
        />
      ) : null}
      {rtrOpen && req !== null ? (
        <SendRtrLauncher
          talentId={talentId}
          requisitionId={reqId}
          companyId={req.company_id}
          talentName={talentName}
          clientName={companyName}
          requisitionTitle={req.title}
          recipientEmail={talent?.email1 ?? null}
          onClose={() => setRtrOpen(false)}
          onSent={() => setReload((n) => n + 1)}
        />
      ) : null}
      {voidOpen ? (
        <RemoveFromRequisitionModal
          talentName={talentName}
          busy={voidBusy}
          error={voidError}
          onCancel={() => {
            if (!voidBusy) setVoidOpen(false);
          }}
          onConfirm={() => void confirmVoid()}
        />
      ) : null}
    </div>
  );
}
