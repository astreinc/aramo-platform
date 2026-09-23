import { useEffect, useState } from 'react';
import { Button, FormField, Checkbox, Input, Select, TextArea } from '@aramo/fe-foundation';

import { searchCompanies } from '../../companies/companies-api';
import type { ContactView } from '../../companies/types';
import { fetchAssignableUsers, type AssignableUser } from '../../users/users-api';
import type {
  CreateContactRequest,
  UpdateContactRequest,
} from '../types';

// Contacts prototype parity — the FOCUSED quick-edit form for the slide-over,
// matching the Contacts.dc.html panel: CONTACT (First*, Last*, Title, Company*
// select, "Primary contact for this company" checkbox) · DETAILS (Email,
// Phone + Mobile, Account owner select, Notes). Mirrors CompanyQuickEditForm:
// discriminated create|edit union, buildCreate/buildPatch with omit-vs-null
// diff. This drawer is the ONLY contact edit surface — the secondary email/
// phone, address, reports-to and lifecycle fields are not surfaced here (a
// future "more fields" affordance can extend the drawer).
//
// On EDIT the company is FIXED (UpdateContactRequest has no company_id — a
// contact cannot change companies) so it renders read-only. On CREATE the
// company is a required <select> populated from searchCompanies.

interface FormState {
  first_name: string;
  last_name: string;
  title: string;
  company_id: string;
  is_primary: boolean;
  email1: string;
  phone_work: string;
  phone_cell: string;
  owner_id: string;
  notes: string;
}

function initialState(c: ContactView | null, initialCompanyId: string): FormState {
  if (c === null) {
    return {
      first_name: '', last_name: '', title: '',
      company_id: initialCompanyId, is_primary: false,
      email1: '', phone_work: '', phone_cell: '', owner_id: '', notes: '',
    };
  }
  return {
    first_name: c.first_name,
    last_name: c.last_name,
    title: c.title ?? '',
    company_id: c.company_id,
    is_primary: c.is_primary,
    email1: c.email1 ?? '',
    phone_work: c.phone_work ?? '',
    phone_cell: c.phone_cell ?? '',
    owner_id: c.owner_id ?? '',
    notes: c.notes ?? '',
  };
}

function buildCreate(s: FormState): CreateContactRequest {
  const b: Record<string, unknown> = {
    company_id: s.company_id,
    first_name: s.first_name.trim(),
    last_name: s.last_name.trim(),
  };
  if (s.title.trim() !== '') b['title'] = s.title.trim();
  if (s.email1.trim() !== '') b['email1'] = s.email1.trim();
  if (s.phone_work.trim() !== '') b['phone_work'] = s.phone_work.trim();
  if (s.phone_cell.trim() !== '') b['phone_cell'] = s.phone_cell.trim();
  if (s.notes.trim() !== '') b['notes'] = s.notes.trim();
  if (s.is_primary) b['is_primary'] = true;
  if (s.owner_id !== '') b['owner_id'] = s.owner_id;
  return b as unknown as CreateContactRequest;
}

function buildPatch(s: FormState, initial: ContactView): UpdateContactRequest {
  const b: Record<string, unknown> = {};
  if (s.first_name.trim() !== initial.first_name) b['first_name'] = s.first_name.trim();
  if (s.last_name.trim() !== initial.last_name) b['last_name'] = s.last_name.trim();

  const diff = (cur: string, init: string | null, key: string) => {
    const c = cur.trim();
    if (c !== (init ?? '')) b[key] = c === '' ? null : c;
  };
  diff(s.title, initial.title, 'title');
  diff(s.email1, initial.email1, 'email1');
  diff(s.phone_work, initial.phone_work, 'phone_work');
  diff(s.phone_cell, initial.phone_cell, 'phone_cell');
  diff(s.notes, initial.notes, 'notes');

  if (s.is_primary !== initial.is_primary) b['is_primary'] = s.is_primary;
  // owner_id: empty → null (clear); else send if changed. company_id is
  // structurally absent on PATCH (the anchor is fixed).
  const initOwner = initial.owner_id ?? '';
  if (s.owner_id !== initOwner) b['owner_id'] = s.owner_id === '' ? null : s.owner_id;
  return b as unknown as UpdateContactRequest;
}

interface CompanyOption {
  readonly id: string;
  readonly name: string;
}

interface CommonProps {
  readonly submitting: boolean;
  readonly onCancel: () => void;
}
type ContactQuickEditFormProps =
  | (CommonProps & {
      readonly mode: 'create';
      readonly initialCompanyId?: string;
      readonly onSubmit: (b: CreateContactRequest) => Promise<void>;
    })
  | (CommonProps & {
      readonly mode: 'edit';
      readonly initial: ContactView;
      readonly onSubmit: (b: UpdateContactRequest) => Promise<void>;
    });

export function ContactQuickEditForm(props: ContactQuickEditFormProps) {
  const initialCompanyId =
    props.mode === 'create' ? (props.initialCompanyId ?? '') : props.initial.company_id;
  const [state, setState] = useState<FormState>(() =>
    initialState(props.mode === 'edit' ? props.initial : null, initialCompanyId),
  );
  const [companies, setCompanies] = useState<readonly CompanyOption[]>([]);
  const [owners, setOwners] = useState<readonly AssignableUser[]>([]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setState((s) => ({ ...s, [k]: v }));

  const isCreate = props.mode === 'create';

  // Company options — CREATE only (edit's company is fixed/read-only).
  useEffect(() => {
    if (!isCreate) return;
    let cancelled = false;
    const params = new URLSearchParams({ paged: 'true', page_size: '200' });
    searchCompanies(params)
      .then((res) => {
        if (cancelled) return;
        setCompanies((res.items ?? []).map((c) => ({ id: c.id, name: c.name })));
      })
      .catch(() => {
        if (!cancelled) setCompanies([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isCreate]);

  // Account-owner options — the shared assignable-users picker source.
  useEffect(() => {
    let cancelled = false;
    fetchAssignableUsers()
      .then((users) => {
        if (!cancelled) setOwners(users);
      })
      .catch(() => {
        if (!cancelled) setOwners([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const companyName =
    props.mode === 'edit'
      ? (props.initial.company_name ?? 'Company')
      : (companies.find((c) => c.id === state.company_id)?.name ?? '');

  const canSubmit =
    state.first_name.trim() !== '' &&
    state.last_name.trim() !== '' &&
    (!isCreate || state.company_id !== '') &&
    !props.submitting;

  async function onSubmit(ev: React.FormEvent): Promise<void> {
    ev.preventDefault();
    if (!canSubmit) return;
    if (props.mode === 'create') {
      await props.onSubmit(buildCreate(state));
    } else {
      await props.onSubmit(buildPatch(state, props.initial));
    }
  }

  return (
    <form className="company-form company-form--drawer" onSubmit={onSubmit}>
      <fieldset className="company-form__section" disabled={props.submitting}>
        <legend>Contact</legend>
        <div className="company-form__row2">
          <FormField label="First name">
            <Input
              type="text"
              value={state.first_name}
              onChange={(e) => set('first_name', e.target.value)}
              aria-label="First name"
              required
            />
          </FormField>
          <FormField label="Last name">
            <Input
              type="text"
              value={state.last_name}
              onChange={(e) => set('last_name', e.target.value)}
              aria-label="Last name"
              required
            />
          </FormField>
        </div>
        <FormField label="Title">
          <Input
            type="text"
            value={state.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="e.g. VP Engineering"
            aria-label="Title"
          />
        </FormField>
        <FormField label="Company">
          {isCreate ? (
            <Select
              value={state.company_id}
              onChange={(e) => set('company_id', e.target.value)}
              aria-label="Company"
            >
              <option value="">Select…</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          ) : (
            <Input
              type="text"
              value={companyName}
              readOnly
              aria-label="Company"
              data-testid="contact-company-readonly"
            />
          )}
        </FormField>
        <FormField label="Primary contact">
          <label className="company-form__check">
            <Checkbox
             
              checked={state.is_primary}
              onChange={(e) => set('is_primary', e.target.checked)}
              aria-label="Primary contact for this company"
            />{' '}
            Primary contact for this company
          </label>
        </FormField>
      </fieldset>

      <fieldset className="company-form__section" disabled={props.submitting}>
        <legend>Details</legend>
        <FormField label="Email">
          <Input
            type="email"
            value={state.email1}
            onChange={(e) => set('email1', e.target.value)}
            placeholder="name@company.com"
            aria-label="Email"
          />
        </FormField>
        <div className="company-form__row2">
          <FormField label="Phone">
            <Input
              type="tel"
              value={state.phone_work}
              onChange={(e) => set('phone_work', e.target.value)}
              aria-label="Phone"
            />
          </FormField>
          <FormField label="Mobile">
            <Input
              type="tel"
              value={state.phone_cell}
              onChange={(e) => set('phone_cell', e.target.value)}
              aria-label="Mobile"
            />
          </FormField>
        </div>
        <FormField label="Account owner">
          <Select
            value={state.owner_id}
            onChange={(e) => set('owner_id', e.target.value)}
            aria-label="Account owner"
          >
            <option value="">Unassigned</option>
            {owners.map((u) => (
              <option key={u.user_id} value={u.user_id}>
                {u.display_name ?? u.user_id}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Notes">
          <TextArea
            rows={3}
            value={state.notes}
            onChange={(e) => set('notes', e.target.value)}
            placeholder="Preferences, escalation rules, meeting cadence…"
            aria-label="Notes"
          />
        </FormField>
      </fieldset>

      <div className="company-form__actions">
        <Button type="button" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {props.submitting
            ? 'Saving…'
            : props.mode === 'create'
              ? 'Save contact'
              : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
