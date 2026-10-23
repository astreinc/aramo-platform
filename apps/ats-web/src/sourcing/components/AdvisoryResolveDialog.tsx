import { useState } from 'react';
import { Button, Dialog, InlineAlert, useToast, TextArea } from '@aramo/fe-foundation';

import { approveAdvisory, dismissAdvisory } from '../sourcing-api';
import { advisoryErrorMessage } from '../error-messages';

export type AdvisoryAction = 'approve' | 'dismiss';

// Minimal structural shape the dialog needs from EITHER caller: the sourcing
// SubjectAdvisory OR the identity-advisories worklist item. ATI-SEP-1 T10 WP2 —
// the ATS duplicate advisory carries the shared contact KINDS (named, never
// values) and its basis; the trust-only contradiction flags are gone.
export interface ResolvableAdvisory {
  readonly id: string;
  readonly basis?: string;
  readonly shared_kinds?: readonly string[];
}

interface Props {
  readonly advisory: ResolvableAdvisory | null;
  readonly action: AdvisoryAction;
  readonly onClose: () => void;
  /** Re-fetch so the resolved advisory drops off the list. */
  readonly onResolved: () => void;
}

// "Shares EMAIL, PHONE" — null when no kinds are populated.
function kindsSummary(kinds: readonly string[] | undefined): string | null {
  if (kinds === undefined || kinds.length === 0) return null;
  return `Shares ${kinds.join(', ')}`;
}

// Inline advisory resolution — approve (the same person) or dismiss (not the
// same person), reusing the privileged /advisories POSTs (identity:resolve; the
// caller gates the trigger button). Uses the shared small confirm Dialog;
// success toasts past-tense, errors render inline.
export function AdvisoryResolveDialog({ advisory, action, onClose, onResolved }: Props) {
  const [justification, setJustification] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const summary = kindsSummary(advisory?.shared_kinds);
  const isArrival = advisory?.basis === 'SOURCED_ARRIVAL';
  const canSubmit = advisory !== null && !busy;

  const reset = () => {
    setJustification('');
    setError(null);
    setBusy(false);
  };

  const submit = async () => {
    if (advisory === null) return;
    setBusy(true);
    setError(null);
    const reason = justification.trim();
    try {
      if (action === 'approve') {
        await approveAdvisory(advisory.id, reason.length > 0 ? { justification: reason } : {});
        toast.show(isArrival ? 'Linked to the existing talent.' : 'Identity merge approved.');
      } else {
        await dismissAdvisory(advisory.id, reason.length > 0 ? { justification: reason } : {});
        toast.show('Advisory dismissed.');
      }
      reset();
      onResolved();
      onClose();
    } catch (err) {
      setError(advisoryErrorMessage(err));
      setBusy(false);
    }
  };

  const title =
    action === 'approve'
      ? isArrival
        ? 'Link to the existing talent?'
        : 'Approve this identity merge?'
      : 'Dismiss this advisory?';
  const confirmLabel =
    action === 'approve'
      ? busy
        ? 'Approving…'
        : isArrival
          ? 'Link to talent'
          : 'Approve merge'
      : busy
        ? 'Dismissing…'
        : 'Dismiss advisory';

  return (
    <Dialog
      open={advisory !== null}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit} data-testid="advisory-confirm">
            {confirmLabel}
          </Button>
        </>
      }
    >
      {summary !== null ? (
        <p className="rc-muted-line mono" data-testid="advisory-kinds">
          {summary}
        </p>
      ) : null}

      {action === 'approve' ? (
        <InlineAlert variant="success">
          {isArrival
            ? 'Approving records that this sourced arrival is the existing talent. It leaves the sourcing pool. This can be reversed later from the advisory queue.'
            : 'Approving merges these two talent records into one. This can be reversed later from the advisory queue.'}
        </InlineAlert>
      ) : (
        <InlineAlert variant="success">
          Dismissing keeps them separate. You can note why for the record.
        </InlineAlert>
      )}

      <label className="rc-field rc-mt-16">
        <span className="rc-field__label">Note (optional)</span>
        <TextArea unstyled
          className="rc-select"
          rows={3}
          value={justification}
          maxLength={2000}
          onChange={(e) => setJustification(e.target.value)}
          placeholder="Optional note…"
        />
      </label>

      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
    </Dialog>
  );
}
