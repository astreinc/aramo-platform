import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { RequisitionContactEmailComposer } from './RequisitionContactEmailComposer';
import {
  createMicrosoftMeeting as defaultCreateMeeting,
  getMicrosoftBindingStatus as defaultLoadStatus,
  sendMicrosoftEmail as defaultSendEmail,
  type CreateMeetingInput,
  type MicrosoftBindingStatus,
  type MicrosoftEmailSendResult,
  type MicrosoftMeetingResult,
  type RequisitionContactDraft,
  type RequisitionContactDraftInput,
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
  readonly loadStatusFn?: () => Promise<MicrosoftBindingStatus>;
  readonly draftFn?: (input: RequisitionContactDraftInput) => Promise<RequisitionContactDraft>;
  readonly sendEmailFn?: (input: SendEmailInput) => Promise<MicrosoftEmailSendResult>;
  readonly createMeetingFn?: (input: CreateMeetingInput) => Promise<MicrosoftMeetingResult>;
}

function newKey(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? String(Math.floor(performance.now()))}`;
}

export function MicrosoftRecruiterActions(props: MicrosoftRecruiterActionsProps): JSX.Element {
  const load = props.loadStatusFn ?? defaultLoadStatus;
  const sendEmail = props.sendEmailFn ?? defaultSendEmail;
  const createMeeting = props.createMeetingFn ?? defaultCreateMeeting;
  const canSendEmail = props.canSendEmail;

  const [status, setStatus] = useState<MicrosoftBindingStatus | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [emailResult, setEmailResult] = useState<MicrosoftEmailSendResult | null>(null);
  const [meetingResult, setMeetingResult] = useState<MicrosoftMeetingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const onCreateMeeting = useCallback(() => {
    setError(null);
    const start = new Date(Date.now() + 3_600_000).toISOString();
    const end = new Date(Date.now() + 5_400_000).toISOString();
    createMeeting({
      talent_record_id: props.talentId,
      requisition_id: props.requisitionId,
      pipeline_id: props.pipelineId,
      subject: 'Introductory call',
      start_date_time: start,
      end_date_time: end,
      idempotency_key: newKey('meeting'),
    })
      .then(setMeetingResult)
      .catch(() => setError('microsoft_reauthorization_required'));
  }, [createMeeting, props]);

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
    <div data-testid="microsoft-actions">
      {canSendEmail && (
        <button type="button" data-testid="microsoft-send-email" onClick={onOpenComposer}>
          Send email
        </button>
      )}
      <button type="button" data-testid="microsoft-create-meeting" onClick={onCreateMeeting}>
        Create Teams meeting
      </button>
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
      {meetingResult !== null && (
        <p data-testid="microsoft-meeting-created">
          Teams meeting link created —{' '}
          <a href={meetingResult.join_url} data-testid="microsoft-meeting-join-url">
            join link
          </a>
        </p>
      )}
      {error !== null && <p data-testid="microsoft-action-error">{error}</p>}
    </div>
  );
}
