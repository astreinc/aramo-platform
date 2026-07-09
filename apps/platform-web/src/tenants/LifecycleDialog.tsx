import { useState } from 'react';
import {
  ApiError,
  Button,
  Dialog,
  FormField,
  InlineAlert,
} from '@aramo/fe-foundation';

import { platformApi } from '../platform-api';

export type LifecycleAction =
  | 'suspend'
  | 'reactivate'
  | 'offboarding'
  | 'close';

const TITLES: Record<LifecycleAction, string> = {
  suspend: 'Suspend tenant',
  reactivate: 'Reactivate tenant',
  offboarding: 'Start offboarding',
  close: 'Close tenant',
};

const REASON_CODES = [
  'ap_violation',
  'non_payment',
  'security_incident',
  'tenant_request',
  'contract_end',
  'resolved',
  'offboarding_complete',
  'other',
];

interface Props {
  readonly action: LifecycleAction;
  readonly tenantId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDone: () => void;
}

// A confirmation-gated lifecycle action dialog (P3). Reason requirements mirror
// the transition service: SUSPEND needs code + text; REACTIVATE + CLOSE need
// code; OFFBOARDING needs closeAt + retentionPolicyCode. Typed 4xx from the
// service (illegal transition 422, missing reason, etc.) render as an InlineAlert
// with the reason. CLOSE carries an extra confirmation checkbox.
export function LifecycleDialog({
  action,
  tenantId,
  open,
  onOpenChange,
  onDone,
}: Props) {
  const [reasonCode, setReasonCode] = useState<string>(REASON_CODES[0] ?? 'other');
  const [reasonText, setReasonText] = useState('');
  const [closeAt, setCloseAt] = useState('');
  const [retentionPolicyCode, setRetentionPolicyCode] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = (): void => {
    setReasonText('');
    setCloseAt('');
    setRetentionPolicyCode('');
    setConfirmClose(false);
    setError(null);
    setBusy(false);
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (action === 'suspend') {
        await platformApi.suspend(tenantId, { reasonCode, reasonText });
      } else if (action === 'reactivate') {
        await platformApi.reactivate(tenantId, { reasonCode });
      } else if (action === 'offboarding') {
        await platformApi.startOffboarding(tenantId, {
          retentionPolicyCode,
          closeAt: new Date(closeAt).toISOString(),
          reasonCode,
        });
      } else {
        await platformApi.close(tenantId, { reasonCode, reasonText });
      }
      reset();
      onOpenChange(false);
      onDone();
    } catch (e) {
      // Typed 4xx → surface the reason honestly (illegal transition, missing
      // reason, etc.). details.reason is the transition service's machine code.
      const reason =
        e instanceof ApiError
          ? (e.details?.['reason'] as string | undefined)
          : undefined;
      setError(
        e instanceof ApiError
          ? `${e.message}${reason ? ` (${reason})` : ''}`
          : 'Action failed.',
      );
      setBusy(false);
    }
  };

  const disabled =
    busy ||
    (action === 'suspend' && reasonText.trim().length === 0) ||
    (action === 'offboarding' &&
      (closeAt.length === 0 || retentionPolicyCode.trim().length === 0)) ||
    (action === 'close' && !confirmClose);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title={TITLES[action]}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={disabled}>
            {busy ? 'Working…' : TITLES[action]}
          </Button>
        </>
      }
    >
      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}

      <FormField label="Reason code">
        <select
          className="tc-input"
          value={reasonCode}
          onChange={(e) => setReasonCode(e.target.value)}
        >
          {REASON_CODES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </FormField>

      {action === 'suspend' || action === 'close' ? (
        <FormField
          label={action === 'suspend' ? 'Reason (required)' : 'Reason (optional)'}
        >
          <textarea
            className="tc-input"
            rows={3}
            value={reasonText}
            onChange={(e) => setReasonText(e.target.value)}
            placeholder="Operator note…"
          />
        </FormField>
      ) : null}

      {action === 'offboarding' ? (
        <>
          <FormField label="Close date">
            <input
              className="tc-input"
              type="date"
              value={closeAt}
              onChange={(e) => setCloseAt(e.target.value)}
            />
          </FormField>
          <FormField
            label="Retention policy code"
            helper="Opaque string — policy semantics TBD (counsel-gated)."
          >
            <input
              className="tc-input"
              value={retentionPolicyCode}
              onChange={(e) => setRetentionPolicyCode(e.target.value)}
              placeholder="e.g. standard_90d"
            />
          </FormField>
        </>
      ) : null}

      {action === 'close' ? (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <input
            type="checkbox"
            checked={confirmClose}
            onChange={(e) => setConfirmClose(e.target.checked)}
          />
          <span>I understand this closes the tenant (terminal).</span>
        </label>
      ) : null}
    </Dialog>
  );
}
