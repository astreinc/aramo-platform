import { FormField, Switch } from '@aramo/fe-foundation';

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
  type EnterpriseFormState,
} from './enterprise-fields';

// Job-Module — the additive enterprise fields, grouped into clearly-
// labelled fieldsets (Classification / Work arrangement / Duration &
// schedule / Source). Closed vocabularies render as native <select>;
// everything else is a text / number / date / switch. All optional + UN-
// gated (no scope check — these are not commercially sensitive).

interface EnterpriseFieldsSectionProps {
  readonly value: EnterpriseFormState;
  readonly onChange: (next: EnterpriseFormState) => void;
  readonly disabled?: boolean;
}

// A native-select option list with a leading blank ("— … —") sentinel for
// the optional / un-set state.
function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly onChange: (next: string) => void;
}) {
  return (
    <FormField label={label}>
      <select
        value={value}
        onChange={(ev) => onChange(ev.target.value)}
        aria-label={label}
      >
        <option value="">— Not specified —</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {enterpriseLabel(opt)}
          </option>
        ))}
      </select>
    </FormField>
  );
}

export function EnterpriseFieldsSection({
  value,
  onChange,
  disabled = false,
}: EnterpriseFieldsSectionProps) {
  function set<K extends keyof EnterpriseFormState>(
    key: K,
    next: EnterpriseFormState[K],
  ): void {
    onChange({ ...value, [key]: next });
  }

  return (
    <>
      <fieldset className="req-form__enterprise" disabled={disabled}>
        <legend>Classification</legend>

        <SelectField
          label="Job type"
          value={value.job_type}
          options={JOB_TYPE_VALUES}
          onChange={(v) => set('job_type', v as EnterpriseFormState['job_type'])}
        />

        <FormField label="Labor category">
          <input
            type="text"
            value={value.labor_category}
            onChange={(ev) => set('labor_category', ev.target.value)}
            aria-label="Labor category"
          />
        </FormField>

        <SelectField
          label="Role family"
          value={value.role_family}
          options={ROLE_FAMILY_VALUES}
          onChange={(v) =>
            set('role_family', v as EnterpriseFormState['role_family'])
          }
        />

        <SelectField
          label="Seniority level"
          value={value.seniority_level}
          options={SENIORITY_LEVEL_VALUES}
          onChange={(v) =>
            set('seniority_level', v as EnterpriseFormState['seniority_level'])
          }
        />

        <SelectField
          label="Headcount reason"
          value={value.headcount_reason}
          options={HEADCOUNT_REASON_VALUES}
          onChange={(v) =>
            set('headcount_reason', v as EnterpriseFormState['headcount_reason'])
          }
        />
      </fieldset>

      <fieldset className="req-form__enterprise" disabled={disabled}>
        <legend>Work arrangement</legend>

        <SelectField
          label="Work arrangement"
          value={value.work_arrangement}
          options={WORK_ARRANGEMENT_VALUES}
          onChange={(v) =>
            set('work_arrangement', v as EnterpriseFormState['work_arrangement'])
          }
        />

        <FormField label="Travel percent">
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={value.travel_percent}
            onChange={(ev) => set('travel_percent', ev.target.value)}
            aria-label="Travel percent"
          />
        </FormField>

        <FormField label="Relocation offered">
          <Switch
            checked={value.relocation_offered}
            onCheckedChange={(c) => set('relocation_offered', c)}
            aria-label="Relocation offered"
          />
        </FormField>

        <SelectField
          label="Work authorization"
          value={value.work_authorization}
          options={WORK_AUTHORIZATION_VALUES}
          onChange={(v) =>
            set(
              'work_authorization',
              v as EnterpriseFormState['work_authorization'],
            )
          }
        />
      </fieldset>

      <fieldset className="req-form__enterprise" disabled={disabled}>
        <legend>Duration &amp; schedule</legend>

        <FormField label="End date">
          <input
            type="date"
            value={value.end_date}
            onChange={(ev) => set('end_date', ev.target.value)}
            aria-label="End date"
          />
        </FormField>

        <FormField label="Duration value">
          <input
            type="number"
            min={0}
            step={1}
            value={value.duration_value}
            onChange={(ev) => set('duration_value', ev.target.value)}
            aria-label="Duration value"
          />
        </FormField>

        <SelectField
          label="Duration unit"
          value={value.duration_unit}
          options={DURATION_UNIT_VALUES}
          onChange={(v) =>
            set('duration_unit', v as EnterpriseFormState['duration_unit'])
          }
        />

        <FormField label="Extension possible">
          <Switch
            checked={value.extension_possible}
            onCheckedChange={(c) => set('extension_possible', c)}
            aria-label="Extension possible"
          />
        </FormField>

        <FormField label="Hours per week">
          <input
            type="number"
            min={0}
            max={168}
            step={1}
            value={value.hours_per_week}
            onChange={(ev) => set('hours_per_week', ev.target.value)}
            aria-label="Hours per week"
          />
        </FormField>
      </fieldset>

      <fieldset className="req-form__enterprise" disabled={disabled}>
        <legend>Source</legend>

        <SelectField
          label="Source system"
          value={value.source_system}
          options={SOURCE_SYSTEM_VALUES}
          onChange={(v) =>
            set('source_system', v as EnterpriseFormState['source_system'])
          }
        />

        <FormField label="External req ID">
          <input
            type="text"
            value={value.external_req_id}
            onChange={(ev) => set('external_req_id', ev.target.value)}
            aria-label="External req ID"
          />
        </FormField>

        <FormField label="Imported at" helper="Usually system-set on import.">
          <input
            type="date"
            value={value.imported_at}
            onChange={(ev) => set('imported_at', ev.target.value)}
            aria-label="Imported at"
          />
        </FormField>
      </fieldset>
    </>
  );
}
