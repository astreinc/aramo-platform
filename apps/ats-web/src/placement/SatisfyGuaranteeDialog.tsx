import { Button, Dialog, InlineAlert, useToast } from '@aramo/fe-foundation';
import { useState } from 'react';

import { satisfyGuarantee } from './permanent-placement-api';
import { satisfyErrorMessage } from './permanent-error-messages';
import type { PermanentPlacementView } from './permanent-placement-types';

// Track 7 / T7-P5 §5.4 — the satisfy-guarantee confirmation. Confirmation-driven; no caller
// actor (the server owns the acting principal). On success the parent re-reads authoritative
// server truth — the lifecycle is NEVER flipped optimistically. A premature satisfy is a
// governed 422 rendered as actionable copy. The parent only mounts this when the guarantee is
// active and the actor holds placement:permanent:transition.
interface Props {
  readonly open: boolean;
  readonly placementId: string;
  readonly onClose: () => void;
  /** Re-read the authoritative permanent placement so the panel shows the satisfied truth. */
  readonly onSatisfied: () => void;
  readonly satisfyFn?: (id: string) => Promise<PermanentPlacementView>;
}

export function SatisfyGuaranteeDialog({ open, placementId, onClose, onSatisfied, satisfyFn }: Props) {
  const satisfyFun = satisfyFn ?? satisfyGuarantee;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const reset = () => {
    setBusy(false);
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await satisfyFun(placementId);
      toast.show('Guarantee satisfied.');
      reset();
      onSatisfied();
      onClose();
    } catch (err) {
      setError(satisfyErrorMessage(err));
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
      title="Satisfy this guarantee?"
      description="Marking the guarantee satisfied is final. It can only be satisfied on or after the guarantee end date."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy} data-testid="guarantee-satisfy-confirm">
            {busy ? 'Satisfying…' : 'Satisfy guarantee'}
          </Button>
        </>
      }
    >
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
    </Dialog>
  );
}
