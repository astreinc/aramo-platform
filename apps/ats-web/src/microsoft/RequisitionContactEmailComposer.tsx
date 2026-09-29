import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, Button, Dialog, InlineAlert, Input, Select, TextArea } from '@aramo/fe-foundation';

import { useMe } from '../shell/me-api';
import {
  listEmailTemplates as defaultListTemplates,
  type EmailTemplateView,
} from '../communications/email-templates-api';

import {
  generateRequisitionContactDraft as defaultDraft,
  sendMicrosoftEmail as defaultSend,
  type MicrosoftEmailSendResult,
  type RequisitionContactDraft,
  type RequisitionContactDraftInput,
  type SendEmailInput,
} from './microsoft-api';

// D-EMAIL-TPL-1 (ET-7) — the composer template picker. Only the wired
// requisition_initial_contact flow is offered; no unwired categories appear. The
// picker is a pure SELECTOR — the FE never resolves merge fields. "Aramo default"
// sends NO template_key (existing behaviour, ET-5 §6); a tenant override sends the
// requisition-contact key. Switching re-renders authoritatively on the server.
const WIRED_CATEGORY = 'requisition_initial_contact';
const REQUISITION_CONTACT_KEY = 'requisition-contact';
const DEFAULT_OPTION = 'default';

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
  readonly listTemplatesFn?: () => Promise<readonly EmailTemplateView[]>;
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
  const listTemplatesFn = props.listTemplatesFn ?? defaultListTemplates;

  // From identity — the recruiter's own M365-connected mailbox. Loading-safe:
  // `me` is null until /me resolves (and on error), so the From row shows a
  // neutral placeholder and never blocks the draft. Presentation-only — the
  // sender is server-owned at send time; this is display, not a submitted field.
  const me = useMe();

  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<RequisitionContactDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<readonly EmailTemplateView[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>(DEFAULT_OPTION);
  const idempotencyKey = useRef<string>('');
  const sendingRef = useRef(false);
  // Monotonic token — the latest draft request wins; stale responses (from a
  // rapid template switch or a close) are discarded so subject/body never flip to
  // an out-of-date render.
  const draftReqToken = useRef(0);

  // Render the draft on the server for the selected template. template_key
  // undefined → the code default (existing behaviour). On failure the current
  // draft is CLEARED (never keep stale content that could be sent). The FE only
  // selects; it never resolves merge fields.
  const loadDraft = useCallback(
    (templateKey: string | undefined) => {
      const token = ++draftReqToken.current;
      setDrafting(true);
      setDraftError(null);
      setSendError(null);
      draftFn({
        talent_record_id: props.talentId,
        requisition_id: props.requisitionId,
        ...(props.pipelineId === undefined ? {} : { pipeline_id: props.pipelineId }),
        ...(templateKey === undefined ? {} : { template_key: templateKey }),
      })
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
    },
    [draftFn, props.talentId, props.requisitionId, props.pipelineId],
  );

  // Open → load the picker options (non-blocking) + the DEFAULT draft (existing
  // behaviour, no template_key). Close → reset fully so re-open is fresh.
  useEffect(() => {
    if (!props.open) {
      draftReqToken.current++; // invalidate any in-flight draft
      setDrafting(false);
      setDraft(null);
      setDraftError(null);
      setSubject('');
      setBody('');
      setSending(false);
      setSendError(null);
      setTemplates([]);
      setSelectedKey(DEFAULT_OPTION);
      sendingRef.current = false;
      return;
    }
    idempotencyKey.current = newIdempotencyKey();
    setSelectedKey(DEFAULT_OPTION);
    listTemplatesFn()
      .then((rows) => setTemplates(rows))
      .catch(() => setTemplates([])); // picker degrades to the default only
    loadDraft(undefined);
  }, [props.open, props.talentId, props.requisitionId, props.pipelineId, listTemplatesFn, loadDraft]);

  // Only the wired requisition_initial_contact flow; the effective active tenant
  // override (if any) is the sole alternative to the Aramo default.
  const overrideRow = templates.find(
    (t) => t.category === WIRED_CATEGORY && !t.is_system_default && t.is_active,
  );

  const onPickTemplate = useCallback(
    (value: string) => {
      if (drafting || sending) return; // don't switch mid-flight
      setSelectedKey(value);
      loadDraft(value === DEFAULT_OPTION ? undefined : REQUISITION_CONTACT_KEY);
    },
    [drafting, sending, loadDraft],
  );

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

  const senderLabel =
    me === null
      ? 'your connected mailbox'
      : me.user.display_name === null
        ? me.user.email
        : `${me.user.display_name} <${me.user.email}>`;

  const reqRef = draft?.context.requisition_reference ?? '';

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
          <span className="rc-eml__pill" data-testid="email-composer-status">
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
            Sent email is logged to this Talent&apos;s activity
            {reqRef === '' ? '' : ` on ${reqRef}`} automatically.
          </span>
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
      {drafting && draft === null ? (
        <p data-testid="email-composer-loading">Preparing the draft…</p>
      ) : draftError !== null ? (
        <InlineAlert variant="error">
          <span data-testid="email-composer-draft-error">{draftError}</span>
        </InlineAlert>
      ) : draft !== null ? (
        <div className="rc-eml">
          {/* Banner — the draft's origin. We deliberately do NOT enumerate which
              fields were inserted (directive G2.3). */}
          <div className="rc-eml__banner" data-testid="email-composer-context">
            <span className="rc-eml__banner-ic" aria-hidden="true">
              <InfoIcon />
            </span>
            <span>
              Draft prepared from{' '}
              <b>
                {draft.context.requisition_reference} ·{' '}
                {draft.context.requisition_title}
              </b>
              . Review and edit the message before sending.
            </span>
          </div>

          <div className="rc-eml__meta">
            {/* Template — pure selector for the wired requisition-contact flow.
                Present only when a tenant override exists (else the default is the
                only template and there is nothing to pick). Switching triggers an
                authoritative server re-render; the FE never resolves merge fields. */}
            {overrideRow ? (
              <>
                <span className="rc-eml__label">Template</span>
                <Select
                  value={selectedKey}
                  onChange={(e) => onPickTemplate(e.target.value)}
                  disabled={drafting || sending}
                  data-testid="email-composer-template"
                  aria-label="Email template"
                >
                  <option value={DEFAULT_OPTION}>Aramo default</option>
                  <option value="override">{overrideRow.name}</option>
                </Select>
              </>
            ) : null}

            {/* From — the recruiter's own M365 identity (read-only). */}
            <span className="rc-eml__label">From</span>
            <span className="rc-eml__from" data-testid="email-composer-from">
              <span className="rc-eml__from-txt">{senderLabel}</span>
              <span className="rc-eml__badge">M365 CONNECTED</span>
            </span>

            {/* To — server-owned recipient (INV-3): a locked chip, NOT an input. */}
            <span className="rc-eml__label">To</span>
            <span>
              <span className="rc-eml__chip" data-testid="email-composer-recipient">
                {recipientLabel}
                <span className="rc-eml__chip-lock" aria-hidden="true">
                  <LockIcon />
                </span>
              </span>
              <span className="rc-eml__hint">
                Resolved from the Talent record — recipient can&apos;t be changed
                here.
              </span>
            </span>

            {/* Subject — editable, seeded from the generated draft. */}
            <span className="rc-eml__label">Subject</span>
            <Input
              type="text"
              data-testid="email-composer-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={sending || drafting}
              aria-label="Email subject"
            />
          </div>

          {draft.warnings !== undefined && draft.warnings.length > 0 ? (
            <InlineAlert variant="error">
              <ul data-testid="email-composer-warning">
                {draft.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </InlineAlert>
          ) : null}

          {/* Body — editable, large (min 340px per G2.3). */}
          <TextArea
            className="rc-eml__body"
            data-testid="email-composer-body"
            rows={16}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={sending || drafting}
            aria-label="Email body"
          />

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

// Decorative inline glyphs (presentation only). Kept local to the composer so
// the modal matches the prototype without pulling new shared icon exports.
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
