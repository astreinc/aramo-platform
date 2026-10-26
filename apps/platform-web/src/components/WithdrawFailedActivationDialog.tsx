import { useState } from 'react';

import { CommercialRequestDialog } from './CommercialRequestDialog';

// CCP-UI-V12 (CCP-UI v1.2 handoff §17.3, §17.4; Architect ruling TD-ACC-1 Option B) — the
// requester's withdrawal of an APPLY_FAILED policy activation, on the §5.10 dialog (danger): the
// consequence, the "Request state: Apply failed → Withdrawn" change, and the two refusals inline
// (role="alert"; commit stays disabled after "already applied"). The server decides: it
// revalidates the requester, reconciles a committed-but-unacknowledged activation to APPLIED and
// refuses while an apply is in flight.
//
// DV-V12-6: no "Reason (required)" field. The ACC-1 withdraw route
// (POST /platform/commercial/change-requests/{id}/withdraw) takes no body, so a reason typed here
// could not be recorded (missing backend contract MBC-V12-1). `onWithdraw` therefore takes none.

export type WithdrawOutcome = 'WITHDRAWN' | 'ALREADY_APPLIED' | 'APPLY_IN_PROGRESS';

export interface WithdrawFailedActivationDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The request reference shown in the title ("CR-1053", or the short id). */
  readonly requestLabel: string;
  /** The policy version the request activates (null when unknown). */
  readonly policyVersion: number | null;
  /** Calls the withdraw route and maps its answer (other errors reject with a message). */
  readonly onWithdraw: () => Promise<WithdrawOutcome>;
  /** After WITHDRAWN (the caller closes, toasts, reloads). */
  readonly onWithdrawn: () => void;
  /** After ALREADY_APPLIED (the caller reloads: the request now reads APPLIED). */
  readonly onReconciled?: () => void;
}

export const WITHDRAW_REFUSAL: Readonly<Record<Exclude<WithdrawOutcome, 'WITHDRAWN'>, string>> = {
  ALREADY_APPLIED: 'This activation was applied. It can’t be withdrawn.',
  APPLY_IN_PROGRESS: 'An apply is still in progress. Try again shortly.',
};

export function WithdrawFailedActivationDialog({ open, onOpenChange, requestLabel, policyVersion, onWithdraw, onWithdrawn, onReconciled }: WithdrawFailedActivationDialogProps) {
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const commit = async (): Promise<void> => {
    setBusy(true);
    setAlert(null);
    try {
      const out = await onWithdraw();
      if (out === 'WITHDRAWN') {
        onWithdrawn();
        return;
      }
      setAlert(WITHDRAW_REFUSAL[out]);
      if (out === 'ALREADY_APPLIED') {
        setApplied(true);
        onReconciled?.();
      }
    } catch (e) {
      setAlert(e instanceof Error && e.message ? e.message : 'The request couldn’t be withdrawn. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <CommercialRequestDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Withdraw ${requestLabel} · Activate policy ${policyVersion === null ? 'version' : `v${policyVersion}`}`}
      sub="This request ends. Activating this version again needs a new request."
      diff={[{ field: 'Request state', before: 'Apply failed', after: 'Withdrawn', changed: true }]}
      alert={alert}
      commitLabel="Withdraw request"
      tone="danger"
      canCommit={!applied}
      busy={busy}
      onCommit={() => void commit()}
    />
  );
}
