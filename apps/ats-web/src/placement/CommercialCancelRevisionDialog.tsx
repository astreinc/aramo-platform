import {
  ApiError,
  Button,
  Dialog,
  InlineAlert,
  RadioGroup,
  type RadioOption,
  useToast,
} from '@aramo/fe-foundation';
import { useState } from 'react';

import { cancelAssignmentCommercialRevision } from './placement-api';
import { CommercialMaskedValue } from './CommercialMaskedState';
import { formatMoney } from './commercial-format';
import {
  COMMERCIAL_CANCELLATION_REASON_LABELS,
  COMMERCIAL_CANCELLATION_REASON_VALUES,
  type AssignmentCommercialSeriesResponse,
  type AssignmentCommercialView,
  type CommercialCancellationReasonCode,
} from './types';

// Track 6 / T6-B4 §12/§13 — cancel a future open-tail commercial revision. Follows the
// house destructive-confirm convention (EndAssignmentDialog): a Dialog size="sm" with an
// explicit Cancel + a confirm carrying a data-testid, a busy label, and inline error
// surface. The reason is chosen from the CLOSED user vocabulary ONLY — ASSIGNMENT_ENDED is
// never offered. The dialog explains that the prior terms resume and shows the predecessor
// pay/bill ONLY if readable (masked otherwise, §7). On success: toast, refresh server truth,
// close. On a governed conflict (stale eligibility) the panel is refreshed and controlled
// inline copy is shown (§16). No optimistic cancellation. The parent mounts this only for
// an eligible future open-tail row (§12).
const REASON_OPTIONS: ReadonlyArray<RadioOption<CommercialCancellationReasonCode>> =
  COMMERCIAL_CANCELLATION_REASON_VALUES.map((value) => ({
    value,
    label: COMMERCIAL_CANCELLATION_REASON_LABELS[value],
  }));

interface Props {
  readonly open: boolean;
  readonly placementId: string;
  /** The scheduled future open-tail revision being cancelled. */
  readonly revision: AssignmentCommercialView;
  /** The predecessor window that will resume, when known/readable (for the resume note). */
  readonly predecessor?: AssignmentCommercialView;
  readonly onClose: () => void;
  /** Re-read authoritative server truth (current projection + series + lifecycle). */
  readonly onRefresh: () => void;
  readonly cancelFn?: (
    id: string,
    revisionId: string,
    body: { cancellation_reason_code: CommercialCancellationReasonCode },
  ) => Promise<AssignmentCommercialSeriesResponse>;
}

function messageForError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT') {
    return 'This scheduled revision can no longer be cancelled — its state changed. The latest terms have been refreshed.';
  }
  if (err instanceof ApiError && err.status === 404) {
    return 'This scheduled revision is no longer available. The latest state has been refreshed.';
  }
  return 'Could not cancel the scheduled revision. Please try again.';
}

export function CommercialCancelRevisionDialog({
  open,
  placementId,
  revision,
  predecessor,
  onClose,
  onRefresh,
  cancelFn,
}: Props) {
  const cancel = cancelFn ?? cancelAssignmentCommercialRevision;
  const toast = useToast();
  const [reason, setReason] = useState<CommercialCancellationReasonCode>('SCHEDULE_WITHDRAWN');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setReason('SCHEDULE_WITHDRAWN');
    setBusy(false);
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await cancel(placementId, revision.assignment_rate_version_id, { cancellation_reason_code: reason });
      toast.show('Scheduled revision cancelled.');
      reset();
      onRefresh();
      onClose();
    } catch (err) {
      onRefresh();
      setError(messageForError(err));
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
      title="Cancel this scheduled revision?"
      description="Cancelling withdraws this future commercial change. The prior terms resume."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Keep revision
          </Button>
          <Button onClick={() => void submit()} disabled={busy} data-testid="commercial-revision-cancel-confirm">
            {busy ? 'Cancelling…' : 'Cancel revision'}
          </Button>
        </>
      }
    >
      {predecessor !== undefined && (
        <p className="rc-muted-line" data-testid="commercial-cancel-resume">
          Prior terms that resume:{' '}
          {predecessor.pay_rate_amount === undefined ? (
            <CommercialMaskedValue />
          ) : (
            formatMoney(predecessor.pay_rate_amount, predecessor.currency, predecessor.rate_period)
          )}{' '}
          pay ·{' '}
          {predecessor.bill_rate_amount === undefined ? (
            <CommercialMaskedValue />
          ) : (
            formatMoney(predecessor.bill_rate_amount, predecessor.currency, predecessor.rate_period)
          )}{' '}
          bill
        </p>
      )}
      <fieldset className="rc-field">
        <legend className="rc-field__label">Cancellation reason</legend>
        <RadioGroup
          name="commercial-cancel-reason"
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
