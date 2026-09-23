import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, Button, Dialog, FormField, InlineAlert } from '@aramo/fe-foundation';

import {
  generateRequisitionContactDraft as defaultDraft,
  sendMicrosoftEmail as defaultSend,
  type MicrosoftEmailSendResult,
  type RequisitionContactDraft,
  type RequisitionContactDraftInput,
  type SendEmailInput,
} from './microsoft-api';

// COMM-C4 PR-2 — the recruiter compose/review/send surface. Replaces the old
// one-click, hard-coded send. The human loop is ALWAYS generate → review/edit →
// explicit Send. The recipient is server-owned (display-only, editable:false)
// and is NEVER submitted by the client (DEC-2/INV-3); the send carries only the
// reviewed subject/body + ids + an idempotency key.

export interface RequisitionContactEmailComposerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly talentId: string;
  readonly requisitionId: string;
  readonly pipelineId?: string;
  readonly draftFn?: (input: RequisitionContactDraftInput) => Promise<RequisitionContactDraft>;
  readonly sendFn?: (input: SendEmailInput) => Promise<MicrosoftEmailSendResult>;
  readonly onSent?: (result: MicrosoftEmailSendResult) => void;
}

function newIdempotencyKey(): string {
  return `email-${globalThis.crypto?.randomUUID?.() ?? String(Math.floor(performance.now()))}`;
}

function draftErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'COMMUNICATION_EMAIL_RECIPIENT_UNAVAILABLE') {
      return 'This talent has no contactable email on file, so an email cannot be drafted.';
    }
    if (error.code === 'COMMUNICATION_REQUISITION_CONTACT_CONTEXT_INVALID') {
      return 'This talent is not associated with this requisition. Reload and try again.';
    }
    if (error.status === 403) return 'You do not have permission to email this talent.';
    if (error.status === 404) return 'This talent or requisition is no longer available.';
  }
  return 'The email draft could not be generated. Please try again.';
}

function sendErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'COMMUNICATION_EMAIL_RECIPIENT_UNAVAILABLE') {
      return 'This talent has no contactable email on file, so the email cannot be sent.';
    }
    if (error.status === 401 || error.status === 403) {
      return 'Reconnect your Microsoft account to send this email (My Settings → Connected accounts).';
    }
    if (error.status === 404) return 'This talent or requisition is no longer available.';
  }
  return 'The email could not be sent. Please try again.';
}

export function RequisitionContactEmailComposer(
  props: RequisitionContactEmailComposerProps,
): JSX.Element {
  const draftFn = props.draftFn ?? defaultDraft;
  const sendFn = props.sendFn ?? defaultSend;

  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<RequisitionContactDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const idempotencyKey = useRef<string>('');
  const sendingRef = useRef(false);

  // Generate the draft when the composer opens; reset fully when it closes so a
  // re-open always starts from a fresh server-authoritative draft.
  useEffect(() => {
    if (!props.open) {
      setDrafting(false);
      setDraft(null);
      setDraftError(null);
      setSubject('');
      setBody('');
      setSending(false);
      setSendError(null);
      sendingRef.current = false;
      return;
    }
    let live = true;
    setDrafting(true);
    setDraftError(null);
    idempotencyKey.current = newIdempotencyKey();
    draftFn({
      talent_record_id: props.talentId,
      requisition_id: props.requisitionId,
      ...(props.pipelineId === undefined ? {} : { pipeline_id: props.pipelineId }),
    })
      .then((d) => {
        if (!live) return;
        setDraft(d);
        setSubject(d.subject);
        setBody(d.body);
        setDrafting(false);
      })
      .catch((err) => {
        if (!live) return;
        setDraftError(draftErrorMessage(err));
        setDrafting(false);
      });
    return () => {
      live = false;
    };
  }, [props.open, props.talentId, props.requisitionId, props.pipelineId, draftFn]);

  const handleSend = useCallback(() => {
    if (sendingRef.current) return; // double-submit guard (synchronous)
    if (draft === null || subject.trim() === '' || body.trim() === '') return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    sendFn({
      talent_record_id: props.talentId,
      requisition_id: props.requisitionId,
      ...(props.pipelineId === undefined ? {} : { pipeline_id: props.pipelineId }),
      subject,
      body,
      idempotency_key: idempotencyKey.current,
    })
      .then((result) => {
        props.onSent?.(result);
        props.onOpenChange(false);
      })
      .catch((err) => {
        sendingRef.current = false;
        setSending(false);
        setSendError(sendErrorMessage(err));
      });
  }, [draft, subject, body, sendFn, props]);

  const recipientLabel =
    draft === null
      ? ''
      : draft.to.display_name === null
        ? draft.to.email
        : `${draft.to.display_name} <${draft.to.email}>`;

  const sendDisabled =
    drafting || sending || draft === null || subject.trim() === '' || body.trim() === '';

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Email this talent"
      description="Review and edit the message. The recipient is resolved by Aramo and cannot be changed here."
      size="lg"
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="email-composer-cancel"
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            data-testid="email-composer-send"
            onClick={handleSend}
            disabled={sendDisabled}
          >
            {sending ? 'Sending…' : 'Send email'}
          </Button>
        </>
      }
    >
      {drafting ? (
        <p data-testid="email-composer-loading">Preparing the draft…</p>
      ) : draftError !== null ? (
        <InlineAlert variant="error">
          <span data-testid="email-composer-draft-error">{draftError}</span>
        </InlineAlert>
      ) : draft !== null ? (
        <div>
          <FormField label="To (resolved by Aramo — not editable)">
            {/* Display-only: recipient is server-owned (INV-3). NOT an input. */}
            <div data-testid="email-composer-recipient">{recipientLabel}</div>
          </FormField>
          <p data-testid="email-composer-context">
            {draft.context.requisition_title} ({draft.context.requisition_reference})
          </p>
          {draft.warnings !== undefined && draft.warnings.length > 0 ? (
            <InlineAlert variant="error">
              <ul data-testid="email-composer-warning">
                {draft.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </InlineAlert>
          ) : null}
          <FormField label="Subject">
            <input
              type="text"
              data-testid="email-composer-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={sending}
              aria-label="Email subject"
            />
          </FormField>
          <FormField
            label="Message"
            helper="This is the exact message sent under your name. Edit it as needed, then send."
          >
            <textarea
              data-testid="email-composer-body"
              rows={10}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={sending}
              aria-label="Email body"
            />
          </FormField>
          {sendError !== null ? (
            <InlineAlert variant="error">
              <span data-testid="email-composer-send-error">{sendError}</span>
            </InlineAlert>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
