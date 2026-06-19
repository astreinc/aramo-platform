import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Combobox,
  FormField,
  InlineAlert,
  Switch,
  type ComboboxItem,
} from '@aramo/fe-foundation';

import { listContactsForCompany } from '../companies/companies-api';
import type { ContactView } from '../companies/types';

import type {
  CreateContactRequest,
  UpdateContactRequest,
} from './types';

// R6' — the shared contact CREATE/EDIT composite. The thin route
// wrappers (ContactCreateView / ContactEditView) handle navigation +
// pre-fetch + success; this component owns the field-by-field form
// state + the buildCreateBody / buildPatchBody construction (R4
// omit-vs-null discipline).
//
// Ruling A — tiered field set. The BE accepts 19 contact fields; the
// form surfaces first/last/title/email1/2/phone_work inline + the
// rest behind a "More fields" disclosure.
//
// THE RELATIONSHIP FIELD — reports_to_id (the self-link). The BE has
// ZERO validation. The FE owns:
//   (a) picker source = the contact's company's contacts
//       (listContactsForCompany)
//   (b) exclude-self on EDIT — `item.value !== contactId`. On CREATE
//       no self exists yet (the contact has no id), so no exclude is
//       needed; we still enumerate the company's contacts.
//   (c) same-company is naturally enforced by the picker source.
//
// Ruling C — left_company surfaced on EDIT only (PATCH-only field; not
// on CREATE). The R3 Contacts row already DISPLAYS the flag; this
// closes the see-but-can't-set loop.
//
// Ruling D — company_department_id NOT surfaced. The PATCH never sends
// the key (omit-not-touch); existing values are preserved.

interface InlineFormState {
  first_name: string;
  last_name: string;
  title: string;
  email1: string;
  email2: string;
  phone_work: string;
}

interface MoreFormState {
  phone_cell: string;
  phone_other: string;
  address: string;
  is_hot: boolean;
  notes: string;
}

interface FormState extends InlineFormState, MoreFormState {
  reports_to_id: string;
  // EDIT-only (ruling C). On CREATE this stays false.
  left_company: boolean;
}

function emptyState(): FormState {
  return {
    first_name: '',
    last_name: '',
    title: '',
    email1: '',
    email2: '',
    phone_work: '',
    phone_cell: '',
    phone_other: '',
    address: '',
    is_hot: false,
    notes: '',
    reports_to_id: '',
    left_company: false,
  };
}

function stateFromInitial(initial: ContactView): FormState {
  return {
    first_name: initial.first_name,
    last_name: initial.last_name,
    title: initial.title ?? '',
    email1: initial.email1 ?? '',
    email2: initial.email2 ?? '',
    phone_work: initial.phone_work ?? '',
    phone_cell: initial.phone_cell ?? '',
    phone_other: initial.phone_other ?? '',
    address: initial.address ?? '',
    is_hot: initial.is_hot,
    notes: initial.notes ?? '',
    reports_to_id: initial.reports_to_id ?? '',
    left_company: initial.left_company,
  };
}

function buildCreateBody(
  state: FormState,
  companyId: string,
): CreateContactRequest {
  const body: Record<string, unknown> = {
    company_id: companyId,
    first_name: state.first_name.trim(),
    last_name: state.last_name.trim(),
  };
  const stringFields: ReadonlyArray<keyof InlineFormState | keyof MoreFormState> = [
    'title',
    'email1',
    'email2',
    'phone_work',
    'phone_cell',
    'phone_other',
    'address',
    'notes',
  ];
  for (const k of stringFields) {
    const v = state[k];
    if (typeof v === 'string' && v !== '') body[k] = v;
  }
  if (state.is_hot) body['is_hot'] = true;
  if (state.reports_to_id !== '') body['reports_to_id'] = state.reports_to_id;
  // Ruling D: company_department_id NOT surfaced; never sent on CREATE.
  return body as unknown as CreateContactRequest;
}

function buildPatchBody(
  state: FormState,
  initial: ContactView,
): UpdateContactRequest {
  const body: Record<string, unknown> = {};
  if (state.first_name !== initial.first_name) {
    body['first_name'] = state.first_name.trim();
  }
  if (state.last_name !== initial.last_name) {
    body['last_name'] = state.last_name.trim();
  }
  if (state.is_hot !== initial.is_hot) body['is_hot'] = state.is_hot;
  if (state.left_company !== initial.left_company) {
    body['left_company'] = state.left_company;
  }

  const initialAsRecord = initial as unknown as Record<string, unknown>;
  const nullableStrings: ReadonlyArray<
    keyof InlineFormState | keyof MoreFormState
  > = [
    'title',
    'email1',
    'email2',
    'phone_work',
    'phone_cell',
    'phone_other',
    'address',
    'notes',
  ];
  for (const k of nullableStrings) {
    const initVal = initialAsRecord[k] ?? '';
    const cur = state[k] as string;
    if (cur !== initVal) {
      body[k] = cur === '' ? null : cur;
    }
  }

  // reports_to_id: empty → null (clear); else send if changed.
  const initialReportsTo = initial.reports_to_id ?? '';
  if (state.reports_to_id !== initialReportsTo) {
    body['reports_to_id'] =
      state.reports_to_id === '' ? null : state.reports_to_id;
  }

  // Ruling D: company_department_id NEVER sent on PATCH — omit
  // preserves the existing value.
  return body as unknown as UpdateContactRequest;
}

interface CommonProps {
  readonly onCancel: () => void;
  readonly submitting?: boolean;
  readonly submitError?: string | null;
}

interface CreateProps extends CommonProps {
  readonly mode: 'create';
  readonly companyId: string;
  readonly onSubmit: (body: CreateContactRequest) => Promise<void>;
}

interface EditProps extends CommonProps {
  readonly mode: 'edit';
  readonly initial: ContactView;
  readonly onSubmit: (body: UpdateContactRequest) => Promise<void>;
}

type ContactFormProps = CreateProps | EditProps;

export function ContactForm(props: ContactFormProps) {
  const [state, setState] = useState<FormState>(() =>
    props.mode === 'edit' ? stateFromInitial(props.initial) : emptyState(),
  );
  const [showMore, setShowMore] = useState(false);
  const [companyContacts, setCompanyContacts] = useState<readonly ContactView[]>([]);

  // The picker source is the contact's company's contacts.
  // CREATE: from props.companyId. EDIT: from props.initial.company_id.
  const companyIdForPicker =
    props.mode === 'create' ? props.companyId : props.initial.company_id;
  const selfId = props.mode === 'edit' ? props.initial.id : null;

  useEffect(() => {
    let cancelled = false;
    listContactsForCompany(companyIdForPicker)
      .then((res) => {
        if (cancelled) return;
        setCompanyContacts(res.items);
      })
      .catch(() => {
        if (cancelled) return;
        setCompanyContacts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [companyIdForPicker]);

  // EXCLUDE SELF on EDIT (the load-bearing FE guard — the BE has zero
  // validation here). On CREATE no self exists yet, so the filter is a
  // no-op; on EDIT we drop the row for `selfId`.
  const reportsToItems: readonly ComboboxItem[] = useMemo(
    () =>
      companyContacts
        .filter((c) => selfId === null || c.id !== selfId)
        .map((c) => ({
          value: c.id,
          label: `${c.first_name} ${c.last_name}`.trim() || '—',
          description: c.title ?? c.email1 ?? undefined,
        })),
    [companyContacts, selfId],
  );

  function set<K extends keyof FormState>(key: K, next: FormState[K]): void {
    setState((s) => ({ ...s, [key]: next }));
  }

  const submitting = props.submitting === true;
  const submitError = props.submitError ?? null;
  const nameValid =
    state.first_name.trim() !== '' && state.last_name.trim() !== '';
  const canSubmit = nameValid && !submitting;

  async function onSubmit(ev: React.FormEvent): Promise<void> {
    ev.preventDefault();
    if (!canSubmit) return;
    if (props.mode === 'create') {
      await props.onSubmit(buildCreateBody(state, props.companyId));
    } else {
      await props.onSubmit(buildPatchBody(state, props.initial));
    }
  }

  return (
    <form className="contact-form" onSubmit={onSubmit}>
      <fieldset className="contact-form__identity" disabled={submitting}>
        <legend>Identity</legend>
        <FormField label="First name">
          <input
            type="text"
            value={state.first_name}
            onChange={(ev) => set('first_name', ev.target.value)}
            aria-label="First name"
            required
          />
        </FormField>
        <FormField label="Last name">
          <input
            type="text"
            value={state.last_name}
            onChange={(ev) => set('last_name', ev.target.value)}
            aria-label="Last name"
            required
          />
        </FormField>
        <FormField label="Title">
          <input
            type="text"
            value={state.title}
            onChange={(ev) => set('title', ev.target.value)}
            aria-label="Title"
          />
        </FormField>
      </fieldset>

      <fieldset className="contact-form__contact" disabled={submitting}>
        <legend>Contact</legend>
        <FormField label="Primary email">
          <input
            type="email"
            value={state.email1}
            onChange={(ev) => set('email1', ev.target.value)}
            aria-label="Primary email"
          />
        </FormField>
        <FormField label="Secondary email">
          <input
            type="email"
            value={state.email2}
            onChange={(ev) => set('email2', ev.target.value)}
            aria-label="Secondary email"
          />
        </FormField>
        <FormField label="Work phone">
          <input
            type="tel"
            value={state.phone_work}
            onChange={(ev) => set('phone_work', ev.target.value)}
            aria-label="Work phone"
          />
        </FormField>
      </fieldset>

      <fieldset className="contact-form__reports-to" disabled={submitting}>
        <legend>Reports to</legend>
        <FormField
          label="Reports to"
          helper={
            reportsToItems.length === 0
              ? 'No other contacts in this company yet.'
              : 'Optional. The contact this person reports to.'
          }
        >
          <Combobox
            ariaLabel="Reports to"
            items={reportsToItems}
            value={state.reports_to_id === '' ? null : state.reports_to_id}
            onSelect={(item) => set('reports_to_id', item.value)}
            placeholder={
              reportsToItems.length === 0
                ? 'No other contacts available'
                : 'Select supervisor…'
            }
            disabled={reportsToItems.length === 0}
            testId="reports-to-picker"
          />
        </FormField>
        {state.reports_to_id !== '' ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => set('reports_to_id', '')}
            disabled={submitting}
          >
            Clear reports-to
          </Button>
        ) : null}
      </fieldset>

      {props.mode === 'edit' ? (
        <fieldset className="contact-form__lifecycle" disabled={submitting}>
          <legend>Lifecycle</legend>
          <FormField
            label="Left company"
            helper="Mark this contact as no longer at the company. The record is preserved for history."
          >
            <Switch
              checked={state.left_company}
              onCheckedChange={(c) => set('left_company', c)}
              aria-label="Left company"
            />
          </FormField>
        </fieldset>
      ) : null}

      <details
        className="contact-form__more"
        open={showMore}
        onToggle={(ev) => setShowMore((ev.target as HTMLDetailsElement).open)}
      >
        <summary>More fields</summary>

        <fieldset className="contact-form__phones" disabled={submitting}>
          <legend>Additional phones</legend>
          <FormField label="Cell phone">
            <input
              type="tel"
              value={state.phone_cell}
              onChange={(ev) => set('phone_cell', ev.target.value)}
              aria-label="Cell phone"
            />
          </FormField>
          <FormField label="Other phone">
            <input
              type="tel"
              value={state.phone_other}
              onChange={(ev) => set('phone_other', ev.target.value)}
              aria-label="Other phone"
            />
          </FormField>
        </fieldset>

        <fieldset className="contact-form__address" disabled={submitting}>
          <legend>Address</legend>
          <FormField label="Address">
            <input
              type="text"
              value={state.address}
              onChange={(ev) => set('address', ev.target.value)}
              aria-label="Address"
            />
          </FormField>
        </fieldset>

        <fieldset className="contact-form__flags" disabled={submitting}>
          <legend>Flags</legend>
          <FormField label="Hot">
            <Switch
              checked={state.is_hot}
              onCheckedChange={(c) => set('is_hot', c)}
              aria-label="Hot"
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
        </fieldset>
      </details>

      {submitError !== null ? (
        <InlineAlert variant="error">{submitError}</InlineAlert>
      ) : null}

      <div className="contact-form__actions">
        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {submitting
            ? 'Saving…'
            : props.mode === 'create'
              ? 'Create contact'
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
