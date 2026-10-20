import { useEffect, useState } from 'react';

import { DocumentPreviewDialog } from '../talent-360/t360-previews';
import { Button } from '../ui';

import { SendRtrModal } from './SendRtrModal';
import { rtrTemplateErrorMessage } from './rtr-binding-messages';
import {
  composeRtr,
  requestRtr,
  sendRtr,
  type RtrComposeResponse,
} from './rtr-api';

// SEAM 4 — the compose-driven "Send RTR" panel for a talent whose RTR has NOT yet
// been requested. Opened from the Talent-in-play List (RTR column) and the Board
// (chip) — the SAME panel. On mount it reads the tenant's ACTIVE RTR template
// provenance + a real-bound preview via composeRtr(talent, requisition); "Send for
// signature" runs the EXISTING governed request→send lifecycle (requestRtr then
// sendRtr) — this surface invents no alternative mutation path and holds no RTR
// authority. Fail-closed: if composeRtr refuses (no approved template / missing
// binding) the honest message shows and Send is disabled — Aramo never substitutes.

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Mirror of RtrPanel.describeError — the fail-closed template codes mapped to honest
// recruiter messaging (kept local; the panel never fabricates or substitutes).
function describeError(e: unknown): string {
  return rtrTemplateErrorMessage(e) ?? messageOf(e);
}

export interface SendRtrLauncherProps {
  readonly talentId: string;
  readonly requisitionId: string;
  readonly companyId: string;
  readonly talentName: string;
  readonly clientName: string | null;
  readonly requisitionTitle: string | null;
  readonly recipientEmail: string | null;
  readonly onClose: () => void;
  /** Fired after a successful request→send so the host can refresh the board/list. */
  readonly onSent?: () => void;
}

export function SendRtrLauncher({
  talentId,
  requisitionId,
  companyId,
  talentName,
  clientName,
  requisitionTitle,
  recipientEmail,
  onClose,
  onSent,
}: SendRtrLauncherProps): JSX.Element {
  const [compose, setCompose] = useState<RtrComposeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failClosed, setFailClosed] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailClosed(null);
    composeRtr(talentId, requisitionId)
      .then((res) => {
        if (active) setCompose(res);
      })
      .catch((e) => {
        if (active) setFailClosed(describeError(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [talentId, requisitionId]);

  // RTR-TEMPLATE-1 §16 — the recruiter reviews the EXACT frozen unsigned document
  // (with the signature block where the talent signs) before it is sent. Step 1
  // requests (freezes) the RTR document; step 2 shows it; Send then sends that same
  // document. A missing authoritative binding fails CLOSED (surfaced inline).
  const [reviewDocId, setReviewDocId] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const onSend = async (): Promise<{ ok: boolean; missingText?: string }> => {
    try {
      const document_id =
        reviewDocId ?? (await requestRtr({ talent_id: talentId, requisition_id: requisitionId, company_id: companyId })).document_id;
      setReviewDocId(document_id);
      setSendError(null);
      setReviewing(true);
      return { ok: true };
    } catch (e) {
      // Fail-closed: surface every failure honestly and keep the action disabled.
      return { ok: false, missingText: describeError(e) };
    }
  };

  const confirmSend = async (): Promise<void> => {
    if (reviewDocId === null) return;
    setSending(true);
    setSendError(null);
    try {
      await sendRtr(reviewDocId, talentId);
      onSent?.();
      onClose();
    } catch (e) {
      setSendError(describeError(e));
    } finally {
      setSending(false);
    }
  };

  if (reviewing && reviewDocId !== null) {
    return (
      <DocumentPreviewDialog
        talentId={talentId}
        documentId={reviewDocId}
        title="Right to Represent"
        onClose={() => setReviewing(false)}
        footer={
          <span style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
            <span style={{ flex: 1 }}>
              {sendError !== null ? (
                <span role="alert" style={{ color: 'var(--rc-danger, #b91c1c)' }}>
                  {sendError}
                </span>
              ) : (
                <>This is the exact document {talentName} will sign. The signature and date go in the signature block.</>
              )}
            </span>
            <Button type="button" variant="secondary" onClick={() => setReviewing(false)} disabled={sending}>
              Back
            </Button>
            <Button type="button" variant="primary" onClick={() => void confirmSend()} disabled={sending} data-testid="rtr-review-send">
              {sending ? 'Sending…' : 'Send for signature'}
            </Button>
          </span>
        }
      />
    );
  }

  const templateLine =
    compose !== null ? `${compose.template.name} · v${compose.template.version_number}` : null;
  const footNote =
    compose !== null
      ? `The document is frozen from v${compose.template.version_number} when sent. A signed RTR is required before qualifying.`
      : 'The document is frozen when sent. A signed RTR is required before qualifying.';

  return (
    <SendRtrModal
      talentName={talentName}
      clientName={clientName}
      requisitionTitle={requisitionTitle}
      templateLine={templateLine}
      recipientEmail={recipientEmail}
      footNote={footNote}
      composePreview={compose?.preview ?? null}
      disabledText={failClosed}
      sendDisabled={loading}
      sendLabel="Review document"
      onPreview={() => {
        /* compose preview is rendered inline by the modal; no presigned URL exists pre-request */
      }}
      onSend={onSend}
      onClose={onClose}
    />
  );
}
