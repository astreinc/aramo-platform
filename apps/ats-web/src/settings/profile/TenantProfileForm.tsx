import { ApiError, Combobox, useToast, type ComboboxItem } from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';
import { IconBuilding } from '@aramo/fe-foundation';

import { Button, Card, InlineAlert } from '../../ui';
import { SettingCardHead, SettingHint } from '../components';

import { ISO_3166_COUNTRIES } from './iso-3166-country';
import {
  EDITABLE_PROFILE_FIELDS,
  fetchTenantProfile,
  updateTenantProfile,
  type EditableProfileField,
  type ProfilePatch,
  type TenantProfileView,
} from './profile-api';

// The country picker mirrors the ISO-4217 currency precedent
// (CompensationSection.tsx): a Combobox whose item value is the 2-letter
// ISO-3166 code (what gets PATCHed) and whose label is the country name.
const COUNTRY_ITEMS: readonly ComboboxItem[] = ISO_3166_COUNTRIES.map(
  (c) => ({ value: c.value, label: c.label }),
);

// Settings Rebuild Directive 3 — the tenant-profile form (replaces the D1
// Organization & branding seam). GET-populated, PATCH-on-save (only the fields
// that actually changed). The logo is an honest URL reference field — the
// upload pipeline is a later increment, so there is no non-working uploader.

type FieldKind = 'text' | 'email' | 'url' | 'country';
interface FieldDef {
  readonly field: EditableProfileField;
  readonly label: string;
  readonly placeholder?: string;
  readonly kind?: FieldKind;
}
interface Group {
  readonly heading: string;
  readonly fields: readonly FieldDef[];
}

const GROUPS: readonly Group[] = [
  {
    heading: 'Organization',
    fields: [
      { field: 'legal_name', label: 'Legal name', placeholder: 'Astre Consulting Services Inc.' },
      { field: 'display_name', label: 'Display name', placeholder: 'Astre' },
    ],
  },
  {
    heading: 'Address',
    fields: [
      { field: 'address_line1', label: 'Address line 1' },
      { field: 'address_line2', label: 'Address line 2' },
      { field: 'city', label: 'City' },
      { field: 'state_province', label: 'State / province' },
      { field: 'postal_code', label: 'Postal code' },
      { field: 'country_code', label: 'Country', placeholder: 'Select country…', kind: 'country' },
    ],
  },
  {
    heading: 'Identifiers',
    fields: [
      { field: 'tax_id', label: 'Tax ID' },
      { field: 'registration_number', label: 'Registration number' },
    ],
  },
  {
    heading: 'Primary contact',
    fields: [
      { field: 'primary_contact_name', label: 'Name' },
      { field: 'primary_contact_email', label: 'Email', kind: 'email' },
      { field: 'primary_contact_phone', label: 'Phone' },
    ],
  },
  {
    heading: 'Branding',
    fields: [
      { field: 'logo_url', label: 'Logo URL', placeholder: 'https://…/logo.png', kind: 'url' },
    ],
  },
];

type Values = Record<EditableProfileField, string>;

function toValues(view: TenantProfileView): Values {
  const out = {} as Values;
  for (const f of EDITABLE_PROFILE_FIELDS) out[f] = view[f] ?? '';
  return out;
}

interface Props {
  readonly fetchFn?: () => Promise<TenantProfileView>;
  readonly saveFn?: (patch: ProfilePatch) => Promise<TenantProfileView>;
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; view: TenantProfileView }
  | { status: 'error'; message: string };

export function TenantProfileForm({ fetchFn, saveFn }: Props = {}) {
  const load = fetchFn ?? fetchTenantProfile;
  const save = saveFn ?? updateTenantProfile;
  const toast = useToast();

  const [state, setState] = useState<State>({ status: 'loading' });
  const [values, setValues] = useState<Values | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    let cancelled = false;
    load()
      .then((view) => {
        if (cancelled) return;
        setState({ status: 'ready', view });
        setValues(toValues(view));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to load the tenant profile.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const baseline = state.status === 'ready' ? toValues(state.view) : null;
  const dirtyFields = useMemo(() => {
    if (values === null || baseline === null) return [] as EditableProfileField[];
    return EDITABLE_PROFILE_FIELDS.filter((f) => values[f].trim() !== baseline[f].trim());
  }, [values, baseline]);

  const onSave = async () => {
    if (values === null || dirtyFields.length === 0) return;
    setSaving(true);
    setFormError('');
    const patch: ProfilePatch = {};
    for (const f of dirtyFields) patch[f] = values[f].trim();
    try {
      const updated = await save(patch);
      setState({ status: 'ready', view: updated });
      setValues(toValues(updated));
      toast.show('Tenant profile saved');
    } catch (err: unknown) {
      const message =
        err instanceof ApiError
          ? messageForApiError(err)
          : err instanceof Error
            ? err.message
            : 'Failed to save the tenant profile.';
      setFormError(message);
    } finally {
      setSaving(false);
    }
  };

  if (state.status === 'loading') {
    return <p className="set-muted">Loading tenant profile…</p>;
  }
  if (state.status === 'error') {
    return <InlineAlert variant="error">{state.message}</InlineAlert>;
  }
  const v = values as Values;

  return (
    <Card flush>
      <SettingCardHead
        icon={<IconBuilding />}
        title="Organization & branding"
        sub="Your tenant's legal identity, address, identifiers, primary contact and logo."
      />
      <div className="rc-card--pad">
        {formError ? <InlineAlert variant="error">{formError}</InlineAlert> : null}
        <p className="set-muted" style={{ paddingTop: 0 }}>
          Workspace name: <strong>{state.view.name}</strong> (set at provisioning — not editable here).
        </p>
        {GROUPS.map((group) => (
          <fieldset className="rc-pf-group" key={group.heading}>
            <legend>{group.heading}</legend>
            <div className="rc-fgrid">
              {group.fields.map((fd) => (
                <label className="rc-ifield" key={fd.field}>
                  <span>{fd.label}</span>
                  {fd.kind === 'country' ? (
                    <Combobox
                      ariaLabel={fd.label}
                      items={COUNTRY_ITEMS}
                      value={v[fd.field] === '' ? null : v[fd.field]}
                      onSelect={(item) =>
                        setValues({ ...v, [fd.field]: item.value })
                      }
                      placeholder={fd.placeholder ?? 'Select…'}
                      testId={`profile-field-${fd.field}`}
                    />
                  ) : (
                    <input
                      className="rc-input"
                      type={fd.kind === 'email' ? 'email' : fd.kind === 'url' ? 'url' : 'text'}
                      value={v[fd.field]}
                      placeholder={fd.placeholder}
                      onChange={(e) =>
                        setValues({ ...v, [fd.field]: e.target.value })
                      }
                      data-testid={`profile-field-${fd.field}`}
                    />
                  )}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        <SettingHint>
          The logo is a URL reference for now — a managed upload is a later increment, so this field
          links to an image you host rather than a non-working uploader.
        </SettingHint>
        <div className="rc-formfoot">
          <Button
            onClick={onSave}
            disabled={saving || dirtyFields.length === 0}
            data-testid="profile-save"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function messageForApiError(err: ApiError): string {
  const reason = typeof err.details?.['reason'] === 'string' ? (err.details['reason'] as string) : '';
  const field = typeof err.details?.['field'] === 'string' ? (err.details['field'] as string) : '';
  switch (reason) {
    case 'invalid_email':
      return 'The primary contact email is not a valid email address.';
    case 'invalid_country_code':
      return 'Country must be a 2-letter ISO code (e.g. US).';
    case 'invalid_url':
      return 'The logo URL must be an http(s) link.';
    case 'too_long':
      return `The value for ${field || 'a field'} is too long.`;
    case 'unknown_field':
      return 'That field cannot be edited here.';
    default:
      return err.message || 'Failed to save the tenant profile.';
  }
}
