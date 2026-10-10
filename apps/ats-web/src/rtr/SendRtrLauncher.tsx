import { useEffect, useState } from 'react';

import { SendRtrModal } from './SendRtrModal';
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
  const code = (e as { code?: string } | null)?.code;
  if (code === 'RTR_TEMPLATE_NOT_CONFIGURED' || code === 'RTR_TEMPLATE_CONFIGURATION_INVALID') {
    return 'Your workspace has not approved a Right to Represent template yet. Ask an admin to approve one in Settings → Documents.';
  }
  if (code === 'RTR_TEMPLATE_BINDING_MISSING' || code === 'TEMPLATE_BINDING_UNSUPPORTED') {
    return 'This RTR can’t be prepared yet — a required detail (such as the requisition reference) is missing. Complete the requisition, then try again.';
  }
  return messageOf(e);
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

  // Send = the EXISTING governed lifecycle: request the RTR document, then send it
  // for signature. A missing authoritative binding fails CLOSED (surfaced inline).
  const onSend = async (): Promise<{ ok: boolean; missingText?: string }> => {
    try {
      const { document_id } = await requestRtr({ talent_id: talentId, requisition_id: requisitionId, company_id: companyId });
      await sendRtr(document_id, talentId);
      onSent?.();
      onClose();
      return { ok: true };
    } catch (e) {
      // Fail-closed: surface every send failure honestly and keep Send disabled.
      return { ok: false, missingText: describeError(e) };
    }
  };

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
      onPreview={() => {
        /* compose preview is rendered inline by the modal; no presigned URL exists pre-request */
      }}
      onSend={onSend}
      onClose={onClose}
    />
  );
}
