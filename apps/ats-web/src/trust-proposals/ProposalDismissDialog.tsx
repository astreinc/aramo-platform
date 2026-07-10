import { useState } from 'react';
import { Button, Dialog, InlineAlert, useToast } from '@aramo/fe-foundation';

import { dismissProposal } from './trust-proposals-api';

interface Props {
  readonly proposalId: string | null;
  readonly onClose: () => void;
  /** Re-fetch the queue so the dismissed row drops from the OPEN tab. */
  readonly onDismissed: () => void;
}

// TR-12 B2 (§3.2) — dismiss a proposal from the Trust Proposals queue. A
// justification is required (the reviewer says why a proposal is not worth
// acting on; it is never silent). Disposes of the proposal ROW only — no ledger
// effect (propose-never-dispose). On success the queue refetches.
export function ProposalDismissDialog({ proposalId, onClose, onDismissed }: Props) {
  const [justification, setJustification] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const canSubmit = proposalId !== null && !busy && justification.trim().length > 0;

  const reset = () => {
    setJustification('');
    setError(null);
    setBusy(false);
  };

  const submit = async () => {
    if (proposalId === null) return;
    setBusy(true);
    setError(null);
    try {
      await dismissProposal(proposalId, justification.trim());
      toast.show('Proposal dismissed.');
      reset();
      onDismissed();
      onClose();
    } catch {
      setError('Could not dismiss the proposal. Please try again.');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={proposalId !== null}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
      title="Dismiss this proposal?"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!canSubmit}
            data-testid="proposal-dismiss-confirm"
          >
            {busy ? 'Dismissing…' : 'Dismiss'}
          </Button>
        </>
      }
    >
      <InlineAlert variant="success">
        Dismissing removes this from the queue. It won’t come back for the same
        reason. Say why for the record.
      </InlineAlert>
      <label className="rc-field rc-mt-16">
        <span className="rc-field__label">Justification (required)</span>
        <textarea
          className="rc-select"
          rows={3}
          value={justification}
          maxLength={2000}
          onChange={(e) => setJustification(e.target.value)}
          placeholder="Why this proposal isn’t worth acting on…"
        />
      </label>
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
    </Dialog>
  );
}
