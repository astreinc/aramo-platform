import {
  ApiError,
  Button,
  Dialog,
  FormField,
  InlineAlert,
  RadioGroup,
  type RadioOption,
  useToast,
} from '@aramo/fe-foundation';
import { useState } from 'react';

import { computeMarginPreview } from './commercial-preview';
import { isValidCurrency, isValidMoney } from './commercial-format';
import { proposeCommercialRevision } from './placement-api';
import type {
  AssignmentCommercialView,
  CommercialProposalMutationResponse,
  ProposeCommercialRevisionRequest,
} from './types';

// Slice #4 — the PROPOSE dialog. It mirrors CommercialRevisionFormDialog's structure (the
// same money/currency/rate-period/reason fields and the same house Dialog chrome) but posts
// to the proposals endpoint: a proposal is INTENT, not applied truth. It adds a LIVE
// current → proposed → delta margin preview computed from the entered values against the
// current terms (integer-cent math via computeMarginPreview — never float margin math). A
// masked current side renders the non-leaking indicator. effective_from is not captured in
// v1 (the server supplies the authoritative instant); the proposal advances only after a
// separate authority decision. On success: toast, refresh server truth, close. On a governed
// 409 (a live proposal already exists) a controlled inline message is shown.
const RATE_PERIOD_OPTIONS: ReadonlyArray<RadioOption<string>> = [
  { value: 'HOURLY', label: 'Hourly' },
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'ANNUAL', label: 'Annual' },
];

interface Props {
  readonly open: boolean;
  readonly placementId: string;
  /** The current effective terms — the baseline for the live margin preview. */
  readonly current: AssignmentCommercialView | null;
  readonly onClose: () => void;
  /** Re-read authoritative server truth (proposals + current projection). */
  readonly onRefresh: () => void;
  readonly proposeFn?: (
    id: string,
    body: ProposeCommercialRevisionRequest,
  ) => Promise<CommercialProposalMutationResponse>;
}

function messageForError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'COMMERCIAL_PROPOSAL_ALREADY_LIVE') {
    return 'A commercial proposal is already in progress for this assignment. The latest state has been refreshed — resolve it before proposing another.';
  }
  if (err instanceof ApiError && err.status === 400) {
    return 'Some values were rejected. Please check the amounts, currency and rate period and try again.';
  }
  return 'Could not submit the commercial proposal. Please try again.';
}

export function CommercialProposeDialog({
  open,
  placementId,
  current,
  onClose,
  onRefresh,
  proposeFn,
}: Props) {
  const propose = proposeFn ?? proposeCommercialRevision;
  const toast = useToast();
  const [pay, setPay] = useState('');
  const [bill, setBill] = useState('');
  const [currency, setCurrency] = useState((current?.currency ?? '').toUpperCase());
  const [ratePeriod, setRatePeriod] = useState(current?.rate_period ?? 'HOURLY');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});

  const reset = () => {
    setPay('');
    setBill('');
    setCurrency((current?.currency ?? '').toUpperCase());
    setRatePeriod(current?.rate_period ?? 'HOURLY');
    setReason('');
    setBusy(false);
    setError(null);
    setFieldError({});
  };

  const validate = (): boolean => {
    const fe: Record<string, string> = {};
    if (!isValidMoney(pay)) fe['pay'] = 'Enter a valid amount (up to 2 decimals).';
    if (!isValidMoney(bill)) fe['bill'] = 'Enter a valid amount (up to 2 decimals).';
    if (!isValidCurrency(currency)) fe['currency'] = 'Enter a 3-letter currency code (e.g. USD).';
    if (reason.trim().length === 0) fe['reason'] = 'A reason is required.';
    setFieldError(fe);
    return Object.keys(fe).length === 0;
  };

  const submit = async () => {
    setError(null);
    if (!validate()) return;
    setBusy(true);
    try {
      await propose(placementId, {
        pay_rate_amount: pay.trim(),
        bill_rate_amount: bill.trim(),
        currency: currency.trim().toUpperCase(),
        rate_period: ratePeriod,
        reason: reason.trim(),
      });
      toast.show('Commercial proposal submitted.');
      reset();
      onRefresh();
      onClose();
    } catch (err) {
      onRefresh();
      setError(messageForError(err));
      setBusy(false);
    }
  };

  // Live preview — recomputed on every render from the entered values against current terms.
  const effectiveCurrency = currency || current?.currency || 'USD';
  const preview = computeMarginPreview({
    currentPay: current?.pay_rate_amount,
    currentBill: current?.bill_rate_amount,
    currentCurrency: current?.currency ?? effectiveCurrency,
    currentRatePeriod: current?.rate_period ?? ratePeriod,
    proposedPay: pay,
    proposedBill: bill,
    proposedCurrency: effectiveCurrency,
    proposedRatePeriod: ratePeriod,
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
      title="Propose a commercial revision"
      description="A proposal is a request to change the commercial terms. It becomes effective only after margin review, client approval and apply."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy}
            data-testid="commercial-proposal-create-confirm"
          >
            {busy ? 'Submitting…' : 'Submit proposal'}
          </Button>
        </>
      }
    >
      <FormField label="Proposed pay rate" error={fieldError['pay']}>
        <input
          className="rc-input"
          inputMode="decimal"
          value={pay}
          onChange={(e) => setPay(e.target.value)}
          disabled={busy}
          data-testid="commercial-proposal-pay-input"
        />
      </FormField>
      <FormField label="Proposed bill rate" error={fieldError['bill']}>
        <input
          className="rc-input"
          inputMode="decimal"
          value={bill}
          onChange={(e) => setBill(e.target.value)}
          disabled={busy}
          data-testid="commercial-proposal-bill-input"
        />
      </FormField>
      <FormField label="Currency" error={fieldError['currency']}>
        <input
          className="rc-input"
          maxLength={3}
          value={currency}
          onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          disabled={busy}
          data-testid="commercial-proposal-currency-input"
        />
      </FormField>
      <fieldset className="rc-field">
        <legend className="rc-field__label">Rate period</legend>
        <RadioGroup
          name="commercial-proposal-rate-period"
          value={ratePeriod}
          options={RATE_PERIOD_OPTIONS}
          onValueChange={setRatePeriod}
          disabled={busy}
        />
      </fieldset>
      <FormField label="Reason" error={fieldError['reason']}>
        <textarea
          className="rc-input"
          rows={2}
          maxLength={2000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
          data-testid="commercial-proposal-reason-input"
        />
      </FormField>

      {preview !== null && (
        <dl className="rc-deflist" data-testid="commercial-proposal-preview">
          <div className="rc-defrow">
            <dt>Current</dt>
            <dd className="num">
              <span data-testid="commercial-proposal-preview-current-pay">{preview.current.pay}</span>
              {' pay · '}
              <span data-testid="commercial-proposal-preview-current-bill">{preview.current.bill}</span>
              {' bill · '}
              <span data-testid="commercial-proposal-preview-current-margin">{preview.current.margin}</span>
              {' margin'}
            </dd>
          </div>
          <div className="rc-defrow">
            <dt>Proposed</dt>
            <dd className="num">
              <span data-testid="commercial-proposal-preview-proposed-pay">{preview.proposed.pay}</span>
              {' pay · '}
              <span data-testid="commercial-proposal-preview-proposed-bill">{preview.proposed.bill}</span>
              {' bill · '}
              <span data-testid="commercial-proposal-preview-proposed-margin">{preview.proposed.margin}</span>
              {' margin'}
            </dd>
          </div>
          <div className="rc-defrow">
            <dt>Change</dt>
            <dd className="num">
              <span data-testid="commercial-proposal-preview-pay-delta">{preview.payDelta}</span>
              {' pay · '}
              <span data-testid="commercial-proposal-preview-bill-delta">{preview.billDelta}</span>
              {' bill · '}
              <span data-testid="commercial-proposal-preview-margin-delta">{preview.marginPointDelta}</span>
              {' margin pts'}
            </dd>
          </div>
        </dl>
      )}

      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
    </Dialog>
  );
}
