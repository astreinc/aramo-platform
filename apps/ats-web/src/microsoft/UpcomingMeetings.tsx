import { Button, Dialog, InlineAlert } from '@aramo/fe-foundation';
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

function when(v: ScheduledMeetingView): string {
  if (v.scheduled_start === null) return '—';
  const d = new Date(v.scheduled_start);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
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

export function UpcomingMeetings(props: UpcomingMeetingsProps): JSX.Element {
  const list = props.listFn ?? defaultList;
  const cancel = props.cancelFn ?? defaultCancel;

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
  if (meetings === null) {
    return <div data-testid="upcoming-loading">Loading meetings…</div>;
  }

  return (
    <div className="rc-upcoming" data-testid="upcoming-meetings">
      <div className="rc-upcoming__head">Upcoming with {props.talentName ?? 'this Talent'}</div>
      {meetings.length === 0 ? (
        <div data-testid="upcoming-empty" className="rc-upcoming__empty">No scheduled meetings yet.</div>
      ) : (
        <ul className="rc-upcoming__list">
          {meetings.map((m) => {
            const active = ACTIVE.has(m.status);
            return (
              <li key={m.interaction_id} data-testid={`upcoming-meeting-${m.interaction_id}`} className="rc-upcoming__row">
                <span className="rc-upcoming__when">{when(m)}</span>
                <span className="rc-upcoming__status">{statusLabel(m.status)}</span>
                <span className="rc-upcoming__actions">
                  {active && m.join_url !== null && (
                    <a data-testid={`upcoming-join-${m.interaction_id}`} href={m.join_url} target="_blank" rel="noreferrer">Join</a>
                  )}
                  {active && props.canEdit && (
                    <Button unstyled className="rc-link-action" data-testid={`upcoming-reschedule-${m.interaction_id}`} onClick={() => props.onReschedule(m)}>Reschedule</Button>
                  )}
                  {active && props.canCancel && (
                    <Button unstyled className="rc-link-action" data-testid={`upcoming-cancel-${m.interaction_id}`} onClick={() => setConfirmId(m.interaction_id)}>Cancel</Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="rc-upcoming__foot">
        Last-known scheduling state from your Outlook calendar. A scheduled meeting isn&apos;t evidence the call happened.
      </p>
      {err !== null && <div data-testid="upcoming-error"><InlineAlert variant="error">{err}</InlineAlert></div>}

      <Dialog
        open={confirmId !== null}
        onOpenChange={(o) => { if (!o) setConfirmId(null); }}
        title="Cancel this meeting?"
        size="sm"
        footer={
          <>
            <Button unstyled className="rc-link-action" onClick={() => setConfirmId(null)} disabled={busy}>Keep meeting</Button>
            <Button data-testid="upcoming-cancel-confirm" onClick={doCancel} disabled={busy}>Cancel meeting</Button>
          </>
        }
      >
        <p>A cancellation goes to everyone invited from your Outlook calendar. Activity keeps a record that it was scheduled and cancelled.</p>
      </Dialog>
    </div>
  );
}
