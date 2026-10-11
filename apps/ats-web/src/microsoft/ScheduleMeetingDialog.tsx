import { Button, Dialog, InlineAlert, Input, Select } from '@aramo/fe-foundation';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { describeCalendarMeetingError } from './calendar-meeting-errors';
import { composeInstants, durationMinutesBetween, instantToZonedWallClock } from './calendar-meeting-tz';
import {
  getCalendarMeeting as defaultGet,
  rescheduleCalendarMeeting as defaultReschedule,
  scheduleCalendarMeeting as defaultSchedule,
  type RescheduleCalendarMeetingInput,
  type ScheduleCalendarMeetingInput,
  type ScheduledMeetingView,
} from './microsoft-api';

// M365-SCHED-1 PR 1B — recruiter Outlook/Teams scheduling dialog (COMM-C2B
// Amendment A1), reconciled to design/aramo-Prototype `Requisitions CRM.dc.html`.
// Create + reschedule in one surface, with an explicit REVIEW-BEFORE-SEND step:
// opening the dialog never transmits; invitations go out only on the review's confirm.
//
// FIX_NOW-1/2: wall-clock date/time is converted through the selected IANA zone into
// an unambiguous OFFSET-BEARING ISO-8601 instant (never a bare local string), DST
// gaps/overlaps are surfaced (not silently resolved), and reschedule initializes the
// displayed date/time in the selected zone. FIX_NOW-3: a version conflict refreshes
// authoritative state and requires a fresh review+confirm (never a stale re-submit).

const PURPOSES = [
  { value: 'Recruiter screen', disabled: false },
  { value: 'Qualification call', disabled: false },
  { value: 'Client interview', disabled: true },
  { value: 'Follow-up', disabled: false },
] as const;

const BASE_ZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Toronto', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
];

function resolvedZone(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof z === 'string' && z.length > 0 ? z : 'UTC';
  } catch {
    return 'UTC';
  }
}

function newIdempotencyKey(): string {
  const rand = globalThis.crypto?.randomUUID?.() ?? String(Math.floor(performance.now()));
  return `sched-${rand}`;
}

function seedFromView(v: ScheduledMeetingView, zone: string): { date: string; time: string; duration: number } {
  if (v.scheduled_start === null) return { date: '', time: '', duration: 30 };
  const { date, time } = instantToZonedWallClock(v.scheduled_start, zone);
  let duration = 30;
  if (v.scheduled_end !== null) {
    const diff = durationMinutesBetween(v.scheduled_start, v.scheduled_end);
    if (diff === 45 || diff === 60) duration = diff;
  }
  return { date, time, duration };
}

export interface ScheduleMeetingDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly talentId: string;
  readonly talentName?: string;
  readonly requisitionId: string;
  readonly pipelineId?: string;
  readonly editing?: ScheduledMeetingView | null;
  readonly scheduleFn?: (input: ScheduleCalendarMeetingInput) => Promise<ScheduledMeetingView>;
  readonly rescheduleFn?: (id: string, input: RescheduleCalendarMeetingInput) => Promise<ScheduledMeetingView>;
  readonly getFn?: (id: string) => Promise<ScheduledMeetingView>;
  readonly onDone: (view: ScheduledMeetingView) => void;
}

export function ScheduleMeetingDialog(props: ScheduleMeetingDialogProps): JSX.Element {
  const scheduleFn = props.scheduleFn ?? defaultSchedule;
  const rescheduleFn = props.rescheduleFn ?? defaultReschedule;
  const getFn = props.getFn ?? defaultGet;
  const isEdit = (props.editing ?? null) !== null;

  const initialZone = useMemo(() => resolvedZone(), []);
  const zones = useMemo(
    () => (BASE_ZONES.includes(initialZone) ? BASE_ZONES : [initialZone, ...BASE_ZONES]),
    [initialZone],
  );
  const seed = useMemo(
    () => (props.editing != null ? seedFromView(props.editing, initialZone) : { date: '', time: '', duration: 30 }),
    [props.editing, initialZone],
  );

  // Authoritative meeting state for an edit; refreshed in place on a version conflict.
  const [current, setCurrent] = useState<ScheduledMeetingView | null>(props.editing ?? null);
  const [purpose, setPurpose] = useState('Recruiter screen');
  const [date, setDate] = useState(seed.date);
  const [time, setTime] = useState(seed.time);
  const [duration, setDuration] = useState(seed.duration);
  const [timeZone, setTimeZone] = useState(initialZone);
  const [subject, setSubject] = useState('Recruiter screen');
  const [phase, setPhase] = useState<'form' | 'review'>('form');
  const [submitting, setSubmitting] = useState(false);
  const [errState, setErrState] = useState<ReturnType<typeof describeCalendarMeetingError> | null>(null);
  const [refreshedNotice, setRefreshedNotice] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);

  const composed = useMemo(
    () => (date.length > 0 && time.length > 0 ? composeInstants(date, time, duration, timeZone) : null),
    [date, time, duration, timeZone],
  );
  const startIso = composed?.startIso ?? '';
  const endIso = composed?.endIso ?? '';
  const dstProblem = composed?.problem ?? 'none';

  const idempotencyKey = useMemo(
    () => newIdempotencyKey(),
    // stable per unchanged intent; changes when any identity-bearing field changes
    [props.talentId, props.requisitionId, subject, startIso, endIso, timeZone],
  );

  const formValid =
    date.length > 0 && time.length > 0 && subject.trim().length > 0 && timeZone.length > 0 && dstProblem === 'none';

  const dstMessage =
    dstProblem === 'nonexistent'
      ? `That time does not exist in ${timeZone} because of a daylight-saving change. Pick another time.`
      : dstProblem === 'ambiguous'
        ? `That time occurs twice in ${timeZone} because of a daylight-saving change. Pick a time at least an hour away.`
        : null;

  const goReview = (): void => {
    setErrState(null);
    setRefreshFailed(false);
    if (formValid) setPhase('review');
  };

  const confirm = (): void => {
    setSubmitting(true);
    setErrState(null);
    setRefreshedNotice(false);
    const done = (view: ScheduledMeetingView): void => {
      setSubmitting(false);
      props.onDone(view);
      props.onOpenChange(false);
    };
    const fail = (err: unknown): void => {
      setSubmitting(false);
      const desc = describeCalendarMeetingError(err);
      // FIX_NOW-3 — a version conflict must NOT be re-submitted with the stale
      // expected_version. Refresh authoritative state, then require a fresh
      // review+confirm. If the refresh itself fails, keep an explicit error.
      if (isEdit && current !== null && desc.code === 'MICROSOFT_MEETING_VERSION_CONFLICT') {
        setErrState(desc);
        getFn(current.interaction_id)
          .then((fresh) => {
            setCurrent(fresh);
            const w = fresh.scheduled_start !== null ? instantToZonedWallClock(fresh.scheduled_start, timeZone) : { date: '', time: '' };
            setDate(w.date);
            setTime(w.time);
            if (fresh.scheduled_start !== null && fresh.scheduled_end !== null) {
              const d = durationMinutesBetween(fresh.scheduled_start, fresh.scheduled_end);
              if (d === 30 || d === 45 || d === 60) setDuration(d);
            }
            setErrState(null);
            setRefreshedNotice(true);
            setRefreshFailed(false);
            setPhase('form'); // force a fresh review + confirm against the refreshed version
          })
          .catch((refreshErr) => {
            setRefreshFailed(true);
            setErrState(describeCalendarMeetingError(refreshErr));
          });
        return;
      }
      setErrState(desc);
    };
    if (isEdit && current !== null) {
      rescheduleFn(current.interaction_id, {
        connection_id: undefined,
        expected_version: current.version,
        start_date_time: startIso,
        end_date_time: endIso,
        time_zone: timeZone,
      }).then(done).catch(fail);
    } else {
      scheduleFn({
        talent_record_id: props.talentId,
        requisition_id: props.requisitionId,
        pipeline_id: props.pipelineId,
        subject: subject.trim(),
        start_date_time: startIso,
        end_date_time: endIso,
        time_zone: timeZone,
        idempotency_key: idempotencyKey,
      }).then(done).catch(fail);
    }
  };

  const title = isEdit ? 'Reschedule meeting' : 'Schedule meeting';
  const primaryLabel = submitting ? (isEdit ? 'Updating…' : 'Creating…') : (isEdit ? 'Update & resend invitation' : 'Schedule & send invitation');
  const recipient = props.talentName ?? 'this Talent';
  // No blind retry: the send affordance is hidden whenever the last outcome is not
  // safely retryable (unresolved / in-progress / idempotency / a failed refresh).
  const showConfirm = !refreshFailed && (errState === null || errState.retryable);

  const footer =
    phase === 'form' ? (
      <>
        <Button unstyled className="rc-link-action" onClick={() => props.onOpenChange(false)}>Cancel</Button>
        <Button data-testid="schedule-review" onClick={goReview} disabled={!formValid}>Review</Button>
      </>
    ) : (
      <>
        <Button unstyled className="rc-link-action" onClick={() => setPhase('form')} disabled={submitting}>Back</Button>
        {showConfirm && (
          <Button data-testid="schedule-confirm" onClick={confirm} disabled={submitting}>{primaryLabel}</Button>
        )}
      </>
    );

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} title={title} size="md" footer={footer}>
      {refreshedNotice && (
        <p data-testid="schedule-refreshed-notice" className="rc-sched-refreshed" role="status">
          This meeting was updated elsewhere — the latest details are loaded below. Review and confirm again.
        </p>
      )}
      {phase === 'form' ? (
        <div className="rc-sched-form" data-testid="schedule-form">
          <label>
            Purpose
            <Select
              data-testid="schedule-purpose"
              value={purpose}
              onChange={(e) => {
                setPurpose(e.target.value);
                if (subject.trim().length === 0) setSubject(e.target.value);
              }}
            >
              {PURPOSES.map((p) => (
                <option key={p.value} value={p.value} disabled={p.disabled}>
                  {p.value}{p.disabled ? ' (scheduled from the interview workflow)' : ''}
                </option>
              ))}
            </Select>
          </label>
          <label>
            Date
            <Input type="date" data-testid="schedule-date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            Time
            <Input type="time" data-testid="schedule-time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <label>
            Duration
            <Select data-testid="schedule-duration" value={String(duration)} onChange={(e) => setDuration(Number.parseInt(e.target.value, 10))}>
              <option value="30">30 min</option>
              <option value="45">45 min</option>
              <option value="60">60 min</option>
            </Select>
          </label>
          <label>
            Time zone
            <Select data-testid="schedule-timezone" value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>{z}{z === initialZone ? ' · your timezone' : ''}</option>
              ))}
            </Select>
          </label>
          <label>
            Subject
            <Input type="text" data-testid="schedule-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          {dstMessage !== null && (
            <div data-testid="schedule-dst-error"><InlineAlert variant="error">{dstMessage}</InlineAlert></div>
          )}
          <p className="rc-sched-provenance">
            <b>Microsoft Teams</b> · created on your Outlook calendar as you. Everyone listed gets the
            calendar invitation from your account the moment you confirm.
          </p>
        </div>
      ) : (
        <div className="rc-sched-review" data-testid="schedule-review-summary">
          <p>Review before sending — confirming sends an Outlook calendar <b>invitation</b> to {recipient}.</p>
          <dl>
            <dt>Recipient</dt><dd>{recipient}</dd>
            <dt>Subject</dt><dd>{subject}</dd>
            <dt>Starts</dt><dd>{startIso}</dd>
            <dt>Ends</dt><dd>{endIso}</dd>
            <dt>Time zone</dt><dd>{timeZone}</dd>
          </dl>
          {errState !== null && (
            <div data-testid="schedule-error">
              <InlineAlert variant="error">{errState.message}</InlineAlert>
              {errState.needsReconnect && (
                <Link to="/settings/me" data-testid="schedule-reconnect-link">Reconnect your Microsoft account →</Link>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
