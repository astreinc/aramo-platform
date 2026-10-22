import { ApiError, safeErrorMessage, useToast } from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';

import { ISO_3166_COUNTRIES } from './iso-3166-country';
import {
  EDITABLE_PROFILE_FIELDS,
  fetchTenantProfile,
  updateTenantProfile,
  type EditableProfileField,
  type ProfilePatch,
  type TenantProfileView,
} from './profile-api';

import './profile.css';

// ORG-UX-1 (Directive v1.0 LOCKED §8.2; handoff §6.2) — the organization profile form.
// GET /v1/tenant/profile populates it; Save PATCHes only the changed fields (the server
// writes the audit entry). A sticky bar appears while anything differs from the saved
// values; Discard restores them.
//   - Logo: the existing URL field; there is no "Upload logo" button (G1).
//   - EIN / Tax ID = tax_id; "DUNS / registration number" = registration_number, shown as
//     entered — nothing here claims a verified D-U-N-S number (G2, P3).
//   - Workspace name is read-only (name + this host).
//   - A1 refusals map to field messages (F10).

type Values = Record<EditableProfileField, string>;

interface FieldDef {
  readonly field: EditableProfileField;
  readonly label: string;
  readonly placeholder?: string;
  readonly hint?: string;
  readonly type?: 'text' | 'email' | 'tel';
  readonly country?: boolean;
}

interface CardDef {
  readonly key: string;
  readonly title: string;
  readonly sub: string;
  readonly fields: readonly FieldDef[];
}

const CARDS: readonly CardDef[] = [
  {
    key: 'address',
    title: 'Address',
    sub: 'Registered business address',
    fields: [
      { field: 'address_line1', label: 'Address line 1' },
      { field: 'address_line2', label: 'Address line 2', placeholder: 'Suite, floor (optional)' },
      { field: 'city', label: 'City' },
      { field: 'state_province', label: 'State / province' },
      { field: 'postal_code', label: 'Postal code' },
      { field: 'country_code', label: 'Country', country: true },
    ],
  },
  {
    key: 'identifiers',
    title: 'Identifiers',
    sub: 'Optional · used on contracts and compliance documents',
    fields: [
      { field: 'tax_id', label: 'EIN / Tax ID', placeholder: '12-3456789' },
      { field: 'registration_number', label: 'DUNS / registration number' },
    ],
  },
  {
    key: 'contact',
    title: 'Primary contact',
    sub: 'Who Aramo contacts about this organization',
    fields: [
      { field: 'primary_contact_name', label: 'Name' },
      { field: 'primary_contact_email', label: 'Email', type: 'email' },
      { field: 'primary_contact_phone', label: 'Phone', type: 'tel', placeholder: '+1 555 000 0000' },
    ],
  },
];

export const COUNTRY_NOT_SUPPORTED_MESSAGE = 'Aramo currently supports organizations in the United States.';
export const PROFILE_INCOMPLETE_MESSAGE = 'Complete the required address fields.';
export const COUNTRY_MISSING_HINT = 'Needed for invoices and documents';

function toValues(view: TenantProfileView): Values {
  const out = {} as Values;
  for (const f of EDITABLE_PROFILE_FIELDS) out[f] = view[f] ?? '';
  return out;
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter((p) => p.length > 0)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

const isHttpUrl = (v: string) => /^https?:\/\//i.test(v.trim());

/** A save refusal, placed where it belongs (F10). */
export type SaveError =
  | { readonly kind: 'field'; readonly field: EditableProfileField; readonly message: string }
  | { readonly kind: 'address'; readonly message: string }
  | { readonly kind: 'form'; readonly message: string };

export function saveErrorOf(err: unknown): SaveError {
  if (!(err instanceof ApiError)) return { kind: 'form', message: safeErrorMessage(err, 'The organization profile couldn’t be saved.') };
  const reason = typeof err.details?.['reason'] === 'string' ? (err.details['reason'] as string) : '';
  const rawField = typeof err.details?.['field'] === 'string' ? (err.details['field'] as string) : '';
  const field = (EDITABLE_PROFILE_FIELDS as readonly string[]).includes(rawField) ? (rawField as EditableProfileField) : null;
  switch (reason) {
    case 'organization_country_not_supported':
      return { kind: 'field', field: field ?? 'country_code', message: COUNTRY_NOT_SUPPORTED_MESSAGE };
    case 'organization_profile_incomplete':
      return { kind: 'address', message: PROFILE_INCOMPLETE_MESSAGE };
    case 'invalid_email':
      return { kind: 'field', field: 'primary_contact_email', message: 'Enter a valid email address.' };
    case 'invalid_country_code':
      return { kind: 'field', field: 'country_code', message: 'Choose a country from the list.' };
    case 'invalid_url':
      return { kind: 'field', field: 'logo_url', message: 'The logo URL must be an http(s) link.' };
    case 'too_long':
      return field !== null ? { kind: 'field', field, message: 'This value is too long.' } : { kind: 'form', message: 'A value is too long.' };
    default:
      return { kind: 'form', message: safeErrorMessage(err, 'The organization profile couldn’t be saved.') };
  }
}

interface Props {
  readonly fetchFn?: () => Promise<TenantProfileView>;
  readonly saveFn?: (patch: ProfilePatch) => Promise<TenantProfileView>;
  /** The host shown under Workspace name (defaults to window.location.host). */
  readonly host?: string;
}

type State = { readonly status: 'loading' } | { readonly status: 'ready'; readonly view: TenantProfileView } | { readonly status: 'error'; readonly message: string };

export function TenantProfileForm({ fetchFn = fetchTenantProfile, saveFn = updateTenantProfile, host }: Props = {}) {
  const toast = useToast();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [values, setValues] = useState<Values | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchFn()
      .then((view) => {
        if (cancelled) return;
        setState({ status: 'ready', view });
        setValues(toValues(view));
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: 'error', message: safeErrorMessage(err, 'The organization profile couldn’t be loaded.') });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchFn]);

  const saved = useMemo(() => (state.status === 'ready' ? toValues(state.view) : null), [state]);
  const dirtyFields = useMemo(() => {
    if (values === null || saved === null) return [] as EditableProfileField[];
    return EDITABLE_PROFILE_FIELDS.filter((f) => values[f].trim() !== saved[f].trim());
  }, [values, saved]);

  if (state.status === 'loading') return <p className="ox-muted" aria-busy="true">Loading the organization profile…</p>;
  if (state.status === 'error')
    return (
      <div className="ox-alert ox-alert--error" role="alert">
        {state.message}
      </div>
    );
  const v = values as Values;
  const view = state.view;
  const workspaceHost = host ?? (typeof window !== 'undefined' ? window.location.host : '');

  const set = (field: EditableProfileField, value: string) => {
    setValues({ ...v, [field]: value });
    if (error?.kind === 'field' && error.field === field) setError(null);
  };

  const onSave = async () => {
    if (dirtyFields.length === 0) return;
    setSaving(true);
    setError(null);
    const patch: ProfilePatch = {};
    for (const f of dirtyFields) patch[f] = v[f].trim();
    try {
      const updated = await saveFn(patch);
      setState({ status: 'ready', view: updated });
      setValues(toValues(updated));
      toast.show('Organization profile saved.');
    } catch (err: unknown) {
      setError(saveErrorOf(err));
    } finally {
      setSaving(false);
    }
  };

  const onDiscard = () => {
    if (saved !== null) setValues(saved);
    setError(null);
  };

  const fieldError = (f: EditableProfileField) => (error?.kind === 'field' && error.field === f ? error.message : null);

  const renderField = (fd: FieldDef) => {
    const id = `pf-${fd.field}`;
    const err = fieldError(fd.field);
    const countryMissing = fd.country === true && v[fd.field].trim() === '';
    const hint = countryMissing ? COUNTRY_MISSING_HINT : fd.hint;
    const describedBy = [err ? `${id}-err` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;
    const cls = err ? 'ox-input--error' : countryMissing ? 'ox-input--warn' : '';
    return (
      <label className="ox-field" key={fd.field} htmlFor={id}>
        <span className="ox-label">{fd.label}</span>
        {fd.country === true ? (
          <select
            id={id}
            className={`ox-select ${cls}`.trim()}
            value={v[fd.field]}
            onChange={(e) => set(fd.field, e.target.value)}
            aria-invalid={err ? true : undefined}
            aria-describedby={describedBy}
            data-testid={`profile-field-${fd.field}`}
          >
            <option value="">Select country…</option>
            {ISO_3166_COUNTRIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={id}
            className={`ox-input ${cls}`.trim()}
            type={fd.type ?? 'text'}
            value={v[fd.field]}
            placeholder={fd.placeholder}
            onChange={(e) => set(fd.field, e.target.value)}
            aria-invalid={err ? true : undefined}
            aria-describedby={describedBy}
            data-testid={`profile-field-${fd.field}`}
          />
        )}
        {hint ? (
          <span id={`${id}-hint`} className={countryMissing ? 'pf-hint pf-hint--warn' : 'pf-hint'}>
            {hint}
          </span>
        ) : null}
        {err ? (
          <span id={`${id}-err`} className="ox-error" role="alert">
            {err}
          </span>
        ) : null}
      </label>
    );
  };

  const orgName = v.display_name.trim() || v.legal_name.trim() || view.name;
  const logoPreview = isHttpUrl(saved?.logo_url ?? '') ? (saved?.logo_url ?? '') : '';

  return (
    <div className="pf-stack">
      <section className="ox-card pf-logo" aria-label="Logo">
        <span className="pf-logo__tile" aria-hidden="true">
          {logoPreview !== '' ? <img src={logoPreview} alt="" /> : initialsOf(orgName)}
        </span>
        <span className="pf-logo__text">
          <span className="pf-logo__title">Logo</span>
          <span className="pf-logo__help">Shown in every Aramo app, in emails and on signer pages. Link to a PNG or SVG you host, at least 256 × 256.</span>
        </span>
        <span className="pf-logo__url">{renderField({ field: 'logo_url', label: 'Logo URL', placeholder: 'https://…/logo.png' })}</span>
      </section>

      <section className="ox-card" aria-labelledby="pf-card-organization">
        <div className="ox-card__head">
          <div>
            <h2 id="pf-card-organization" className="ox-card__title">
              Organization
            </h2>
            <p className="ox-card__sub">Legal identity shown on documents and invoices</p>
          </div>
        </div>
        <div className="pf-fields ox-form-grid">
          {renderField({ field: 'legal_name', label: 'Legal name' })}
          {renderField({ field: 'display_name', label: 'Display name', hint: 'Shown in app headers and emails' })}
          <label className="ox-field" htmlFor="pf-workspace">
            <span className="ox-label">Workspace name</span>
            <input id="pf-workspace" className="ox-input" value={view.name} readOnly aria-describedby="pf-workspace-hint" data-testid="profile-workspace-name" />
            <span id="pf-workspace-hint" className="pf-hint">
              Set when your organization was created · {workspaceHost}
            </span>
          </label>
        </div>
      </section>

      {CARDS.map((card) => (
        <section className="ox-card" key={card.key} aria-labelledby={`pf-card-${card.key}`}>
          <div className="ox-card__head">
            <div>
              <h2 id={`pf-card-${card.key}`} className="ox-card__title">
                {card.title}
              </h2>
              <p className="ox-card__sub">{card.sub}</p>
            </div>
          </div>
          <div className="pf-fields">
            {card.key === 'address' && error?.kind === 'address' ? (
              <div className="ox-alert ox-alert--error" role="alert" style={{ marginBottom: 14 }} data-testid="profile-address-error">
                {error.message}
              </div>
            ) : null}
            <div className="ox-form-grid">{card.fields.map(renderField)}</div>
          </div>
        </section>
      ))}

      {error?.kind === 'form' ? (
        <div className="ox-alert ox-alert--error" role="alert" data-testid="profile-form-error">
          {error.message}
        </div>
      ) : null}

      {dirtyFields.length > 0 ? (
        <div className="pf-bar" role="region" aria-label="Unsaved changes" data-testid="profile-unsaved-bar">
          <span className="pf-bar__text">
            <b>Unsaved changes</b> to the organization profile
          </span>
          <button type="button" className="ox-btn ox-btn--secondary" onClick={onDiscard} disabled={saving} data-testid="profile-discard">
            Discard
          </button>
          <button type="button" className="ox-btn ox-btn--primary" onClick={() => void onSave()} disabled={saving} data-testid="profile-save">
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
