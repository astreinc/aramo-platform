import {
  InlineEditField,
  InlineSelectField,
} from '../components/InlineEditField';

import {
  DURATION_UNIT_VALUES,
  HEADCOUNT_REASON_VALUES,
  JOB_TYPE_VALUES,
  ROLE_FAMILY_VALUES,
  SENIORITY_LEVEL_VALUES,
  SOURCE_SYSTEM_VALUES,
  WORK_ARRANGEMENT_VALUES,
  WORK_AUTHORIZATION_VALUES,
  enterpriseLabel,
} from './enterprise-fields';
import {
  canEditBucket,
  type CockpitFieldDescriptor,
} from './field-affordance';
import { RATE_PERIOD_VALUES, REQUISITION_STATUS_VALUES } from './types';

// PR-A2 P1 — the cockpit FIELD ROW renderer. Given a field descriptor + the
// requisition payload + the actor's scopes, renders the right inline editor
// (or read-only display) with the correct per-field affordance. Pure glue
// over the P2 primitive + the affordance map; no scope logic of its own
// beyond delegating to canEditBucket.

type Options = readonly { value: string; label: string }[];

function vocab(values: readonly string[]): Options {
  return values.map((v) => ({ value: v, label: enterpriseLabel(v) }));
}

// Closed-vocabulary option sets keyed by field. Booleans use a Yes/No set.
const BOOLEAN_OPTIONS: Options = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

const FIELD_OPTIONS: Readonly<Record<string, Options>> = {
  status: REQUISITION_STATUS_VALUES.map((v) => ({ value: v, label: v })),
  job_type: vocab(JOB_TYPE_VALUES),
  role_family: vocab(ROLE_FAMILY_VALUES),
  seniority_level: vocab(SENIORITY_LEVEL_VALUES),
  headcount_reason: vocab(HEADCOUNT_REASON_VALUES),
  work_arrangement: vocab(WORK_ARRANGEMENT_VALUES),
  work_authorization: vocab(WORK_AUTHORIZATION_VALUES),
  duration_unit: vocab(DURATION_UNIT_VALUES),
  source_system: vocab(SOURCE_SYSTEM_VALUES),
  pay_rate_period: RATE_PERIOD_VALUES.map((v) => ({ value: v, label: v })),
  bill_rate_period: RATE_PERIOD_VALUES.map((v) => ({ value: v, label: v })),
};

const BOOLEAN_KEYS = new Set(['is_hot', 'relocation_offered', 'extension_possible']);

// The cockpit save dispatcher signature. The host (RequisitionDetailView)
// supplies this; it maps (key, value) → a typed PATCH /v1/requisitions/:id.
export type SaveFieldFn = (key: string, value: unknown) => Promise<void>;

interface CockpitFieldRowProps {
  readonly field: CockpitFieldDescriptor;
  readonly raw: unknown;
  readonly scopes: readonly string[];
  readonly onSave: SaveFieldFn;
}

export function CockpitFieldRow({
  field,
  raw,
  scopes,
  onSave,
}: CockpitFieldRowProps) {
  const canEdit = canEditBucket(scopes, field.bucket);
  const testId = `cockpit-field-${field.key}`;

  // Booleans — rendered as a Yes/No inline select (always defined; never
  // null). Maps 'true'/'false' → boolean at save.
  if (BOOLEAN_KEYS.has(field.key)) {
    const value = raw === true ? 'true' : 'false';
    return (
      <InlineSelectField
        label={field.label}
        value={value}
        canEdit={canEdit}
        options={BOOLEAN_OPTIONS}
        allowEmpty={false}
        testId={testId}
        onSave={(next) => onSave(field.key, next === 'true')}
      />
    );
  }

  if (field.kind === 'select') {
    const options = FIELD_OPTIONS[field.key] ?? [];
    const value = raw === null || raw === undefined ? null : String(raw);
    // status is required (no empty option); other selects allow clear.
    const allowEmpty = field.key !== 'status';
    return (
      <InlineSelectField
        label={field.label}
        value={value}
        canEdit={canEdit}
        options={options}
        allowEmpty={allowEmpty}
        testId={testId}
        onSave={(next) => onSave(field.key, next)}
      />
    );
  }

  // DERIVED comp views + any never-editable field: canEdit is false by
  // bucket, so the primitive renders a read-only display.
  const value = raw === null || raw === undefined ? null : String(raw);
  const isNumber = field.kind === 'number';
  return (
    <InlineEditField
      label={field.label}
      value={value}
      canEdit={canEdit}
      type={isNumber ? 'number' : field.kind === 'date' ? 'date' : 'text'}
      multiline={field.key === 'description' || field.key === 'notes'}
      testId={testId}
      onSave={(next) =>
        onSave(field.key, next === null ? null : isNumber ? Number(next) : next)
      }
    />
  );
}
