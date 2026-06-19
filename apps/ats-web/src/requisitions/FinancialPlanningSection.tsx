import { FormField } from '@aramo/fe-foundation';

import { DECIMAL_PATTERN } from './decimal-format';
import {
  FINANCIALS_VIEW_SCOPE,
  type FinancialFormState,
} from './enterprise-fields';

// Job-Module — the gated financial-planning section (🔒). Renders ONLY
// when the actor holds 'requisition:view:financials'. This mirrors the
// compensation D5-defensive floor (CompensationSection returns null when
// the actor has no comp-view scope): same mechanism, same posture — the
// consumer ALSO omits these keys at submit when the section is hidden, so
// a non-holder never authors financial planning data.
//
// Money/percent fields are decimal strings (NOT numbers — precision over
// the wire; same DECIMAL_PATTERN as compensation). rate_card_id is a UUID
// stub (free text). golden_profile_id is rendered read-only by the host
// form (the "Linked profile" indicator) — it is NEVER an editable input.

// True iff the actor holds the financials view scope. Exported so the
// host form gates the section render + the submit-omission identically
// (single source of truth for the gate — no two-place drift).
export function canViewFinancials(scopes: readonly string[]): boolean {
  return scopes.includes(FINANCIALS_VIEW_SCOPE);
}

interface FinancialPlanningSectionProps {
  readonly value: FinancialFormState;
  readonly onChange: (next: FinancialFormState) => void;
  readonly scopes: readonly string[];
  readonly disabled?: boolean;
}

function MoneyField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
}) {
  return (
    <FormField label={label}>
      <input
        type="text"
        inputMode="decimal"
        pattern={DECIMAL_PATTERN}
        value={value}
        onChange={(ev) => onChange(ev.target.value)}
        aria-label={label}
      />
    </FormField>
  );
}

export function FinancialPlanningSection({
  value,
  onChange,
  scopes,
  disabled = false,
}: FinancialPlanningSectionProps) {
  if (!canViewFinancials(scopes)) {
    // No financials scope → the entire section is hidden (the load-bearing
    // gate; the consumer also omits financial fields at submit).
    return null;
  }

  function set<K extends keyof FinancialFormState>(
    key: K,
    next: FinancialFormState[K],
  ): void {
    onChange({ ...value, [key]: next });
  }

  return (
    <fieldset className="req-form__financials" disabled={disabled}>
      <legend>Financial planning 🔒</legend>

      <MoneyField
        label="Target margin percent"
        value={value.target_margin_percent}
        onChange={(v) => set('target_margin_percent', v)}
      />
      <MoneyField
        label="Markup percent target"
        value={value.markup_percent_target}
        onChange={(v) => set('markup_percent_target', v)}
      />

      <FormField label="Rate card ID">
        <input
          type="text"
          value={value.rate_card_id}
          onChange={(ev) => set('rate_card_id', ev.target.value)}
          aria-label="Rate card ID"
        />
      </FormField>

      <MoneyField
        label="Min bill rate"
        value={value.min_bill_rate}
        onChange={(v) => set('min_bill_rate', v)}
      />
      <MoneyField
        label="Max bill rate"
        value={value.max_bill_rate}
        onChange={(v) => set('max_bill_rate', v)}
      />
      <MoneyField
        label="Min pay rate"
        value={value.min_pay_rate}
        onChange={(v) => set('min_pay_rate', v)}
      />
      <MoneyField
        label="Max pay rate"
        value={value.max_pay_rate}
        onChange={(v) => set('max_pay_rate', v)}
      />
    </fieldset>
  );
}
