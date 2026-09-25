import { Input, Select, TextArea } from '@aramo/fe-foundation';

import { companyTypes, relStatusFor } from './company-workspace';
import type {
  CompanyRelationshipInput,
  CompanyView,
  UpdateCompanyRequest,
} from './types';

// Company Detail — the inline in-place Overview edit model (Company Detail.dc.html).
// The SAME field positions/dimensions render in read and edit mode (a bordered
// box in view, a matching input/select in edit) so toggling never shifts layout.
// One `draft` string-map holds edits; Cancel discards it, Save diffs → PATCH.

export type OverviewDraft = Record<string, string>;

export interface OverviewField {
  readonly key: string;
  readonly label: string;
  readonly options?: readonly string[];
  readonly ph?: string;
  readonly req?: boolean;
}

// Prototype select vocabularies (the visual authority).
const OPT_INDUSTRY = ['Technology', 'Banking', 'Healthcare', 'Government', 'Insurance', 'Consulting', 'Manufacturing', 'Retail'];
const OPT_EMPLOYEES = ['', '1–50', '51–200', '201–1,000', '1,001–5,000', '5,000+'];
const OPT_REVENUE = ['', '< $10M', '$10M–$100M', '$100M–$1B', '> $1B'];
const OPT_OWNERSHIP = ['', 'Private', 'Public', 'Government', 'Non-profit'];
const OPT_COUNTRY = ['US', 'Canada', 'United Kingdom', 'India'];
const OPT_FEE = ['', 'Contract markup', 'Perm fee', 'Both'];
const OPT_TERMS = ['Net 15', 'Net 30', 'Net 45', 'Net 60'];
const OPT_CREDIT = ['', 'Approved', 'On review', 'Hold'];
const OPT_CURRENCY = ['USD', 'CAD', 'GBP', 'INR'];
const OPT_SUPPLIER = ['', 'Approved supplier', 'Preferred supplier', 'Pending onboarding'];

export const PROFILE_FIELDS: readonly OverviewField[] = [
  { key: 'name', label: 'Company name', req: true },
  { key: 'url', label: 'Website' },
  { key: 'industry', label: 'Industry', options: OPT_INDUSTRY },
  { key: 'employee_count_band', label: 'Employees', options: OPT_EMPLOYEES },
  { key: 'annual_revenue_band', label: 'Revenue band', options: OPT_REVENUE },
  { key: 'founded_year', label: 'Founded', ph: 'YYYY' },
  { key: 'ownership_type', label: 'Ownership', options: OPT_OWNERSHIP },
  // Parent company has no backend field — rendered read-only for parity below.
];

export const HQ_FIELDS: readonly OverviewField[] = [
  { key: 'address', label: 'Street address' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'zip', label: 'ZIP / Postal code' },
  { key: 'country', label: 'Country', options: OPT_COUNTRY },
];

export const COMMERCIAL_FIELDS: readonly OverviewField[] = [
  { key: 'fee_model', label: 'Fee model', options: OPT_FEE },
  { key: 'payment_terms', label: 'Payment terms', options: OPT_TERMS },
  { key: 'default_contract_markup_pct', label: 'Contract markup %' },
  { key: 'default_perm_fee_pct', label: 'Perm fee %' },
  { key: 'credit_status', label: 'Credit status', options: OPT_CREDIT },
  { key: 'default_currency', label: 'Currency', options: OPT_CURRENCY },
];

export const SUPPLIER_FIELDS: readonly OverviewField[] = [
  { key: 'supplier_status', label: 'Supplier status', options: OPT_SUPPLIER },
  { key: 'exclusivity', label: 'Exclusive', options: ['No', 'Yes'] },
  // MSP / VMS + Vendor number have no backend fields — read-only parity below.
];

// Fields whose draft value is a plain string patched 1:1 (trim, '' → null).
const STRING_KEYS = [
  'name', 'url', 'industry', 'employee_count_band', 'annual_revenue_band',
  'ownership_type', 'address', 'city', 'state', 'zip', 'country', 'description',
  'fee_model', 'payment_terms', 'default_contract_markup_pct',
  'default_perm_fee_pct', 'credit_status', 'default_currency', 'supplier_status',
] as const;

const REL_TYPES = ['CLIENT', 'VENDOR', 'PARTNER'] as const;

function rec(c: CompanyView): Record<string, unknown> {
  return c as unknown as Record<string, unknown>;
}
function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

export function companyToDraft(c: CompanyView): OverviewDraft {
  const r = rec(c);
  const d: OverviewDraft = {};
  for (const k of STRING_KEYS) d[k] = str(r[k]);
  d['name'] = c.name; // always present
  d['founded_year'] = c.founded_year !== null && c.founded_year !== undefined ? String(c.founded_year) : '';
  d['exclusivity'] = c.exclusivity ? 'Yes' : 'No';
  d['communication_restricted'] = c.communication_restricted ? 'true' : 'false';
  const types = companyTypes(c);
  for (const t of REL_TYPES) {
    d[`rel_${t}`] = types.includes(t) ? 'true' : 'false';
    d[`rel_${t}_status`] = relStatusFor(c, t) ?? (t === 'CLIENT' ? 'ACTIVE' : 'PROSPECT');
  }
  return d;
}

function selectedRels(d: OverviewDraft): CompanyRelationshipInput[] {
  const out: CompanyRelationshipInput[] = [];
  for (const t of REL_TYPES) {
    if (d[`rel_${t}`] === 'true') out.push({ type: t, status: d[`rel_${t}_status`] ?? 'PROSPECT' });
  }
  return out;
}

// Diff the draft against the company → the minimal authoritative PATCH body.
// commercialGated=false drops the commercial keys (never written without access).
export function draftToPatch(
  d: OverviewDraft,
  c: CompanyView,
  commercialGated: boolean,
): UpdateCompanyRequest {
  const r = rec(c);
  const body: Record<string, unknown> = {};
  const commercialKeys = new Set([
    'fee_model', 'payment_terms', 'default_contract_markup_pct',
    'default_perm_fee_pct', 'credit_status', 'default_currency',
  ]);
  for (const k of STRING_KEYS) {
    if (!commercialGated && commercialKeys.has(k)) continue;
    const cur = (d[k] ?? '').trim();
    if (cur !== str(r[k])) body[k] = cur === '' ? null : cur;
  }
  // founded_year — number | null.
  const fy = (d['founded_year'] ?? '').trim();
  const fyCur = c.founded_year !== null && c.founded_year !== undefined ? String(c.founded_year) : '';
  if (fy !== fyCur) {
    if (fy === '') body['founded_year'] = null;
    else {
      const n = Number(fy);
      if (Number.isFinite(n)) body['founded_year'] = n;
    }
  }
  // exclusivity (Yes/No) + do-not-contact (bool).
  const exc = d['exclusivity'] === 'Yes';
  if (exc !== c.exclusivity) body['exclusivity'] = exc;
  const dnc = d['communication_restricted'] === 'true';
  if (dnc !== c.communication_restricted) body['communication_restricted'] = dnc;

  // Relationships — per-type status; de-select → INACTIVE (Amendment-3), not delete.
  const selected = selectedRels(d);
  const selTypes = selected.map((x) => x.type);
  const initTypes = [...companyTypes(c)];
  const initPairs = initTypes.map((t) => `${t}:${relStatusFor(c, t) ?? ''}`).sort();
  const selPairs = selected.map((x) => `${x.type}:${x.status}`).sort();
  const removed = initTypes.filter((t) => !selTypes.includes(t));
  if (JSON.stringify(initPairs) !== JSON.stringify(selPairs) || removed.length > 0) {
    const rels: CompanyRelationshipInput[] = [...selected];
    for (const t of removed) rels.push({ type: t, status: 'INACTIVE' });
    body['relationships'] = rels;
  }
  return body as unknown as UpdateCompanyRequest;
}

// One Overview field — a bordered read box (view) or the matching control (edit),
// at the SAME position/size so read↔edit never shifts. `readOnly` renders the box
// even in edit mode (fields with no backend write path, e.g. Parent company).
export function EF({
  field,
  value,
  editing,
  onChange,
  readOnly,
}: {
  readonly field: OverviewField;
  readonly value: string;
  readonly editing: boolean;
  readonly onChange?: (v: string) => void;
  readonly readOnly?: boolean;
}): JSX.Element {
  const empty = value === '' || value === '—';
  const options =
    field.options !== undefined && !field.options.includes(value) && value !== ''
      ? [value, ...field.options]
      : field.options;
  return (
    <label className="rc-ef">
      <span className="rc-ef__lb">
        {field.label}
        {field.req ? <span className="rc-ef__req"> *</span> : null}
      </span>
      {editing && !readOnly && options !== undefined ? (
        <Select
          unstyled
          className="rc-ef__input"
          value={value}
          aria-label={field.label}
          onChange={(e) => onChange?.(e.target.value)}
        >
          {options.map((o) => (
            <option key={o} value={o}>
              {o === '' ? '—' : o}
            </option>
          ))}
        </Select>
      ) : editing && !readOnly ? (
        <Input
          unstyled
          className="rc-ef__input"
          type="text"
          value={value}
          placeholder={field.ph ?? ''}
          aria-label={field.label}
          onChange={(e) => onChange?.(e.target.value)}
        />
      ) : (
        <div className={`rc-ef__view${empty ? ' rc-ef__view--empty' : ''}`}>
          {empty ? '—' : value}
        </div>
      )}
    </label>
  );
}

// The About textarea (edit) / read box (view).
export function EFAbout({
  value,
  editing,
  onChange,
}: {
  readonly value: string;
  readonly editing: boolean;
  readonly onChange?: (v: string) => void;
}): JSX.Element {
  const empty = value.trim() === '';
  return (
    <label className="rc-ef rc-ef--full">
      <span className="rc-ef__lb">About</span>
      {editing ? (
        <TextArea
          unstyled
          className="rc-ef__input rc-ef__ta"
          rows={4}
          value={value}
          placeholder="What the company does, divisions you work with, how they hire…"
          aria-label="About"
          onChange={(e) => onChange?.(e.target.value)}
        />
      ) : (
        <div className={`rc-ef__view${empty ? ' rc-ef__view--empty' : ''}`}>
          {empty ? '—' : value}
        </div>
      )}
    </label>
  );
}
