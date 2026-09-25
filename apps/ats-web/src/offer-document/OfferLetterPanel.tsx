import { Button } from '@aramo/fe-foundation';
import { useState } from 'react';

import {
  requestOfferDocument,
  sendOfferDocument,
  getOfferDocumentStatus,
} from './offer-document-api';

// DOC-6 (R-6-8) — the recruiter-facing Offer Letter panel. Sits ALONGSIDE the Offer
// status + Offer workflow actions (Accept / Continue Negotiation / Rescind), which are
// the existing offer aggregate surface and are NOT rendered here. Makes the intended
// dual state legible (PL-1): the Offer Letter can be Signed while the Offer is still
// SENT — the recruiter accepts the offer explicitly, later, via the offer surface.
// Backend stays authoritative for status; this panel only presents the derived label.
//
// PL-5: NO Copy-link / Resend action — the signing link is delivered to the Talent by
// the E-Sign notification at send time; it is never exposed for client-side copy.

const STATUS_LABEL: Record<string, string> = {
  PREPARING: 'Preparing',
  AWAITING_SIGNATURE: 'Awaiting signature',
  EXECUTED: 'Signed / Executed',
};

export interface OfferLetterPanelProps {
  offerId: string;
  /** The Offer aggregate's own state (e.g. SENT) — shown for the dual-state view; unchanged by signing. */
  offerState: string;
}

export function OfferLetterPanel({ offerId, offerState }: OfferLetterPanelProps): JSX.Element {
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRequest = (): Promise<void> =>
    run(async () => {
      const res = await requestOfferDocument({ offer_id: offerId });
      setDocumentId(res.document_id);
      setStatus('PREPARING');
    });

  const onSend = (): Promise<void> =>
    run(async () => {
      if (documentId === null) return;
      await sendOfferDocument(documentId, offerId);
      setStatus('AWAITING_SIGNATURE');
    });

  const onRefresh = (): Promise<void> =>
    run(async () => {
      if (documentId === null) return;
      const res = await getOfferDocumentStatus(documentId);
      setStatus(res.status);
    });

  const executed = status === 'EXECUTED';

  return (
    <section className="offer-letter-panel" aria-label="Offer Letter">
      <h3>Offer Letter</h3>
      {/* Dual-state view (PL-1): the Offer's own status is independent of the letter's. */}
      <p className="offer-letter-offer-state">
        Offer: <strong>{offerState}</strong>
      </p>
      {documentId === null ? (
        <Button unstyled type="button" onClick={() => void onRequest()} disabled={busy}>
          Request offer letter
        </Button>
      ) : (
        <div className="offer-letter-actions">
          <p>
            Letter: <strong>{status !== null ? (STATUS_LABEL[status] ?? status) : 'Unknown'}</strong>
          </p>
          <Button unstyled type="button" onClick={() => void onSend()} disabled={busy || executed}>
            Send for signature
          </Button>
          <Button unstyled type="button" onClick={() => void onRefresh()} disabled={busy}>
            Refresh status
          </Button>
          {executed && (
            <div className="offer-letter-executed">
              <a href={`/v1/documents/${documentId}/artifacts`}>View Executed Offer</a>
              <a href={`/v1/documents/${documentId}/artifacts`}>View Execution Certificate</a>
            </div>
          )}
        </div>
      )}
      {error.length > 0 && <p className="offer-letter-error" role="alert">{error}</p>}
    </section>
  );
}
