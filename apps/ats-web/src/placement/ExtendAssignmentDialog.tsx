import {
  Button,
  Dialog,
  InlineAlert,
  RadioGroup,
  type RadioOption,
  useToast,
} from '@aramo/fe-foundation';
import { useState } from 'react';

import { extendPlacementAssignment } from './placement-api';
import {
  ASSIGNMENT_EXTENSION_REASON_LABELS,
  ASSIGNMENT_EXTENSION_REASON_VALUES,
  type AssignmentExtensionReason,
  type ContractAssignmentView,
  type ExtendAssignmentRequest,
} from './types';

// Slice #3 — the Extend confirmation for an ACTIVE ContractAssignment. Extension is a
// governed COMMAND (a new planned end + reason + optional comment), never a bare date
// edit; the BE enforces strictly-forward (ASSIGNMENT_EXTENSION_NOT_FORWARD). No
// lifecycle transition occurs. Mirrors EndAssignmentDialog's house confirm shape.
// The parent mounts this only when the assignment is ACTIVE and the actor holds
// assignment:extend.
interface Props {
  readonly open: boolean;
  readonly placementId: string;
  readonly currentExpectedEnd: string | null;
  readonly onClose: () => void;
  /** Re-read the authoritative assignment so the panel shows the new horizon. */
  readonly onExtended: () => void;
  readonly extendAssignmentFn?: (
    id: string,
    body: ExtendAssignmentRequest,
  ) => Promise<ContractAssignmentView>;
}

const REASON_OPTIONS: ReadonlyArray<RadioOption<AssignmentExtensionReason>> =
  ASSIGNMENT_EXTENSION_REASON_VALUES.map((value) => ({
    value,
    label: ASSIGNMENT_EXTENSION_REASON_LABELS[value],
  }));

export function ExtendAssignmentDialog({
  open,
  placementId,
  currentExpectedEnd,
  onClose,
  onExtended,
  extendAssignmentFn,
}: Props) {
  const extendFun = extendAssignmentFn ?? extendPlacementAssignment;
  const [newEnd, setNewEnd] = useState('');
  const [reason, setReason] = useState<AssignmentExtensionReason>('CLIENT_REQUEST');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const reset = () => {
    setNewEnd('');
    setReason('CLIENT_REQUEST');
    setComment('');
    setBusy(false);
    setError(null);
  };

  const submit = async () => {
    if (newEnd === '') {
      setError('Choose the new planned end date.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await extendFun(placementId, {
        new_expected_end_at: newEnd,
        reason,
        ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
      });
      toast.show('Assignment extended.');
      reset();
      // Do NOT mutate locally — re-read authoritative server truth.
      onExtended();
      onClose();
    } catch {
      setError(
        'Could not extend the assignment. The new planned end must be later than the current one.',
      );
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
      title="Extend this assignment?"
      description="Move the planned end forward. This records an extension in the history — the lifecycle stays ACTIVE."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy}
            data-testid="assignment-extend-confirm"
          >
            {busy ? 'Extending…' : 'Extend assignment'}
          </Button>
        </>
      }
    >
      <label className="rc-field">
        <span className="rc-field__label">New planned end</span>
        <input
          type="date"
          className="rc-input"
          value={newEnd}
          min={currentExpectedEnd?.slice(0, 10)}
          onChange={(e) => setNewEnd(e.target.value)}
          disabled={busy}
          data-testid="assignment-extend-date"
        />
      </label>
      <fieldset className="rc-field">
        <legend className="rc-field__label">Extension reason</legend>
        <RadioGroup
          name="assignment-extend-reason"
          value={reason}
          options={REASON_OPTIONS}
          onValueChange={setReason}
          disabled={busy}
        />
      </fieldset>
      <label className="rc-field">
        <span className="rc-field__label">Comment (optional)</span>
        <input
          type="text"
          className="rc-input"
          value={comment}
          maxLength={2000}
          onChange={(e) => setComment(e.target.value)}
          disabled={busy}
          data-testid="assignment-extend-comment"
        />
      </label>
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
    </Dialog>
  );
}
