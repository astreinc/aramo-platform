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

import { createAssignmentCommercialRevision } from './placement-api';
import { isValidCurrency, isValidMoney } from './commercial-format';
import type {
  AssignmentCommercialCreatedResponse,
  CommercialRevisionCreateRequest,
} from './types';

// Track 6 / T6-B4 §10 + DateTime amendment §4/§7 — the create-revision dialog. B4 v1 is
// EFFECTIVE-NOW ONLY: there is NO effective_from input, the request omits effective_from
// (the type has no such field), and the server supplies the authoritative instant. The
// dialog states the revision takes effect immediately. Fields are pay/bill (money strings),
// currency + rate_period (prefilled from the current version — both never-masked, so
// prefilling them leaks nothing, §10), and a required change_reason. Masked pay/bill are
// NEVER prefilled. On success: toast, refresh server truth, close. On a governed conflict
// (409) the underlying panel is refreshed and a controlled inline message is shown (§16);
// no optimistic insertion. The server remains authoritative for all validation.
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
  /** Prefill from the current version (never-masked fields only). */
  readonly defaultCurrency?: string;
  readonly defaultRatePeriod?: string;
  readonly onClose: () => void;
  /** Re-read authoritative server truth (current projection + series + lifecycle). */
  readonly onRefresh: () => void;
  readonly createFn?: (
    id: string,
    body: CommercialRevisionCreateRequest,
  ) => Promise<AssignmentCommercialCreatedResponse>;
}

// Map a create failure to controlled, non-leaking copy (§16). Never renders raw server text.
function messageForError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT') {
    const reason = (err.details as { reason?: unknown } | undefined)?.reason;
    if (reason === 'duplicate_effective_from' || reason === 'window_overlap') {
      return 'This commercial change conflicts with the current schedule. The latest terms have been refreshed — please review and try again.';
    }
    return 'The assignment commercial state changed. The latest terms have been refreshed — please review and try again.';
  }
  if (err instanceof ApiError && err.status === 404) {
    return 'This assignment is no longer available for a commercial revision. The latest state has been refreshed.';
  }
  if (err instanceof ApiError && err.status === 400) {
    return 'Some values were rejected. Please check the amounts, currency and rate period and try again.';
  }
  return 'Could not save the commercial revision. Please try again.';
}

export function CommercialRevisionFormDialog({
  open,
  placementId,
  defaultCurrency,
  defaultRatePeriod,
  onClose,
  onRefresh,
  createFn,
}: Props) {
  const create = createFn ?? createAssignmentCommercialRevision;
  const toast = useToast();
  const [pay, setPay] = useState('');
  const [bill, setBill] = useState('');
  const [currency, setCurrency] = useState((defaultCurrency ?? '').toUpperCase());
  const [ratePeriod, setRatePeriod] = useState(defaultRatePeriod ?? 'HOURLY');
  const [changeReason, setChangeReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});

  const reset = () => {
    setPay('');
    setBill('');
    setCurrency((defaultCurrency ?? '').toUpperCase());
    setRatePeriod(defaultRatePeriod ?? 'HOURLY');
    setChangeReason('');
    setBusy(false);
    setError(null);
    setFieldError({});
  };

  const validate = (): boolean => {
    const fe: Record<string, string> = {};
    if (!isValidMoney(pay)) fe['pay'] = 'Enter a valid amount (up to 2 decimals).';
    if (!isValidMoney(bill)) fe['bill'] = 'Enter a valid amount (up to 2 decimals).';
    if (!isValidCurrency(currency)) fe['currency'] = 'Enter a 3-letter currency code (e.g. USD).';
    if (changeReason.trim().length === 0) fe['changeReason'] = 'A change reason is required.';
    setFieldError(fe);
    return Object.keys(fe).length === 0;
  };

  const submit = async () => {
    setError(null);
    if (!validate()) return;
    setBusy(true);
    try {
      // Effective-now ONLY — effective_from is deliberately absent (amendment §4).
      await create(placementId, {
        pay_rate_amount: pay.trim(),
        bill_rate_amount: bill.trim(),
        currency: currency.trim().toUpperCase(),
        rate_period: ratePeriod,
        change_reason: changeReason.trim(),
      });
      toast.show('Commercial revision saved.');
      reset();
      onRefresh();
      onClose();
    } catch (err) {
      // No optimistic insertion — refresh authoritative server truth, show controlled copy.
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
      title="New commercial revision"
      description="The new terms take effect immediately upon save. The server records the effective instant."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy} data-testid="commercial-revision-create-confirm">
            {busy ? 'Saving…' : 'Save revision'}
          </Button>
        </>
      }
    >
      <FormField label="Pay rate" error={fieldError['pay']}>
        <input
          className="rc-input"
          inputMode="decimal"
          value={pay}
          onChange={(e) => setPay(e.target.value)}
          disabled={busy}
          data-testid="commercial-revision-pay-input"
        />
      </FormField>
      <FormField label="Bill rate" error={fieldError['bill']}>
        <input
          className="rc-input"
          inputMode="decimal"
          value={bill}
          onChange={(e) => setBill(e.target.value)}
          disabled={busy}
          data-testid="commercial-revision-bill-input"
        />
      </FormField>
      <FormField label="Currency" error={fieldError['currency']}>
        <input
          className="rc-input"
          maxLength={3}
          value={currency}
          onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          disabled={busy}
          data-testid="commercial-revision-currency-input"
        />
      </FormField>
      <fieldset className="rc-field">
        <legend className="rc-field__label">Rate period</legend>
        <RadioGroup
          name="commercial-revision-rate-period"
          value={ratePeriod}
          options={RATE_PERIOD_OPTIONS}
          onValueChange={setRatePeriod}
          disabled={busy}
        />
      </fieldset>
      <FormField label="Change reason" error={fieldError['changeReason']}>
        <textarea
          className="rc-input"
          rows={2}
          maxLength={2000}
          value={changeReason}
          onChange={(e) => setChangeReason(e.target.value)}
          disabled={busy}
          data-testid="commercial-revision-reason-input"
        />
      </FormField>
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
    </Dialog>
  );
}
