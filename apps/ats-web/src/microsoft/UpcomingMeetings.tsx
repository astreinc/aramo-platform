import * as RadixDialog from '@radix-ui/react-dialog';
import { Button, InlineAlert, useOptionalToast } from '@aramo/fe-foundation';
import { useCallback, useEffect, useState } from 'react';

import { describeCalendarMeetingError } from './calendar-meeting-errors';
import {
  cancelCalendarMeeting as defaultCancel,
  listCalendarMeetings as defaultList,
  type CancelCalendarMeetingInput,
  type ListCalendarMeetingsQuery,
  type ScheduledMeetingView,
} from './microsoft-api';

// M365-SCHED-1 PR 1B — "Upcoming with {Talent}" block (COMM-C2B Amendment A1),
// reconciled to design/aramo-Prototype `Requisitions CRM.dc.html`. Shows recruiter-
// owned Outlook meetings as Aramo's LAST-KNOWN scheduling state (PR 1A has no
// bidirectional Outlook sync — the copy does NOT claim Outlook changes appear
// automatically). Join / Reschedule / Cancel are independently scope-gated. Only the
// known-active lifecycle {scheduled, rescheduled} exposes actions; any other status
// is rendered conservatively (never assumed to be scheduled).

const ACTIVE = new Set(['scheduled', 'rescheduled']);

function statusLabel(status: string): string {
  if (status === 'scheduled') return 'Invited';
  if (status === 'rescheduled') return 'Rescheduled · invited';
  if (status === 'cancelled') return 'Cancelled';
  return 'Status unavailable'; // conservative — never present an unknown status as scheduled
}

function startDate(v: ScheduledMeetingView): Date | null {
  if (v.scheduled_start === null) return null;
  const d = new Date(v.scheduled_start);
  return Number.isNaN(d.getTime()) ? null : d;
}
function dayLabel(d: Date | null): string {
  return d === null ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function timeLabel(d: Date | null): string {
  return d === null ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function cancelDesc(v: ScheduledMeetingView | null, talentName: string | undefined): string {
  if (v === null) return '';
  const d = startDate(v);
  const who = talentName ?? 'this Talent';
  return d !== null ? `Meeting with ${who} on ${dayLabel(d)} at ${timeLabel(d)}.` : `Meeting with ${who}.`;
}
function durationLabel(v: ScheduledMeetingView): string {
  if (v.scheduled_start === null || v.scheduled_end === null) return 'Outlook meeting';
  const mins = Math.round((new Date(v.scheduled_end).getTime() - new Date(v.scheduled_start).getTime()) / 60000);
  return Number.isFinite(mins) && mins > 0 ? `${mins} min · organized by you · on your Outlook calendar` : 'organized by you · on your Outlook calendar';
}

export interface UpcomingMeetingsProps {
  readonly talentId: string;
  readonly talentName?: string;
  readonly requisitionId?: string;
  readonly canEdit: boolean;
  readonly canCancel: boolean;
  readonly listFn?: (query: ListCalendarMeetingsQuery) => Promise<{ meetings: readonly ScheduledMeetingView[] }>;
  readonly cancelFn?: (id: string, input: CancelCalendarMeetingInput) => Promise<ScheduledMeetingView>;
  readonly onReschedule: (view: ScheduledMeetingView) => void;
  /** Bumped by the parent to force a reload after a schedule/reschedule completes. */
  readonly reloadToken?: number;
}

export function UpcomingMeetings(props: UpcomingMeetingsProps): JSX.Element | null {
  const list = props.listFn ?? defaultList;
  const cancel = props.cancelFn ?? defaultCancel;
  const toast = useOptionalToast();

  const [meetings, setMeetings] = useState<readonly ScheduledMeetingView[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // FIX_NOW-4 — a failed read is a distinct error state; it is NEVER collapsed into an
  // empty list (that would falsely assert "no meetings exist").
  const load = useCallback(() => {
    setLoadError(false);
    list({ talent_record_id: props.talentId, requisition_id: props.requisitionId })
      .then((r) => {
        setMeetings(r.meetings);
        setLoadError(false);
      })
      .catch(() => {
        setMeetings(null);
        setLoadError(true);
      });
  }, [list, props.talentId, props.requisitionId]);

  useEffect(() => {
    load();
  }, [load, props.reloadToken]);

  const confirmTarget = meetings?.find((m) => m.interaction_id === confirmId) ?? null;

  const doCancel = (): void => {
    if (confirmTarget === null) return;
    setBusy(true);
    setErr(null);
    cancel(confirmTarget.interaction_id, { expected_version: confirmTarget.version })
      .then(() => {
        setBusy(false);
        setConfirmId(null);
        load();
        toast.show('Meeting cancelled · cancellation sent from your Outlook calendar');
      })
      .catch((e) => {
        setBusy(false);
        setConfirmId(null);
        setErr(describeCalendarMeetingError(e).message);
      });
  };

  if (loadError) {
    return (
      <div className="rc-upcoming" data-testid="upcoming-meetings">
        <div className="rc-upcoming__head">Upcoming with {props.talentName ?? 'this Talent'}</div>
        <div data-testid="upcoming-load-error" className="rc-upcoming__error">
          <InlineAlert variant="error">Could not load scheduled meetings right now.</InlineAlert>
          <Button unstyled className="rc-link-action" data-testid="upcoming-retry" onClick={load}>Retry</Button>
        </div>
      </div>
    );
  }
  // Zero-state (and the brief pre-load) render NOTHING — the block appears below the
  // card only once a non-cancelled meeting exists (prototype). A failed read is the
  // distinct `loadError` state above, never collapsed into "no meetings" (FIX-4).
  if (meetings === null || meetings.length === 0) {
    return null;
  }

  return (
    <div className="rc-upcoming" data-testid="upcoming-meetings">
      <div className="rc-upcoming__head">Upcoming with {props.talentName ?? 'this Talent'}</div>
      <ul className="rc-upcoming__list">
        {meetings.map((m) => {
          const active = ACTIVE.has(m.status);
          const d = startDate(m);
          const statusTone = active ? 'rc-upcoming__pill--status' : 'rc-upcoming__pill--prov';
          return (
            <li key={m.interaction_id} data-testid={`upcoming-meeting-${m.interaction_id}`} className="rc-upcoming__row">
              <span className="rc-upcoming__when">{dayLabel(d)}<small>{timeLabel(d)}</small></span>
              <span className="rc-upcoming__mid">
                <span className="rc-upcoming__title">Outlook meeting · Teams</span>
                <span className="rc-upcoming__sub">{durationLabel(m)}</span>
                <span className="rc-upcoming__pills">
                  <span className="rc-upcoming__pill rc-upcoming__pill--prov">Outlook · Teams</span>
                  <span className={`rc-upcoming__pill ${statusTone}`}>{statusLabel(m.status)}</span>
                </span>
              </span>
              <span className="rc-upcoming__actions">
                {active && m.join_url !== null && (
                  <a className="rc-upcoming__join" data-testid={`upcoming-join-${m.interaction_id}`} href={m.join_url} target="_blank" rel="noreferrer">Join</a>
                )}
                {active && props.canEdit && (
                  <Button unstyled className="rc-upcoming__resched" data-testid={`upcoming-reschedule-${m.interaction_id}`} onClick={() => props.onReschedule(m)}>Reschedule</Button>
                )}
                {active && props.canCancel && (
                  <Button unstyled className="rc-upcoming__cancel" data-testid={`upcoming-cancel-${m.interaction_id}`} onClick={() => setConfirmId(m.interaction_id)}>Cancel</Button>
                )}
              </span>
            </li>
          );
        })}
        <li className="rc-upcoming__foot" aria-hidden="false">
          {/* ATS-QA-1 I-1 UX — plain recruiter copy (was "last-known scheduling state … evidence"). */}
          Meeting invites and Teams links are on your Outlook calendar. Aramo shows the last-known schedule; it
          doesn&apos;t confirm the meeting took place.
        </li>
      </ul>
      {err !== null && <div data-testid="upcoming-error"><InlineAlert variant="error">{err}</InlineAlert></div>}

      <RadixDialog.Root open={confirmId !== null} onOpenChange={(o) => { if (!o) setConfirmId(null); }}>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className="rc-sched__overlay" />
          <RadixDialog.Content className="rc-sched__content rc-sched__content--sm" aria-describedby={undefined}>
            <div className="rc-sched__confirm-body">
              <RadixDialog.Title className="rc-sched__confirm-title">Cancel this meeting?</RadixDialog.Title>
              <p className="rc-sched__confirm-desc">
                {cancelDesc(confirmTarget, props.talentName)} A cancellation goes to everyone invited from your
                Outlook calendar. Activity keeps a record that it was scheduled and cancelled.
              </p>
            </div>
            <div className="rc-sched__ft rc-sched__ft--confirm">
              <Button unstyled className="rc-sched__btn-cancel" onClick={() => setConfirmId(null)} disabled={busy}>Keep meeting</Button>
              <Button unstyled className="rc-sched__btn-danger" data-testid="upcoming-cancel-confirm" onClick={doCancel} disabled={busy}>Cancel meeting</Button>
            </div>
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>
    </div>
  );
}
