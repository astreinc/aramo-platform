import { Button, Dialog, InlineAlert, RadioGroup, type RadioOption, useToast } from '@aramo/fe-foundation';
import { useState } from 'react';

import { endPlacementAssignment } from './placement-api';
import {
  ASSIGNMENT_END_REASON_LABELS,
  ASSIGNMENT_END_REASON_VALUES,
  type ContractAssignmentEndReason,
} from './types';

// Track 4 (T4-E) — the safe END confirmation for an ACTIVE ContractAssignment.
// Ending is final, so it follows the house destructive-confirm convention
// (ProposalDismissDialog): a Dialog size="sm" with an explicit Cancel + a
// confirm carrying a data-testid, a busy label, and inline error surface. The
// ending reason is chosen from the AUTHORITATIVE taxonomy only
// (COMPLETED / WORKER_ENDED / CLIENT_ENDED — never an invented state) and is
// sent verbatim to POST /v1/placements/{id}/assignment/end. This component
// never renders itself as authorized: the parent only mounts it when the
// assignment is ACTIVE and the actor holds assignment:end.
interface Props {
  readonly open: boolean;
  readonly placementId: string;
  readonly onClose: () => void;
  /** Re-read the authoritative assignment so the panel shows the ENDED truth. */
  readonly onEnded: () => void;
  readonly endAssignmentFn?: (
    id: string,
    endReason: ContractAssignmentEndReason,
  ) => Promise<{ ok: true }>;
}

const REASON_OPTIONS: ReadonlyArray<RadioOption<ContractAssignmentEndReason>> =
  ASSIGNMENT_END_REASON_VALUES.map((value) => ({
    value,
    label: ASSIGNMENT_END_REASON_LABELS[value],
  }));

export function EndAssignmentDialog({
  open,
  placementId,
  onClose,
  onEnded,
  endAssignmentFn,
}: Props) {
  const endFun = endAssignmentFn ?? endPlacementAssignment;
  const [reason, setReason] = useState<ContractAssignmentEndReason>('COMPLETED');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const reset = () => {
    setReason('COMPLETED');
    setBusy(false);
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await endFun(placementId, reason);
      toast.show('Assignment ended.');
      reset();
      // Do NOT flip lifecycle locally — re-read authoritative server truth.
      onEnded();
      onClose();
    } catch {
      setError('Could not end the assignment. Please try again.');
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
      title="End this assignment?"
      description="Ending an assignment is final. Choose the ending reason for the record."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy}
            data-testid="assignment-end-confirm"
          >
            {busy ? 'Ending…' : 'End assignment'}
          </Button>
        </>
      }
    >
      <fieldset className="rc-field">
        <legend className="rc-field__label">Ending reason</legend>
        <RadioGroup
          name="assignment-end-reason"
          value={reason}
          options={REASON_OPTIONS}
          onValueChange={setReason}
          disabled={busy}
        />
      </fieldset>
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
    </Dialog>
  );
}
