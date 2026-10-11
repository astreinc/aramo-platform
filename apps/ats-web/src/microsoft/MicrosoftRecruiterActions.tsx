import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, useOptionalToast } from '@aramo/fe-foundation';


import { RequisitionContactEmailComposer } from './RequisitionContactEmailComposer';
import { ScheduleMeetingDialog } from './ScheduleMeetingDialog';
import { UpcomingMeetings } from './UpcomingMeetings';
import {
  getMicrosoftBindingStatus as defaultLoadStatus,
  sendMicrosoftEmail as defaultSendEmail,
  type CancelCalendarMeetingInput,
  type ListCalendarMeetingsQuery,
  type MicrosoftBindingStatus,
  type MicrosoftEmailSendResult,
  type RequisitionContactDraft,
  type RequisitionContactDraftInput,
  type RescheduleCalendarMeetingInput,
  type ScheduleCalendarMeetingInput,
  type ScheduledMeetingView,
  type SendEmailInput,
} from './microsoft-api';

// COMM-C2B recruiter UX (C2B-7). Shows the recruiter's Microsoft binding state:
// when reauthorization is required, it offers an authorize action; otherwise it
// exposes send-email + create-Teams-meeting. It is TRUTHFUL about the locked
// boundary — a sent email is evidence of an accepted outbound send, NOT a Talent
// response; a created meeting is a link, NOT attendance. No token is ever shown.
//
// COMM-C4 PR-2 — "Send email" no longer transmits on click: it opens the
// compose/review composer (INV-1). The old hard-coded subject/body literals and
// the client-supplied recipient are gone (INV-10) — the backend owns both.

export interface MicrosoftRecruiterActionsProps {
  readonly talentId: string;
  readonly requisitionId: string;
  readonly pipelineId?: string;
  // Least-visibility (INV/§8), FAIL-CLOSED: the email affordance is shown only
  // when the session holds `communication:email:send`. REQUIRED (no default) so
  // a caller that forgets to pass the capability hides the action rather than
  // accidentally exposing it; the server still enforces authorization too.
  readonly canSendEmail: boolean;
  // M365-SCHED-1 PR 1B — Outlook scheduling scopes, independently gated (fail-closed,
  // default hidden). communication:meeting:create/read/edit/cancel. The backend
  // remains authoritative; these only control affordance visibility.
  readonly canScheduleMeeting?: boolean;
  readonly canReadMeetings?: boolean;
  readonly canEditMeeting?: boolean;
  readonly canCancelMeeting?: boolean;
  readonly talentName?: string;
  readonly talentEmail?: string;
  readonly requisitionReference?: string;
  readonly requisitionTitle?: string;
  readonly loadStatusFn?: () => Promise<MicrosoftBindingStatus>;
  readonly draftFn?: (input: RequisitionContactDraftInput) => Promise<RequisitionContactDraft>;
  readonly sendEmailFn?: (input: SendEmailInput) => Promise<MicrosoftEmailSendResult>;
  readonly scheduleFn?: (input: ScheduleCalendarMeetingInput) => Promise<ScheduledMeetingView>;
  readonly rescheduleFn?: (id: string, input: RescheduleCalendarMeetingInput) => Promise<ScheduledMeetingView>;
  readonly listMeetingsFn?: (q: ListCalendarMeetingsQuery) => Promise<{ meetings: readonly ScheduledMeetingView[] }>;
  readonly cancelMeetingFn?: (id: string, input: CancelCalendarMeetingInput) => Promise<ScheduledMeetingView>;
}

export function MicrosoftRecruiterActions(props: MicrosoftRecruiterActionsProps): JSX.Element {
  const load = props.loadStatusFn ?? defaultLoadStatus;
  const sendEmail = props.sendEmailFn ?? defaultSendEmail;
  const canSendEmail = props.canSendEmail;

  const toast = useOptionalToast();
  const canScheduleMeeting = props.canScheduleMeeting ?? false;
  const canReadMeetings = props.canReadMeetings ?? false;
  const canEditMeeting = props.canEditMeeting ?? false;
  const canCancelMeeting = props.canCancelMeeting ?? false;

  const [status, setStatus] = useState<MicrosoftBindingStatus | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [emailResult, setEmailResult] = useState<MicrosoftEmailSendResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Outlook scheduling (PR 1B): one dialog serves create (editingMeeting === null)
  // and reschedule (editingMeeting set from the Upcoming block). reloadToken forces
  // the Upcoming list to refresh after a completed schedule/reschedule.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [editingMeeting, setEditingMeeting] = useState<ScheduledMeetingView | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    load()
      .then((s) => {
        if (live) setStatus(s);
      })
      .catch(() => {
        if (live) setStatus(null);
      });
    return () => {
      live = false;
    };
  }, [load]);

  // INV-1 — clicking "Send email" opens the compose/review surface; it does NOT
  // transmit. Transmission happens only via the composer's explicit Send.
  const onOpenComposer = useCallback(() => {
    setError(null);
    setComposerOpen(true);
  }, []);

  if (status === null) {
    return <div data-testid="microsoft-actions-loading">Checking Microsoft connection…</div>;
  }

  if (status.needs_reauthorization) {
    return (
      <div data-testid="microsoft-reauth-required">
        <p>
          Connect your Microsoft account to send email and create Teams meetings.
        </p>
        {/* The per-user mailbox connect lives in My Settings → Connected
            accounts (personal setting), not on the Talent panel. */}
        <Link to="/settings/me" data-testid="microsoft-connect-link">
          Connect your account in My Settings →
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="rc-m365" data-testid="microsoft-actions">
      <div className="rc-m365__row">
        {canSendEmail && (
          <Button
            unstyled
            type="button"
            className="rc-m365__btn rc-m365__btn--primary"
            data-testid="microsoft-send-email"
            onClick={onOpenComposer}
          >
            <span className="rc-m365__btn-ic" aria-hidden="true">
              <MailGlyph />
            </span>
            Send email
          </Button>
        )}
        {/* M365-SCHED-1 UX fidelity (R1) — the create-link-only action is removed from
            THIS card (the Schedule-meeting Outlook event supersedes it here); the
            legacy capability remains available + scope-gated in the Interviews
            workflow (InterviewDetailView "Create Teams meeting"). Independently gated. */}
        {canScheduleMeeting && (
          <Button
            unstyled
            type="button"
            className="rc-m365__btn rc-m365__btn--secondary"
            data-testid="microsoft-schedule-meeting"
            onClick={() => {
              setEditingMeeting(null);
              setScheduleOpen(true);
            }}
          >
            <span className="rc-m365__btn-ic" aria-hidden="true">
              <CalendarGlyph />
            </span>
            Schedule meeting
          </Button>
        )}
      </div>
      <p className="rc-m365__helper">
        Sent as you from your connected Microsoft 365 account · invitations go out from
        your Outlook calendar · logged to this Talent&apos;s activity automatically.
      </p>
      {canSendEmail && (
        <RequisitionContactEmailComposer
          open={composerOpen}
          onOpenChange={setComposerOpen}
          talentId={props.talentId}
          requisitionId={props.requisitionId}
          pipelineId={props.pipelineId}
          draftFn={props.draftFn}
          sendFn={sendEmail}
          onSent={setEmailResult}
        />
      )}
      {emailResult !== null && (
        <p data-testid="microsoft-email-sent">Email sent (delivery accepted).</p>
      )}
      {error !== null && <p data-testid="microsoft-action-error">{error}</p>}
      </div>

      {/* Upcoming meetings render as a SIBLING below the card (prototype), and render
          nothing at all when there are no non-cancelled meetings. */}
      {canReadMeetings && (
        <UpcomingMeetings
          talentId={props.talentId}
          talentName={props.talentName}
          requisitionId={props.requisitionId}
          canEdit={canEditMeeting}
          canCancel={canCancelMeeting}
          listFn={props.listMeetingsFn}
          cancelFn={props.cancelMeetingFn}
          reloadToken={reloadToken}
          onReschedule={(m) => {
            setEditingMeeting(m);
            setScheduleOpen(true);
          }}
        />
      )}

      {(canScheduleMeeting || editingMeeting !== null) && scheduleOpen && (
        <ScheduleMeetingDialog
          open={scheduleOpen}
          onOpenChange={setScheduleOpen}
          talentId={props.talentId}
          talentName={props.talentName}
          talentEmail={props.talentEmail}
          requisitionId={props.requisitionId}
          requisitionReference={props.requisitionReference}
          requisitionTitle={props.requisitionTitle}
          pipelineId={props.pipelineId}
          editing={editingMeeting}
          scheduleFn={props.scheduleFn}
          rescheduleFn={props.rescheduleFn}
          onDone={(view) => {
            setEditingMeeting(null);
            setReloadToken((t) => t + 1);
            // Prototype success toast — only on an authoritative success response. Never
            // claims a send on a replay (the backend already had the meeting).
            if (view.idempotent_replay) {
              toast.show('This meeting was already scheduled on your Outlook calendar.');
            } else if (view.status === 'rescheduled') {
              toast.show('Meeting updated · new invitation sent from your Outlook calendar');
            } else {
              toast.show(`Meeting scheduled · invitation sent${props.talentName !== undefined ? ` to ${props.talentName}` : ''} from your Outlook calendar`);
            }
          }}
        />
      )}
    </>
  );
}

// Decorative inline glyphs (presentation only) matching the prototype's M365 card.
function MailGlyph(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-10 6L2 7" />
    </svg>
  );
}

function CalendarGlyph(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}
