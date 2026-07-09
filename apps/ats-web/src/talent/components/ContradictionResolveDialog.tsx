import { useState } from 'react';
import { Button, Dialog, InlineAlert, useToast } from '@aramo/fe-foundation';

import { resolveContradiction, type ContradictionItem } from '../dossier-api';

interface Props {
  readonly item: ContradictionItem | null;
  readonly onClose: () => void;
  /** Re-fetch the dossier so the lifted (VALID) state renders. */
  readonly onResolved: () => void;
}

// TR-14 B2 (§3.4) — resolve a standing contradiction from the Trust tab, via the
// privileged TR-4 endpoint (identity:resolve; the caller gates the trigger). A
// justification is required (R4 audit — the reason threads into the resolved
// event). On success the dossier refetches and the cap lifts.
export function ContradictionResolveDialog({ item, onClose, onResolved }: Props) {
  const [justification, setJustification] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const canSubmit = item !== null && !busy && justification.trim().length > 0;

  const reset = () => {
    setJustification('');
    setError(null);
    setBusy(false);
  };

  const submit = async () => {
    if (item === null) return;
    setBusy(true);
    setError(null);
    try {
      await resolveContradiction(item.evidence_id, justification.trim());
      toast.show('Contradiction resolved.');
      reset();
      onResolved();
      onClose();
    } catch {
      setError('Could not resolve the contradiction. Please try again.');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={item !== null}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
      title="Resolve this contradiction?"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit} data-testid="contradiction-confirm">
            {busy ? 'Resolving…' : 'Resolve'}
          </Button>
        </>
      }
    >
      <InlineAlert variant="success">
        Resolving marks this evidence valid again and lifts the cap it placed on the
        dimension. Say why for the record.
      </InlineAlert>
      {item?.reason != null && item.reason !== '' ? (
        <p className="rc-muted-line">Raised because: {item.reason}</p>
      ) : null}
      <label className="rc-field rc-mt-16">
        <span className="rc-field__label">Justification (required)</span>
        <textarea
          className="rc-select"
          rows={3}
          value={justification}
          maxLength={2000}
          onChange={(e) => setJustification(e.target.value)}
          placeholder="Why this is not a real conflict…"
        />
      </label>
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
    </Dialog>
  );
}
