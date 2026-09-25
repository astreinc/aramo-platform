import { Button } from '@aramo/fe-foundation';
import { useState } from 'react';

import { requestRtr, sendRtr, getRtrStatus } from './rtr-api';

// DOC-5 (R-5-12) — the recruiter-facing RTR panel for a (talent, requisition,
// company) context: request the RTR, send it for the Talent's signature, and
// view the DERIVED status. Backend stays authoritative for status/readiness;
// this panel only presents it.

const STATUS_LABEL: Record<string, string> = {
  REQUESTED: 'Requested — preparing',
  AWAITING_SIGNATURE: 'Awaiting signature',
  EXECUTED: 'Executed',
};

export interface RtrPanelProps {
  talentId: string;
  requisitionId: string;
  companyId: string;
}

export function RtrPanel({ talentId, requisitionId, companyId }: RtrPanelProps): JSX.Element {
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
      const res = await requestRtr({ talent_id: talentId, requisition_id: requisitionId, company_id: companyId });
      setDocumentId(res.document_id);
      setStatus('REQUESTED');
    });

  const onSend = (): Promise<void> =>
    run(async () => {
      if (documentId === null) return;
      await sendRtr(documentId, talentId);
      setStatus('AWAITING_SIGNATURE');
    });

  const onRefresh = (): Promise<void> =>
    run(async () => {
      if (documentId === null) return;
      const res = await getRtrStatus(documentId);
      setStatus(res.status);
    });

  return (
    <section className="rtr-panel" aria-label="Right to Represent">
      <h3>Right to Represent</h3>
      {documentId === null ? (
        <Button unstyled type="button" onClick={() => void onRequest()} disabled={busy}>
          Request RTR
        </Button>
      ) : (
        <div className="rtr-actions">
          <p>
            Status: <strong>{status !== null ? (STATUS_LABEL[status] ?? status) : 'Unknown'}</strong>
          </p>
          <Button unstyled type="button" onClick={() => void onSend()} disabled={busy || status === 'EXECUTED'}>
            Send for signature
          </Button>
          <Button unstyled type="button" onClick={() => void onRefresh()} disabled={busy}>
            Refresh status
          </Button>
        </div>
      )}
      {error.length > 0 && <p className="rtr-error" role="alert">{error}</p>}
    </section>
  );
}
