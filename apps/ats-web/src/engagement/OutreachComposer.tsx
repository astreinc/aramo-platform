import { useState } from 'react';
import { Button, FormField, InlineAlert } from '@aramo/fe-foundation';

import { draftOutreach, sendOutreach } from './engagement-api';
import {
  outreachDraftErrorMessage,
  outreachSendErrorMessage,
} from './error-messages';
import { uuidv4 } from './idempotency';
import { legalNextStates } from './legal-transitions';
import type {
  EngagementState,
  OutreachDraftConsentWarning,
  OutreachDraftResponse,
} from './types';

interface OutreachComposerProps {
  readonly engagementId: string;
  readonly state: EngagementState;
  // Called after a successful SEND — the parent reloads (the engagement has
  // advanced to awaiting_response + the event log gained an outreach_sent
  // event carrying final_text + source_draft_event_id, the editable trail).
  readonly onSent: () => void;
}

// The draft→preview→send outreach composer (§6 / Amendment v1.1). The
// human-in-the-loop sequence is ALWAYS compose → review → send: there is NO
// one-click generate-and-send. The recruiter sees and may edit the exact
// final_text before it is delivered under their name.
//
// Two idempotency-key lifecycles (Amendment v1.1):
//   - DRAFT key — RE-MINTED per generation attempt (a changed prompt is a
//     new operation; a re-draft must actually re-run, never replay a prior
//     draft). Minted fresh at each handleDraft call, NOT memoized.
//   - SEND key — KEYED ON draft_event_id (stable across send retries →
//     dedupes, never double-delivers). draft_event_id is a server-minted
//     UUID, so it satisfies the controller's UUID-shaped key requirement.
//
// Engaged-gate (computed from the mirror, no extra fetch): the draft action
// shows only when legalNextStates(state) includes 'awaiting_response' — i.e.
// the talent is engaged. Otherwise a non-action explanation.
export function OutreachComposer({
  engagementId,
  state,
  onSent,
}: OutreachComposerProps) {
  const [prompt, setPrompt] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [systemMessage, setSystemMessage] = useState('');
  const [recipientHandle, setRecipientHandle] = useState('');
  const [draft, setDraft] = useState<OutreachDraftResponse | null>(null);
  const [finalText, setFinalText] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  // The engaged-gate, derived for free from the legal-transition mirror.
  const canDraft = legalNextStates(state).includes('awaiting_response');
  if (!canDraft) {
    return (
      <p className="outreach-composer__gate">
        Outreach can be drafted once the talent is engaged.
      </p>
    );
  }

  const parseMaxTokens = (): number | undefined => {
    const t = maxTokens.trim();
    if (t === '') return undefined;
    const n = Number(t);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };

  const optional = (value: string): string | undefined =>
    value.trim() === '' ? undefined : value;

  const handleDraft = async () => {
    if (prompt.trim() === '') {
      setDraftError('Enter a prompt to generate a draft.');
      return;
    }
    setDrafting(true);
    setDraftError(null);
    setSendError(null);
    try {
      // RE-MINT a fresh key for EACH generation attempt — a re-draft is a
      // genuinely new operation and must re-run, never replay.
      const res = await draftOutreach(
        engagementId,
        {
          prompt,
          max_tokens: parseMaxTokens(),
          system_message: optional(systemMessage),
          recipient_handle: optional(recipientHandle),
        },
        uuidv4(),
      );
      setDraft(res);
      // Seed the editable field with the AI text; the recruiter may diverge
      // it (final_text may differ from draft_text — the editable trail).
      setFinalText(res.draft_text);
      setDrafting(false);
    } catch (err) {
      setDraftError(outreachDraftErrorMessage(err));
      setDrafting(false);
    }
  };

  const handleSend = async () => {
    if (draft === null) return;
    if (finalText.trim() === '') {
      setSendError('The message cannot be empty.');
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      // KEY ON draft_event_id — stable across send retries so a retried send
      // dedupes and never double-delivers.
      await sendOutreach(
        engagementId,
        {
          draft_event_id: draft.draft_event_id,
          final_text: finalText,
          recipient_handle: optional(recipientHandle),
        },
        draft.draft_event_id,
      );
      onSent();
    } catch (err) {
      // 403 CONSENT_NOT_GRANTED_AT_SEND is the BINDING gate — surfaced here
      // and NON-overridable: the composer offers NO override path (distinct
      // from the soft draft-time consent_warning).
      setSendError(outreachSendErrorMessage(err));
      setSending(false);
    }
  };

  return (
    <div className="outreach-composer">
      {/* Step 1 — Compose (the prompt). */}
      <FormField
        label="Outreach prompt"
        helper="Describe the message; the assistant drafts it for you to review and edit before it sends."
      >
        <textarea
          className="outreach-composer__prompt"
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={drafting}
          aria-label="Outreach prompt"
        />
      </FormField>
      <FormField label="Max tokens (optional)">
        <input
          type="number"
          min={1}
          value={maxTokens}
          onChange={(e) => setMaxTokens(e.target.value)}
          disabled={drafting}
          aria-label="Max tokens"
        />
      </FormField>
      <FormField label="System message (optional)">
        <textarea
          rows={2}
          value={systemMessage}
          onChange={(e) => setSystemMessage(e.target.value)}
          disabled={drafting}
          aria-label="System message"
        />
      </FormField>
      <FormField label="Recipient handle (optional)">
        <input
          type="text"
          value={recipientHandle}
          onChange={(e) => setRecipientHandle(e.target.value)}
          disabled={drafting}
          aria-label="Recipient handle"
        />
      </FormField>
      {draftError !== null ? (
        <InlineAlert variant="error">{draftError}</InlineAlert>
      ) : null}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => void handleDraft()}
        disabled={drafting}
      >
        {drafting
          ? 'Generating…'
          : draft === null
            ? 'Generate draft'
            : 'Re-generate draft'}
      </Button>

      {/* Step 2 — Preview / edit. The editable trail. */}
      {draft !== null ? (
        <div className="outreach-composer__preview">
          {draft.consent_warning !== undefined ? (
            <ConsentWarning warning={draft.consent_warning} />
          ) : null}
          <FormField
            label="Review and edit before sending"
            helper="This is the exact message that will be sent under your name. Edit it as needed, then send."
          >
            <textarea
              className="outreach-composer__final"
              rows={8}
              value={finalText}
              onChange={(e) => setFinalText(e.target.value)}
              disabled={sending}
              aria-label="Final message"
            />
          </FormField>
          {sendError !== null ? (
            <InlineAlert variant="error">{sendError}</InlineAlert>
          ) : null}
          {/* Step 3 — Send. No override control is ever rendered — the
              binding 403 is non-overridable by design. */}
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => void handleSend()}
            disabled={sending}
          >
            {sending ? 'Sending…' : 'Send outreach'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// The soft, NON-blocking consent warning surfaced on the draft response. The
// draft still succeeded and the recruiter may continue to edit + send; the
// BINDING gate is the 403 at SEND. (fe-foundation's InlineAlert has only
// error/success variants — error styling reads as the cautionary note here.)
function ConsentWarning({
  warning,
}: {
  readonly warning: OutreachDraftConsentWarning;
}) {
  const message =
    warning.display_message ??
    'Consent is not currently granted — review before sending.';
  return <InlineAlert variant="error">{message}</InlineAlert>;
}
