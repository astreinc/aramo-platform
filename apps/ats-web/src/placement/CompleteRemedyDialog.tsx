import { Button, Dialog, FormField, InlineAlert, useToast } from '@aramo/fe-foundation';
import { useState } from 'react';

import { formatMoney } from './commercial-format';
import { completeRemedy } from './permanent-placement-api';
import { remedyErrorMessage } from './permanent-error-messages';
import type { PermanentPlacementRemedyView, PermanentPlacementView } from './permanent-placement-types';

// Track 7 / T7-P5 §5.4 — complete the remedy OBLIGATION with governed completion EVIDENCE.
// REPLACEMENT → a validated replacement placement-process reference (the server validates the
// same-requisition / permanent / STARTED constraint and maps failures to actionable copy; NO new
// lookup route, §3.6). REFUND / PRORATED_CREDIT → a bounded completion/external reference; the
// server-derived obligation amount is shown READ-ONLY and is never editable. The caller supplies
// NO amount and NO actor (completed_by = JWT sub). Wording uses "completion evidence"/"obligation";
// never payment. Mounted only in a remedy-due state while the actor holds placement:remedy:resolve.
interface Props {
  readonly open: boolean;
  readonly placementId: string;
  readonly remedy: PermanentPlacementRemedyView;
  readonly onClose: () => void;
  readonly onCompleted: () => void;
  readonly completeRemedyFn?: (
    id: string,
    body: { replacement_placement_process_id?: string; external_reference?: string },
  ) => Promise<PermanentPlacementView>;
}

export function CompleteRemedyDialog({ open, placementId, remedy, onClose, onCompleted, completeRemedyFn }: Props) {
  const completeFun = completeRemedyFn ?? completeRemedy;
  const isReplacement = remedy.remedy_type === 'REPLACEMENT';
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const reset = () => {
    setReference('');
    setBusy(false);
    setError(null);
  };

  const submit = async () => {
    if (reference.trim() === '') {
      setError(isReplacement ? 'Enter the replacement placement reference.' : 'Enter the completion evidence reference.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await completeFun(
        placementId,
        isReplacement
          ? { replacement_placement_process_id: reference.trim() }
          : { external_reference: reference.trim() },
      );
      toast.show('Remedy completion recorded.');
      reset();
      onCompleted();
      onClose();
    } catch (err) {
      setError(remedyErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
      title="Complete this remedy obligation"
      description="Record the governed completion evidence for this remedy obligation. Aramo records the obligation only — it does not execute any payment or settlement."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy} data-testid="remedy-complete-confirm">
            {busy ? 'Recording…' : 'Record completion evidence'}
          </Button>
        </>
      }
    >
      {!isReplacement && remedy.calculated_amount !== null && remedy.currency !== null && (
        <p className="rc-muted-line" data-testid="remedy-dialog-amount">
          Obligation amount (read-only): {formatMoney(remedy.calculated_amount, remedy.currency, '')} — an obligation, not a payment.
        </p>
      )}
      {isReplacement ? (
        <FormField
          label="Replacement placement reference"
          helper="The replacement must be a permanent placement on the same requisition that has started."
        >
          <input
            className="rc-input"
            type="text"
            aria-label="Replacement placement reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            disabled={busy}
            data-testid="remedy-replacement-input"
          />
        </FormField>
      ) : (
        <FormField
          label="Completion evidence reference"
          helper="A governed reference for the completed remedy obligation."
        >
          <input
            className="rc-input"
            type="text"
            aria-label="Completion evidence reference"
            maxLength={255}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            disabled={busy}
            data-testid="remedy-reference-input"
          />
        </FormField>
      )}
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
    </Dialog>
  );
}
