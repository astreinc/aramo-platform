import { useEffect, useId, useMemo, useState } from 'react';
import { Input, Select } from '@aramo/fe-foundation';

import {
  ChainPreview,
  CommercialRequestDialog,
  RequestField,
  type CommercialDiffRow,
} from '../../components';
import type { SupportPolicy } from '../support-extensions/support-extension-api';

import {
  REFUND_BASIS_MAX,
  REFUND_CATEGORY_OPTIONS,
  amountText,
  moneyLabel,
  parseAmount,
  paymentBlockedWhy,
  refundDraftError,
  refundPayload,
} from './refund-model';
import {
  newRequestKey,
  subscriptionsApi,
  type ChangeRequestRef,
  type RefundablePayment,
  type RefundablePayments,
} from './subscriptions-api';
import { refusalLine } from './subscriptions-model';

// Aramo-CCP-Console-Refund-Request-Directive-v1_0-LOCKED §2 item 2 — Tenant › Commercial "Request
// refund". It CREATES AND SUBMITS a REFUND change request and nothing else: the Finance → Owner chain
// signs it, the requester applies it, and Stripe confirms by webhook (unchanged CCP-C4 flow). The
// payment list and each remainder are the server's (refundable-payments read); the policy reference
// comes from the ACTIVE policy and is read-only (A1 RF-8, A2 RX-8).

export interface RefundRequestDialogProps {
  readonly tenantId: string;
  readonly tenantName: string;
  /** The ACTIVE policy's `refund_policy_ref` (the action is not offered without one). */
  readonly policyRef: string;
  readonly policy: Pick<SupportPolicy, 'version_number' | 'approval_expiry_hours'> | null;
  readonly onClose: () => void;
  readonly onDone: (request: ChangeRequestRef, submitted: boolean) => void;
  /** Test seam: the read. */
  readonly load?: (tenantId: string) => Promise<RefundablePayments>;
}

const dateLabel = (iso: string | null): string =>
  iso === null
    ? '—'
    : new Date(iso).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      });

function paymentOption(p: RefundablePayment): string {
  const why = paymentBlockedWhy(p);
  const head = `${p.number ?? p.invoice_ref} · ${dateLabel(p.created_at)} · paid ${moneyLabel(p.amount_paid_minor, p.currency)}`;
  return why === null
    ? `${head} · ${moneyLabel(p.remainder_minor, p.currency)} refundable`
    : `${head} · not refundable`;
}

export function RefundRequestDialog({
  tenantId,
  tenantName,
  policyRef,
  policy,
  onClose,
  onDone,
  load = (id) => subscriptionsApi.refundablePayments(id),
}: RefundRequestDialogProps) {
  const [read, setRead] = useState<RefundablePayments | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [invoiceRef, setInvoiceRef] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [basis, setBasis] = useState('');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const paymentId = useId();
  const amountId = useId();
  const categoryId = useId();
  const key = useMemo(() => newRequestKey('refund'), []);

  useEffect(() => {
    let cancelled = false;
    load(tenantId).then(
      (r) => {
        if (cancelled) return;
        setRead(r);
        // Default: the newest refundable payment, for its full remainder.
        const first = r.payments.find((p) => paymentBlockedWhy(p) === null) ?? null;
        if (first !== null) {
          setInvoiceRef(first.invoice_ref);
          setAmount(amountText(first.remainder_minor ?? 0));
        }
      },
      (err: unknown) => {
        if (!cancelled) setReadError(refusalLine(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tenantId, load]);

  const payments = read?.payments ?? [];
  const payment = payments.find((p) => p.invoice_ref === invoiceRef) ?? null;
  const draft = { payment, amountText: amount, category, basis };
  const problem = refundDraftError(draft);
  const payload = refundPayload(draft, policyRef, read?.subscription_id ?? null);
  const valid = payload !== null && reason.trim().length > 0 && evidence.trim().length > 0;
  const minor = parseAmount(amount);

  const empty =
    read === null
      ? null
      : read.availability !== 'AVAILABLE'
        ? (read.detail ?? `Stripe payments can’t be read (${read.availability}).`)
        : payments.length === 0
          ? 'No paid Stripe invoices on the open subscription.'
          : payments.every((p) => paymentBlockedWhy(p) !== null)
            ? 'No payment has anything left to refund.'
            : null;

  const diff: CommercialDiffRow[] =
    payment === null
      ? []
      : [
          {
            field: 'Payment',
            before: payment.number ?? payment.invoice_ref,
            after: payment.number ?? payment.invoice_ref,
            changed: false,
          },
          {
            field: 'Refundable',
            before: moneyLabel(payment.remainder_minor, payment.currency),
            after: moneyLabel(
              minor === null ? null : Math.max((payment.remainder_minor ?? 0) - minor, 0),
              payment.currency,
            ),
            changed: minor !== null && minor > 0,
          },
          {
            field: 'Refund',
            before: '—',
            after: minor === null ? '—' : moneyLabel(minor, payment.currency),
            changed: minor !== null && minor > 0,
          },
          { field: 'Policy', before: policyRef, after: policyRef, changed: false },
        ];

  const commit = async (): Promise<void> => {
    if (payload === null) return;
    setBusy(true);
    setAlert(null);
    try {
      const request = await subscriptionsApi.request({
        action_type: 'REFUND',
        tenant_id: tenantId,
        payload,
        reason,
        evidence,
        submit: true,
        idempotency_key: key,
      });
      onDone(request, true);
    } catch (err) {
      setAlert(refusalLine(err));
      setBusy(false);
    }
  };

  return (
    <CommercialRequestDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Request refund · ${tenantName}`}
      sub={`Refunds a Stripe payment of the open self-service subscription. Nothing is refunded until Finance and the Owner sign and you apply it; Stripe confirms by webhook.`}
      diff={diff}
      chain={
        <ChainPreview
          label="Refund"
          steps={['Finance', 'Owner']}
          policy={policy ? `v${policy.version_number}` : '—'}
          window={policy ? `${policy.approval_expiry_hours} h` : '—'}
        />
      }
      typed={{ token: tenantName, value: typed, onChange: setTyped }}
      alert={
        alert ??
        readError ??
        empty ??
        (read !== null &&
        payment !== null &&
        problem !== null &&
        (amount !== '' || category !== '' || basis !== '')
          ? problem
          : null)
      }
      commitLabel="Submit for approval"
      tone="danger"
      canCommit={valid}
      busy={busy}
      onCommit={() => void commit()}
      secondary={null}
    >
      <div className="pw-crd__field">
        <label className="pw-crd__label" htmlFor={paymentId}>
          Payment
        </label>
        <Select
          unstyled
          id={paymentId}
          className="cs-dlg-select"
          value={invoiceRef}
          disabled={read === null || payments.length === 0}
          onChange={(e) => {
            setInvoiceRef(e.target.value);
            const p = payments.find((x) => x.invoice_ref === e.target.value);
            setAmount(
              p && p.remainder_minor !== null && p.remainder_minor > 0
                ? amountText(p.remainder_minor)
                : '',
            );
          }}
        >
          {read === null ? <option value="">Loading payments…</option> : null}
          {payments.map((p) => (
            <option
              key={p.invoice_ref}
              value={p.invoice_ref}
              disabled={paymentBlockedWhy(p) !== null}
            >
              {paymentOption(p)}
            </option>
          ))}
        </Select>
        {payment !== null && paymentBlockedWhy(payment) !== null ? (
          <span className="cs-dlg-help">{paymentBlockedWhy(payment)}</span>
        ) : null}
      </div>
      <div className="pw-crd__field">
        <label className="pw-crd__label" htmlFor={amountId}>
          Amount{payment?.currency ? ` (${payment.currency})` : ''}
        </label>
        <Input
          unstyled
          id={amountId}
          className="cs-dlg-num"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-describedby={`${amountId}-help`}
        />
        <span id={`${amountId}-help`} className="cs-dlg-help">
          {payment !== null
            ? `At most ${moneyLabel(payment.remainder_minor, payment.currency)}.`
            : ''}
        </span>
      </div>
      <div className="pw-crd__field">
        <label className="pw-crd__label" htmlFor={categoryId}>
          Category
        </label>
        <Select
          unstyled
          id={categoryId}
          className="cs-dlg-select"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">Choose a category…</option>
          {REFUND_CATEGORY_OPTIONS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </div>
      <RequestField
        label={`Basis (contractual or legal, max ${REFUND_BASIS_MAX})`}
        value={basis}
        onChange={setBasis}
        placeholder="e.g. ToS 2.0 B5.3 — corrects a verified duplicate charge"
        multiline
      />
      <div className="pw-crd__field">
        <span className="pw-crd__label">Refund policy</span>
        <span className="cs-dlg-help" data-testid="refund-policy-ref">
          {policyRef} (from the active commercial policy)
        </span>
      </div>
      <RequestField
        label="Reason"
        value={reason}
        onChange={setReason}
        placeholder="Why this refund is needed"
        multiline
      />
      <RequestField
        label="Evidence"
        value={evidence}
        onChange={setEvidence}
        placeholder="Ticket, email or call notes reference"
      />
    </CommercialRequestDialog>
  );
}
