import { Button, Dialog, InlineAlert, Input, Select } from '@aramo/fe-foundation';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { describeCalendarMeetingError } from './calendar-meeting-errors';
import {
  rescheduleCalendarMeeting as defaultReschedule,
  scheduleCalendarMeeting as defaultSchedule,
  type RescheduleCalendarMeetingInput,
  type ScheduleCalendarMeetingInput,
  type ScheduledMeetingView,
} from './microsoft-api';

// M365-SCHED-1 PR 1B — recruiter Outlook/Teams scheduling dialog (COMM-C2B
// Amendment A1), reconciled to design/aramo-Prototype `Requisitions CRM.dc.html`.
// Create + reschedule in one surface, with an explicit REVIEW-BEFORE-SEND step:
// opening the dialog never transmits; invitations go out only on the review's
// confirm. Timezone is a VALIDATED IANA selection (no authoritative calendar zone
// is exposed by any backend contract — Architect timezone-authority guard), never
// free text. "Client interview" is intentionally disabled here: client interviews
// live in the InterviewSession workflow (G-3), not Communications scheduling.

// Meeting purposes that map to a Communications meeting. "Client interview" is shown
// but disabled — it belongs to the InterviewSession lifecycle (submittal-gated).
const PURPOSES = [
  { value: 'Recruiter screen', disabled: false },
  { value: 'Qualification call', disabled: false },
  { value: 'Client interview', disabled: true },
  { value: 'Follow-up', disabled: false },
] as const;

// A curated set of common IANA zones; the viewer's resolved zone is the default and
// is prepended if not already present, so the select always has a concrete value.
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

/** Wall-clock local datetime string (ISO-8601 without offset) from date + time. */
function composeStart(date: string, time: string): string {
  return `${date}T${time}:00`;
}

/** start + durationMinutes, same local wall clock, as an ISO-8601 (no offset) string. */
function composeEnd(date: string, time: string, durationMinutes: number): string {
  const [h, m] = time.split(':').map((n) => Number.parseInt(n, 10));
  const base = new Date(Date.UTC(2000, 0, 1, Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0));
  base.setUTCMinutes(base.getUTCMinutes() + durationMinutes);
  const hh = String(base.getUTCHours()).padStart(2, '0');
  const mm = String(base.getUTCMinutes()).padStart(2, '0');
  // Duration ≤ 60min never rolls the date for the supported options; keep the date.
  return `${date}T${hh}:${mm}:00`;
}

function deriveFromView(v: ScheduledMeetingView): { date: string; time: string; duration: number } {
  if (v.scheduled_start === null) return { date: '', time: '', duration: 30 };
  const start = new Date(v.scheduled_start);
  const date = start.toISOString().slice(0, 10);
  const time = start.toISOString().slice(11, 16);
  let duration = 30;
  if (v.scheduled_end !== null) {
    const diff = Math.round((new Date(v.scheduled_end).getTime() - start.getTime()) / 60000);
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
  readonly requisitionReference?: string;
  /** When present, the dialog is in RESCHEDULE mode for this meeting. */
  readonly editing?: ScheduledMeetingView | null;
  readonly scheduleFn?: (input: ScheduleCalendarMeetingInput) => Promise<ScheduledMeetingView>;
  readonly rescheduleFn?: (id: string, input: RescheduleCalendarMeetingInput) => Promise<ScheduledMeetingView>;
  readonly onDone: (view: ScheduledMeetingView) => void;
}

export function ScheduleMeetingDialog(props: ScheduleMeetingDialogProps): JSX.Element {
  const scheduleFn = props.scheduleFn ?? defaultSchedule;
  const rescheduleFn = props.rescheduleFn ?? defaultReschedule;
  const editing = props.editing ?? null;
  const isEdit = editing !== null;

  const seed = useMemo(
    () => (editing !== null ? deriveFromView(editing) : { date: '', time: '', duration: 30 }),
    [editing],
  );
  const zones = useMemo(() => {
    const def = resolvedZone();
    return BASE_ZONES.includes(def) ? BASE_ZONES : [def, ...BASE_ZONES];
  }, []);

  const [purpose, setPurpose] = useState<string>('Recruiter screen');
  const [date, setDate] = useState(seed.date);
  const [time, setTime] = useState(seed.time);
  const [duration, setDuration] = useState(seed.duration);
  const [timeZone, setTimeZone] = useState(resolvedZone());
  const [subject, setSubject] = useState(editing === null ? 'Recruiter screen' : 'Recruiter screen');
  const [phase, setPhase] = useState<'form' | 'review'>('form');
  const [submitting, setSubmitting] = useState(false);
  const [errState, setErrState] = useState<ReturnType<typeof describeCalendarMeetingError> | null>(null);

  const startIso = date.length > 0 && time.length > 0 ? composeStart(date, time) : '';
  const endIso = date.length > 0 && time.length > 0 ? composeEnd(date, time, duration) : '';

  // Idempotency: one stable key per unchanged scheduling intent. Recomputed only when
  // a field in the fingerprint changes → a genuinely new intent gets a new key, while
  // retries of an unchanged request reuse it ("confirming twice never creates two").
  const fingerprint = [props.talentId, props.requisitionId, subject, startIso, endIso, timeZone].join('|');
  const idempotencyKey = useMemo(() => newIdempotencyKey(), [fingerprint]);

  const formValid = date.length > 0 && time.length > 0 && subject.trim().length > 0 && timeZone.length > 0;

  const goReview = (): void => {
    setErrState(null);
    if (formValid) setPhase('review');
  };

  const confirm = (): void => {
    setSubmitting(true);
    setErrState(null);
    const done = (view: ScheduledMeetingView): void => {
      setSubmitting(false);
      props.onDone(view);
      props.onOpenChange(false);
    };
    const fail = (err: unknown): void => {
      setSubmitting(false);
      setErrState(describeCalendarMeetingError(err));
    };
    if (isEdit && editing !== null) {
      rescheduleFn(editing.interaction_id, {
        connection_id: undefined,
        expected_version: editing.version,
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
  const primaryLabel = submitting
    ? (isEdit ? 'Updating…' : 'Creating…')
    : (isEdit ? 'Update & resend invitation' : 'Schedule & send invitation');
  const recipient = props.talentName ?? 'this Talent';

  const footer =
    phase === 'form' ? (
      <>
        <Button unstyled className="rc-link-action" onClick={() => props.onOpenChange(false)}>Cancel</Button>
        <Button data-testid="schedule-review" onClick={goReview} disabled={!formValid}>Review</Button>
      </>
    ) : (
      <>
        <Button unstyled className="rc-link-action" onClick={() => setPhase('form')} disabled={submitting}>Back</Button>
        {/* No blind retry: the confirm (send) affordance is hidden when the last
            outcome is not safely retryable (e.g. unresolved / in-progress). */}
        {(errState === null || errState.retryable) && (
          <Button data-testid="schedule-confirm" onClick={confirm} disabled={submitting}>{primaryLabel}</Button>
        )}
      </>
    );

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} title={title} size="md" footer={footer}>
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
                <option key={z} value={z}>{z}{z === resolvedZone() ? ' · your timezone' : ''}</option>
              ))}
            </Select>
          </label>
          <label>
            Subject
            <Input type="text" data-testid="schedule-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
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
