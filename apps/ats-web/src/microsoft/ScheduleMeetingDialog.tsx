import * as RadixDialog from '@radix-ui/react-dialog';
import { Button, Input, Select } from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useMe } from '../shell/me-api';

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

// M365-SCHED-1 — recruiter Outlook/Teams scheduling dialog (COMM-C2B Amendment A1),
// rebuilt to pixel-fidelity with the canonical prototype (design/aramo-Prototype/
// platform/Requisitions CRM.dc.html). Rendered on Radix dialog primitives with
// rc-sched-* styles extracted from the authored CSS. Architecture-mandated deviations
// (documented): (R2) an explicit lightweight review confirmation gates the send — the
// dialog never transmits on open; (R3) the timezone is a VALIDATED IANA select styled
// as the prototype's read-only field, with NO "Talent in the same zone" claim (no
// authoritative source); (req#3) participants show authoritative identities only — the
// organizer is "you" (the bound Microsoft 365 account) and the Talent by name; the
// recipient email is server-resolved and never fabricated. All timezone/idempotency/
// version-conflict/DST/state-isolation behavior is preserved.

interface Purpose { value: string; disabled: boolean; note: string; dur: number; }
const PURPOSES: Purpose[] = [
  { value: 'Recruiter screen', disabled: false, dur: 30, note: 'A recruiter-owned call. Logged to activity; it does not change the pipeline stage on its own.' },
  { value: 'Qualification call', disabled: false, dur: 45, note: 'Confirm interest, rate and availability. Logged to activity; mark qualified separately when done.' },
  { value: 'Client interview', disabled: true, dur: 60, note: 'Client interviews are scheduled from the Interviews workflow once the Talent is submitted to the client.' },
  { value: 'Follow-up', disabled: false, dur: 30, note: 'A recruiter-owned follow-up on your calendar.' },
];

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
function tomorrow(defaultDate?: string): string {
  if (defaultDate !== undefined && defaultDate.length > 0) return defaultDate;
  const d = new Date(Date.now() + 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (first === undefined) return '—';
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return (first.charAt(0) + (last !== undefined ? last.charAt(0) : '')).toUpperCase();
}
function subjectFor(purpose: string, talentName: string | undefined, requisitionTitle: string | undefined): string {
  return [purpose, talentName, requisitionTitle].filter((x) => x !== undefined && x !== '').join(' · ');
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
  readonly talentEmail?: string;
  readonly requisitionId: string;
  readonly requisitionReference?: string;
  readonly requisitionTitle?: string;
  readonly pipelineId?: string;
  // Authoritative organizer identity override (for the visual harness); production
  // reads it from useMe(). Never a fabricated value in the app.
  readonly organizerName?: string;
  readonly organizerEmail?: string;
  readonly editing?: ScheduledMeetingView | null;
  readonly scheduleFn?: (input: ScheduleCalendarMeetingInput) => Promise<ScheduledMeetingView>;
  readonly rescheduleFn?: (id: string, input: RescheduleCalendarMeetingInput) => Promise<ScheduledMeetingView>;
  readonly getFn?: (id: string) => Promise<ScheduledMeetingView>;
  readonly onDone: (view: ScheduledMeetingView) => void;
  // Deterministic seeds for tests/visual harness (default: tomorrow / 10:30).
  readonly defaultDate?: string;
  readonly defaultTime?: string;
}

function CalendarIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

export function ScheduleMeetingDialog(props: ScheduleMeetingDialogProps): JSX.Element {
  const scheduleFn = props.scheduleFn ?? defaultSchedule;
  const rescheduleFn = props.rescheduleFn ?? defaultReschedule;
  const getFn = props.getFn ?? defaultGet;
  const isEdit = (props.editing ?? null) !== null;

  // Authoritative organizer identity: the signed-in recruiter (the Outlook event is
  // created "as you"). Never fabricated — falls back to an accurate "You" when the
  // profile has not resolved. A harness override is accepted for deterministic renders.
  const me = useMe();
  const organizerName = props.organizerName ?? me?.user.display_name ?? me?.user.email ?? undefined;
  const organizerEmail = props.organizerEmail ?? me?.user.email ?? undefined;

  const initialZone = useMemo(() => resolvedZone(), []);
  const zones = useMemo(
    () => (BASE_ZONES.includes(initialZone) ? BASE_ZONES : [initialZone, ...BASE_ZONES]),
    [initialZone],
  );

  const [current, setCurrent] = useState<ScheduledMeetingView | null>(props.editing ?? null);
  const [purpose, setPurpose] = useState('Recruiter screen');
  const [subjectEdited, setSubjectEdited] = useState(false);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [duration, setDuration] = useState(30);
  const [timeZone, setTimeZone] = useState(initialZone);
  const [subject, setSubject] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errState, setErrState] = useState<ReturnType<typeof describeCalendarMeetingError> | null>(null);
  const [refreshedNotice, setRefreshedNotice] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sessionNonce, setSessionNonce] = useState(0);

  // Lifecycle isolation (re-seed ALL state on every open / target change) — a reused
  // instance never leaks a prior meeting's id/version/form/review/error/key.
  useEffect(() => {
    if (!props.open) return;
    const active = props.editing ?? null;
    const zone = resolvedZone();
    const seed = active != null ? seedFromView(active, zone) : { date: tomorrow(props.defaultDate), time: props.defaultTime ?? '10:30', duration: 30 };
    setCurrent(active);
    setPurpose('Recruiter screen');
    setSubjectEdited(false);
    setDate(seed.date);
    setTime(seed.time);
    setDuration(seed.duration);
    setTimeZone(zone);
    setSubject(subjectFor('Recruiter screen', props.talentName, props.requisitionTitle));
    setSubmitting(false);
    setErrState(null);
    setRefreshedNotice(false);
    setRefreshFailed(false);
    setConfirmOpen(false);
    setSessionNonce((n) => n + 1);
  }, [props.open, props.editing, props.talentName, props.requisitionTitle, props.defaultDate, props.defaultTime]);

  const composed = useMemo(
    () => (date.length > 0 && time.length > 0 ? composeInstants(date, time, duration, timeZone) : null),
    [date, time, duration, timeZone],
  );
  const startIso = composed?.startIso ?? '';
  const endIso = composed?.endIso ?? '';
  const dstProblem = composed?.problem ?? 'none';

  const idempotencyKey = useMemo(
    () => newIdempotencyKey(),
    [sessionNonce, props.talentId, props.requisitionId, subject, startIso, endIso, timeZone],
  );

  const formValid = date.length > 0 && time.length > 0 && subject.trim().length > 0 && timeZone.length > 0 && dstProblem === 'none';
  const dstMessage =
    dstProblem === 'nonexistent' ? `That time does not exist in ${timeZone} because of a daylight-saving change. Pick another time.`
      : dstProblem === 'ambiguous' ? `That time occurs twice in ${timeZone} because of a daylight-saving change. Pick a time at least an hour away.`
        : null;

  const pickPurpose = (p: Purpose): void => {
    if (p.disabled) return;
    setPurpose(p.value);
    setDuration(p.dur);
    if (!subjectEdited) setSubject(subjectFor(p.value, props.talentName, props.requisitionTitle));
  };

  const openReview = (): void => {
    if (!formValid) return;
    setErrState(null);
    setRefreshFailed(false);
    setConfirmOpen(true);
  };

  const confirm = (): void => {
    setSubmitting(true);
    setErrState(null);
    setRefreshedNotice(false);
    const done = (view: ScheduledMeetingView): void => {
      setSubmitting(false);
      setConfirmOpen(false);
      props.onDone(view);
      props.onOpenChange(false);
    };
    const fail = (err: unknown): void => {
      setSubmitting(false);
      const desc = describeCalendarMeetingError(err);
      if (isEdit && current !== null && desc.code === 'MICROSOFT_MEETING_VERSION_CONFLICT') {
        setErrState(desc);
        getFn(current.interaction_id)
          .then((fresh) => {
            setCurrent(fresh);
            const w = fresh.scheduled_start !== null ? instantToZonedWallClock(fresh.scheduled_start, timeZone) : { date: '', time: '' };
            setDate(w.date); setTime(w.time);
            if (fresh.scheduled_start !== null && fresh.scheduled_end !== null) {
              const d = durationMinutesBetween(fresh.scheduled_start, fresh.scheduled_end);
              if (d === 30 || d === 45 || d === 60) setDuration(d);
            }
            setErrState(null); setRefreshedNotice(true); setRefreshFailed(false);
            setConfirmOpen(false); // force a fresh review against the refreshed version
          })
          .catch((refreshErr) => { setRefreshFailed(true); setErrState(describeCalendarMeetingError(refreshErr)); });
        return;
      }
      setErrState(desc);
    };
    if (isEdit && current !== null) {
      rescheduleFn(current.interaction_id, {
        connection_id: undefined, expected_version: current.version,
        start_date_time: startIso, end_date_time: endIso, time_zone: timeZone,
      }).then(done).catch(fail);
    } else {
      scheduleFn({
        talent_record_id: props.talentId, requisition_id: props.requisitionId, pipeline_id: props.pipelineId,
        subject: subject.trim(), start_date_time: startIso, end_date_time: endIso, time_zone: timeZone,
        idempotency_key: idempotencyKey,
      }).then(done).catch(fail);
    }
  };

  const title = isEdit ? 'Reschedule meeting' : 'Schedule meeting';
  const primaryLabel = isEdit ? 'Update & resend invitation' : 'Schedule & send invitation';
  const recipient = props.talentName ?? 'this Talent';
  const subtitle = [props.talentName, props.requisitionReference, props.requisitionTitle].filter((x) => x !== undefined && x !== '').join(' · ');
  const activeNote = PURPOSES.find((p) => p.value === purpose)?.note ?? '';
  const showConfirmBtn = !refreshFailed && (errState === null || errState.retryable);

  return (
    <>
      <RadixDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className="rc-sched__overlay" />
          <RadixDialog.Content className="rc-sched__content" data-testid="schedule-form" aria-describedby={undefined}>
            <div className="rc-sched__hd">
              <span className="rc-sched__hd-ic" aria-hidden="true"><CalendarIcon /></span>
              <span className="rc-sched__hd-tx">
                <RadixDialog.Title className="rc-sched__title">{title}</RadixDialog.Title>
                {subtitle.length > 0 && <span className="rc-sched__subtitle">{subtitle}</span>}
              </span>
              <RadixDialog.Close asChild>
                <Button unstyled type="button" className="rc-sched__close" aria-label="Close" data-testid="schedule-close">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" /></svg>
                </Button>
              </RadixDialog.Close>
            </div>

            <div className="rc-sched__body">
              {refreshedNotice && (
                <p data-testid="schedule-refreshed-notice" className="rc-sched__note" role="status" style={{ color: '#B3402A' }}>
                  This meeting was updated elsewhere — the latest details are loaded. Review and confirm again.
                </p>
              )}
              <div className="rc-sched__flabel">Purpose</div>
              <div className="rc-sched__seg" data-testid="schedule-purpose" role="group" aria-label="Purpose">
                {PURPOSES.map((p) => (
                  <Button unstyled
                    key={p.value} type="button" disabled={p.disabled}
                    title={p.disabled ? 'Client interviews are scheduled from the Interviews workflow once the Talent is submitted to the client' : undefined}
                    className={`rc-sched__seg-btn${p.value === purpose ? ' rc-sched__seg-btn--on' : ''}`}
                    aria-pressed={p.value === purpose}
                    onClick={() => pickPurpose(p)}
                  >{p.value}</Button>
                ))}
              </div>
              <div className="rc-sched__note">{activeNote}</div>

              <div className="rc-sched__grid">
                <label className="rc-sched__fld"><span>Date</span>
                  <Input unstyled type="date" data-testid="schedule-date" className="rc-sched__in" value={date} onChange={(e) => setDate(e.target.value)} />
                </label>
                <label className="rc-sched__fld"><span>Time · duration</span>
                  <span className="rc-sched__timerow">
                    <Input unstyled type="time" data-testid="schedule-time" className="rc-sched__in" value={time} onChange={(e) => setTime(e.target.value)} />
                    <Select unstyled data-testid="schedule-duration" className="rc-sched__in rc-sched__dur" value={String(duration)} onChange={(e) => setDuration(Number.parseInt(e.target.value, 10))}>
                      <option value="30">30 min</option><option value="45">45 min</option><option value="60">60 min</option>
                    </Select>
                  </span>
                </label>
                <label className="rc-sched__fld rc-sched__full"><span>Time zone</span>
                  {/* R3 — validated IANA selection, styled as the prototype's read-only field; no same-zone claim. */}
                  <Select unstyled data-testid="schedule-timezone" className="rc-sched__tz" value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
                    {zones.map((z) => (<option key={z} value={z}>{z}{z === initialZone ? ' · your timezone' : ''}</option>))}
                  </Select>
                </label>
                <label className="rc-sched__fld rc-sched__full"><span>Subject</span>
                  <Input unstyled type="text" data-testid="schedule-subject" className="rc-sched__in rc-sched__subject" value={subject} onChange={(e) => { setSubject(e.target.value); setSubjectEdited(true); }} />
                </label>
              </div>
              {dstMessage !== null && <div className="rc-sched__err" data-testid="schedule-dst-error">{dstMessage}</div>}

              <div className="rc-sched__plabel">Participants</div>
              <div className="rc-sched__people">
                <div className="rc-sched__person">
                  <span className="rc-sched__avatar" style={{ background: '#022AC0' }} aria-hidden="true">{organizerName !== undefined ? initials(organizerName) : 'ME'}</span>
                  <span className="rc-sched__pname">
                    <b>{organizerName ?? 'You'}</b>
                    <span className="rc-sched__pmuted">{organizerEmail !== undefined ? ` · ${organizerEmail}` : ' · your Microsoft 365 account'}</span>
                  </span>
                  <span className="rc-sched__pchip">Organizer · you</span>
                </div>
                <div className="rc-sched__person">
                  <span className="rc-sched__avatar" style={{ background: '#6B7A52' }} aria-hidden="true">{props.talentName !== undefined ? initials(props.talentName) : '—'}</span>
                  <span className="rc-sched__pname">
                    <b>{recipient}</b>
                    <span className="rc-sched__pmuted">{props.talentEmail !== undefined && props.talentEmail !== '' ? ` · ${props.talentEmail}` : ' · invited at their contact email on file'}</span>
                  </span>
                  <span className="rc-sched__pchip">Talent</span>
                </div>
              </div>

              <div className="rc-sched__callout">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#022AC0" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M12 11v5" /></svg>
                <span><b>Microsoft Teams</b> · created on your Outlook calendar as you. Everyone listed gets the calendar invitation from your account the moment you confirm.</span>
              </div>
            </div>

            <div className="rc-sched__ft">
              <span className="rc-sched__ft-note">Idempotent — confirming twice never creates two events.</span>
              <span className="rc-sched__ft-actions">
                <RadixDialog.Close asChild><Button unstyled type="button" className="rc-sched__btn-cancel">Cancel</Button></RadixDialog.Close>
                <Button unstyled type="button" className="rc-sched__btn-primary" data-testid="schedule-review" disabled={!formValid} onClick={openReview}>{primaryLabel}</Button>
              </span>
            </div>
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>

      {/* R2 — lightweight explicit review confirmation before any invitation is sent. */}
      <RadixDialog.Root open={confirmOpen} onOpenChange={(o) => { if (!o) setConfirmOpen(false); }}>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className="rc-sched__overlay" style={{ zIndex: 72 }} />
          <RadixDialog.Content className="rc-sched__content" style={{ width: 'min(460px,94vw)', zIndex: 73 }} data-testid="schedule-review-summary" aria-describedby={undefined}>
            <div className="rc-sched__hd">
              <span className="rc-sched__hd-tx"><RadixDialog.Title className="rc-sched__title">{isEdit ? 'Send updated invitation?' : 'Send invitation?'}</RadixDialog.Title></span>
            </div>
            <div className="rc-sched__body">
              <p className="rc-sched__note">Confirming sends an Outlook calendar <b>invitation</b> to {recipient} from your Microsoft 365 account.</p>
              <div className="rc-sched__people" style={{ borderRadius: 10 }}>
                <div className="rc-sched__person"><span className="rc-sched__pname">Subject</span><span className="rc-sched__pchip" style={{ background: 'transparent', color: '#1B2730', fontWeight: 600 }}>{subject}</span></div>
                <div className="rc-sched__person"><span className="rc-sched__pname">Starts</span><span className="rc-sched__pmuted">{startIso}</span></div>
                <div className="rc-sched__person"><span className="rc-sched__pname">Ends</span><span className="rc-sched__pmuted">{endIso}</span></div>
                <div className="rc-sched__person"><span className="rc-sched__pname">Time zone</span><span className="rc-sched__pmuted">{timeZone}</span></div>
              </div>
              {errState !== null && (
                <div data-testid="schedule-error" className="rc-sched__err" style={{ marginTop: 10 }}>
                  {errState.message}
                  {errState.needsReconnect && (<><br /><Link to="/settings/me" data-testid="schedule-reconnect-link">Reconnect your Microsoft account →</Link></>)}
                </div>
              )}
            </div>
            <div className="rc-sched__ft">
              <span className="rc-sched__ft-actions">
                <Button unstyled type="button" className="rc-sched__btn-cancel" disabled={submitting} onClick={() => setConfirmOpen(false)}>Back</Button>
                {showConfirmBtn && <Button unstyled type="button" className="rc-sched__btn-primary" data-testid="schedule-confirm" disabled={submitting} onClick={confirm}>{submitting ? (isEdit ? 'Updating…' : 'Sending…') : (isEdit ? 'Update & resend' : 'Send invitation')}</Button>}
              </span>
            </div>
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>
    </>
  );
}
