import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, Button, Dialog, InlineAlert, Input, TextArea } from '@aramo/fe-foundation';

import { useMe } from '../shell/me-api';

import {
  generateGeneralTalentContactDraft as defaultDraft,
  sendMicrosoftEmail as defaultSend,
  type GeneralTalentContactDraft,
  type GeneralTalentContactDraftInput,
  type MicrosoftEmailSendResult,
  type SendEmailInput,
} from './microsoft-api';

// COMM-RECRUITER-W1 (W1-A3) — the General Talent Contact compose/review/send
// surface. Talent-only: NO requisition. Reuses the governed composer interaction
// language (COMM-C4): the server resolves the governed template (tenant override
// else the gender-neutral code default); the recruiter only reviews/edits →
// explicit Send. The recipient is server-owned (display-only, editable:false) and
// is NEVER submitted by the client. No template selector. No FE merge-field
// interpolation. The send carries only the reviewed subject/body + the talent id
// + an idempotency key (NO requisition_id).

export interface GeneralTalentContactEmailComposerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly talentId: string;
  readonly draftFn?: (input: GeneralTalentContactDraftInput) => Promise<GeneralTalentContactDraft>;
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
    if (error.code === 'TALENT_CONTACT_CONTEXT_INVALID') {
      return 'This talent is no longer available. Reload and try again.';
    }
    if (error.status === 403) return 'You do not have permission to email this talent.';
    if (error.status === 404) return 'This talent is no longer available.';
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
    if (error.status === 404) return 'This talent is no longer available.';
  }
  return 'The email could not be sent. Please try again.';
}

export function GeneralTalentContactEmailComposer(
  props: GeneralTalentContactEmailComposerProps,
): JSX.Element {
  const draftFn = props.draftFn ?? defaultDraft;
  const sendFn = props.sendFn ?? defaultSend;
  const me = useMe();

  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<GeneralTalentContactDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const idempotencyKey = useRef<string>('');
  const sendingRef = useRef(false);
  const draftReqToken = useRef(0);

  const loadDraft = useCallback(() => {
    const token = ++draftReqToken.current;
    setDrafting(true);
    setDraftError(null);
    setSendError(null);
    draftFn({ talent_record_id: props.talentId })
      .then((d) => {
        if (token !== draftReqToken.current) return;
        setDraft(d);
        setSubject(d.subject);
        setBody(d.body);
        setDrafting(false);
      })
      .catch((err) => {
        if (token !== draftReqToken.current) return;
        setDraft(null);
        setDraftError(draftErrorMessage(err));
        setDrafting(false);
      });
  }, [draftFn, props.talentId]);

  useEffect(() => {
    if (!props.open) {
      draftReqToken.current++;
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
    idempotencyKey.current = newIdempotencyKey();
    loadDraft();
  }, [props.open, props.talentId, loadDraft]);

  const handleSend = useCallback(() => {
    if (sendingRef.current) return;
    if (draft === null || subject.trim() === '' || body.trim() === '') return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    // NO requisition_id — a General Talent Contact send is Talent-only.
    sendFn({
      talent_record_id: props.talentId,
      subject,
      body,
      idempotency_key: idempotencyKey.current,
      template_key: draft.context.template_key,
      template_id: draft.context.template_id,
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

  const senderLabel =
    me === null
      ? 'your connected mailbox'
      : me.user.display_name === null
        ? me.user.email
        : `${me.user.display_name} <${me.user.email}>`;

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      size="xl"
      title={
        <span className="rc-eml__hd">
          <span className="rc-eml__hd-ic" aria-hidden="true">
            <MailIcon />
          </span>
          <span className="rc-eml__hd-txt">Review email draft</span>
          <span className="rc-eml__pill" data-testid="gtc-email-composer-status">
            <span className="rc-eml__pill-dot" aria-hidden="true" />
            DRAFT · NOT SENT
          </span>
        </span>
      }
      description="Sent via your connected Microsoft 365 mailbox · nothing sends until you click Send"
      footer={
        <>
          <span className="rc-eml__logline">
            <span className="rc-eml__logline-ic" aria-hidden="true">
              <CheckIcon />
            </span>
            Sent email is logged to this Talent&apos;s activity automatically.
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="gtc-email-composer-cancel"
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            data-testid="gtc-email-composer-send"
            onClick={handleSend}
            disabled={sendDisabled}
          >
            {sending ? 'Sending…' : 'Send email'}
          </Button>
        </>
      }
    >
      <div data-testid="general-email-composer">
        {drafting && draft === null ? (
          <p data-testid="gtc-email-composer-loading">Preparing the draft…</p>
        ) : draftError !== null ? (
          <InlineAlert variant="error">
            <span data-testid="gtc-email-composer-draft-error">{draftError}</span>
          </InlineAlert>
        ) : draft !== null ? (
          <div className="rc-eml">
            <div className="rc-eml__banner" data-testid="gtc-email-composer-context">
              <span className="rc-eml__banner-ic" aria-hidden="true">
                <InfoIcon />
              </span>
              <span>
                General contact with this Talent (not tied to a requisition). Review and edit the
                message before sending.
              </span>
            </div>

            <div className="rc-eml__meta">
              <span className="rc-eml__label">From</span>
              <span className="rc-eml__from" data-testid="gtc-email-composer-from">
                <span className="rc-eml__from-txt">{senderLabel}</span>
                <span className="rc-eml__badge">M365 CONNECTED</span>
              </span>

              <span className="rc-eml__label">To</span>
              <span>
                <span className="rc-eml__chip" data-testid="gtc-email-composer-recipient">
                  {recipientLabel}
                  <span className="rc-eml__chip-lock" aria-hidden="true">
                    <LockIcon />
                  </span>
                </span>
                <span className="rc-eml__hint">
                  Resolved from the Talent record — recipient can&apos;t be changed here.
                </span>
              </span>

              <span className="rc-eml__label">Subject</span>
              <Input
                type="text"
                data-testid="gtc-email-composer-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                disabled={sending || drafting}
                aria-label="Email subject"
              />
            </div>

            {draft.warnings !== undefined && draft.warnings.length > 0 ? (
              <InlineAlert variant="error">
                <ul data-testid="gtc-email-composer-warning">
                  {draft.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </InlineAlert>
            ) : null}

            <TextArea
              className="rc-eml__body"
              data-testid="gtc-email-composer-body"
              rows={16}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={sending || drafting}
              aria-label="Email body"
            />

            {sendError !== null ? (
              <InlineAlert variant="error">
                <span data-testid="gtc-email-composer-send-error">{sendError}</span>
              </InlineAlert>
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function MailIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-10 6L2 7" />
    </svg>
  );
}

function LockIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function CheckIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function InfoIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8h.01M12 11v5" />
    </svg>
  );
}
