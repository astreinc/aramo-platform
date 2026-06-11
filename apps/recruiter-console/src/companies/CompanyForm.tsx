import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Combobox,
  FormField,
  InlineAlert,
  Switch,
  type ComboboxItem,
} from '@aramo/fe-foundation';

import { AddressTypeahead } from './AddressTypeahead';
import {
  createCompanyDepartment,
  deleteCompanyDepartment,
  listCompanyDepartments,
  listContactsForCompany,
} from './companies-api';
import type {
  AddressDetails,
  CompanyDepartmentView,
  CompanyView,
  ContactView,
  CreateCompanyRequest,
  UpdateCompanyRequest,
} from './types';

// R6' — the shared company CREATE/EDIT composite. The thin route
// wrappers (CompanyCreateView / CompanyEditView) handle navigation +
// pre-fetch + success; this component owns the field-by-field form
// state + the buildCreateBody / buildPatchBody construction (R4
// omit-vs-null discipline).
//
// Ruling A — tiered field set. The BE accepts 16 company fields; the
// form surfaces name + commonly-used inline + the rest (address block,
// phone2, fax_number) behind a "More fields" disclosure. The directive
// listed 9 — the substrate is richer; tiering preserves data fidelity
// without form-bloat.
//
// Ruling B — billing_contact_id is EDIT-only. A new company has no
// contacts yet (chicken-and-egg); we omit the picker on CREATE entirely.
// On EDIT the picker shows the company's existing contacts; null clears
// the field. The BE accepts billing_contact_id on CREATE in the DTO
// (no validation prevents it), but we don't surface a picker.
//
// Ruling F — owner_id is omitted (no /v1/users:assignable endpoint).
// The server defaults owner_id to entered_by_id (the creating recruiter).

interface InlineFormState {
  name: string;
  phone1: string;
  url: string;
  key_technologies: string;
  is_hot: boolean;
}

interface MoreFormState {
  address: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  phone2: string;
  fax_number: string;
  notes: string;
  // Address-Autocomplete v1.0 — provider place reference, set when the address
  // block is populated via the typeahead; '' for a manually-typed address.
  address_provider_place_id: string;
  address_provider: string;
}

// Company-Fields v1.1 — the additive un-gated text fields (string form
// state; founded_year/tags handled specially below).
interface ExpandedFormState {
  status: string;
  description: string;
  industry: string;
  country: string;
  employee_count_band: string;
  annual_revenue_band: string;
  founded_year: string; // numeric input value; parsed on submit
  ownership_type: string;
  registration_number: string;
  source: string;
  client_tier: string;
  supplier_status: string;
  exclusivity: boolean;
  tags: string; // comma-separated input; split on submit
  general_email: string;
}

// Company-Fields v1.1 — the GATED commercial fields (rendered only when the
// actor holds company:read_commercial; absent from the DOM otherwise so they
// are never sent on save).
interface CommercialFormState {
  fee_model: string;
  default_contract_markup_pct: string;
  default_perm_fee_pct: string;
  payment_terms: string;
  credit_status: string;
  default_currency: string;
}

interface FormState
  extends InlineFormState,
    MoreFormState,
    ExpandedFormState,
    CommercialFormState {
  // EDIT-only (ruling B). Empty string represents "no selection / null".
  billing_contact_id: string;
}

// Company-Fields v1.1 — dropdown option sets (FE constraint only; the BE
// columns stay String-not-enum). Machine value stored; label shown. Values
// match the directive vocabularies EXACTLY.
interface Opt {
  readonly value: string;
  readonly label: string;
}
const STATUS_OPTS: readonly Opt[] = [
  { value: 'prospect', label: 'Prospect' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'do_not_contact', label: 'Do Not Contact' },
];
const OWNERSHIP_OPTS: readonly Opt[] = [
  { value: 'private', label: 'Private' },
  { value: 'public', label: 'Public' },
  { value: 'nonprofit', label: 'Nonprofit' },
  { value: 'government', label: 'Government' },
];
const FEE_MODEL_OPTS: readonly Opt[] = [
  { value: 'contract', label: 'Contract' },
  { value: 'perm', label: 'Perm' },
  { value: 'both', label: 'Both' },
];
const SUPPLIER_STATUS_OPTS: readonly Opt[] = [
  { value: 'preferred', label: 'Preferred' },
  { value: 'approved', label: 'Approved' },
  { value: 'exclusive', label: 'Exclusive' },
  { value: 'open', label: 'Open' },
];
const PAYMENT_TERMS_OPTS: readonly Opt[] = [
  { value: 'net_15', label: 'Net 15' },
  { value: 'net_30', label: 'Net 30' },
  { value: 'net_45', label: 'Net 45' },
  { value: 'net_60', label: 'Net 60' },
];
// Store ISO alpha-2; display full name. Short set, US default, includes India.
const COUNTRY_OPTS: readonly Opt[] = [
  { value: 'US', label: 'United States' },
  { value: 'CA', label: 'Canada' },
  { value: 'MX', label: 'Mexico' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'IE', label: 'Ireland' },
  { value: 'IN', label: 'India' },
  { value: 'AU', label: 'Australia' },
  { value: 'DE', label: 'Germany' },
  { value: 'FR', label: 'France' },
  { value: 'NL', label: 'Netherlands' },
  { value: 'SG', label: 'Singapore' },
  { value: 'AE', label: 'United Arab Emirates' },
  { value: 'PH', label: 'Philippines' },
  { value: 'NZ', label: 'New Zealand' },
];

function renderOptions(opts: readonly Opt[], includeBlank: boolean) {
  return (
    <>
      {includeBlank ? <option value="">—</option> : null}
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </>
  );
}

const EMPTY_EXPANDED: ExpandedFormState = {
  status: 'active',
  description: '',
  industry: '',
  country: 'US', // US default (directive)
  employee_count_band: '',
  annual_revenue_band: '',
  founded_year: '',
  ownership_type: '',
  registration_number: '',
  source: '',
  client_tier: '',
  supplier_status: '',
  exclusivity: false,
  tags: '',
  general_email: '',
};

const EMPTY_COMMERCIAL: CommercialFormState = {
  fee_model: '',
  default_contract_markup_pct: '',
  default_perm_fee_pct: '',
  payment_terms: '',
  credit_status: '',
  default_currency: 'USD', // locked to USD for now (directive)
};

function emptyState(): FormState {
  return {
    name: '',
    phone1: '',
    url: '',
    key_technologies: '',
    is_hot: false,
    address: '',
    address2: '',
    city: '',
    state: '',
    zip: '',
    phone2: '',
    fax_number: '',
    notes: '',
    address_provider_place_id: '',
    address_provider: '',
    billing_contact_id: '',
    ...EMPTY_EXPANDED,
    ...EMPTY_COMMERCIAL,
  };
}

function stateFromInitial(initial: CompanyView): FormState {
  return {
    name: initial.name,
    phone1: initial.phone1 ?? '',
    url: initial.url ?? '',
    key_technologies: initial.key_technologies ?? '',
    is_hot: initial.is_hot,
    address: initial.address ?? '',
    address2: initial.address2 ?? '',
    city: initial.city ?? '',
    state: initial.state ?? '',
    zip: initial.zip ?? '',
    phone2: initial.phone2 ?? '',
    fax_number: initial.fax_number ?? '',
    notes: initial.notes ?? '',
    address_provider_place_id: initial.address_provider_place_id ?? '',
    address_provider: initial.address_provider ?? '',
    billing_contact_id: initial.billing_contact_id ?? '',
    // Expanded un-gated.
    status: initial.status ?? 'active',
    description: initial.description ?? '',
    industry: initial.industry ?? '',
    country: initial.country ?? '',
    employee_count_band: initial.employee_count_band ?? '',
    annual_revenue_band: initial.annual_revenue_band ?? '',
    founded_year: initial.founded_year !== null ? String(initial.founded_year) : '',
    ownership_type: initial.ownership_type ?? '',
    registration_number: initial.registration_number ?? '',
    source: initial.source ?? '',
    client_tier: initial.client_tier ?? '',
    supplier_status: initial.supplier_status ?? '',
    exclusivity: initial.exclusivity,
    tags: initial.tags.join(', '),
    general_email: initial.general_email ?? '',
    // Commercial — absent from the view (omitted by the interceptor) for
    // non-holders, so these read back '' until a holder loads the form.
    fee_model: initial.fee_model ?? '',
    default_contract_markup_pct: initial.default_contract_markup_pct ?? '',
    default_perm_fee_pct: initial.default_perm_fee_pct ?? '',
    payment_terms: initial.payment_terms ?? '',
    credit_status: initial.credit_status ?? '',
    default_currency: initial.default_currency ?? 'USD', // locked field
  };
}

// The un-gated string fields sent verbatim when non-empty (create) /
// diffed (patch). founded_year (number), exclusivity (boolean), tags (array)
// are handled specially.
const UNGATED_STRING_FIELDS = [
  'phone1',
  'url',
  'key_technologies',
  'address',
  'address2',
  'city',
  'state',
  'zip',
  'phone2',
  'fax_number',
  'notes',
  'description',
  'industry',
  'country',
  'employee_count_band',
  'annual_revenue_band',
  'ownership_type',
  'registration_number',
  'source',
  'client_tier',
  'supplier_status',
  'general_email',
] as const;

const COMMERCIAL_STRING_FIELDS = [
  'fee_model',
  'default_contract_markup_pct',
  'default_perm_fee_pct',
  'payment_terms',
  'credit_status',
  'default_currency',
] as const;

function buildCreateBody(
  state: FormState,
  canSeeCommercial: boolean,
): CreateCompanyRequest {
  const body: Record<string, unknown> = {
    name: state.name.trim(),
  };
  for (const k of UNGATED_STRING_FIELDS) {
    const v = state[k];
    if (typeof v === 'string' && v.trim() !== '') body[k] = v.trim();
  }
  // status defaults to 'active' (DB default) — send only when changed away
  // from it, so a plain create stays a minimal body.
  if (state.status.trim() !== '' && state.status !== 'active') {
    body['status'] = state.status;
  }
  if (state.is_hot) body['is_hot'] = true;
  if (state.exclusivity) body['exclusivity'] = true;
  if (state.founded_year.trim() !== '') {
    const n = Number.parseInt(state.founded_year, 10);
    if (Number.isFinite(n)) body['founded_year'] = n;
  }
  const tags = splitTags(state.tags);
  if (tags.length > 0) body['tags'] = tags;
  // Address-Autocomplete v1.0 — stamp the provider place reference when the
  // address came from the typeahead (manual entry leaves these blank).
  if (state.address_provider_place_id.trim() !== '') {
    body['address_provider_place_id'] = state.address_provider_place_id;
    if (state.address_provider.trim() !== '') {
      body['address_provider'] = state.address_provider;
    }
  }
  // Commercial: only the holder's payload carries these (the section is not
  // in the DOM for non-holders, and the server strips them regardless).
  if (canSeeCommercial) {
    for (const k of COMMERCIAL_STRING_FIELDS) {
      const v = state[k];
      if (typeof v === 'string' && v.trim() !== '') body[k] = v.trim();
    }
  }
  // Ruling B: billing_contact_id is NOT sent on CREATE — no picker
  // is rendered; the form state for it stays at '' on CREATE.
  return body as unknown as CreateCompanyRequest;
}

function splitTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

function buildPatchBody(
  state: FormState,
  initial: CompanyView,
  canSeeCommercial: boolean,
): UpdateCompanyRequest {
  const body: Record<string, unknown> = {};
  if (state.name !== initial.name) body['name'] = state.name.trim();
  if (state.is_hot !== initial.is_hot) body['is_hot'] = state.is_hot;
  if (state.exclusivity !== initial.exclusivity) {
    body['exclusivity'] = state.exclusivity;
  }

  const initialAsRecord = initial as unknown as Record<string, unknown>;
  // status is non-nullable (defaulted) — diff but never clear-to-null.
  if (state.status !== (initial.status ?? 'active')) {
    body['status'] = state.status;
  }
  for (const k of UNGATED_STRING_FIELDS) {
    const initVal = initialAsRecord[k] ?? '';
    const cur = state[k] as string;
    if (cur !== initVal) {
      body[k] = cur === '' ? null : cur;
    }
  }

  // founded_year — numeric diff; empty clears to null.
  const initFounded = initial.founded_year !== null ? String(initial.founded_year) : '';
  if (state.founded_year.trim() !== initFounded) {
    if (state.founded_year.trim() === '') {
      body['founded_year'] = null;
    } else {
      const n = Number.parseInt(state.founded_year, 10);
      if (Number.isFinite(n)) body['founded_year'] = n;
    }
  }

  // tags — array diff (compare normalized).
  const curTags = splitTags(state.tags);
  const initTags = [...initial.tags];
  if (JSON.stringify(curTags) !== JSON.stringify(initTags)) {
    body['tags'] = curTags;
  }

  // Address-Autocomplete v1.0 — provider place reference diff (null clears).
  const initPlaceId = initial.address_provider_place_id ?? '';
  if (state.address_provider_place_id !== initPlaceId) {
    body['address_provider_place_id'] =
      state.address_provider_place_id === '' ? null : state.address_provider_place_id;
  }
  const initProvider = initial.address_provider ?? '';
  if (state.address_provider !== initProvider) {
    body['address_provider'] =
      state.address_provider === '' ? null : state.address_provider;
  }

  // Commercial — only when the actor holds the scope (otherwise the section
  // is not rendered and these stay '' === initial '' → no diff anyway).
  if (canSeeCommercial) {
    for (const k of COMMERCIAL_STRING_FIELDS) {
      const initVal = (initialAsRecord[k] as string | null | undefined) ?? '';
      const cur = state[k] as string;
      if (cur !== initVal) {
        body[k] = cur === '' ? null : cur;
      }
    }
  }

  // Ruling B EDIT picker: empty string → null (explicit clear); else
  // send if changed.
  const initialBilling = initial.billing_contact_id ?? '';
  if (state.billing_contact_id !== initialBilling) {
    body['billing_contact_id'] =
      state.billing_contact_id === '' ? null : state.billing_contact_id;
  }
  return body as unknown as UpdateCompanyRequest;
}

interface CommonProps {
  readonly onCancel: () => void;
  readonly submitting?: boolean;
  readonly submitError?: string | null;
  // Company-Fields v1.1 — true iff the actor holds company:read_commercial.
  // When false, the Commercial section is NOT rendered (absent from the DOM,
  // so its fields are never collected or sent on save).
  readonly canSeeCommercial: boolean;
}

interface CreateProps extends CommonProps {
  readonly mode: 'create';
  readonly onSubmit: (body: CreateCompanyRequest) => Promise<void>;
}

interface EditProps extends CommonProps {
  readonly mode: 'edit';
  readonly initial: CompanyView;
  readonly onSubmit: (body: UpdateCompanyRequest) => Promise<void>;
}

type CompanyFormProps = CreateProps | EditProps;

export function CompanyForm(props: CompanyFormProps) {
  const [state, setState] = useState<FormState>(() =>
    props.mode === 'edit' ? stateFromInitial(props.initial) : emptyState(),
  );
  const [showMore, setShowMore] = useState(false);
  const [contacts, setContacts] = useState<readonly ContactView[]>([]);

  // Load the company's contacts on EDIT for the billing_contact_id
  // picker. CREATE has no company yet → no picker, no fetch.
  const initialCompanyId = props.mode === 'edit' ? props.initial.id : null;
  useEffect(() => {
    if (initialCompanyId === null) return;
    let cancelled = false;
    listContactsForCompany(initialCompanyId)
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
  }, [initialCompanyId]);

  const billingContactItems: readonly ComboboxItem[] = useMemo(
    () =>
      contacts.map((c) => ({
        value: c.id,
        label: `${c.first_name} ${c.last_name}`.trim() || '—',
        description: c.email1 ?? c.title ?? undefined,
      })),
    [contacts],
  );

  function set<K extends keyof FormState>(key: K, next: FormState[K]): void {
    setState((s) => ({ ...s, [key]: next }));
  }

  // Address-Autocomplete v1.0 — populate the (still-editable) address fields
  // from a selected suggestion + stamp the provider place reference. A null
  // field from the provider leaves the existing value untouched for country
  // (the firmographics select); blank for the rest.
  function populateFromAddress(details: AddressDetails): void {
    setState((s) => ({
      ...s,
      address: details.address ?? '',
      address2: details.address2 ?? '',
      city: details.city ?? '',
      state: details.state ?? '',
      zip: details.zip ?? '',
      country: details.country ?? s.country,
      address_provider_place_id: details.place_id,
      address_provider: details.provider,
    }));
  }

  const submitting = props.submitting === true;
  const submitError = props.submitError ?? null;
  const nameValid = state.name.trim() !== '';
  const canSubmit = nameValid && !submitting;

  async function onSubmit(ev: React.FormEvent): Promise<void> {
    ev.preventDefault();
    if (!canSubmit) return;
    if (props.mode === 'create') {
      await props.onSubmit(buildCreateBody(state, props.canSeeCommercial));
    } else {
      await props.onSubmit(
        buildPatchBody(state, props.initial, props.canSeeCommercial),
      );
    }
  }

  return (
    <form className="company-form" onSubmit={onSubmit}>
      <fieldset className="company-form__basics" disabled={submitting}>
        <legend>Basics</legend>
        <FormField label="Name">
          <input
            type="text"
            value={state.name}
            onChange={(ev) => set('name', ev.target.value)}
            aria-label="Name"
            required
          />
        </FormField>
        <FormField label="Phone">
          <input
            type="tel"
            value={state.phone1}
            onChange={(ev) => set('phone1', ev.target.value)}
            aria-label="Phone"
          />
        </FormField>
        <FormField label="Website">
          <input
            type="url"
            value={state.url}
            onChange={(ev) => set('url', ev.target.value)}
            aria-label="Website"
          />
        </FormField>
        <FormField
          label="Key technologies"
          helper="Free-text — e.g. 'AWS, Postgres, Python'."
        >
          <input
            type="text"
            value={state.key_technologies}
            onChange={(ev) => set('key_technologies', ev.target.value)}
            aria-label="Key technologies"
          />
        </FormField>
        <FormField label="Hot">
          <Switch
            checked={state.is_hot}
            onCheckedChange={(c) => set('is_hot', c)}
            aria-label="Hot"
          />
        </FormField>
      </fieldset>

      <details
        className="company-form__more"
        open={showMore}
        onToggle={(ev) => setShowMore((ev.target as HTMLDetailsElement).open)}
      >
        <summary>More fields</summary>
        <fieldset className="company-form__address" disabled={submitting}>
          <legend>Address</legend>
          {/* Address-Autocomplete v1.0 — optional typeahead. Populates the
              editable fields below; manual entry always works (the inputs
              remain). No-op visually when the feature is disabled server-side
              (the lookup returns empty). */}
          <FormField
            label="Find address"
            helper="Search to auto-fill the fields below — you can still edit them."
          >
            <AddressTypeahead
              onSelectAddress={populateFromAddress}
              testId="address-typeahead"
            />
          </FormField>
          <FormField label="Address">
            <input
              type="text"
              value={state.address}
              onChange={(ev) => set('address', ev.target.value)}
              aria-label="Address"
            />
          </FormField>
          <FormField label="Address 2">
            <input
              type="text"
              value={state.address2}
              onChange={(ev) => set('address2', ev.target.value)}
              aria-label="Address 2"
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
          <FormField label="Zip">
            <input
              type="text"
              value={state.zip}
              onChange={(ev) => set('zip', ev.target.value)}
              aria-label="Zip"
            />
          </FormField>
        </fieldset>

        <fieldset className="company-form__contact-extras" disabled={submitting}>
          <legend>Additional contact</legend>
          <FormField label="Phone (secondary)">
            <input
              type="tel"
              value={state.phone2}
              onChange={(ev) => set('phone2', ev.target.value)}
              aria-label="Phone (secondary)"
            />
          </FormField>
          <FormField label="Fax">
            <input
              type="tel"
              value={state.fax_number}
              onChange={(ev) => set('fax_number', ev.target.value)}
              aria-label="Fax"
            />
          </FormField>
        </fieldset>

        <fieldset className="company-form__notes" disabled={submitting}>
          <legend>Notes</legend>
          <FormField label="Notes">
            <textarea
              value={state.notes}
              onChange={(ev) => set('notes', ev.target.value)}
              aria-label="Notes"
              rows={3}
            />
          </FormField>
        </fieldset>

        {/* Company-Fields v1.1 — Profile / lifecycle. */}
        <fieldset className="company-form__profile" disabled={submitting}>
          <legend>Profile</legend>
          <FormField label="Status">
            <select
              value={state.status}
              onChange={(ev) => set('status', ev.target.value)}
              aria-label="Status"
            >
              {renderOptions(STATUS_OPTS, false)}
            </select>
          </FormField>
          <FormField label="Industry">
            <input
              type="text"
              value={state.industry}
              onChange={(ev) => set('industry', ev.target.value)}
              aria-label="Industry"
            />
          </FormField>
          <FormField label="Description">
            <textarea
              value={state.description}
              onChange={(ev) => set('description', ev.target.value)}
              aria-label="Description"
              rows={2}
            />
          </FormField>
        </fieldset>

        {/* Company-Fields v1.1 — Firmographics. */}
        <fieldset className="company-form__firmographics" disabled={submitting}>
          <legend>Firmographics</legend>
          <FormField label="Country">
            <select value={state.country} onChange={(ev) => set('country', ev.target.value)} aria-label="Country">
              {renderOptions(COUNTRY_OPTS, true)}
            </select>
          </FormField>
          <FormField label="Employees (band)">
            <input type="text" value={state.employee_count_band} onChange={(ev) => set('employee_count_band', ev.target.value)} aria-label="Employees (band)" />
          </FormField>
          <FormField label="Revenue (band)">
            <input type="text" value={state.annual_revenue_band} onChange={(ev) => set('annual_revenue_band', ev.target.value)} aria-label="Revenue (band)" />
          </FormField>
          <FormField label="Founded year">
            <input type="number" value={state.founded_year} onChange={(ev) => set('founded_year', ev.target.value)} aria-label="Founded year" />
          </FormField>
          <FormField label="Ownership type">
            <select value={state.ownership_type} onChange={(ev) => set('ownership_type', ev.target.value)} aria-label="Ownership type">
              {renderOptions(OWNERSHIP_OPTS, true)}
            </select>
          </FormField>
          <FormField label="Registration number">
            <input type="text" value={state.registration_number} onChange={(ev) => set('registration_number', ev.target.value)} aria-label="Registration number" />
          </FormField>
          <FormField label="General email">
            <input type="email" value={state.general_email} onChange={(ev) => set('general_email', ev.target.value)} aria-label="General email" />
          </FormField>
        </fieldset>

        {/* Company-Fields v1.1 — Relationship. */}
        <fieldset className="company-form__relationship" disabled={submitting}>
          <legend>Relationship</legend>
          <FormField label="Source">
            <input type="text" value={state.source} onChange={(ev) => set('source', ev.target.value)} aria-label="Source" />
          </FormField>
          <FormField label="Client tier" helper="a | b | c">
            <input type="text" value={state.client_tier} onChange={(ev) => set('client_tier', ev.target.value)} aria-label="Client tier" />
          </FormField>
          <FormField label="Supplier status">
            <select value={state.supplier_status} onChange={(ev) => set('supplier_status', ev.target.value)} aria-label="Supplier status">
              {renderOptions(SUPPLIER_STATUS_OPTS, true)}
            </select>
          </FormField>
          <FormField label="Tags" helper="Comma-separated.">
            <input type="text" value={state.tags} onChange={(ev) => set('tags', ev.target.value)} aria-label="Tags" />
          </FormField>
          <FormField label="Exclusivity">
            <Switch checked={state.exclusivity} onCheckedChange={(c) => set('exclusivity', c)} aria-label="Exclusivity" />
          </FormField>
        </fieldset>
      </details>

      {props.mode === 'edit' ? (
        <fieldset className="company-form__billing" disabled={submitting}>
          <legend>Billing</legend>
          <FormField
            label="Billing contact"
            helper={
              contacts.length === 0
                ? 'Add a contact to this company first, then pick them here.'
                : 'Optional. The contact responsible for invoices.'
            }
          >
            <Combobox
              ariaLabel="Billing contact"
              items={billingContactItems}
              value={
                state.billing_contact_id === ''
                  ? null
                  : state.billing_contact_id
              }
              onSelect={(item) => set('billing_contact_id', item.value)}
              placeholder={
                contacts.length === 0
                  ? 'No contacts yet'
                  : 'Select billing contact…'
              }
              disabled={contacts.length === 0}
              testId="billing-contact-picker"
            />
          </FormField>
          {state.billing_contact_id !== '' ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => set('billing_contact_id', '')}
              disabled={submitting}
            >
              Clear billing contact
            </Button>
          ) : null}
        </fieldset>
      ) : null}

      {/* Company-Fields v1.1 — GATED commercial section. Rendered ONLY when
          the actor holds company:read_commercial; absent from the DOM
          otherwise, so its fields are never collected or sent on save. */}
      {props.canSeeCommercial ? (
        <fieldset className="company-form__commercial" disabled={submitting}>
          <legend>Commercial defaults</legend>
          <FormField label="Fee model">
            <select value={state.fee_model} onChange={(ev) => set('fee_model', ev.target.value)} aria-label="Fee model">
              {renderOptions(FEE_MODEL_OPTS, true)}
            </select>
          </FormField>
          <FormField label="Default contract markup %">
            <input type="text" inputMode="decimal" value={state.default_contract_markup_pct} onChange={(ev) => set('default_contract_markup_pct', ev.target.value)} aria-label="Default contract markup %" />
          </FormField>
          <FormField label="Default perm fee %">
            <input type="text" inputMode="decimal" value={state.default_perm_fee_pct} onChange={(ev) => set('default_perm_fee_pct', ev.target.value)} aria-label="Default perm fee %" />
          </FormField>
          <FormField label="Payment terms">
            <select value={state.payment_terms} onChange={(ev) => set('payment_terms', ev.target.value)} aria-label="Payment terms">
              {renderOptions(PAYMENT_TERMS_OPTS, true)}
            </select>
          </FormField>
          <FormField label="Credit status">
            <input type="text" value={state.credit_status} onChange={(ev) => set('credit_status', ev.target.value)} aria-label="Credit status" />
          </FormField>
          <FormField label="Default currency" helper="USD only for now.">
            <input
              type="text"
              value="USD"
              aria-label="Default currency"
              disabled
              readOnly
            />
          </FormField>
        </fieldset>
      ) : null}

      {/* Company-Fields v1.1 — departments editor (EDIT-only; the company
          must exist first). The CompanyDepartment CRUD sub-routes already
          existed — surfaced here. */}
      {props.mode === 'edit' ? (
        <DepartmentsEditor companyId={props.initial.id} disabled={submitting} />
      ) : null}

      {submitError !== null ? (
        <InlineAlert variant="error">{submitError}</InlineAlert>
      ) : null}

      <div className="company-form__actions">
        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {submitting
            ? 'Saving…'
            : props.mode === 'create'
              ? 'Create company'
              : 'Save changes'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={props.onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

// Company-Fields v1.1 — the departments editor. List + add + remove against
// the existing /v1/companies/:id/departments CRUD. Self-contained (its own
// fetch/mutate state); independent of the company-form submit. Rendered only
// in EDIT mode (a company must exist before it can have departments).
function DepartmentsEditor({
  companyId,
  disabled,
}: {
  readonly companyId: string;
  readonly disabled: boolean;
}) {
  const [departments, setDepartments] = useState<readonly CompanyDepartmentView[]>([]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh(): void {
    listCompanyDepartments(companyId)
      .then((res) => setDepartments(res.items))
      .catch(() => setError('Could not load departments.'));
  }

  useEffect(() => {
    let cancelled = false;
    listCompanyDepartments(companyId)
      .then((res) => {
        if (!cancelled) setDepartments(res.items);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load departments.');
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  async function onAdd(): Promise<void> {
    const name = newName.trim();
    if (name === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createCompanyDepartment(companyId, { name });
      setNewName('');
      refresh();
    } catch {
      setError('Could not add the department.');
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(id: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteCompanyDepartment(companyId, id);
      refresh();
    } catch {
      setError('Could not remove the department.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="company-form__departments" disabled={disabled || busy}>
      <legend>Departments</legend>
      {departments.length === 0 ? (
        <p className="company-form__departments-empty">No departments yet.</p>
      ) : (
        <ul className="company-form__departments-list">
          {departments.map((d) => (
            <li key={d.id}>
              <span>{d.name}</span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void onRemove(d.id)}
                aria-label={`Remove ${d.name}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <FormField label="Add department">
        <input
          type="text"
          value={newName}
          onChange={(ev) => setNewName(ev.target.value)}
          aria-label="Add department"
        />
      </FormField>
      <Button
        type="button"
        variant="secondary"
        onClick={() => void onAdd()}
        disabled={newName.trim() === '' || busy}
      >
        Add department
      </Button>
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
    </fieldset>
  );
}
