import { useEffect, useState } from 'react';
import { Button, Dialog, InlineAlert, Select } from '@aramo/fe-foundation';

import { addTalentToPipeline } from '../pipeline/pipeline-api';
import { listRequisitions } from '../requisitions/requisitions-api';
import type { RequisitionView } from '../requisitions/types';

// Add-to-requisition dialog — extracted from TalentDetailView so both the
// Talent Detail surface and Talent 360 reuse the SAME flow (the sanctioned
// pipeline-add path: listRequisitions → addTalentToPipeline, idempotent on
// 409/422). No business logic is cloned; this is the one shared dialog.
export function AddToRequisitionDialog({
  open,
  onClose,
  talentId,
}: {
  open: boolean;
  onClose: () => void;
  talentId: string;
}) {
  const [reqs, setReqs] = useState<readonly RequisitionView[]>([]);
  const [reqId, setReqId] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadErr(false);
    setAdded(false);
    setActionErr(null);
    setReqId('');
    listRequisitions()
      .then((r) => {
        if (cancelled) return;
        setReqs(r.items.filter((x) => x.status === 'open'));
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadErr(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const onAdd = () => {
    if (reqId === '') return;
    setBusy(true);
    setActionErr(null);
    addTalentToPipeline(talentId, reqId)
      .then(() => {
        setBusy(false);
        setAdded(true);
      })
      .catch((err: unknown) => {
        setBusy(false);
        const status = (err as { status?: number } | null)?.status;
        // Already on this pipeline — treat as success (idempotent intent).
        if (status === 409 || status === 422) {
          setAdded(true);
          return;
        }
        setActionErr('We couldn’t add this talent to the requisition. Please try again.');
      });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add to requisition"
    >
      {loading ? (
        <p>Loading requisitions…</p>
      ) : loadErr ? (
        <InlineAlert variant="error">Could not load requisitions.</InlineAlert>
      ) : added ? (
        <>
          <InlineAlert variant="success">Talent added to the requisition.</InlineAlert>
          <div className="talent-detail__dialog-actions">
            <Button variant="secondary" onClick={onClose}>Done</Button>
          </div>
        </>
      ) : reqs.length === 0 ? (
        <p className="talent-detail__empty">No open requisitions to add to.</p>
      ) : (
        <>
          <label className="talent-detail__dialog-field">
            <span>Requisition</span>
            <Select
              value={reqId}
              onChange={(e) => setReqId(e.target.value)}
              aria-label="Requisition"
            >
              <option value="">Choose a requisition…</option>
              {reqs.map((r) => (
                <option key={r.id} value={r.id}>{r.title}</option>
              ))}
            </Select>
          </label>
          {actionErr !== null ? (
            <InlineAlert variant="error">{actionErr}</InlineAlert>
          ) : null}
          <div className="talent-detail__dialog-actions">
            <Button variant="primary" onClick={onAdd} disabled={reqId === '' || busy}>
              {busy ? 'Adding…' : 'Add to requisition'}
            </Button>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
