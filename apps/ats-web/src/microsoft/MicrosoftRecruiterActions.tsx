import { useCallback, useEffect, useState } from 'react';

import {
  createMicrosoftMeeting as defaultCreateMeeting,
  getMicrosoftBindingStatus as defaultLoadStatus,
  sendMicrosoftEmail as defaultSendEmail,
  startMicrosoftAuthorize as defaultStartAuthorize,
  type CreateMeetingInput,
  type MicrosoftBindingStatus,
  type MicrosoftEmailSendResult,
  type MicrosoftMeetingResult,
  type SendEmailInput,
} from './microsoft-api';

// COMM-C2B recruiter UX (C2B-7). Shows the recruiter's Microsoft binding state:
// when reauthorization is required, it offers an authorize action; otherwise it
// exposes send-email + create-Teams-meeting. It is TRUTHFUL about the locked
// boundary — a sent email is evidence of an accepted outbound send, NOT a Talent
// response; a created meeting is a link, NOT attendance. No token is ever shown.

export interface MicrosoftRecruiterActionsProps {
  readonly talentId: string;
  readonly requisitionId: string;
  readonly pipelineId?: string;
  readonly toEmail?: string;
  readonly loadStatusFn?: () => Promise<MicrosoftBindingStatus>;
  readonly startAuthorizeFn?: () => Promise<{ authorize_url: string }>;
  readonly sendEmailFn?: (input: SendEmailInput) => Promise<MicrosoftEmailSendResult>;
  readonly createMeetingFn?: (input: CreateMeetingInput) => Promise<MicrosoftMeetingResult>;
  readonly onNavigate?: (url: string) => void;
}

function newKey(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? String(Math.floor(performance.now()))}`;
}

export function MicrosoftRecruiterActions(props: MicrosoftRecruiterActionsProps): JSX.Element {
  const load = props.loadStatusFn ?? defaultLoadStatus;
  const startAuthorize = props.startAuthorizeFn ?? defaultStartAuthorize;
  const sendEmail = props.sendEmailFn ?? defaultSendEmail;
  const createMeeting = props.createMeetingFn ?? defaultCreateMeeting;

  const [status, setStatus] = useState<MicrosoftBindingStatus | null>(null);
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

  const onAuthorize = useCallback(() => {
    startAuthorize()
      .then(({ authorize_url }) => {
        if (props.onNavigate) props.onNavigate(authorize_url);
      })
      .catch(() => setError('microsoft_authorize_failed'));
  }, [startAuthorize, props]);

  const onSendEmail = useCallback(() => {
    setError(null);
    sendEmail({
      talent_record_id: props.talentId,
      requisition_id: props.requisitionId,
      pipeline_id: props.pipelineId,
      to_email: props.toEmail ?? '',
      subject: 'Regarding your application',
      body: 'A recruiter would like to connect with you.',
      idempotency_key: newKey('email'),
    })
      .then(setEmailResult)
      .catch(() => setError('microsoft_reauthorization_required'));
  }, [sendEmail, props]);

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
        <p>Connect your Microsoft account to send email and create Teams meetings.</p>
        <button type="button" data-testid="microsoft-authorize-button" onClick={onAuthorize}>
          Authorize Microsoft
        </button>
      </div>
    );
  }

  return (
    <div data-testid="microsoft-actions">
      <button type="button" data-testid="microsoft-send-email" onClick={onSendEmail}>
        Send email
      </button>
      <button type="button" data-testid="microsoft-create-meeting" onClick={onCreateMeeting}>
        Create Teams meeting
      </button>
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
