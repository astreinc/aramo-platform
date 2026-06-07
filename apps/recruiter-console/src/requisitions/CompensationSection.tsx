import { useMemo } from 'react';
import {
  Combobox,
  FormField,
  RadioGroup,
  type ComboboxItem,
} from '@aramo/fe-foundation';

import { ISO_4217_CURRENCIES } from './iso-4217-currency';
import { DECIMAL_PATTERN } from './decimal-format';
import {
  RATE_PERIOD_VALUES,
  type CompensationModel,
  type RatePeriod,
} from './types';
import {
  visibleWritableCompensationFields,
  type CompensationFieldKey,
} from './compensation-visibility';

// R4 — the compensation section (the discriminator + the per-branch
// fields + the currency picker + the decimal-as-string money inputs).
//
// RULING 2 (Option A — hide off-branch; no auto-clear):
//   - CONTRACT renders pay_rate + bill_rate groups (if visible)
//   - PERMANENT renders salary + placement_fee groups (if visible)
//   - (none / unset) renders only the discriminator
//   - off-branch fields are HIDDEN, not cleared on flip; the consumer's
//     submit logic OMITS off-branch keys (no auto-clear footgun)
//
// RULING 1 (D5 Frame B — defensive FE):
//   - visibleFields is the consumer's view-scope-filtered set (see
//     compensation-visibility.ts). A field whose key is NOT in
//     visibleFields does not render and its value is never sent.

// Form state shape — strings throughout (the empty-string convention
// is the React-controlled-input idiom; the consumer maps '' → undefined
// at submit). Decimal money fields are validated against DECIMAL_PATTERN
// on the input itself (HTML5 pattern attr) + the consumer at submit.
export interface CompensationFormState {
  compensation_model: CompensationModel | '';
  pay_rate_amount: string;
  pay_rate_currency: string;
  pay_rate_period: RatePeriod | '';
  bill_rate_amount: string;
  bill_rate_currency: string;
  bill_rate_period: RatePeriod | '';
  placement_fee_percent: string;
  placement_fee_amount: string;
  salary_amount: string;
  salary_currency: string;
}

export function emptyCompensationFormState(): CompensationFormState {
  return {
    compensation_model: '',
    pay_rate_amount: '',
    pay_rate_currency: '',
    pay_rate_period: '',
    bill_rate_amount: '',
    bill_rate_currency: '',
    bill_rate_period: '',
    placement_fee_percent: '',
    placement_fee_amount: '',
    salary_amount: '',
    salary_currency: '',
  };
}

interface CompensationSectionProps {
  readonly value: CompensationFormState;
  readonly onChange: (next: CompensationFormState) => void;
  // The actor's compensation:view:* scopes (just those; pre-filtered or
  // the full session.scopes — visibleWritableCompensationFields ignores
  // non-comp scopes).
  readonly scopes: readonly string[];
  readonly disabled?: boolean;
}

const CURRENCY_ITEMS: readonly ComboboxItem[] = ISO_4217_CURRENCIES.map(
  (code) => ({ value: code, label: code }),
);

const RATE_PERIOD_OPTIONS: ReadonlyArray<{
  readonly value: '' | RatePeriod;
  readonly label: string;
}> = [
  { value: '', label: '— Period —' },
  ...RATE_PERIOD_VALUES.map((p) => ({ value: p, label: p })),
];

export function CompensationSection({
  value,
  onChange,
  scopes,
  disabled = false,
}: CompensationSectionProps) {
  const visible = useMemo(
    () => visibleWritableCompensationFields(scopes),
    [scopes],
  );

  function set<K extends keyof CompensationFormState>(
    key: K,
    next: CompensationFormState[K],
  ): void {
    onChange({ ...value, [key]: next });
  }

  const showCompModelPicker = visible.size > 0;
  if (!showCompModelPicker) {
    // No comp scopes at all → entire section hidden (the load-bearing
    // D5 Frame-B floor; the consumer also omits comp fields at submit).
    return null;
  }

  const model = value.compensation_model;

  return (
    <fieldset className="req-form__compensation" disabled={disabled}>
      <legend>Compensation</legend>

      <FormField label="Compensation type">
        <RadioGroup<CompensationModel | 'none'>
          name="compensation_model"
          value={model === '' ? 'none' : model}
          onValueChange={(next) =>
            set('compensation_model', next === 'none' ? '' : next)
          }
          options={[
            { value: 'none', label: 'Not specified' },
            { value: 'CONTRACT', label: 'Contract' },
            { value: 'PERMANENT', label: 'Permanent' },
          ]}
        />
      </FormField>

      {model === 'CONTRACT' ? (
        <ContractFields value={value} set={set} visible={visible} />
      ) : null}
      {model === 'PERMANENT' ? (
        <PermanentFields value={value} set={set} visible={visible} />
      ) : null}
    </fieldset>
  );
}

interface BranchProps {
  readonly value: CompensationFormState;
  readonly set: <K extends keyof CompensationFormState>(
    key: K,
    next: CompensationFormState[K],
  ) => void;
  readonly visible: ReadonlySet<CompensationFieldKey>;
}

function ContractFields({ value, set, visible }: BranchProps) {
  return (
    <>
      {visible.has('pay_rate_amount') ? (
        <RateGroup
          legend="Pay rate"
          amountFieldKey="pay_rate_amount"
          currencyFieldKey="pay_rate_currency"
          periodFieldKey="pay_rate_period"
          value={value}
          set={set}
        />
      ) : null}
      {visible.has('bill_rate_amount') ? (
        <RateGroup
          legend="Bill rate"
          amountFieldKey="bill_rate_amount"
          currencyFieldKey="bill_rate_currency"
          periodFieldKey="bill_rate_period"
          value={value}
          set={set}
        />
      ) : null}
    </>
  );
}

function PermanentFields({ value, set, visible }: BranchProps) {
  return (
    <>
      {visible.has('salary_amount') ? (
        <SalaryGroup value={value} set={set} />
      ) : null}
      {visible.has('placement_fee_percent') ||
      visible.has('placement_fee_amount') ? (
        <PlacementFeeGroup value={value} set={set} visible={visible} />
      ) : null}
    </>
  );
}

interface RateGroupProps {
  readonly legend: string;
  readonly amountFieldKey: 'pay_rate_amount' | 'bill_rate_amount';
  readonly currencyFieldKey: 'pay_rate_currency' | 'bill_rate_currency';
  readonly periodFieldKey: 'pay_rate_period' | 'bill_rate_period';
  readonly value: CompensationFormState;
  readonly set: <K extends keyof CompensationFormState>(
    key: K,
    next: CompensationFormState[K],
  ) => void;
}

function RateGroup({
  legend,
  amountFieldKey,
  currencyFieldKey,
  periodFieldKey,
  value,
  set,
}: RateGroupProps) {
  return (
    <fieldset className="req-form__rate-group">
      <legend>{legend}</legend>
      <FormField label="Amount">
        <input
          type="text"
          inputMode="decimal"
          pattern={DECIMAL_PATTERN}
          value={value[amountFieldKey]}
          onChange={(ev) => set(amountFieldKey, ev.target.value)}
          aria-label={`${legend} amount`}
        />
      </FormField>
      <FormField label="Currency">
        <Combobox
          ariaLabel={`${legend} currency`}
          items={CURRENCY_ITEMS}
          value={value[currencyFieldKey] === '' ? null : value[currencyFieldKey]}
          onSelect={(item) => set(currencyFieldKey, item.value)}
          placeholder="Select currency…"
          testId={`${amountFieldKey}-currency`}
        />
      </FormField>
      <FormField label="Period">
        <select
          value={value[periodFieldKey]}
          onChange={(ev) => set(periodFieldKey, ev.target.value as RatePeriod | '')}
          aria-label={`${legend} period`}
        >
          {RATE_PERIOD_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </FormField>
    </fieldset>
  );
}

function SalaryGroup({
  value,
  set,
}: Pick<BranchProps, 'value' | 'set'>) {
  return (
    <fieldset className="req-form__rate-group">
      <legend>Salary</legend>
      <FormField label="Amount">
        <input
          type="text"
          inputMode="decimal"
          pattern={DECIMAL_PATTERN}
          value={value.salary_amount}
          onChange={(ev) => set('salary_amount', ev.target.value)}
          aria-label="Salary amount"
        />
      </FormField>
      <FormField label="Currency">
        <Combobox
          ariaLabel="Salary currency"
          items={CURRENCY_ITEMS}
          value={value.salary_currency === '' ? null : value.salary_currency}
          onSelect={(item) => set('salary_currency', item.value)}
          placeholder="Select currency…"
          testId="salary-currency"
        />
      </FormField>
    </fieldset>
  );
}

function PlacementFeeGroup({
  value,
  set,
  visible,
}: BranchProps) {
  return (
    <fieldset className="req-form__rate-group">
      <legend>Placement fee</legend>
      {visible.has('placement_fee_percent') ? (
        <FormField label="Percent">
          <input
            type="text"
            inputMode="decimal"
            pattern={DECIMAL_PATTERN}
            value={value.placement_fee_percent}
            onChange={(ev) => set('placement_fee_percent', ev.target.value)}
            aria-label="Placement fee percent"
          />
        </FormField>
      ) : null}
      {visible.has('placement_fee_amount') ? (
        <FormField label="Amount">
          <input
            type="text"
            inputMode="decimal"
            pattern={DECIMAL_PATTERN}
            value={value.placement_fee_amount}
            onChange={(ev) => set('placement_fee_amount', ev.target.value)}
            aria-label="Placement fee amount"
          />
        </FormField>
      ) : null}
    </fieldset>
  );
}
