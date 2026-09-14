import { useState } from 'react';
import { Button, FormField } from '@aramo/fe-foundation';

import { companyTypes, relStatusFor } from '../company-workspace';
import type {
  CompanyRelationshipInput,
  CompanyView,
  CreateCompanyRequest,
  UpdateCompanyRequest,
} from '../types';

// Company Party/Role (ADR-0032, R6) — the FOCUSED quick-edit form for the
// slide-over, matching the Companies.dc.html panel: COMPANY (relationship rows
// with per-role status, name, industry, do-not-contact, website, phone,
// location) · ENGAGEMENT (payment terms) · Notes. The full field set
// (firmographics, commercial defaults, departments, address block, billing
// contact) lives in the detail-page "Full Edit" — NOT here.
//
// Relationship body-building mirrors CompanyForm exactly (per-role status;
// Amendment-3 de-select → INACTIVE transition, not delete) and is covered by
// this component's own spec.

const REL_STATUS_OPTS: readonly { value: string; label: string }[] = [
  { value: 'PROSPECT', label: 'Prospect' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ON_HOLD', label: 'On hold' },
  { value: 'INACTIVE', label: 'Inactive' },
];

interface FormState {
  name: string;
  industry: string;
  url: string;
  phone1: string;
  city: string;
  notes: string;
  payment_terms: string;
  communication_restricted: boolean;
  rel_client: boolean;
  rel_client_status: string;
  rel_vendor: boolean;
  rel_vendor_status: string;
  rel_partner: boolean;
  rel_partner_status: string;
}

function initialState(c: CompanyView | null): FormState {
  if (c === null) {
    return {
      name: '', industry: '', url: '', phone1: '', city: '', notes: '',
      payment_terms: '', communication_restricted: false,
      rel_client: true, rel_client_status: 'PROSPECT',
      rel_vendor: false, rel_vendor_status: 'PROSPECT',
      rel_partner: false, rel_partner_status: 'PROSPECT',
    };
  }
  const types = companyTypes(c);
  return {
    name: c.name,
    industry: c.industry ?? '',
    url: c.url ?? '',
    phone1: c.phone1 ?? '',
    city: c.city ?? '',
    notes: c.notes ?? '',
    payment_terms: c.payment_terms ?? '',
    communication_restricted: c.communication_restricted,
    rel_client: types.includes('CLIENT'),
    rel_client_status: relStatusFor(c, 'CLIENT') ?? 'ACTIVE',
    rel_vendor: types.includes('VENDOR'),
    rel_vendor_status: relStatusFor(c, 'VENDOR') ?? 'PROSPECT',
    rel_partner: types.includes('PARTNER'),
    rel_partner_status: relStatusFor(c, 'PARTNER') ?? 'PROSPECT',
  };
}

function selectedRels(s: FormState): CompanyRelationshipInput[] {
  const out: CompanyRelationshipInput[] = [];
  if (s.rel_client) out.push({ type: 'CLIENT', status: s.rel_client_status });
  if (s.rel_vendor) out.push({ type: 'VENDOR', status: s.rel_vendor_status });
  if (s.rel_partner) out.push({ type: 'PARTNER', status: s.rel_partner_status });
  return out;
}

function buildCreate(s: FormState, canSeeCommercial: boolean): CreateCompanyRequest {
  const b: Record<string, unknown> = { name: s.name.trim() };
  const rels = selectedRels(s);
  if (rels.length > 0) b['relationships'] = rels;
  if (s.communication_restricted) b['communication_restricted'] = true;
  if (s.industry.trim() !== '') b['industry'] = s.industry.trim();
  if (s.url.trim() !== '') b['url'] = s.url.trim();
  if (s.phone1.trim() !== '') b['phone1'] = s.phone1.trim();
  if (s.city.trim() !== '') b['city'] = s.city.trim();
  if (s.notes.trim() !== '') b['notes'] = s.notes.trim();
  if (canSeeCommercial && s.payment_terms.trim() !== '')
    b['payment_terms'] = s.payment_terms.trim();
  return b as unknown as CreateCompanyRequest;
}

function buildPatch(
  s: FormState,
  initial: CompanyView,
  canSeeCommercial: boolean,
): UpdateCompanyRequest {
  const b: Record<string, unknown> = {};
  if (s.name.trim() !== initial.name) b['name'] = s.name.trim();

  // Relationship diff (per-role status; Amendment-3 de-select → INACTIVE).
  const selected = selectedRels(s);
  const selTypes = selected.map((r) => r.type);
  const initTypes = [...companyTypes(initial)];
  const initPairs = initTypes.map((t) => `${t}:${relStatusFor(initial, t) ?? ''}`).sort();
  const selPairs = selected.map((r) => `${r.type}:${r.status}`).sort();
  const removed = initTypes.filter((t) => !selTypes.includes(t));
  if (JSON.stringify(initPairs) !== JSON.stringify(selPairs) || removed.length > 0) {
    const rels: CompanyRelationshipInput[] = [...selected];
    for (const t of removed) rels.push({ type: t, status: 'INACTIVE' });
    b['relationships'] = rels;
  }
  if (s.communication_restricted !== initial.communication_restricted)
    b['communication_restricted'] = s.communication_restricted;

  const diff = (cur: string, init: string | null, key: string) => {
    const c = cur.trim();
    if (c !== (init ?? '')) b[key] = c === '' ? null : c;
  };
  diff(s.industry, initial.industry, 'industry');
  diff(s.url, initial.url, 'url');
  diff(s.phone1, initial.phone1, 'phone1');
  diff(s.city, initial.city, 'city');
  diff(s.notes, initial.notes, 'notes');
  if (canSeeCommercial) diff(s.payment_terms, initial.payment_terms ?? '', 'payment_terms');
  return b as unknown as UpdateCompanyRequest;
}

interface CommonProps {
  readonly canSeeCommercial: boolean;
  readonly submitting: boolean;
  readonly onCancel: () => void;
}
type CompanyQuickEditFormProps =
  | (CommonProps & { readonly mode: 'create'; readonly onSubmit: (b: CreateCompanyRequest) => Promise<void> })
  | (CommonProps & { readonly mode: 'edit'; readonly initial: CompanyView; readonly onSubmit: (b: UpdateCompanyRequest) => Promise<void> });

export function CompanyQuickEditForm(props: CompanyQuickEditFormProps) {
  const [state, setState] = useState<FormState>(() =>
    initialState(props.mode === 'edit' ? props.initial : null),
  );
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setState((s) => ({ ...s, [k]: v }));

  const canSubmit =
    state.name.trim() !== '' && selectedRels(state).length > 0 && !props.submitting;

  async function onSubmit(ev: React.FormEvent): Promise<void> {
    ev.preventDefault();
    if (props.mode === 'create') {
      await props.onSubmit(buildCreate(state, props.canSeeCommercial));
    } else {
      await props.onSubmit(buildPatch(state, props.initial, props.canSeeCommercial));
    }
  }

  const relRow = (
    label: string,
    desc: string,
    on: boolean,
    onKey: keyof FormState,
    statusVal: string,
    statusKey: keyof FormState,
  ) => (
    <div className="company-form__relrow">
      <label className="company-form__check">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => set(onKey, e.target.checked as never)}
        />{' '}
        <span>
          {label}
          <small>{desc}</small>
        </span>
      </label>
      <select
        value={statusVal}
        onChange={(e) => set(statusKey, e.target.value as never)}
        aria-label={`${label} status`}
        disabled={!on || props.submitting}
      >
        {REL_STATUS_OPTS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );

  return (
    <form className="company-form company-form--drawer" onSubmit={onSubmit}>
      <fieldset className="company-form__section" disabled={props.submitting}>
        <legend>Company</legend>
        <FormField label="Relationships">
          <div className="company-form__rel" role="group" aria-label="Relationships">
            {relRow('Client', 'Owns requisitions · receives submittals · placements', state.rel_client, 'rel_client', state.rel_client_status, 'rel_client_status')}
            {relRow('Vendor', 'Supplies talent · staffing supplier', state.rel_vendor, 'rel_vendor', state.rel_vendor_status, 'rel_vendor_status')}
            {relRow('Partner', 'Strategic · referral · integration', state.rel_partner, 'rel_partner', state.rel_partner_status, 'rel_partner_status')}
          </div>
          <p className="company-form__hint">
            Each relationship carries its own status — a company can be an active
            client and an inactive vendor at the same time.
          </p>
        </FormField>
        <FormField label="Company name">
          <input
            type="text"
            value={state.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="e.g. Northwind Systems"
            aria-label="Company name"
          />
        </FormField>
        <div className="company-form__row2">
          <FormField label="Industry">
            <input
              type="text"
              value={state.industry}
              onChange={(e) => set('industry', e.target.value)}
              aria-label="Industry"
            />
          </FormField>
          <FormField label="Do not contact">
            <label className="company-form__check">
              <input
                type="checkbox"
                checked={state.communication_restricted}
                onChange={(e) => set('communication_restricted', e.target.checked)}
              />{' '}
              Company-wide — overrides all relationships
            </label>
          </FormField>
        </div>
        <div className="company-form__row2">
          <FormField label="Website">
            <input type="text" value={state.url} onChange={(e) => set('url', e.target.value)} placeholder="https://" aria-label="Website" />
          </FormField>
          <FormField label="Phone">
            <input type="text" value={state.phone1} onChange={(e) => set('phone1', e.target.value)} aria-label="Phone" />
          </FormField>
        </div>
        <FormField label="Location">
          <input type="text" value={state.city} onChange={(e) => set('city', e.target.value)} placeholder="City" aria-label="Location" />
        </FormField>
      </fieldset>

      {props.canSeeCommercial ? (
        <fieldset className="company-form__section" disabled={props.submitting}>
          <legend>Engagement</legend>
          <FormField label="Payment terms">
            <input type="text" value={state.payment_terms} onChange={(e) => set('payment_terms', e.target.value)} placeholder="e.g. net_30" aria-label="Payment terms" />
          </FormField>
        </fieldset>
      ) : null}

      <fieldset className="company-form__section" disabled={props.submitting}>
        <legend>Notes</legend>
        <FormField label="Notes">
          <textarea rows={3} value={state.notes} onChange={(e) => set('notes', e.target.value)} aria-label="Notes" />
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
              ? 'Save company'
              : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
