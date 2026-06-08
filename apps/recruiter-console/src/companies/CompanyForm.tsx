import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Combobox,
  FormField,
  InlineAlert,
  Switch,
  type ComboboxItem,
} from '@aramo/fe-foundation';

import { listContactsForCompany } from './companies-api';
import type {
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
}

interface FormState extends InlineFormState, MoreFormState {
  // EDIT-only (ruling B). Empty string represents "no selection / null".
  billing_contact_id: string;
}

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
    billing_contact_id: '',
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
    billing_contact_id: initial.billing_contact_id ?? '',
  };
}

function buildCreateBody(state: FormState): CreateCompanyRequest {
  const body: Record<string, unknown> = {
    name: state.name.trim(),
  };
  const stringFields: ReadonlyArray<keyof (InlineFormState & MoreFormState)> = [
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
  ];
  for (const k of stringFields) {
    const v = state[k];
    if (typeof v === 'string' && v !== '') body[k] = v;
  }
  if (state.is_hot) body['is_hot'] = true;
  // Ruling B: billing_contact_id is NOT sent on CREATE — no picker
  // is rendered; the form state for it stays at '' on CREATE.
  return body as unknown as CreateCompanyRequest;
}

function buildPatchBody(
  state: FormState,
  initial: CompanyView,
): UpdateCompanyRequest {
  const body: Record<string, unknown> = {};
  if (state.name !== initial.name) body['name'] = state.name.trim();
  if (state.is_hot !== initial.is_hot) body['is_hot'] = state.is_hot;

  const initialAsRecord = initial as unknown as Record<string, unknown>;
  const nullableStrings: ReadonlyArray<keyof MoreFormState | keyof InlineFormState> = [
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
  ];
  for (const k of nullableStrings) {
    const initVal = initialAsRecord[k] ?? '';
    const cur = state[k] as string;
    if (cur !== initVal) {
      body[k] = cur === '' ? null : cur;
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

  const submitting = props.submitting === true;
  const submitError = props.submitError ?? null;
  const nameValid = state.name.trim() !== '';
  const canSubmit = nameValid && !submitting;

  async function onSubmit(ev: React.FormEvent): Promise<void> {
    ev.preventDefault();
    if (!canSubmit) return;
    if (props.mode === 'create') {
      await props.onSubmit(buildCreateBody(state));
    } else {
      await props.onSubmit(buildPatchBody(state, props.initial));
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
