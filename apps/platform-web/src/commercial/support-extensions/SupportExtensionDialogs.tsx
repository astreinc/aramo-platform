import { useMemo, useState } from 'react';
import { ApiError } from '@aramo/fe-foundation';

import { SupportField, SupportRequestDialog } from '../../components/SupportRequestDialog';

import {
  newIdempotencyKey,
  supportExtensionApi,
  type SupportChangeRequest,
  type SupportExtension,
  type SupportExtensionOutcome,
  type SupportPolicy,
  type SupportSubscription,
} from './support-extension-api';
import { clauseHelp, previewExtension, shortRef } from './support-extension-model';

// CCP-B6 — the two dialogs of the support workflow (CCP-UI v1.0 handoff §5.9, §5.10;
// Commercial Control Plane v1.0.dc.html `dlgExt`).
//
//   RequestExtensionDialog  days + reason, the live preview (within bounds → "Apply extension
//                           (exception)"; out of bounds → the Finance chain strip and "Submit for
//                           approval"). ONE call: POST /support-extensions. The server decides; a
//                           breach is escalated, never applied (PBD §5.3 B6 row).
//   RemoveExtensionDialog   reason; a SUPPORT_EXTENSION change request with operation REMOVE,
//                           submitted to Finance (TD-A8-5). Never removes anything itself.

/** Q7 / TD-A3-2: an escalated extension and a removal go to the Finance-only chain. */
const FINANCE_CHAIN = { label: 'Below threshold', steps: ['Finance'] } as const;

export function refusalText(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Something went wrong. Try again in a minute.';
  const reason = typeof err.details?.['reason'] === 'string' ? (err.details['reason'] as string) : null;
  const code = `${err.status} ${err.code ?? 'ERROR'}${reason ? ` · ${reason}` : ''}`;
  if (reason === 'open_request_exists') return `Refused: another request on this product is open. It must close first. (${code})`;
  if (reason === 'subscription_not_open') return `Refused: the subscription is no longer open. Reload and try again. (${code})`;
  if (err.code === 'COMMERCIAL_POLICY_UNAVAILABLE') return `Refused: no commercial policy is active, so nothing can be decided. (${code})`;
  if (err.status === 403) return `Refused: your account doesn’t hold the permission for this. (${code})`;
  return `Refused. (${code})`;
}

export interface RequestExtensionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly subscription: SupportSubscription;
  readonly policy: SupportPolicy | null;
  readonly prior: readonly SupportExtension[];
  readonly actorName: string;
  readonly actorRoles: string;
  readonly now: () => Date;
  readonly onDone: (out: SupportExtensionOutcome) => void;
}

export function RequestExtensionDialog({ open, onOpenChange, tenantId, tenantName, subscription, policy, prior, actorName, actorRoles, now, onDone }: RequestExtensionDialogProps) {
  // Design `init: { days: 7 }`.
  const [days, setDays] = useState('7');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const n = Number(days);
  const preview = useMemo(
    () => previewExtension({ days: Number.isInteger(n) ? n : NaN, prior, policy, subscription, now: now() }),
    [n, prior, policy, subscription, now],
  );
  const clause = policy?.clause;
  const within = preview?.withinBounds ?? false;
  const valid = Number.isInteger(n) && n >= 1 && reason.trim().length > 0 && policy !== null;

  const commit = async (): Promise<void> => {
    setBusy(true);
    setAlert(null);
    try {
      const out = await supportExtensionApi.request({
        tenant_id: tenantId,
        subscription_id: subscription.id,
        requested_days: n,
        reason: reason.trim(),
        idempotency_key: newIdempotencyKey('b6-ext'),
      });
      onDone(out);
    } catch (err) {
      setAlert(refusalText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SupportRequestDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Request support extension · ${tenantName}`}
      sub={
        subscription.source === 'SELF_SERVICE'
          ? 'Extends access as an overlay. Stripe billing dates and invoices don’t change.'
          : 'Extends the current period as an overlay on the MANUAL subscription.'
      }
      preview={
        preview === null
          ? null
          : within
            ? {
                tone: 'ok',
                title: 'Within bounds — applies now as an exception, with zero approvals',
                lines: [
                  `Actor: ${actorName} · roles: ${actorRoles}`,
                  `Policy clause: v${policy?.version_number ?? '—'}`,
                  `Uses in the ${clause?.support_extension_frequency_window_days ?? '—'}-day window: ${preview.use.uses} → ${preview.use.uses + 1}`,
                  `Cumulative days: ${preview.use.cumulative} → ${preview.use.cumulative + preview.days} (cap ${clause?.support_extension_cumulative_max_days ?? '—'})`,
                  'Recorded in audit with the exception flag',
                ],
              }
            : {
                tone: 'warn',
                title: 'Out of bounds — escalates to approval (Finance)',
                lines: [preview.why, 'The request goes to Pending approval and applies only after it is signed.'],
              }
      }
      chain={preview !== null && !within && policy !== null ? { ...FINANCE_CHAIN, policy: `v${policy.version_number}`, window: `${policy.approval_expiry_hours} h` } : null}
      alert={alert ?? (policy === null ? 'No commercial policy is active, so an extension can’t be decided right now.' : null)}
      // Design `commitFn`: the exception commit only while the preview says within bounds.
      commitLabel={within ? 'Apply extension (exception)' : 'Submit for approval'}
      tone="terra"
      canCommit={valid}
      busy={busy}
      onCommit={() => void commit()}
    >
      <SupportField
        kind="number"
        label="Extension (days)"
        value={days}
        min={1}
        max={60}
        onChange={setDays}
        help={policy === null ? undefined : clauseHelp(policy)}
      />
      <SupportField label="Reason" value={reason} onChange={setReason} placeholder="Why the tenant needs more time" />
    </SupportRequestDialog>
  );
}

export interface RemoveExtensionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly tenantId: string;
  readonly extension: SupportExtension;
  readonly policy: SupportPolicy | null;
  readonly onDone: (request: SupportChangeRequest) => void;
}

export function RemoveExtensionDialog({ open, onOpenChange, tenantId, extension, policy, onDone }: RemoveExtensionDialogProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  // One key per dialog: a retried commit replays instead of creating a second request.
  const [key] = useState(() => newIdempotencyKey('b6-remove'));

  const commit = async (): Promise<void> => {
    setBusy(true);
    setAlert(null);
    try {
      onDone(await supportExtensionApi.requestRemoval({ tenant_id: tenantId, support_extension_id: extension.id, reason: reason.trim(), idempotency_key: key }));
    } catch (err) {
      setAlert(refusalText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SupportRequestDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Request removal · EXT-${shortRef(extension.id)}`}
      sub="Ends the overlay once Finance approves and you apply it. Stripe billing dates and invoices don’t change."
      chain={policy === null ? null : { ...FINANCE_CHAIN, policy: `v${policy.version_number}`, window: `${policy.approval_expiry_hours} h` }}
      alert={alert}
      commitLabel="Submit for approval"
      tone="danger"
      canCommit={reason.trim().length > 0}
      busy={busy}
      onCommit={() => void commit()}
    >
      <SupportField label="Reason" value={reason} onChange={setReason} placeholder="Why the extension should end" />
    </SupportRequestDialog>
  );
}
