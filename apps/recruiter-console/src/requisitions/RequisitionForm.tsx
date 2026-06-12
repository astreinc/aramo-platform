import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Combobox,
  FormField,
  InlineAlert,
  Switch,
  type ComboboxItem,
  type Session,
} from '@aramo/fe-foundation';

import { listCompanies, listContactsForCompany } from '../companies/companies-api';
import type { CompanyView, ContactView } from '../companies/types';

import {
  CompensationSection,
  emptyCompensationFormState,
  type CompensationFormState,
} from './CompensationSection';
import { EnterpriseFieldsSection } from './EnterpriseFieldsSection';
import {
  FinancialPlanningSection,
  canViewFinancials,
} from './FinancialPlanningSection';
import {
  ENTERPRISE_BOOLEAN_KEYS,
  ENTERPRISE_NUMBER_KEYS,
  ENTERPRISE_STRING_KEYS,
  FINANCIAL_STRING_KEYS,
  emptyEnterpriseFormState,
  emptyFinancialFormState,
  type EnterpriseFormState,
  type FinancialFormState,
} from './enterprise-fields';
import { createRequisition } from './requisitions-api';
import { createErrorMessage } from './error-messages';
import {
  visibleWritableCompensationFields,
  type CompensationFieldKey,
} from './compensation-visibility';
import {
  REQUISITION_STATUS_VALUES,
  type CompensationModel,
  type CreateRequisitionRequest,
  type RequisitionStatus,
  type RequisitionView,
} from './types';

// R4 — the requisition CREATE form. The thin route wrapper
// (RequisitionCreateView) handles the session + the success navigation;
// this component owns the form state + the D5-defensive CREATE construction.
//
// PR-A2 P4 — EDIT MODE RETIRED. Editing a requisition is now INLINE in the
// cockpit (RequisitionDetailView), so the form is create-only: the PATCH
// path (buildPatchBody), the pre-fill (stateFromInitial), and the in-form
// GenerateProfileDialog were removed. The component stays SHARED in spirit
// (the D5-defensive CREATE-body construction is unchanged) — only the edit
// affordance moved. CREATE remains fully functional (the §4 P5 proof).
//
// SUBMIT SAFETY (ruling 1 — D5 Frame B):
// - The CREATE body sends compensation only when (a) the discriminator
//   is set AND (b) the field is visible to the actor AND (c) the field
//   is ON the chosen branch (ruling 2 Option A — off-branch hidden +
//   omitted).
// - The discriminator UX preserves off-branch state on flip (no auto-
//   clear — ruling 2's footgun guard).

const CONTRACT_BRANCH_KEYS: readonly CompensationFieldKey[] = [
  'pay_rate_amount',
  'pay_rate_currency',
  'pay_rate_period',
  'bill_rate_amount',
  'bill_rate_currency',
  'bill_rate_period',
];

const PERMANENT_BRANCH_KEYS: readonly CompensationFieldKey[] = [
  'salary_amount',
  'salary_currency',
  'placement_fee_percent',
  'placement_fee_amount',
];

function onBranchKeys(
  model: CompensationModel | '',
): readonly CompensationFieldKey[] {
  if (model === 'CONTRACT') return CONTRACT_BRANCH_KEYS;
  if (model === 'PERMANENT') return PERMANENT_BRANCH_KEYS;
  return [];
}

interface BasicsFormState {
  title: string;
  company_id: string;
  contact_id: string;
  status: RequisitionStatus;
  description: string;
  notes: string;
  is_hot: boolean;
  openings: number;
  start_date: string;
  city: string;
  state: string;
}

interface FormState
  extends BasicsFormState,
    CompensationFormState,
    EnterpriseFormState,
    FinancialFormState {}

function emptyState(): FormState {
  return {
    title: '',
    company_id: '',
    contact_id: '',
    status: 'active',
    description: '',
    notes: '',
    is_hot: false,
    openings: 1,
    start_date: '',
    city: '',
    state: '',
    ...emptyCompensationFormState(),
    ...emptyEnterpriseFormState(),
    ...emptyFinancialFormState(),
  };
}

function buildCreateBody(
  state: FormState,
  visibleComp: ReadonlySet<CompensationFieldKey>,
  financialsVisible: boolean,
): CreateRequisitionRequest {
  // Build as a mutable bag, cast at return. The DTO types are `readonly`
  // for callers; internal construction keeps the bag mutable.
  const body: Record<string, unknown> = {
    title: state.title.trim(),
    company_id: state.company_id,
  };
  if (state.contact_id !== '') body['contact_id'] = state.contact_id;
  body['status'] = state.status;
  if (state.description !== '') body['description'] = state.description;
  if (state.notes !== '') body['notes'] = state.notes;
  if (state.is_hot) body['is_hot'] = true;
  if (state.openings > 0) body['openings'] = state.openings;
  if (state.start_date !== '') body['start_date'] = state.start_date;
  if (state.city !== '') body['city'] = state.city;
  if (state.state !== '') body['state'] = state.state;

  if (state.compensation_model !== '' && visibleComp.size > 0) {
    body['compensation_model'] = state.compensation_model;
    for (const k of onBranchKeys(state.compensation_model)) {
      if (!visibleComp.has(k)) continue;
      const val = state[k];
      if (val !== '') body[k] = val;
    }
  }

  // Enterprise fields — UN-gated, omit-empty. Strings/selects '' → omit;
  // numbers '' → omit (else Number()); booleans → send only when true.
  for (const k of ENTERPRISE_STRING_KEYS) {
    const val = state[k];
    if (val !== '') body[k] = val;
  }
  for (const k of ENTERPRISE_NUMBER_KEYS) {
    const val = state[k];
    if (val !== '') body[k] = Number(val);
  }
  for (const k of ENTERPRISE_BOOLEAN_KEYS) {
    if (state[k]) body[k] = true;
  }

  // Financial-planning fields — ONLY when the section is visible (the D5-
  // defensive omission mirror: a non-holder never authors these).
  if (financialsVisible) {
    for (const k of FINANCIAL_STRING_KEYS) {
      const val = state[k];
      if (val !== '') body[k] = val;
    }
  }
  return body as unknown as CreateRequisitionRequest;
}

interface RequisitionFormProps {
  readonly session: Session;
  readonly onSuccess: (req: RequisitionView) => void;
  readonly onCancel: () => void;
}

export function RequisitionForm({
  session,
  onSuccess,
  onCancel,
}: RequisitionFormProps) {
  const [state, setState] = useState<FormState>(() => emptyState());
  const [companies, setCompanies] = useState<readonly CompanyView[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(true);
  const [companiesTruncated, setCompaniesTruncated] = useState(false);
  const [contacts, setContacts] = useState<readonly ContactView[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const visibleComp = useMemo(
    () => visibleWritableCompensationFields(session.scopes),
    [session.scopes],
  );

  // The financial-planning gate — single source of truth used for BOTH
  // the section render AND the submit-omission (no two-place drift).
  const financialsVisible = useMemo(
    () => canViewFinancials(session.scopes),
    [session.scopes],
  );

  // Load the visible companies (D4b — same source as the companies LIST).
  useEffect(() => {
    let cancelled = false;
    listCompanies()
      .then((res) => {
        if (cancelled) return;
        setCompanies(res.items);
        setCompaniesTruncated(res.items.length >= 50);
        setCompaniesLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setCompaniesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load contacts when company changes; reset selection when company changes.
  useEffect(() => {
    if (state.company_id === '') {
      setContacts([]);
      return;
    }
    let cancelled = false;
    listContactsForCompany(state.company_id)
      .then((res) => {
        if (cancelled) return;
        setContacts(res.items);
      })
      .catch(() => {
        if (cancelled) return;
        setContacts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [state.company_id]);

  const companyItems: readonly ComboboxItem[] = useMemo(
    () =>
      companies.map((c) => ({
        value: c.id,
        label: c.name,
        description:
          [c.city, c.state].filter((v) => v !== null && v !== '').join(', ') ||
          undefined,
      })),
    [companies],
  );

  const contactItems: readonly ComboboxItem[] = useMemo(
    () =>
      contacts.map((c) => ({
        value: c.id,
        label: `${c.first_name} ${c.last_name}`.trim() || '—',
        description: c.title ?? undefined,
      })),
    [contacts],
  );

  function set<K extends keyof FormState>(key: K, next: FormState[K]): void {
    setState((s) => ({ ...s, [key]: next }));
  }

  function onCompanyChange(companyId: string): void {
    // Resetting contact_id when the company changes — the prior contact
    // may belong to a different company (foreign-key-style coherence).
    setState((s) => ({ ...s, company_id: companyId, contact_id: '' }));
  }

  const titleValid = state.title.trim() !== '';
  const companyValid = state.company_id !== '';
  const canSubmit = titleValid && companyValid && !submitting;

  async function onSubmit(ev: React.FormEvent): Promise<void> {
    ev.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const body = buildCreateBody(state, visibleComp, financialsVisible);
      const created = await createRequisition(body);
      onSuccess(created);
    } catch (err) {
      setSubmitError(createErrorMessage(err));
      setSubmitting(false);
    }
  }

  return (
    <form className="req-form" onSubmit={onSubmit}>
      <fieldset className="req-form__basics" disabled={submitting}>
        <legend>Basics</legend>

        <FormField label="Title">
          <input
            type="text"
            value={state.title}
            onChange={(ev) => set('title', ev.target.value)}
            aria-label="Title"
            required
          />
        </FormField>

        <FormField
          label="Company"
          helper={
            companiesTruncated
              ? 'Showing first 50 visible companies. If a company you need is not listed, contact your administrator.'
              : undefined
          }
        >
          <Combobox
            ariaLabel="Company"
            items={companyItems}
            value={state.company_id === '' ? null : state.company_id}
            onSelect={(item) => onCompanyChange(item.value)}
            placeholder={companiesLoading ? 'Loading…' : 'Select company…'}
            disabled={companiesLoading}
            testId="company-picker"
          />
        </FormField>

        <FormField label="Contact" helper="Optional. Resets when the company changes.">
          <Combobox
            ariaLabel="Contact"
            items={contactItems}
            value={state.contact_id === '' ? null : state.contact_id}
            onSelect={(item) => set('contact_id', item.value)}
            placeholder={
              state.company_id === ''
                ? 'Select a company first…'
                : 'Select contact…'
            }
            disabled={state.company_id === ''}
            testId="contact-picker"
          />
        </FormField>

        <FormField label="Status">
          <select
            value={state.status}
            onChange={(ev) => set('status', ev.target.value as RequisitionStatus)}
            aria-label="Status"
          >
            {REQUISITION_STATUS_VALUES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="Openings">
          <input
            type="number"
            min={0}
            step={1}
            value={state.openings}
            onChange={(ev) =>
              set('openings', Math.max(0, Number(ev.target.value) || 0))
            }
            aria-label="Openings"
          />
        </FormField>

        <FormField label="Hot">
          <Switch
            checked={state.is_hot}
            onCheckedChange={(c) => set('is_hot', c)}
            aria-label="Hot"
          />
        </FormField>

        <FormField label="Description">
          <textarea
            value={state.description}
            onChange={(ev) => set('description', ev.target.value)}
            aria-label="Description"
            rows={4}
          />
        </FormField>

        <FormField label="Notes">
          <textarea
            value={state.notes}
            onChange={(ev) => set('notes', ev.target.value)}
            aria-label="Notes"
            rows={3}
          />
        </FormField>

        <FormField label="Start date">
          <input
            type="date"
            value={state.start_date}
            onChange={(ev) => set('start_date', ev.target.value)}
            aria-label="Start date"
          />
        </FormField>

        <FormField label="City">
          <input
            type="text"
            value={state.city}
            onChange={(ev) => set('city', ev.target.value)}
            aria-label="City"
          />
        </FormField>

        <FormField label="State">
          <input
            type="text"
            value={state.state}
            onChange={(ev) => set('state', ev.target.value)}
            aria-label="State"
          />
        </FormField>
      </fieldset>

      <EnterpriseFieldsSection
        value={state}
        onChange={(ent) => setState((s) => ({ ...s, ...ent }))}
        disabled={submitting}
      />

      <CompensationSection
        value={state}
        onChange={(comp) => setState((s) => ({ ...s, ...comp }))}
        scopes={session.scopes}
        disabled={submitting}
      />

      <FinancialPlanningSection
        value={state}
        onChange={(fin) => setState((s) => ({ ...s, ...fin }))}
        scopes={session.scopes}
        disabled={submitting}
      />

      {/* PR-A2 P4 — the in-form AI profile surface is RETIRED. The
          GoldenProfile workbench now lives in the cockpit (the persistent
          ProfileWorkbenchPanel), reachable after the req is created. */}

      {submitError !== null ? (
        <InlineAlert variant="error">{submitError}</InlineAlert>
      ) : null}

      <div className="req-form__actions">
        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {submitting ? 'Saving…' : 'Create requisition'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
