import { Button } from '@aramo/fe-foundation';

// Accidental-Add Correction — the "Remove from requisition" confirmation (§15). This is a
// CORRECTION confirmation, NOT a generic destructive dialog: it never says "Delete", it
// states explicitly that the Talent record is preserved and that this is not a
// "Not in consideration" disposition. Reason is fixed to "Added by mistake" (v1 vocabulary).
export interface RemoveFromRequisitionModalProps {
  readonly talentName: string;
  readonly busy: boolean;
  readonly error: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function RemoveFromRequisitionModal({
  talentName,
  busy,
  error,
  onCancel,
  onConfirm,
}: RemoveFromRequisitionModalProps): JSX.Element {
  return (
    <div className="rc-voidmodal__scrim" role="presentation" onClick={onCancel}>
      <div
        className="rc-voidmodal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rc-voidmodal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="rc-voidmodal-title" className="rc-voidmodal__title">
          Remove {talentName} from this requisition?
        </h2>
        <p className="rc-voidmodal__body">
          Use this only if the Talent was added by mistake. This does not delete the Talent
          record or mark the Talent as “Not in consideration”.
        </p>
        <div className="rc-voidmodal__reason">
          <span className="rc-voidmodal__reason-label">Reason</span>
          <span className="rc-voidmodal__reason-value">Added by mistake</span>
        </div>
        {error.length > 0 && (
          <p className="rc-voidmodal__error" role="alert">
            {error}
          </p>
        )}
        <div className="rc-voidmodal__actions">
          <Button unstyled type="button" className="rc-voidmodal__cancel" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button unstyled type="button" className="rc-voidmodal__confirm" onClick={onConfirm} disabled={busy}>
            {busy ? 'Removing…' : 'Remove from requisition'}
          </Button>
        </div>
      </div>
    </div>
  );
}
