import {
  Button,
  Checkbox,
  hasScope,
  InlineAlert,
  Input,
  Select,
  TextArea,
  useSession,
} from '@aramo/fe-foundation';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { createMicrosoftMeeting } from '../microsoft/microsoft-api';
import { safeErrorMessage } from '../ui';
import {
  fetchAssignableUsers,
  resolveUserNames,
  type AssignableUser,
} from '../users/users-api';

import {
  dayHeading,
  INTERVIEW_STATE_LABEL,
  timeLabel,
} from './interview-format';
import {
  addInterviewFeedback,
  associateInterviewMeeting,
  getInterviewSession,
  isTransitionConflict,
  listInterviewFeedback,
  scheduleInterview,
  transitionInterview,
  updateInterviewInterviewers,
  type InterviewFeedbackNote,
  type InterviewSessionDetail,
  type InterviewSessionState,
} from './interviews-api';

// The authoritative interview DETAIL + lifecycle interactions (Calendar/Interview §7/§8/
// §11/§12). A READ of GET /v1/client-selection/interview-sessions/:id plus the versioned
// write actions (reschedule / cancel / complete / no-show via the transition command, and
// schedule-another-round via the schedule command). The backend state machine is
// authoritative — the FE only renders permissible actions and echoes the version; a stale
// version surfaces the "someone changed this interview" refresh prompt, never an overwrite.

const TERMINAL: ReadonlySet<InterviewSessionState> = new Set([
  'COMPLETED',
  'CANCELED',
  'NO_SHOW',
]);

const CONFLICT_MESSAGE =
  'Someone changed this interview. Refresh the interview and try again.';

type Mode = 'view' | 'reschedule' | 'schedule' | 'panel';

function toIsoOrUndefined(local: string): string | undefined {
  if (local.length === 0) return undefined;
  const t = Date.parse(local);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

export function InterviewDetailView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [detail, setDetail] = useState<InterviewSessionDetail | null>(null);
  const [interviewerNames, setInterviewerNames] = useState<
    Record<string, string>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>('view');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  // Reschedule form.
  const [rStart, setRStart] = useState('');
  const [rEnd, setREnd] = useState('');
  const [rTz, setRTz] = useState('');

  // Schedule-another-round form.
  const [sType, setSType] = useState('onsite');
  const [sStart, setSStart] = useState('');
  const [sEnd, setSEnd] = useState('');
  const [sTz, setSTz] = useState('');
  const [roster, setRoster] = useState<readonly AssignableUser[]>([]);
  const [selectedInterviewers, setSelectedInterviewers] = useState<
    readonly string[]
  >([]);

  // Feedback (qualitative, via the activity substrate) + panel-edit selection.
  const [feedback, setFeedback] = useState<readonly InterviewFeedbackNote[]>([]);
  const [feedbackText, setFeedbackText] = useState('');
  const [panelSelected, setPanelSelected] = useState<readonly string[]>([]);

  // Authorization-hidden actions (Calendar/Interview §29 / Slice D): the FE renders only
  // the actions the principal is scoped for. The backend remains the enforcement floor.
  const sessionState = useSession();
  const session =
    sessionState.status === 'authenticated' ? sessionState.session : null;
  const canWrite =
    session !== null && hasScope(session, 'client-selection:interview:transition');
  const canSchedule =
    session !== null && hasScope(session, 'client-selection:interview:schedule');
  const canCreateMeeting =
    session !== null && hasScope(session, 'communication:meeting:create');
  const canAddFeedback = session !== null && hasScope(session, 'activity:create');

  const load = useCallback(() => {
    if (sessionId === undefined) return;
    setLoading(true);
    setError(null);
    setConflict(false);
    getInterviewSession(sessionId)
      .then(async (v) => {
        setDetail(v);
        const [names, fb] = await Promise.all([
          v.interviewer_user_ids.length > 0
            ? resolveUserNames(v.interviewer_user_ids)
            : Promise.resolve<Record<string, string>>({}),
          listInterviewFeedback(v.id),
        ]);
        setInterviewerNames(names);
        setFeedback(fb);
      })
      .catch((e) => setError(safeErrorMessage(e, 'Could not load this interview.')))
      .finally(() => setLoading(false));
  }, [sessionId]);
  useEffect(() => load(), [load]);

  const runTransition = useCallback(
    async (
      to_state: InterviewSessionState,
      extra: { scheduled_at?: string; scheduled_end_at?: string; timezone?: string } = {},
    ) => {
      if (detail === null) return;
      setBusy(true);
      setActionError(null);
      setConflict(false);
      try {
        const updated = await transitionInterview(detail.id, {
          to_state,
          expected_version: detail.version,
          ...extra,
        });
        setDetail(updated);
        setMode('view');
      } catch (e) {
        if (isTransitionConflict(e)) setConflict(true);
        else setActionError(safeErrorMessage(e, 'Could not update the interview.'));
      } finally {
        setBusy(false);
      }
    },
    [detail],
  );

  const openScheduleAnother = useCallback(() => {
    setMode('schedule');
    setActionError(null);
    if (roster.length === 0) {
      fetchAssignableUsers()
        .then((r) => setRoster(r))
        .catch(() => setRoster([]));
    }
  }, [roster.length]);

  const submitReschedule = useCallback(() => {
    const startIso = toIsoOrUndefined(rStart);
    if (startIso === undefined) {
      setActionError('A new start date/time is required to reschedule.');
      return;
    }
    void runTransition('RESCHEDULED', {
      scheduled_at: startIso,
      ...(toIsoOrUndefined(rEnd) === undefined
        ? {}
        : { scheduled_end_at: toIsoOrUndefined(rEnd) }),
      ...(rTz.length === 0 ? {} : { timezone: rTz }),
    });
  }, [rStart, rEnd, rTz, runTransition]);

  const submitScheduleAnother = useCallback(async () => {
    if (detail === null) return;
    const startIso = toIsoOrUndefined(sStart);
    if (startIso === undefined) {
      setActionError('A start date/time is required to schedule an interview.');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const created = await scheduleInterview(detail.client_selection_process_id, {
        interview_type: sType,
        round: detail.round + 1,
        scheduled_at: startIso,
        ...(toIsoOrUndefined(sEnd) === undefined
          ? {}
          : { scheduled_end_at: toIsoOrUndefined(sEnd) }),
        ...(sTz.length === 0 ? {} : { timezone: sTz }),
        ...(selectedInterviewers.length === 0
          ? {}
          : { interviewer_user_ids: selectedInterviewers }),
      });
      // Navigate to the newly-scheduled interview.
      window.location.assign(`/interviews/${created.id}`);
    } catch (e) {
      setActionError(safeErrorMessage(e, 'Could not schedule the interview.'));
    } finally {
      setBusy(false);
    }
  }, [detail, sType, sStart, sEnd, sTz, selectedInterviewers]);

  const submitFeedback = useCallback(async () => {
    if (detail === null || feedbackText.trim().length === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      await addInterviewFeedback(detail.id, feedbackText.trim());
      setFeedback(await listInterviewFeedback(detail.id));
      setFeedbackText('');
    } catch (e) {
      setActionError(safeErrorMessage(e, 'Could not add feedback.'));
    } finally {
      setBusy(false);
    }
  }, [detail, feedbackText]);

  const openPanelEdit = useCallback(() => {
    if (detail === null) return;
    setMode('panel');
    setActionError(null);
    setPanelSelected(detail.interviewer_user_ids);
    if (roster.length === 0) {
      fetchAssignableUsers()
        .then((r) => setRoster(r))
        .catch(() => setRoster([]));
    }
  }, [detail, roster.length]);

  const submitPanel = useCallback(async () => {
    if (detail === null) return;
    setBusy(true);
    setActionError(null);
    setConflict(false);
    try {
      const updated = await updateInterviewInterviewers(detail.id, {
        expected_version: detail.version,
        interviewer_user_ids: panelSelected,
      });
      setDetail(updated);
      setInterviewerNames(
        updated.interviewer_user_ids.length > 0
          ? await resolveUserNames(updated.interviewer_user_ids)
          : {},
      );
      setMode('view');
    } catch (e) {
      if (isTransitionConflict(e)) setConflict(true);
      else setActionError(safeErrorMessage(e, 'Could not update the panel.'));
    } finally {
      setBusy(false);
    }
  }, [detail, panelSelected]);

  // Slice D (§14) — thin Communications wiring: create a Teams meeting via the EXISTING
  // Microsoft capability, then associate the resulting interaction to the interview.
  // Failure semantics: a create failure leaves the interview UNCHANGED (no association
  // attempted); an association CAS conflict surfaces refresh/retry (never a silent
  // overwrite), and the created meeting still exists as evidence in Communications.
  const createAndAssociateMeeting = useCallback(async () => {
    if (detail === null) return;
    setBusy(true);
    setActionError(null);
    setConflict(false);
    try {
      const endIso =
        detail.scheduled_end_at ??
        new Date(Date.parse(detail.scheduled_at) + 60 * 60 * 1000).toISOString();
      const meeting = await createMicrosoftMeeting({
        talent_record_id: detail.talent_record_id,
        requisition_id: detail.requisition_id,
        subject: `Interview · Round ${detail.round}`,
        start_date_time: detail.scheduled_at,
        end_date_time: endIso,
        idempotency_key: crypto.randomUUID(),
      });
      try {
        const updated = await associateInterviewMeeting(detail.id, {
          expected_version: detail.version,
          meeting_interaction_id: meeting.interaction_id,
        });
        setDetail(updated);
      } catch (assocErr) {
        if (isTransitionConflict(assocErr)) setConflict(true);
        else
          setActionError(
            safeErrorMessage(
              assocErr,
              'Meeting created, but linking it to the interview failed. Refresh and retry.',
            ),
          );
      }
    } catch {
      // Meeting creation failed → the interview is unchanged (no association attempted).
      setActionError('Meeting link not created.');
    } finally {
      setBusy(false);
    }
  }, [detail]);

  if (loading && detail === null) {
    return <p className="rc-muted-line">Loading interview…</p>;
  }
  if (error !== null && detail === null) {
    return (
      <InlineAlert variant="error">
        {error}{' '}
        <Button unstyled className="rc-link-action" onClick={load}>
          Retry
        </Button>
      </InlineAlert>
    );
  }
  if (detail === null) return null;

  const isTerminal = TERMINAL.has(detail.state);

  return (
    <section className="rc-page">
      <header className="rc-page-head">
        <p className="rc-muted-line">
          <Link to="/interviews" className="rc-link-action">
            ← Interviews
          </Link>
        </p>
        <h1>Interview · Round {detail.round}</h1>
        <p className="rc-muted-line">
          {dayHeading(detail.scheduled_at)} at {timeLabel(detail.scheduled_at)}
          {detail.scheduled_end_at !== null
            ? ` – ${timeLabel(detail.scheduled_end_at)}`
            : ''}
          {detail.timezone !== null ? ` (${detail.timezone})` : ''} ·{' '}
          <span
            className={`rc-interview-state rc-state-${detail.state.toLowerCase()}`}
          >
            {INTERVIEW_STATE_LABEL[detail.state]}
          </span>
        </p>
      </header>

      {conflict ? (
        <InlineAlert variant="error">
          {CONFLICT_MESSAGE}{' '}
          <Button unstyled className="rc-link-action" onClick={load}>
            Refresh
          </Button>
        </InlineAlert>
      ) : null}
      {actionError !== null ? (
        <InlineAlert variant="error">{actionError}</InlineAlert>
      ) : null}

      {/* Derived recruiter attention (Calendar/Interview §23/§24) — computed from the
          current state / meeting / feedback; it clears automatically when the condition
          clears. Advisory, not an error, and NOT a persisted Task. */}
      {!isTerminal && detail.meeting_interaction_id === null ? (
        <p className="rc-attention" role="status">
          Meeting link not added.
        </p>
      ) : null}
      {detail.state === 'COMPLETED' && feedback.length === 0 ? (
        <p className="rc-attention" role="status">
          Interview completed · Feedback not yet added.
        </p>
      ) : null}

      <dl className="rc-detail-grid">
        <dt>Type</dt>
        <dd>{detail.interview_type}</dd>
        <dt>Talent</dt>
        <dd>
          <Link to={`/talent/${detail.talent_record_id}`} className="rc-link-action">
            View Talent
          </Link>
        </dd>
        <dt>Requisition</dt>
        <dd>
          <Link
            to={`/requisitions/${detail.requisition_id}`}
            className="rc-link-action"
          >
            View requisition
          </Link>
        </dd>
        <dt>Interviewers</dt>
        <dd>
          {detail.interviewer_user_ids.length === 0
            ? 'None assigned'
            : detail.interviewer_user_ids
                .map((id) => interviewerNames[id] ?? id)
                .join(', ')}
        </dd>
        <dt>Meeting</dt>
        <dd>
          {detail.meeting_interaction_id === null
            ? 'No meeting link'
            : 'Teams meeting linked'}
        </dd>
      </dl>

      <div className="rc-interview-actions">
        {!isTerminal && mode === 'view' && canWrite ? (
          <>
            <Button onClick={() => setMode('reschedule')} disabled={busy}>
              Reschedule
            </Button>
            <Button onClick={() => void runTransition('COMPLETED')} disabled={busy}>
              Complete
            </Button>
            <Button onClick={() => void runTransition('CANCELED')} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void runTransition('NO_SHOW')} disabled={busy}>
              No-show
            </Button>
            <Button onClick={openPanelEdit} disabled={busy}>
              Edit panel
            </Button>
          </>
        ) : null}
        {!isTerminal &&
        mode === 'view' &&
        detail.meeting_interaction_id === null &&
        canCreateMeeting ? (
          <Button onClick={() => void createAndAssociateMeeting()} disabled={busy}>
            Create Teams meeting
          </Button>
        ) : null}
        {mode === 'view' && canSchedule ? (
          <Button
            unstyled
            className="rc-link-action"
            onClick={openScheduleAnother}
            disabled={busy}
          >
            Schedule another round
          </Button>
        ) : null}
      </div>

      {mode === 'reschedule' ? (
        <div className="rc-interview-form" aria-label="Reschedule interview">
          <h2>Reschedule</h2>
          <label>
            New start
            <Input
              type="datetime-local"
              value={rStart}
              onChange={(e) => setRStart(e.target.value)}
            />
          </label>
          <label>
            New end (optional)
            <Input
              type="datetime-local"
              value={rEnd}
              onChange={(e) => setREnd(e.target.value)}
            />
          </label>
          <label>
            Time zone (optional, IANA)
            <Input
              type="text"
              value={rTz}
              placeholder="America/New_York"
              onChange={(e) => setRTz(e.target.value)}
            />
          </label>
          <div className="rc-interview-actions">
            <Button onClick={submitReschedule} disabled={busy}>
              Save new time
            </Button>
            <Button unstyled className="rc-link-action" onClick={() => setMode('view')} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {mode === 'schedule' ? (
        <div className="rc-interview-form" aria-label="Schedule another round">
          <h2>Schedule round {detail.round + 1}</h2>
          <label>
            Type
            <Select value={sType} onChange={(e) => setSType(e.target.value)}>
              <option value="phone">Phone</option>
              <option value="video">Video</option>
              <option value="onsite">Onsite</option>
            </Select>
          </label>
          <label>
            Start
            <Input
              type="datetime-local"
              value={sStart}
              onChange={(e) => setSStart(e.target.value)}
            />
          </label>
          <label>
            End (optional)
            <Input
              type="datetime-local"
              value={sEnd}
              onChange={(e) => setSEnd(e.target.value)}
            />
          </label>
          <label>
            Time zone (optional, IANA)
            <Input
              type="text"
              value={sTz}
              placeholder="America/New_York"
              onChange={(e) => setSTz(e.target.value)}
            />
          </label>
          <fieldset className="rc-interview-panel">
            <legend>Interviewers</legend>
            {roster.length === 0 ? (
              <p className="rc-muted-line">No assignable users available.</p>
            ) : (
              roster.map((u) => (
                <label key={u.user_id} className="rc-interview-panel__opt">
                  <Checkbox
                    checked={selectedInterviewers.includes(u.user_id)}
                    onChange={(e) =>
                      setSelectedInterviewers((prev) =>
                        e.target.checked
                          ? [...prev, u.user_id]
                          : prev.filter((id) => id !== u.user_id),
                      )
                    }
                  />
                  {u.display_name ?? u.user_id}
                </label>
              ))
            )}
          </fieldset>
          <div className="rc-interview-actions">
            <Button onClick={() => void submitScheduleAnother()} disabled={busy}>
              Schedule interview
            </Button>
            <Button unstyled className="rc-link-action" onClick={() => setMode('view')} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {mode === 'panel' ? (
        <div className="rc-interview-form" aria-label="Edit interviewer panel">
          <h2>Edit interviewer panel</h2>
          <fieldset className="rc-interview-panel">
            <legend>Interviewers</legend>
            {roster.length === 0 ? (
              <p className="rc-muted-line">No assignable users available.</p>
            ) : (
              roster.map((u) => (
                <label key={u.user_id} className="rc-interview-panel__opt">
                  <Checkbox
                    checked={panelSelected.includes(u.user_id)}
                    onChange={(e) =>
                      setPanelSelected((prev) =>
                        e.target.checked
                          ? [...prev, u.user_id]
                          : prev.filter((id) => id !== u.user_id),
                      )
                    }
                  />
                  {u.display_name ?? u.user_id}
                </label>
              ))
            )}
          </fieldset>
          <div className="rc-interview-actions">
            <Button onClick={() => void submitPanel()} disabled={busy}>
              Save panel
            </Button>
            <Button unstyled className="rc-link-action" onClick={() => setMode('view')} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {mode === 'view' ? (
        <div className="rc-interview-feedback" aria-label="Interview feedback">
          <h2>Feedback</h2>
          {feedback.length === 0 ? (
            <p className="rc-muted-line">No feedback recorded yet.</p>
          ) : (
            <ul className="rc-feedback-list">
              {feedback.map((f) => (
                <li key={f.id} className="rc-feedback-item">
                  <p className="rc-feedback-body">
                    {f.redacted_at !== null ? '(redacted)' : f.notes}
                  </p>
                  <p className="rc-muted-line">
                    {new Date(f.created_at).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {canAddFeedback ? (
            <>
              <label>
                Add feedback
                <TextArea
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                  rows={3}
                />
              </label>
              <div className="rc-interview-actions">
                <Button
                  onClick={() => void submitFeedback()}
                  disabled={busy || feedbackText.trim().length === 0}
                >
                  Add feedback
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
