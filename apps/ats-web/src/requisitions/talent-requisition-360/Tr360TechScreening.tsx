import { Button, Input, Select, TextArea } from '@aramo/fe-foundation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { getCalendarMeeting, type ScheduledMeetingView } from '../../microsoft/microsoft-api';
import {
  AiFindingReview,
  CaptureModes,
  RECORDING_LABEL,
  TranscriptPanel,
  provenanceLabel,
} from '../../technical-screening/ScreeningAssistPanels';
import {
  ConfirmDialog,
  FindingForm,
  VoidDialog,
  confirmableIds,
  publicationLabel,
} from '../../technical-screening/TechnicalScreeningView';
import {
  actionScreeningSuggestion,
  addScreeningFinding,
  addScreeningNote,
  addScreeningQuestion,
  checkScreeningTranscripts,
  confirmScreeningSession,
  createScreeningSession,
  editScreeningFinding,
  generateScreeningQuestions,
  getScreeningCaptureModes,
  getScreeningSession,
  listScreeningSessions,
  removeScreeningFinding,
  requestScreeningSuggestions,
  retryScreeningPublication,
  reviewScreeningFinding,
  scheduleScreeningMeeting,
  updateScreeningQuestion,
  voidScreeningSession,
  type ScreeningCaptureModes,
  type ScreeningCitation,
  type ScreeningFinding,
  type ScreeningFindingInput,
  type ScreeningQuestion,
  type ScreeningSession,
  type ScreeningSessionDetail,
  type ScreeningSuggestion,
  type ScreeningTranscriptCheckItem,
} from '../../technical-screening/technical-screening-api';
import { safeErrorMessage } from '../../ui';

import {
  AI_DRAFTED_LABEL,
  PHASE_PILL,
  QUESTION_STATUS_LABEL,
  SESSION_STATE_PILL,
  TR360_BASIS_LABEL,
  aiErrorKind,
  aiErrorMessage,
  formatMeetingDate,
  pickSession,
  planCoverage,
  planProvenance,
  planQuestions,
  questionMeta,
  questionTitle,
  scheduledTitle,
  screeningPhase,
  type Tr360ScreeningPhase,
} from './tr360-screening-model';

// Talent × Requisition 360 → Technical Screening (§5).
//
// Hosts the INC-3 screening flow as amended by ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED,
// on this page per A1 Note 1 (TR360 as a second host, scoped to this
// requisition). It uses ONLY the existing INC-3/A1 routes and scopes; every
// lifecycle rule (DRAFT-only edits, version CAS, consent, review-before-confirm,
// attestation, publication) is server-side. Production activation is NOT granted
// (A1 :474), so the tab stays behind `techScreening360` (default off).
//
// Governed replacements of the prototype (PO decision 2026-10-16): no rating,
// level or overall assessment — findings carry the closed basis set instead; the
// question status is Selected / Proposed; no live / in-progress / call-ended
// state (no attendance inference, A1 :337/:340); no attachments; no invented
// retention period; no client-facing summary; follow-ups come "from your plan and
// notes". Nothing here can change stage or ordering, qualify, reject or submit —
// "Mark qualified" stays the recruiter's header decision.

export interface Tr360TechScreeningProps {
  readonly enabled: boolean;
  readonly talentId: string;
  readonly reqId: string;
  readonly scopes: readonly string[];
  readonly talentFirstName: string;
  readonly reqCode: string;
  /** The requisition profile's must-have skills (critical + required). */
  readonly mustHaveSkills: readonly string[];
}

type Slot = { subject: string; start_date_time: string; end_date_time: string; time_zone: string };

const isConflict = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 409;

function emptyDetail(session: ScreeningSession): ScreeningSessionDetail {
  return {
    session, findings: [], publications: [], citations: [], questions: [], notes: [], suggestions: [],
    generations: [], transcripts: [], analyses: [],
  };
}

function CalendarGlyph(): JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h16v14H4zM8 3v4M16 3v4M4 10h16" />
    </svg>
  );
}

function EmptyState({
  enabled,
  talentFirstName,
  onPrepare,
  busy,
}: {
  enabled: boolean;
  talentFirstName: string;
  onPrepare?: () => void;
  busy?: boolean;
}): JSX.Element {
  return (
    <div className="tr360-ts__empty" data-testid="tr360-screening-empty">
      <div className="tr360-ts__empty-title">No technical screening yet</div>
      {enabled ? (
        <div className="tr360-ts__empty-body">
          Aramo will draft questions from the requisition, the client&apos;s must-haves and{' '}
          {talentFirstName}&apos;s resume; you review, edit, schedule on Teams and run the call.
        </div>
      ) : null}
      {onPrepare !== undefined ? (
        <Button unstyled type="button" className="tr360-btn tr360-btn--brand" disabled={busy} onClick={onPrepare}>
          {busy === true ? 'Preparing…' : 'Prepare screening'}
        </Button>
      ) : null}
    </div>
  );
}

export function Tr360TechScreening(props: Tr360TechScreeningProps): JSX.Element {
  const { enabled, talentId, reqId, scopes, talentFirstName, reqCode } = props;
  const canRead = scopes.includes('screening:read');
  const canCreate = scopes.includes('screening:create');
  const canEdit = scopes.includes('screening:edit');
  const canConfirm = scopes.includes('screening:confirm');
  const canSchedule = canEdit && scopes.includes('communication:meeting:create');
  const canReadMeetings = scopes.includes('communication:meeting:read');
  const canReadTranscript = scopes.includes('screening:transcript:read');
  const active = enabled && canRead && talentId !== '' && reqId !== '';

  const [load, setLoad] = useState<'loading' | 'error' | 'ready'>('loading');
  const [sessions, setSessions] = useState<ScreeningSession[]>([]);
  const [detail, setDetail] = useState<ScreeningSessionDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [consentFallback, setConsentFallback] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [meeting, setMeeting] = useState<ScheduledMeetingView | null>(null);
  const [joinFallback, setJoinFallback] = useState<string | null>(null);
  const [modes, setModes] = useState<ScreeningCaptureModes | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const reloadAll = useCallback(
    async (preferId?: string) => {
      setLoad('loading');
      try {
        const { items } = await listScreeningSessions(talentId);
        const targetId = preferId ?? pickSession(items, reqId)?.id ?? null;
        const next = targetId !== null ? await getScreeningSession(targetId) : null;
        if (!alive.current) return;
        setSessions(items);
        setDetail(next);
        setLoad('ready');
      } catch {
        if (alive.current) setLoad('error');
      }
    },
    [talentId, reqId],
  );

  useEffect(() => {
    if (active) void reloadAll();
  }, [active, reloadAll]);

  const sessionId = detail?.session.id ?? null;
  const interactionId = detail?.session.interaction_id ?? null;
  const phase: Tr360ScreeningPhase | null = detail !== null ? screeningPhase(detail.session) : null;

  // Scheduled: the time and join link come from the calendar-meeting read.
  useEffect(() => {
    setMeeting(null);
    if (!active || interactionId === null || !canReadMeetings) return undefined;
    let cancelled = false;
    getCalendarMeeting(interactionId)
      .then((m) => !cancelled && setMeeting(m))
      .catch(() => !cancelled && setMeeting(null));
    return () => {
      cancelled = true;
    };
  }, [active, interactionId, canReadMeetings]);

  // Scheduled: the honest recording request state (a request, never proof).
  useEffect(() => {
    setModes(null);
    if (!active || sessionId === null || phase !== 'scheduled') return undefined;
    let cancelled = false;
    getScreeningCaptureModes(sessionId)
      .then((m) => !cancelled && setModes(m))
      .catch(() => !cancelled && setModes(null));
    return () => {
      cancelled = true;
    };
  }, [active, sessionId, phase]);

  const adopt = (next: ScreeningSessionDetail): void => {
    setDetail(next);
    setSessions((cur) => cur.map((s) => (s.id === next.session.id ? next.session : s)));
  };

  const showError = (e: unknown, failure: string): void => {
    const kind = aiErrorKind(e);
    if (kind !== null) {
      setNotice(aiErrorMessage(kind, talentFirstName));
      setConsentFallback(kind === 'consent');
    } else {
      setNotice(safeErrorMessage(e, failure));
    }
  };

  // Run a mutation; adopt the returned detail; on 409 reload.
  const mutate = async (op: () => Promise<ScreeningSessionDetail>, failure: string): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    setConsentFallback(false);
    try {
      adopt(await op());
      return true;
    } catch (e) {
      if (isConflict(e) && sessionId !== null) {
        setNotice('This screening changed since you opened it. It has been reloaded.');
        try {
          adopt(await getScreeningSession(sessionId));
        } catch {
          /* the notice already tells the recruiter */
        }
      } else {
        showError(e, failure);
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const mutateWith = async <T,>(op: () => Promise<T & { session: ScreeningSessionDetail }>, failure: string): Promise<T | null> => {
    let result: (T & { session: ScreeningSessionDetail }) | null = null;
    const ok = await mutate(async () => {
      result = await op();
      return result.session;
    }, failure);
    return ok ? result : null;
  };

  // Prepare = create a session for THIS requisition, then draft the plan.
  const prepare = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    setConsentFallback(false);
    setHistoryOpen(false);
    setScheduling(false);
    let created: ScreeningSession;
    try {
      created = await createScreeningSession(talentId, reqId);
    } catch (e) {
      setNotice(safeErrorMessage(e, 'We couldn’t start a screening.'));
      setBusy(false);
      return;
    }
    setSessions((cur) => [created, ...cur]);
    setDetail(emptyDetail(created));
    if (canEdit) {
      try {
        adopt(await generateScreeningQuestions(created.id, true));
      } catch (e) {
        showError(e, 'We couldn’t draft questions.');
      }
    }
    setBusy(false);
  };

  const openSession = async (id: string): Promise<void> => {
    setHistoryOpen(false);
    setScheduling(false);
    setNotice(null);
    try {
      setDetail(await getScreeningSession(id));
    } catch (e) {
      setNotice(safeErrorMessage(e, 'We couldn’t load this screening.'));
    }
  };

  if (!enabled) {
    return (
      <div className="tr360-card tr360-ts" data-testid="tr360-screening">
        <EmptyState enabled={false} talentFirstName={talentFirstName} />
      </div>
    );
  }

  const hasDraft = detail !== null && detail.session.state === 'DRAFT';

  return (
    <div className="tr360-card tr360-ts" data-testid="tr360-screening">
      <div className="tr360-ts__hd">
        <span className="tr360-ts__hdtext">
          <span className="tr360-ts__title">Technical Screening</span>
          <span className="tr360-ts__sub">
            Run and record a structured technical conversation with {talentFirstName} for {reqCode}.
            Aramo drafts; you decide.
          </span>
        </span>
        {canRead ? (
          <span className="tr360-ts__btns">
            {/* "View guidelines" is hidden: no guideline content is defined anywhere yet. */}
            <Button
              unstyled
              type="button"
              className="tr360-btn"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((o) => !o)}
            >
              Screening history
            </Button>
            {canCreate ? (
              <Button
                unstyled
                type="button"
                className="tr360-btn tr360-btn--brand"
                disabled={hasDraft || busy || load !== 'ready'}
                style={{ opacity: hasDraft ? 0.5 : 1 }}
                onClick={() => void prepare()}
              >
                + New screening
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>

      {!canRead ? (
        <div className="tr360-ts__empty" data-testid="tr360-screening-noaccess">
          <div className="tr360-ts__empty-body">You don’t have access to technical screening.</div>
        </div>
      ) : (
        <>
          {historyOpen && load === 'ready' ? (
            <ScreeningHistory
              sessions={sessions}
              reqId={reqId}
              reqCode={reqCode}
              talentId={talentId}
              currentId={sessionId}
              onOpen={(id) => void openSession(id)}
            />
          ) : null}

          {notice !== null ? (
            <div className="tr360-ts__notice" role="alert">
              <span>{notice}</span>
              {consentFallback && hasDraft && canEdit && detail !== null ? (
                <Button
                  unstyled
                  type="button"
                  className="tr360-btn tr360-btn--xs"
                  disabled={busy}
                  onClick={() =>
                    void mutate(() => generateScreeningQuestions(detail.session.id, false), 'We couldn’t draft questions.')
                  }
                >
                  Draft from the requisition only
                </Button>
              ) : null}
            </div>
          ) : null}

          {load === 'loading' ? (
            <div className="tr360-ts__empty">
              <div className="tr360-ts__empty-body">Loading technical screening…</div>
            </div>
          ) : load === 'error' ? (
            <div className="tr360-ts__empty">
              <div className="tr360-ts__empty-body">Technical screening couldn’t be loaded.</div>
              <Button unstyled type="button" className="tr360-btn" onClick={() => void reloadAll()}>
                Try again
              </Button>
            </div>
          ) : detail === null || phase === null ? (
            <EmptyState
              enabled
              talentFirstName={talentFirstName}
              busy={busy}
              onPrepare={canCreate ? () => void prepare() : undefined}
            />
          ) : scheduling ? (
            <ScheduleCard
              detail={detail}
              busy={busy}
              canSchedule={canSchedule}
              talentFirstName={talentFirstName}
              reqCode={reqCode}
              onBack={() => setScheduling(false)}
              onSchedule={async (slot) => {
                const r = await mutateWith<{ meeting: { join_url: string | null } }>(
                  () => scheduleScreeningMeeting(detail.session.id, slot),
                  'We couldn’t schedule the Teams meeting.',
                );
                if (r !== null) {
                  setJoinFallback(r.meeting.join_url);
                  setScheduling(false);
                }
              }}
            />
          ) : (
            <SessionView
              key={detail.session.id}
              detail={detail}
              phase={phase}
              busy={busy}
              canEdit={canEdit}
              canConfirm={canConfirm}
              canSchedule={canSchedule}
              canReadTranscript={canReadTranscript}
              talentFirstName={talentFirstName}
              reqCode={reqCode}
              mustHaveSkills={props.mustHaveSkills}
              meeting={meeting}
              joinUrl={meeting?.join_url ?? joinFallback}
              recording={modes?.recording.status ?? null}
              onScheduleOpen={() => setScheduling(true)}
              mutate={mutate}
              onCheckTranscripts={async () => {
                const r = await mutateWith<{ items: ScreeningTranscriptCheckItem[] }>(
                  () => checkScreeningTranscripts(detail.session.id),
                  'We couldn’t retrieve the Teams transcript.',
                );
                return r === null ? null : r.items;
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

// ── Screening history: this requisition, plus sessions without one ──────────
function ScreeningHistory({
  sessions,
  reqId,
  reqCode,
  talentId,
  currentId,
  onOpen,
}: {
  sessions: readonly ScreeningSession[];
  reqId: string;
  reqCode: string;
  talentId: string;
  currentId: string | null;
  onOpen: (id: string) => void;
}): JSX.Element {
  const byNewest = (a: ScreeningSession, b: ScreeningSession): number => b.created_at.localeCompare(a.created_at);
  const mine = sessions.filter((s) => s.requisition_id === reqId).sort(byNewest);
  const unscoped = sessions.filter((s) => s.requisition_id === null).sort(byNewest);
  const row = (s: ScreeningSession, action: JSX.Element): JSX.Element => {
    const pill = SESSION_STATE_PILL[s.state];
    return (
      <div key={s.id} className="tr360-ts__hrow" data-testid="tr360-screening-history-row">
        <span className="tr360-ts__hdate">
          {formatMeetingDate(s.created_at)}
          {s.state === 'CONFIRMED' && s.confirmed_at !== null ? ` · confirmed ${formatMeetingDate(s.confirmed_at)}` : ''}
        </span>
        <span className={`tr360-ts__status tr360-tone--${pill.tone}`}>{pill.label}</span>
        {action}
      </div>
    );
  };
  return (
    <div className="tr360-ts__history" data-testid="tr360-screening-history">
      <div className="tr360-ts__label">On {reqCode}</div>
      {mine.length === 0 ? (
        <div className="tr360-ts__muted">No screenings on {reqCode} yet.</div>
      ) : (
        mine.map((s) =>
          row(
            s,
            s.id === currentId ? (
              <span className="tr360-ts__muted">Showing</span>
            ) : (
              <Button unstyled type="button" className="tr360-btn tr360-btn--xs" onClick={() => onOpen(s.id)}>
                Open
              </Button>
            ),
          ),
        )
      )}
      {unscoped.length > 0 ? (
        <>
          <div className="tr360-ts__label tr360-ts__label--gap">Without a requisition</div>
          {unscoped.map((s) =>
            row(
              s,
              <Link className="tr360-btn tr360-btn--xs" to={`/talent/${talentId}/screening`}>
                Open in workspace ↗
              </Link>,
            ),
          )}
        </>
      ) : null}
    </div>
  );
}

// ── Schedule on Teams (prototype vSchedule, governed) ───────────────────────
// No recording checkbox (recording is decided by existing consent at schedule
// time) and no retention line (A1 :69, :394).
function tomorrowIso(): string {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ScheduleCard({
  detail,
  busy,
  canSchedule,
  talentFirstName,
  reqCode,
  onBack,
  onSchedule,
}: {
  detail: ScreeningSessionDetail;
  busy: boolean;
  canSchedule: boolean;
  talentFirstName: string;
  reqCode: string;
  onBack: () => void;
  onSchedule: (slot: Slot) => Promise<void>;
}): JSX.Element {
  const [date, setDate] = useState(tomorrowIso);
  const [time, setTime] = useState('10:00');
  const [minutes, setMinutes] = useState('45');
  const start = new Date(`${date}T${time}`);
  const valid = canSchedule && date !== '' && time !== '' && !Number.isNaN(start.getTime());
  return (
    <div className="tr360-ts__sched" data-testid="tr360-screening-schedule">
      <div className="tr360-ts__schedtitle">Schedule technical screening</div>
      <div className="tr360-ts__schedsub">
        Microsoft Teams · created on your Outlook calendar as you · {talentFirstName} gets the invitation from your
        account when contact consent allows.
      </div>
      <div className="tr360-ts__schedgrid">
        <label className="tr360-ts__schedfield">
          Date
          <Input unstyled className="tr360-ts__schedinput" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
        </label>
        <label className="tr360-ts__schedfield">
          Time · duration
          <span className="tr360-ts__schedrow">
            <Input unstyled className="tr360-ts__schedinput" type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
            <Select unstyled className="tr360-ts__schedsel" value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="Duration">
              <option value="45">45 min</option>
              <option value="30">30 min</option>
              <option value="60">60 min</option>
            </Select>
          </span>
        </label>
      </div>
      <div className="tr360-ts__label tr360-ts__label--gap">Capture on this call</div>
      <CaptureModes sessionId={detail.session.id} refreshKey={`${detail.session.version}`} />
      {!canSchedule ? (
        <div className="tr360-ts__muted">You don’t have permission to schedule Teams meetings.</div>
      ) : null}
      <div className="tr360-ts__schedbtns">
        <Button unstyled type="button" className="tr360-btn" onClick={onBack}>
          Back
        </Button>
        <Button
          unstyled
          type="button"
          className="tr360-btn tr360-btn--brand"
          disabled={!valid || busy}
          onClick={() => {
            if (!valid) return;
            const end = new Date(start.getTime() + Number(minutes) * 60_000);
            void onSchedule({
              subject: `Technical screening · ${reqCode}`,
              start_date_time: start.toISOString(),
              end_date_time: end.toISOString(),
              time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            });
          }}
        >
          Schedule &amp; send invitation
        </Button>
      </div>
    </div>
  );
}

// ── The session: banner + question list + current question + rail ──────────
interface SessionViewProps {
  readonly detail: ScreeningSessionDetail;
  readonly phase: Tr360ScreeningPhase;
  readonly busy: boolean;
  readonly canEdit: boolean;
  readonly canConfirm: boolean;
  readonly canSchedule: boolean;
  readonly canReadTranscript: boolean;
  readonly talentFirstName: string;
  readonly reqCode: string;
  readonly mustHaveSkills: readonly string[];
  readonly meeting: ScheduledMeetingView | null;
  readonly joinUrl: string | null;
  readonly recording: ScreeningCaptureModes['recording']['status'] | null;
  readonly onScheduleOpen: () => void;
  readonly mutate: (op: () => Promise<ScreeningSessionDetail>, failure: string) => Promise<boolean>;
  readonly onCheckTranscripts: () => Promise<ScreeningTranscriptCheckItem[] | null>;
}

const RECORDING_PILL: Record<ScreeningCaptureModes['recording']['status'], string | null> = {
  not_applicable: null,
  requested: 'Recording requested',
  not_requested: 'Recording not requested',
};

function SessionView(props: SessionViewProps): JSX.Element {
  const { detail, phase, busy, canEdit, talentFirstName, reqCode, mutate } = props;
  const { session } = detail;
  const id = session.id;
  const draft = session.state === 'DRAFT';
  const isPrepared = phase === 'prepared';
  const questions = planQuestions(detail);
  const qCount = questions.length;
  const [cur, setCur] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [newQ, setNewQ] = useState('');
  const [newSkill, setNewSkill] = useState('');
  const idx = Math.min(cur, Math.max(0, qCount - 1));
  const q: ScreeningQuestion | undefined = questions[idx];
  const pill = PHASE_PILL[phase];
  const lastPlan = [...detail.generations].reverse().find((g) => g.kind === 'QUESTION_PLAN');
  const coverage = planCoverage(props.mustHaveSkills, detail.questions);

  const title =
    phase === 'prepared'
      ? qCount > 0
        ? `Screening prepared · ${qCount} question${qCount === 1 ? '' : 's'}`
        : 'Screening prepared · no questions yet'
      : phase === 'scheduled'
        ? scheduledTitle(props.meeting)
        : phase === 'complete'
          ? 'Screening complete'
          : 'Screening voided';
  const confirmedCount = detail.findings.filter((f) => f.review_status !== 'REJECTED').length;
  const sub =
    phase === 'prepared'
      ? planProvenance(detail, reqCode, talentFirstName)
      : phase === 'scheduled'
        ? props.meeting?.status === 'cancelled'
          ? 'The Outlook meeting for this screening was cancelled.'
          : `On your Outlook calendar · the invitation follows ${talentFirstName}’s contact consent`
        : phase === 'complete'
          ? `${session.confirmed_at !== null ? `Confirmed ${formatMeetingDate(session.confirmed_at)} · ` : ''}${confirmedCount} finding${
              confirmedCount === 1 ? '' : 's'
            } recorded as recruiter-attested evidence`
          : (session.void_reason ?? 'Kept for history; it can’t be edited or confirmed.');
  const recLabel = phase === 'scheduled' && props.recording !== null ? RECORDING_PILL[props.recording] : null;
  const joinable = phase === 'scheduled' && props.joinUrl !== null && props.meeting?.status !== 'cancelled';

  return (
    <>
      <div className="tr360-ts__banner" data-testid="tr360-screening-banner">
        <span className="tr360-ts__tile">
          <CalendarGlyph />
        </span>
        <span className="tr360-ts__btext">
          <span className="tr360-ts__btitle">{title}</span>
          <span className="tr360-ts__bsub">{sub}</span>
        </span>
        <span className="tr360-ts__bstate">
          <span className={`tr360-ts__status tr360-tone--${pill.tone}`}>{pill.label}</span>
          {recLabel !== null && props.recording !== null ? (
            <span className="tr360-ts__rec" title={RECORDING_LABEL[props.recording].text}>
              <span className="tr360-ts__recdot" aria-hidden="true" />
              {recLabel}
            </span>
          ) : null}
          {isPrepared && props.canSchedule ? (
            <Button unstyled type="button" className="tr360-btn tr360-btn--brand tr360-btn--xs" onClick={props.onScheduleOpen}>
              Schedule on Teams
            </Button>
          ) : null}
          {joinable && props.joinUrl !== null ? (
            <a className="tr360-btn tr360-btn--teams tr360-btn--xs" href={props.joinUrl} target="_blank" rel="noreferrer">
              Join Teams call
            </a>
          ) : null}
        </span>
      </div>

      <div className="tr360-ts__panes">
        <div className="tr360-ts__qlist">
          {questions.length === 0 ? <div className="tr360-ts__muted">No questions yet.</div> : null}
          {questions.map((x, i) => {
            const on = i === idx;
            return (
              <Button
                unstyled
                key={x.id}
                type="button"
                className={`tr360-ts__q${on ? ' tr360-ts__q--on' : ''}`}
                onClick={() => {
                  setCur(i);
                  setEditing(false);
                }}
              >
                <span className="tr360-ts__qdot">{String(i + 1)}</span>
                <span className="tr360-ts__qtext">
                  <span className="tr360-ts__qskill">{questionTitle(x)}</span>
                  <span className="tr360-ts__qmeta">{questionMeta(x)}</span>
                </span>
              </Button>
            );
          })}
          {isPrepared && canEdit ? (
            <form
              className="tr360-ts__addform"
              aria-label="Add your own question"
              onSubmit={async (e) => {
                e.preventDefault();
                if (newQ.trim() === '') return;
                if (await mutate(() => addScreeningQuestion(id, newQ.trim(), newSkill), 'We couldn’t add the question.')) {
                  setNewQ('');
                  setNewSkill('');
                }
              }}
            >
              <span className="tr360-ts__add">
                <Input unstyled className="tr360-ts__addq" value={newQ} onChange={(e) => setNewQ(e.target.value)} placeholder="Add your own question…" aria-label="Your question" maxLength={1000} />
                <Button unstyled type="submit" className="tr360-btn" disabled={busy || newQ.trim() === ''}>
                  Add
                </Button>
              </span>
              <Input unstyled className="tr360-ts__addq tr360-ts__addskill" value={newSkill} onChange={(e) => setNewSkill(e.target.value)} placeholder="Skill it covers (optional)" aria-label="Skill it covers" maxLength={200} />
            </form>
          ) : null}
        </div>

        <div className="tr360-ts__cur">
          {q !== undefined ? (
            <>
              <div className="tr360-ts__curhd">
                <span className="tr360-ts__curtext">
                  <span className="tr360-ts__curskill">
                    {idx + 1}. {questionTitle(q)}
                  </span>
                </span>
                <span className="tr360-ts__nav">
                  <Button unstyled type="button" className="tr360-btn" disabled={idx === 0} onClick={() => { setCur(Math.max(0, idx - 1)); setEditing(false); }}>
                    ‹ Previous
                  </Button>
                  <Button unstyled type="button" className="tr360-btn" disabled={idx >= qCount - 1} onClick={() => { setCur(Math.min(qCount - 1, idx + 1)); setEditing(false); }}>
                    Next ›
                  </Button>
                </span>
              </div>
              <div className="tr360-ts__qbox">
                <div className="tr360-ts__qboxhd">
                  <span className="tr360-ts__label tr360-ts__label--brand">QUESTION</span>
                  <span className={`tr360-ts__src tr360-tone--${q.origin === 'AI_GENERATED' ? 'blue' : 'grey'}`}>
                    {q.origin === 'AI_GENERATED' ? AI_DRAFTED_LABEL : 'Your question'}
                  </span>
                  {q.edited ? <span className="tr360-ts__src tr360-tone--grey">Edited by you</span> : null}
                  {isPrepared && canEdit ? (
                    <Button
                      unstyled
                      type="button"
                      className="tr360-ts__edit"
                      disabled={busy}
                      onClick={async () => {
                        if (!editing) {
                          setEditText(q.text);
                          setEditing(true);
                          return;
                        }
                        const text = editText.trim();
                        if (text === '' || text === q.text) {
                          setEditing(false);
                          return;
                        }
                        if (await mutate(() => updateScreeningQuestion(id, q.id, { text }), 'We couldn’t update the question.')) {
                          setEditing(false);
                        }
                      }}
                    >
                      {editing ? 'Done' : 'Edit'}
                    </Button>
                  ) : null}
                </div>
                {editing ? (
                  <TextArea unstyled className="tr360-ts__qedit" rows={3} value={editText} onChange={(e) => setEditText(e.target.value)} aria-label="Question text" maxLength={1000} />
                ) : (
                  <div className="tr360-ts__qread">{q.text}</div>
                )}
              </div>
            </>
          ) : (
            <div className="tr360-ts__muted">
              {isPrepared ? 'Re-draft suggestions or add your own question to build the plan.' : 'This screening has no questions.'}
            </div>
          )}

          {isPrepared && canEdit ? (
            <div className="tr360-ts__prep">
              {q !== undefined ? (
                <>
                  <Button
                    unstyled
                    type="button"
                    aria-pressed={q.status === 'SELECTED'}
                    className={`tr360-btn ${q.status === 'SELECTED' ? 'tr360-ts__must--on' : 'tr360-ts__must--off'}`}
                    disabled={busy}
                    title={q.status === 'SELECTED' ? 'Selected for your plan · click to set back to proposed' : 'Proposed · click to select for your plan'}
                    onClick={() =>
                      void mutate(
                        () => updateScreeningQuestion(id, q.id, { status: q.status === 'SELECTED' ? 'PROPOSED' : 'SELECTED' }),
                        'We couldn’t update the question.',
                      )
                    }
                  >
                    {QUESTION_STATUS_LABEL[q.status]}
                  </Button>
                  <Button
                    unstyled
                    type="button"
                    className="tr360-btn tr360-btn--danger-text"
                    disabled={busy}
                    onClick={async () => {
                      if (await mutate(() => updateScreeningQuestion(id, q.id, { status: 'REMOVED' }), 'We couldn’t remove the question.')) {
                        setCur((c) => Math.max(0, c - 1));
                        setEditing(false);
                      }
                    }}
                  >
                    Remove
                  </Button>
                </>
              ) : null}
              <Button
                unstyled
                type="button"
                className="tr360-btn tr360-ts__regen"
                disabled={busy}
                onClick={() =>
                  void mutate(
                    () => generateScreeningQuestions(id, lastPlan?.used_talent_profile ?? true),
                    'We couldn’t draft questions.',
                  )
                }
              >
                {busy ? 'Drafting…' : 'Re-draft suggestions'}
              </Button>
            </div>
          ) : null}

          {isPrepared ? (
            <div className="tr360-ts__cov" data-testid="tr360-screening-coverage">
              <div className="tr360-ts__label tr360-ts__label--upper" style={{ marginBottom: 8 }}>
                Question-plan coverage of must-have skills
              </div>
              {coverage.length === 0 ? (
                <div className="tr360-ts__muted">This requisition’s profile lists no must-have skills.</div>
              ) : (
                coverage.map((c) => (
                  <div key={c.skill} className="tr360-ts__covrow">
                    <span>{c.skill}</span>
                    <span className="tr360-ts__covbar">
                      <span
                        className="tr360-ts__covfill"
                        style={{ width: `${Math.min(100, c.count * 50)}%`, background: c.count > 0 ? '#022AC0' : '#C0410C' }}
                      />
                    </span>
                    <span className="tr360-ts__covn">
                      {c.count > 0 ? `${c.count} question${c.count > 1 ? 's' : ''}` : 'none'}
                    </span>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>

        <div className="tr360-ts__rail">
          <NotesBox {...props} />
          {phase === 'scheduled' ? (
            <div className="tr360-ts__box tr360-ts__box--embed">
              <TranscriptPanel
                detail={detail}
                busy={busy}
                canCheck={canEdit && props.canReadTranscript}
                onCheck={props.onCheckTranscripts}
              />
            </div>
          ) : null}
          <OutcomeBox {...props} draft={draft} />
        </div>
      </div>
    </>
  );
}

// ── Session notes + follow-up suggestions "from your plan and notes" ────────
function NotesBox(props: SessionViewProps): JSX.Element {
  const { detail, busy, canEdit, mutate } = props;
  const id = detail.session.id;
  const draft = detail.session.state === 'DRAFT';
  const [note, setNote] = useState('');
  const pending = detail.suggestions.filter((s) => s.action === null);
  const suggestedFor = new Set(
    detail.suggestions
      .map((s) => (s.trigger_kind === 'NOTE' ? (s.trigger_ref as { note_id?: string } | null)?.note_id : undefined))
      .filter((x): x is string => x !== undefined),
  );

  const askNext = async (s: ScreeningSuggestion): Promise<void> => {
    if (await mutate(() => actionScreeningSuggestion(id, s.id, 'USED'), 'We couldn’t record that.')) {
      await mutate(() => addScreeningQuestion(id, s.text), 'We couldn’t add the question.');
    }
  };

  return (
    <>
      <div className="tr360-ts__box" data-testid="tr360-screening-notes">
        <div className="tr360-ts__boxhd">
          <span className="tr360-ts__boxtitle">
            Session notes <span>· recruiter-attested</span>
          </span>
        </div>
        {draft && canEdit ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (note.trim() !== '' && (await mutate(() => addScreeningNote(id, note.trim()), 'We couldn’t save the note.'))) {
                setNote('');
              }
            }}
          >
            <TextArea
              unstyled
              className="tr360-ts__summary"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 4000))}
              aria-label="Session note"
              placeholder={`What ${props.talentFirstName} said, in your words.`}
            />
            <div className="tr360-ts__notefoot">
              <span className="tr360-ts__counter">{note.length}/4000</span>
              <Button unstyled type="submit" className="tr360-btn tr360-btn--xs" disabled={busy || note.trim() === ''}>
                Add note
              </Button>
            </div>
          </form>
        ) : null}
        {detail.notes.length === 0 ? (
          <div className="tr360-ts__muted">No notes yet.</div>
        ) : (
          detail.notes.map((n) => (
            <div key={n.id} className="tr360-ts__note">
              <div className="tr360-ts__sgtext">{n.body}</div>
              {draft && canEdit && !suggestedFor.has(n.id) ? (
                <Button
                  unstyled
                  type="button"
                  className="tr360-ts__toggle"
                  disabled={busy}
                  onClick={() => void mutate(() => requestScreeningSuggestions(id, n.id), 'We couldn’t get follow-up suggestions.')}
                >
                  Suggest follow-ups
                </Button>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div className="tr360-ts__box" data-testid="tr360-screening-followups">
        <div className="tr360-ts__boxhd" style={{ marginBottom: 6 }}>
          <span className="tr360-ts__boxtitle">Suggested follow-ups</span>
          <span className="tr360-ts__assist">Assist</span>
        </div>
        <div className="tr360-ts__muted">Suggestions from your plan and notes. Advisory only — never findings.</div>
        {pending.map((sg) => (
          <div key={sg.id} className="tr360-ts__sg">
            <div className="tr360-ts__sgtext">{sg.text}</div>
            {draft && canEdit ? (
              <div className="tr360-ts__sgbtns">
                <Button unstyled type="button" className="tr360-btn tr360-btn--brand" disabled={busy} onClick={() => void askNext(sg)}>
                  Ask next
                </Button>
                <Button
                  unstyled
                  type="button"
                  className="tr360-btn"
                  disabled={busy}
                  onClick={() => void mutate(() => actionScreeningSuggestion(id, sg.id, 'DISMISSED'), 'We couldn’t record that.')}
                >
                  Dismiss
                </Button>
              </div>
            ) : null}
          </div>
        ))}
        {pending.length === 0 ? (
          <div className="tr360-ts__muted tr360-ts__muted--rule">
            {draft ? 'Add a note, then ask for follow-ups.' : 'No open follow-ups.'}
          </div>
        ) : null}
      </div>
    </>
  );
}

// ── Final outcome: recruiter-attested findings (replaces level + summary) ───
function OutcomeBox(props: SessionViewProps & { draft: boolean }): JSX.Element {
  const { detail, busy, canEdit, canConfirm, mutate, draft } = props;
  const { session, findings, publications } = detail;
  const id = session.id;
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const byFinding = new Map(publications.map((p) => [p.finding_id, p]));
  const citationsBy = new Map<string, ScreeningCitation[]>();
  for (const c of detail.citations) citationsBy.set(c.finding_id, [...(citationsBy.get(c.finding_id) ?? []), c]);
  const pendingReview = findings.filter((f) => f.origin === 'AI_DRAFTED' && f.review_status === 'DRAFT').length;
  const confirmable = confirmableIds(findings);
  const hasPendingPublication = publications.some((p) => p.state === 'PENDING');
  const completeDisabled = !canConfirm || busy || confirmable.length === 0 || pendingReview > 0;

  const save = (fn: () => Promise<ScreeningSessionDetail>, failure: string) => async (): Promise<void> => {
    if (await mutate(fn, failure)) setEditing(null);
  };

  return (
    <div className="tr360-ts__box tr360-ts__box--final" data-testid="tr360-screening-outcome">
      <div className="tr360-ts__boxtitle" style={{ marginBottom: 8 }}>
        Final outcome <span>· findings you attest</span>
      </div>
      {pendingReview > 0 && draft ? (
        <div className="tr360-ts__muted" role="status">
          {pendingReview} AI-drafted finding{pendingReview === 1 ? '' : 's'} await your review.
        </div>
      ) : null}
      {findings.length === 0 && editing !== 'new' ? (
        <div className="tr360-ts__muted">{draft ? 'No findings yet.' : 'This screening has no findings.'}</div>
      ) : null}
      {findings.map((f) =>
        editing === f.id ? (
          <FindingForm
            key={f.id}
            initial={f}
            busy={busy}
            basisLabels={TR360_BASIS_LABEL}
            onCancel={() => setEditing(null)}
            onSave={(input: ScreeningFindingInput) =>
              save(() => editScreeningFinding(id, f.id, session.version, input), 'We couldn’t save the finding.')()
            }
          />
        ) : (
          <div key={f.id} className={`tr360-ts__finding${f.review_status === 'REJECTED' ? ' tr360-ts__finding--rejected' : ''}`} data-testid="tr360-screening-finding">
            <FindingRow finding={f} publication={byFinding.get(f.id)} />
            {f.origin === 'AI_DRAFTED' ? (
              <AiFindingReview
                sessionId={id}
                finding={f}
                citations={citationsBy.get(f.id) ?? []}
                busy={busy}
                canEdit={canEdit}
                canReadTranscript={props.canReadTranscript}
                draft={draft}
                onAccept={() => void mutate(() => reviewScreeningFinding(id, f.id, session.version, 'CONFIRMED'), 'We couldn’t record your review.')}
                onReject={() => void mutate(() => reviewScreeningFinding(id, f.id, session.version, 'REJECTED'), 'We couldn’t record your review.')}
                onEdit={() => setEditing(f.id)}
              />
            ) : draft && canEdit ? (
              <div className="tr360-ts__sgbtns">
                <Button unstyled type="button" className="tr360-btn" disabled={busy} onClick={() => setEditing(f.id)}>
                  Edit
                </Button>
                <Button
                  unstyled
                  type="button"
                  className="tr360-btn tr360-btn--danger-text"
                  disabled={busy}
                  onClick={() => void mutate(() => removeScreeningFinding(id, f.id, session.version), 'We couldn’t remove the finding.')}
                >
                  Remove
                </Button>
              </div>
            ) : null}
          </div>
        ),
      )}
      {editing === 'new' ? (
        <FindingForm
          busy={busy}
          basisLabels={TR360_BASIS_LABEL}
          onCancel={() => setEditing(null)}
          onSave={(input: ScreeningFindingInput) =>
            save(() => addScreeningFinding(id, session.version, input), 'We couldn’t add the finding.')()
          }
        />
      ) : null}
      {draft && canEdit && editing === null ? (
        <Button unstyled type="button" className="tr360-btn tr360-btn--xs tr360-ts__addfinding" disabled={busy} onClick={() => setEditing('new')}>
          + Add finding
        </Button>
      ) : null}

      {draft ? (
        <div className="tr360-ts__save">
          <Button
            unstyled
            type="button"
            className="tr360-btn tr360-btn--brand"
            disabled={completeDisabled}
            style={{ opacity: completeDisabled ? 0.55 : 1 }}
            onClick={() => setConfirmOpen(true)}
          >
            Complete screening
          </Button>
          {canEdit ? (
            <Button unstyled type="button" className="tr360-btn tr360-btn--danger-text" title="Void this screening" disabled={busy} onClick={() => setVoidOpen(true)}>
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}
      {session.state === 'CONFIRMED' && hasPendingPublication && canConfirm ? (
        <div className="tr360-ts__save">
          <Button unstyled type="button" className="tr360-btn" disabled={busy} onClick={() => void mutate(() => retryScreeningPublication(id), 'Publishing failed again. Try later.')}>
            Retry publishing
          </Button>
        </div>
      ) : null}
      <div className="tr360-ts__foot">
        Saved as recruiter-attested findings. Aramo never qualifies, rejects or ranks — &quot;Mark qualified&quot; in
        the header stays your decision.
      </div>

      {confirmOpen ? (
        <ConfirmDialog
          findings={findings.filter((f) => f.review_status !== 'REJECTED')}
          version={session.version}
          busy={busy}
          basisLabels={TR360_BASIS_LABEL}
          onClose={() => setConfirmOpen(false)}
          onConfirm={async () => {
            if (await mutate(() => confirmScreeningSession(id, session.version, confirmable), 'We couldn’t confirm this screening.')) {
              setConfirmOpen(false);
            }
          }}
        />
      ) : null}
      {voidOpen ? (
        <VoidDialog
          busy={busy}
          onClose={() => setVoidOpen(false)}
          onVoid={async (reason) => {
            if (await mutate(() => voidScreeningSession(id, session.version, reason), 'We couldn’t void this screening.')) {
              setVoidOpen(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function FindingRow({ finding: f, publication }: { finding: ScreeningFinding; publication?: Parameters<typeof publicationLabel>[0] }): JSX.Element {
  const pub = publication !== undefined ? publicationLabel(publication) : null;
  const pubTone = pub === null ? null : pub.tone === 'ok' ? 'green' : pub.tone === 'danger' ? 'red' : pub.tone === 'warn' ? 'amber' : 'blue';
  return (
    <>
      <div className="tr360-ts__fhead">
        <b>{f.skill_raw}</b>
        {pub !== null ? <span className={`tr360-ts__src tr360-tone--${pubTone}`}>{pub.text}</span> : null}
      </div>
      <div className="tr360-ts__fbasis">{TR360_BASIS_LABEL[f.basis]}</div>
      <div className="tr360-ts__fprov">{provenanceLabel(f)}</div>
      <div className="tr360-ts__sgtext">{f.observation_raw}</div>
      {f.demonstration_raw !== null ? (
        <div className="tr360-ts__fextra">
          <span>Observed activity: </span>
          {f.demonstration_raw}
        </div>
      ) : null}
      {f.limitations_raw !== null ? (
        <div className="tr360-ts__fextra">
          <span>Not covered: </span>
          {f.limitations_raw}
        </div>
      ) : null}
    </>
  );
}
