import { Button, Dialog, FormField, InlineAlert, RadioGroup, type RadioOption, useToast } from '@aramo/fe-foundation';
import { useState } from 'react';

import { isValidCurrency, isValidMoney } from '../placement/commercial-format';

import { createGuaranteeTerms, reviseGuaranteeTerms } from './guarantee-terms-api';
import { guaranteeTermsErrorMessage } from './guarantee-terms-error-messages';
import {
  GUARANTEE_TERMS_SOURCE_VALUES,
  GUARANTEE_TERMS_SOURCE_LABELS,
  TERMS_REMEDY_POLICY_LABELS,
  TERMS_REMEDY_POLICY_VALUES,
  type GuaranteeTermVersionView,
  type GuaranteeTermsSourceType,
  type TermsRemedyPolicy,
} from './guarantee-terms-types';

// Track 7 / T7-P5 §5.5 — create or revise the reusable requisition-level guarantee terms.
// `mode='create'` posts the initial (open) version; `mode='revise'` first-closes the current
// version and inserts a successor. Effective date is a calendar `<input type="date">` (bare
// yyyy-mm-dd, no timezone conversion). Money/currency use the shared T6 client guards
// (isValidMoney/isValidCurrency) pre-submit; the server is authoritative. The copy makes explicit
// that a revision applies to FUTURE activations only — already-started permanent placements keep
// the snapshot captured at activation. No cancellation. On success the parent re-reads server
// truth (never optimistic).
interface Props {
  readonly open: boolean;
  readonly mode: 'create' | 'revise';
  readonly requisitionId: string;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly createFn?: typeof createGuaranteeTerms;
  readonly reviseFn?: typeof reviseGuaranteeTerms;
}

const POLICY_OPTIONS: ReadonlyArray<RadioOption<TermsRemedyPolicy>> = TERMS_REMEDY_POLICY_VALUES.map((value) => ({
  value,
  label: TERMS_REMEDY_POLICY_LABELS[value],
}));
const SOURCE_OPTIONS: ReadonlyArray<RadioOption<GuaranteeTermsSourceType>> = GUARANTEE_TERMS_SOURCE_VALUES.map(
  (value) => ({ value, label: GUARANTEE_TERMS_SOURCE_LABELS[value] }),
);

export function GuaranteeTermsFormDialog({ open, mode, requisitionId, onClose, onSaved, createFn, reviseFn }: Props) {
  const createFun = createFn ?? createGuaranteeTerms;
  const reviseFun = reviseFn ?? reviseGuaranteeTerms;
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [durationDays, setDurationDays] = useState('');
  const [remedyPolicy, setRemedyPolicy] = useState<TermsRemedyPolicy>('REFUND');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('');
  const [sourceType, setSourceType] = useState<GuaranteeTermsSourceType>('MANUAL');
  const [sourceReference, setSourceReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const reset = () => {
    setEffectiveFrom('');
    setDurationDays('');
    setRemedyPolicy('REFUND');
    setAmount('');
    setCurrency('');
    setSourceType('MANUAL');
    setSourceReference('');
    setBusy(false);
    setError(null);
  };

  const validate = (): string | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) return 'Choose an effective date.';
    const days = Number(durationDays);
    if (!Number.isInteger(days) || days <= 0) return 'Duration must be a positive whole number of days.';
    if (!isValidMoney(amount)) return 'Enter a valid exposure amount.';
    if (!isValidCurrency(currency)) return 'Enter a 3-letter currency code.';
    return null;
  };

  const submit = async () => {
    const v = validate();
    if (v !== null) {
      setError(v);
      return;
    }
    setBusy(true);
    setError(null);
    const body = {
      effective_from: effectiveFrom,
      guarantee_duration_days: Number(durationDays),
      remedy_policy: remedyPolicy,
      guarantee_exposure_amount: amount.trim(),
      currency: currency.trim().toUpperCase(),
      source_type: sourceType,
      ...(sourceReference.trim() === '' ? {} : { source_reference: sourceReference.trim() }),
    };
    try {
      const saved: GuaranteeTermVersionView =
        mode === 'create' ? await createFun(requisitionId, body) : await reviseFun(requisitionId, body);
      void saved;
      toast.show(mode === 'create' ? 'Guarantee terms created.' : 'Guarantee terms revised.');
      reset();
      onSaved();
      onClose();
    } catch (err) {
      setError(guaranteeTermsErrorMessage(err));
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
      title={mode === 'create' ? 'Create guarantee terms' : 'Revise guarantee terms'}
      description="These reusable terms apply to future permanent-placement activations for this requisition. Permanent placements that have already started keep the guarantee snapshot captured at activation and are not changed by a revision."
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy} data-testid="guarantee-terms-submit">
            {busy ? 'Saving…' : mode === 'create' ? 'Create terms' : 'Revise terms'}
          </Button>
        </>
      }
    >
      <FormField label="Effective from">
        <input
          className="rc-input"
          type="date"
          aria-label="Effective from"
          value={effectiveFrom}
          onChange={(e) => setEffectiveFrom(e.target.value)}
          disabled={busy}
          data-testid="terms-effective-from"
        />
      </FormField>
      <FormField label="Guarantee duration (days)">
        <input
          className="rc-input"
          type="number"
          min={1}
          aria-label="Guarantee duration days"
          value={durationDays}
          onChange={(e) => setDurationDays(e.target.value)}
          disabled={busy}
          data-testid="terms-duration"
        />
      </FormField>
      <fieldset className="rc-field">
        <legend className="rc-field__label">Remedy policy</legend>
        <RadioGroup name="terms-remedy-policy" value={remedyPolicy} options={POLICY_OPTIONS} onValueChange={setRemedyPolicy} disabled={busy} />
      </fieldset>
      <FormField label="Guarantee exposure amount">
        <input
          className="rc-input"
          type="text"
          inputMode="decimal"
          aria-label="Guarantee exposure amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={busy}
          data-testid="terms-exposure-amount"
        />
      </FormField>
      <FormField label="Currency">
        <input
          className="rc-input"
          type="text"
          maxLength={3}
          aria-label="Currency"
          value={currency}
          onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          disabled={busy}
          data-testid="terms-currency"
        />
      </FormField>
      <fieldset className="rc-field">
        <legend className="rc-field__label">Source</legend>
        <RadioGroup name="terms-source-type" value={sourceType} options={SOURCE_OPTIONS} onValueChange={setSourceType} disabled={busy} />
      </fieldset>
      <FormField label="Source reference (optional)">
        <input
          className="rc-input"
          type="text"
          maxLength={255}
          aria-label="Source reference"
          value={sourceReference}
          onChange={(e) => setSourceReference(e.target.value)}
          disabled={busy}
          data-testid="terms-source-reference"
        />
      </FormField>
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
    </Dialog>
  );
}
