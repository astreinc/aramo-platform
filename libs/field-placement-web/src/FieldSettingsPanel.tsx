import {
  DEFAULT_MONEY_CURRENCY,
  DEFAULT_MONEY_DECIMALS,
  DROPDOWN_CHOICES_MAX,
  FIELD_DATA_NAME_PATTERN,
  FIELD_FONT_SIZE_MAX,
  FIELD_FONT_SIZE_MIN,
  FIELD_PLACEHOLDER_MAX,
  FIELD_TOOLTIP_MAX,
  MULTILINE_TEXT_MAX,
  NUMBER_DECIMALS_MAX,
  VALIDATIONS_BY_TYPE,
  fieldValueRefusal,
  type DropdownChoice,
  type FieldOptions,
  type FieldSetting,
  type FieldValidation,
} from '@aramo/sign-fields';

import { CONDITION_WHEN_LABELS, conditionWhensFor, dependentsOf, usableTriggers, triggerChoices } from './lib/conditions';
import { typeLabelOf, type PlacedField, type PlacementCapabilities } from './lib/model';
import { groupSize, type SettingsPatch } from './lib/settings';
import { cleanChoices, conditionIssues, optionsToWire, settingsIssue } from './lib/settings-wire';

// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §6.2 —
// the inspector's settings controls, the same for every host. A control shows only when the
// catalog says the type takes the setting (fieldSettingsOf) AND the host lists it in its
// capabilities (`shown`): label (S-1), tooltip (S-1), placeholder (S-2), sender-filled with the
// sender's value (S-5, dark: only when the host says the server flag is on) and read-only (S-4,
// only with sender-filled), validation preset and its parameters (S-6), font size auto / fixed
// (S-7), data name (S-9), the DROPDOWN choices editor and the NUMBER format (options), the
// check-box / radio group (M-A6 §2.3; T-5) and SIGNER_NAME's name mode (M-A6 §2.2). The ONE
// settings rule (parseFieldSettings) runs on every change; its refusal is shown here.

export const VALIDATION_LABELS: Readonly<Record<FieldValidation, string>> = {
  email: 'Email address',
  phone: 'Phone number',
  us_zip: 'US ZIP code',
  max_length: 'Maximum length',
  number_range: 'Number range',
  date_range: 'Date range',
};

export interface FieldSettingsPanelProps {
  readonly field: PlacedField;
  readonly fields: readonly PlacedField[];
  readonly shown: readonly FieldSetting[];
  readonly capabilities: PlacementCapabilities;
  readonly idPrefix: string;
  readonly onChange: (patch: SettingsPatch) => void;
  /** RADIO — add a sibling option to this field's group. */
  readonly onAddRadioOption?: () => void;
  /** FIELD-PARITY-2 B-7 — how a field is named in the trigger list (default: its type, label and page). */
  readonly describe?: (f: PlacedField) => string;
  /** B-7 — start (or stop) picking this field's trigger by clicking it on the page. */
  readonly onPickTrigger?: () => void;
  /** B-7 — picking this field's trigger on the page is in progress. */
  readonly picking?: boolean;
}

/** The default name of a field in the trigger list: its type, its label and its page. */
export function describeField(f: PlacedField): string {
  const label = f.settings.label.trim();
  return `${typeLabelOf(f.type)}${label.length > 0 ? ` “${label}”` : ''} · page ${f.page + 1}`;
}

const numOrUndefined = (v: string): number | undefined => {
  if (v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function FieldSettingsPanel({ field, fields, shown, capabilities, idPrefix: p, onChange, onAddRadioOption, describe = describeField, onPickTrigger, picking = false }: FieldSettingsPanelProps) {
  const s = field.settings;
  const type = field.type;
  const has = (k: FieldSetting): boolean => shown.includes(k);
  const opts: FieldOptions = s.options ?? {};
  const setOptions = (patch: Partial<{ -readonly [K in keyof FieldOptions]: FieldOptions[K] }>): void => {
    const next: Record<string, unknown> = { ...opts, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    onChange({ options: Object.keys(next).length > 0 ? (next as FieldOptions) : null });
  };
  const grouped = s.groupKey.trim().length > 0;
  const presets = VALIDATIONS_BY_TYPE[type] ?? [];
  const senderFilledOn = has('sender_filled');
  const issue = settingsIssue(type, s, { senderFilledEnabled: senderFilledOn });
  const wireOptions = optionsToWire(type, s.validation, s.options);
  const valueIssue =
    senderFilledOn && s.senderFilled && s.senderValue !== '' && capabilities.senderValues === true
      ? fieldValueRefusal({ field_type: type, validation: s.validation === '' ? null : s.validation, options: wireOptions }, s.senderValue)
      : null;

  return (
    <>
      {has('name_mode') ? (
        <label className="fpe-row">
          <span className="fpe-label">Name comes from</span>
          <select
            className="fpe-select"
            value={s.nameMode}
            onChange={(e) => onChange({ nameMode: e.target.value === 'SIGNER_ENTERED' ? 'SIGNER_ENTERED' : 'SIGNER_PROFILE' })}
            data-testid={`${p}-name-mode`}
          >
            <option value="SIGNER_PROFILE">Signer profile (filled by Aramo Sign)</option>
            <option value="SIGNER_ENTERED">Signer types it</option>
          </select>
        </label>
      ) : null}
      {has('label') ? (
        <label className="fpe-row">
          <span className="fpe-label">{type === 'RADIO' ? 'Option text' : 'Label'}</span>
          <input
            className="fpe-input"
            type="text"
            value={s.label}
            maxLength={capabilities.limits?.labelMax}
            onChange={(e) => onChange({ label: e.target.value })}
            data-testid={type === 'CHECKBOX' ? `${p}-checkbox-label` : `${p}-label`}
          />
        </label>
      ) : null}
      {has('group_key') ? (
        <label className="fpe-row">
          <span className="fpe-label">{type === 'RADIO' ? 'Radio group' : 'Group'}</span>
          <input
            className="fpe-input"
            type="text"
            value={s.groupKey}
            maxLength={capabilities.limits?.groupKeyMax}
            placeholder={type === 'RADIO' ? 'A radio button needs a group' : 'No group'}
            onChange={(e) => onChange({ groupKey: e.target.value })}
            data-testid={type === 'RADIO' ? `${p}-radio-group` : `${p}-checkbox-group`}
          />
        </label>
      ) : null}
      {type === 'RADIO' && has('group_key') ? (
        <>
          <p className="fpe-note" data-testid={`${p}-radio-count`}>
            {grouped ? `${groupSize(fields, field)} options in this group · the signer picks exactly one.` : 'Give the radio button a group.'}
          </p>
          {onAddRadioOption !== undefined ? (
            <button type="button" className="fpe-btn fpe-btn--block" onClick={onAddRadioOption} disabled={!grouped} data-testid={`${p}-radio-add`}>
              Add option
            </button>
          ) : null}
        </>
      ) : null}
      {has('group_rule') && type !== 'RADIO' && grouped ? (
        <label className="fpe-row">
          <span className="fpe-label">Rule</span>
          <select
            className="fpe-select"
            value={s.groupRule}
            onChange={(e) => onChange({ groupRule: e.target.value === 'SELECT_ONE' ? 'SELECT_ONE' : 'SELECT_ANY' })}
            data-testid={`${p}-checkbox-rule`}
          >
            <option value="SELECT_ANY">Select any</option>
            <option value="SELECT_ONE">Select one</option>
          </select>
        </label>
      ) : null}
      {has('min_selected') && grouped && s.groupRule === 'SELECT_ANY' ? (
        <label className="fpe-row">
          <span className="fpe-label">Minimum checked (when required)</span>
          <input
            className="fpe-input"
            type="number"
            min={1}
            max={groupSize(fields, field)}
            value={s.minSelected ?? 1}
            onChange={(e) => {
              const n = Math.floor(Number(e.target.value));
              if (Number.isFinite(n) && n >= 1) onChange({ minSelected: Math.min(n, groupSize(fields, field)) });
            }}
            data-testid={`${p}-checkbox-min`}
          />
        </label>
      ) : null}
      {type === 'DROPDOWN' && has('options') ? <ChoicesEditor choices={opts.choices ?? []} idPrefix={p} onChange={(choices) => setOptions({ choices })} /> : null}
      {type === 'NUMBER' && has('options') ? (
        <fieldset className="fpe-fieldset" data-testid={`${p}-number-format`}>
          <legend className="fpe-label">Number format</legend>
          <label className="fpe-row">
            <span className="fpe-label">Format</span>
            <select
              className="fpe-select"
              value={opts.format === 'money' ? 'money' : 'plain'}
              onChange={(e) =>
                e.target.value === 'money'
                  ? setOptions({ format: 'money', currency: opts.currency ?? DEFAULT_MONEY_CURRENCY, decimals: opts.decimals ?? DEFAULT_MONEY_DECIMALS })
                  : setOptions({ format: undefined, currency: undefined })
              }
              data-testid={`${p}-number-format-select`}
            >
              <option value="plain">Number</option>
              <option value="money">Money</option>
            </select>
          </label>
          {opts.format === 'money' ? (
            <label className="fpe-row">
              <span className="fpe-label">Currency (ISO code)</span>
              <input
                className="fpe-input"
                type="text"
                maxLength={3}
                value={opts.currency ?? ''}
                onChange={(e) => setOptions({ currency: e.target.value.toUpperCase() })}
                data-testid={`${p}-number-currency`}
              />
            </label>
          ) : null}
          <label className="fpe-row">
            <span className="fpe-label">Decimal places</span>
            <input
              className="fpe-input"
              type="number"
              min={0}
              max={NUMBER_DECIMALS_MAX}
              value={opts.decimals ?? ''}
              onChange={(e) => {
                const n = numOrUndefined(e.target.value);
                setOptions({ decimals: n === undefined ? undefined : Math.max(0, Math.min(NUMBER_DECIMALS_MAX, Math.floor(n))) });
              }}
              data-testid={`${p}-number-decimals`}
            />
          </label>
        </fieldset>
      ) : null}
      {has('validation') && presets.length > 0 ? (
        <>
          <label className="fpe-row">
            <span className="fpe-label">Validation</span>
            <select
              className="fpe-select"
              value={s.validation}
              onChange={(e) => {
                const v = e.target.value as FieldValidation | '';
                // A preset that needs a parameter starts with a sensible one.
                const start: Partial<FieldOptions> = v === 'max_length' && opts.max_length === undefined ? { max_length: type === 'MULTILINE_TEXT' ? 1000 : 100 } : {};
                onChange({ validation: v, ...(Object.keys(start).length > 0 ? { options: { ...opts, ...start } } : {}) });
              }}
              data-testid={`${p}-validation`}
            >
              <option value="">None</option>
              {presets.map((v) => (
                <option key={v} value={v}>
                  {VALIDATION_LABELS[v]}
                </option>
              ))}
            </select>
          </label>
          {s.validation === 'max_length' ? (
            <label className="fpe-row">
              <span className="fpe-label">Most characters</span>
              <input
                className="fpe-input"
                type="number"
                min={1}
                max={MULTILINE_TEXT_MAX}
                value={opts.max_length ?? ''}
                onChange={(e) => {
                  const n = numOrUndefined(e.target.value);
                  setOptions({ max_length: n === undefined ? undefined : Math.floor(n) });
                }}
                data-testid={`${p}-max-length`}
              />
            </label>
          ) : null}
          {s.validation === 'number_range' ? (
            <div className="fpe-inline">
              <label className="fpe-row">
                <span className="fpe-label">Minimum</span>
                <input className="fpe-input" type="number" value={opts.min ?? ''} onChange={(e) => setOptions({ min: numOrUndefined(e.target.value) })} data-testid={`${p}-number-min`} />
              </label>
              <label className="fpe-row">
                <span className="fpe-label">Maximum</span>
                <input className="fpe-input" type="number" value={opts.max ?? ''} onChange={(e) => setOptions({ max: numOrUndefined(e.target.value) })} data-testid={`${p}-number-max`} />
              </label>
            </div>
          ) : null}
          {s.validation === 'date_range' ? (
            <div className="fpe-inline">
              <label className="fpe-row">
                <span className="fpe-label">Earliest</span>
                <input className="fpe-input" type="date" value={opts.min_date ?? ''} onChange={(e) => setOptions({ min_date: e.target.value || undefined })} data-testid={`${p}-date-min`} />
              </label>
              <label className="fpe-row">
                <span className="fpe-label">Latest</span>
                <input className="fpe-input" type="date" value={opts.max_date ?? ''} onChange={(e) => setOptions({ max_date: e.target.value || undefined })} data-testid={`${p}-date-max`} />
              </label>
            </div>
          ) : null}
        </>
      ) : null}
      {has('placeholder') ? (
        <label className="fpe-row">
          <span className="fpe-label">Placeholder</span>
          <input className="fpe-input" type="text" value={s.placeholder} maxLength={FIELD_PLACEHOLDER_MAX} onChange={(e) => onChange({ placeholder: e.target.value })} data-testid={`${p}-placeholder`} />
        </label>
      ) : null}
      {has('tooltip') ? (
        <label className="fpe-row">
          <span className="fpe-label">Tooltip</span>
          <input className="fpe-input" type="text" value={s.tooltip} maxLength={FIELD_TOOLTIP_MAX} onChange={(e) => onChange({ tooltip: e.target.value })} data-testid={`${p}-tooltip`} />
        </label>
      ) : null}
      {has('font_size') ? (
        <div className="fpe-inline">
          <label className="fpe-row">
            <span className="fpe-label">Font size</span>
            <select
              className="fpe-select"
              value={s.fontSize === null ? 'auto' : 'fixed'}
              onChange={(e) => onChange({ fontSize: e.target.value === 'auto' ? null : (s.fontSize ?? 10) })}
              data-testid={`${p}-font-size-mode`}
            >
              <option value="auto">Auto (fits the box)</option>
              <option value="fixed">Fixed</option>
            </select>
          </label>
          {s.fontSize !== null ? (
            <label className="fpe-row">
              <span className="fpe-label">Points</span>
              <input
                className="fpe-input"
                type="number"
                min={FIELD_FONT_SIZE_MIN}
                max={FIELD_FONT_SIZE_MAX}
                value={s.fontSize}
                onChange={(e) => {
                  const n = Math.floor(Number(e.target.value));
                  if (Number.isFinite(n)) onChange({ fontSize: Math.max(FIELD_FONT_SIZE_MIN, Math.min(FIELD_FONT_SIZE_MAX, n)) });
                }}
                data-testid={`${p}-font-size`}
              />
            </label>
          ) : null}
        </div>
      ) : null}
      {has('data_name') ? (
        <label className="fpe-row">
          <span className="fpe-label">Data name</span>
          <input
            className="fpe-input"
            type="text"
            value={s.dataName}
            placeholder="e.g. effective_date"
            onChange={(e) => onChange({ dataName: e.target.value })}
            aria-invalid={s.dataName !== '' && !FIELD_DATA_NAME_PATTERN.test(s.dataName)}
            data-testid={`${p}-data-name`}
          />
        </label>
      ) : null}
      {senderFilledOn ? (
        <>
          <label className="fpe-check">
            <input type="checkbox" checked={s.senderFilled} onChange={(e) => onChange({ senderFilled: e.target.checked })} data-testid={`${p}-sender-filled`} />
            You fill this before sending
          </label>
          {s.senderFilled && capabilities.senderValues === true ? <SenderValueInput field={field} options={wireOptions} idPrefix={p} onChange={(senderValue) => onChange({ senderValue })} /> : null}
          {s.senderFilled && has('read_only') ? (
            <label className="fpe-check">
              <input type="checkbox" checked={s.readOnly} onChange={(e) => onChange({ readOnly: e.target.checked })} data-testid={`${p}-read-only`} />
              Signer can’t change it (read-only)
            </label>
          ) : null}
          {valueIssue !== null ? (
            <p className="fpe-note fpe-note--error" role="alert" data-testid={`${p}-sender-value-issue`}>
              This value doesn’t fit the field ({valueIssue.replace(/_/g, ' ')}).
            </p>
          ) : null}
        </>
      ) : null}
      {has('condition') ? (
        <ConditionSettings field={field} fields={fields} idPrefix={p} describe={describe} onChange={onChange} {...(onPickTrigger !== undefined ? { onPickTrigger } : {})} picking={picking} />
      ) : null}
      {issue !== null ? (
        <p className="fpe-note fpe-note--error" role="alert" data-testid={`${p}-settings-issue`}>
          {issue.message}
        </p>
      ) : null}
    </>
  );
}

/**
 * FIELD-PARITY-2 B-7 — "Show only when…": the trigger (from the list of fields the shared rule
 * accepts, or picked on the page), the rule its type offers, and the shared rule's refusal inline
 * (conditionIssues: the server's fieldConditionIssues). A field the sender fills is always shown.
 */
function ConditionSettings({
  field,
  fields,
  idPrefix: p,
  describe,
  onChange,
  onPickTrigger,
  picking,
}: {
  readonly field: PlacedField;
  readonly fields: readonly PlacedField[];
  readonly idPrefix: string;
  readonly describe: (f: PlacedField) => string;
  readonly onChange: (patch: SettingsPatch) => void;
  readonly onPickTrigger?: () => void;
  readonly picking: boolean;
}) {
  const c = field.settings.condition;
  const usable = usableTriggers(fields, field.id);
  const trigger = c === null ? undefined : fields.find((f) => f.id === c.trigger_key);
  const issue = conditionIssues(fields).get(field.id);
  const dependents = dependentsOf(fields, [field.id]).flatMap((id) => fields.filter((f) => f.id === id));
  const choose = (id: string): void => {
    if (id === '') {
      onChange({ condition: null });
      return;
    }
    const t = usable.find((f) => f.id === id);
    const when = t === undefined ? undefined : conditionWhensFor(t.type)[0];
    if (t === undefined || when === undefined) return;
    if (when !== 'one_of') onChange({ condition: { trigger_key: t.id, when } });
    else {
      const first = triggerChoices(t)[0];
      if (first !== undefined) onChange({ condition: { trigger_key: t.id, when, values: [first.value] } });
    }
  };
  return (
    <fieldset className="fpe-fieldset" data-testid={`${p}-condition`}>
      <legend className="fpe-label">Show only when…</legend>
      {field.settings.senderFilled ? (
        <p className="fpe-note" data-testid={`${p}-condition-sender-filled`}>
          A field you fill before sending is always shown.
        </p>
      ) : (
        <>
          <label className="fpe-row">
            <span className="fpe-label">This field shows</span>
            <select className="fpe-select" value={c?.trigger_key ?? ''} onChange={(e) => choose(e.target.value)} data-testid={`${p}-condition-trigger`}>
              <option value="">Always</option>
              {c !== null && !usable.some((f) => f.id === c.trigger_key) ? (
                <option value={c.trigger_key}>When {trigger !== undefined ? describe(trigger) : 'a field that is gone'} (can’t be used)</option>
              ) : null}
              {usable.map((f) => (
                <option key={f.id} value={f.id}>
                  When {describe(f)}
                </option>
              ))}
            </select>
          </label>
          {onPickTrigger !== undefined ? (
            <button type="button" className={picking ? 'fpe-btn fpe-btn--block is-on' : 'fpe-btn fpe-btn--block'} aria-pressed={picking} onClick={onPickTrigger} disabled={!picking && usable.length === 0} data-testid={`${p}-condition-pick`}>
              {picking ? 'Cancel picking' : 'Pick the field on the page'}
            </button>
          ) : null}
          {usable.length === 0 && c === null ? (
            <p className="fpe-faint" data-testid={`${p}-condition-none`}>
              Add a check box, radio button or dropdown for the same signer to show this field only for some answers.
            </p>
          ) : null}
          {c !== null && trigger !== undefined ? <ConditionRule field={field} trigger={trigger} idPrefix={p} onChange={onChange} /> : null}
        </>
      )}
      {dependents.length > 0 ? (
        <p className="fpe-note" data-testid={`${p}-condition-dependents`}>
          Shows or hides: {dependents.map((d) => describe(d)).join('; ')}.
        </p>
      ) : null}
      {issue !== undefined ? (
        <p className="fpe-note fpe-note--error" role="alert" data-testid={`${p}-condition-issue`}>
          This condition can’t be saved: {issue.message}.
        </p>
      ) : null}
    </fieldset>
  );
}

/** The rule of a condition, as its trigger's type offers it. */
function ConditionRule({ field, trigger, idPrefix: p, onChange }: { readonly field: PlacedField; readonly trigger: PlacedField; readonly idPrefix: string; readonly onChange: (patch: SettingsPatch) => void }) {
  const c = field.settings.condition!;
  const whens = conditionWhensFor(trigger.type);
  if (c.when === 'chosen' || c.when === 'one_of') {
    if (c.when === 'chosen') {
      return (
        <p className="fpe-note" data-testid={`${p}-condition-rule`}>
          …when the signer chooses this option.
        </p>
      );
    }
    const values = new Set(c.values ?? []);
    const choices = triggerChoices(trigger);
    const toggle = (v: string, on: boolean): void => {
      const next = choices.map((ch) => ch.value).filter((x) => (x === v ? on : values.has(x)));
      if (next.length > 0) onChange({ condition: { trigger_key: c.trigger_key, when: 'one_of', values: next } });
    };
    return (
      <fieldset className="fpe-fieldset" data-testid={`${p}-condition-rule`}>
        <legend className="fpe-label">…when the signer picks one of</legend>
        {choices.map((ch, i) => (
          <label key={ch.value} className="fpe-choicecheck">
            <input
              type="checkbox"
              checked={values.has(ch.value)}
              disabled={values.has(ch.value) && values.size === 1}
              onChange={(e) => toggle(ch.value, e.target.checked)}
              data-testid={`${p}-condition-value-${i}`}
            />
            {ch.label}
          </label>
        ))}
      </fieldset>
    );
  }
  return (
    <label className="fpe-row">
      <span className="fpe-label">Rule</span>
      <select
        className="fpe-select"
        value={c.when}
        onChange={(e) => {
          const when = whens.find((w) => w === e.target.value);
          if (when !== undefined) onChange({ condition: { trigger_key: c.trigger_key, when } });
        }}
        data-testid={`${p}-condition-rule`}
      >
        {(whens.includes(c.when) ? whens : [c.when, ...whens]).map((w) => (
          <option key={w} value={w}>
            {CONDITION_WHEN_LABELS[w]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The sender's value of a sender-filled field, with the input its type needs. */
function SenderValueInput({ field, options, idPrefix: p, onChange }: { field: PlacedField; options: FieldOptions | null; idPrefix: string; onChange: (v: string) => void }) {
  const v = field.settings.senderValue;
  const t = field.type;
  if (t === 'CHECKBOX' || t === 'RADIO') {
    return (
      <label className="fpe-check">
        <input type="checkbox" checked={v === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : 'false')} data-testid={`${p}-sender-value`} />
        {t === 'RADIO' ? 'This option is chosen' : 'Checked'}
      </label>
    );
  }
  if (t === 'DROPDOWN') {
    return (
      <label className="fpe-row">
        <span className="fpe-label">Your value</span>
        <select className="fpe-select" value={v} onChange={(e) => onChange(e.target.value)} data-testid={`${p}-sender-value`}>
          <option value="">Choose…</option>
          {(options?.choices ?? []).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (t === 'MULTILINE_TEXT') {
    return (
      <label className="fpe-row">
        <span className="fpe-label">Your value</span>
        <textarea className="fpe-input" rows={3} value={v} onChange={(e) => onChange(e.target.value)} data-testid={`${p}-sender-value`} />
      </label>
    );
  }
  return (
    <label className="fpe-row">
      <span className="fpe-label">Your value</span>
      <input
        className="fpe-input"
        type={t === 'DATE' ? 'date' : 'text'}
        inputMode={t === 'NUMBER' ? 'decimal' : undefined}
        value={v}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`${p}-sender-value`}
      />
    </label>
  );
}

/** T-4 — the DROPDOWN choices: add, remove, reorder; each a value and the label the signer sees. */
function ChoicesEditor({ choices, idPrefix: p, onChange }: { choices: readonly DropdownChoice[]; idPrefix: string; onChange: (c: DropdownChoice[]) => void }) {
  const list = [...choices];
  const set = (i: number, patch: Partial<DropdownChoice>): void => {
    const next = list.map((c, j) => (j === i ? { ...c, ...patch } : c));
    onChange(next);
  };
  const move = (i: number, d: -1 | 1): void => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const usable = cleanChoices(list).length;
  return (
    <fieldset className="fpe-fieldset" data-testid={`${p}-choices`}>
      <legend className="fpe-label">Choices ({usable})</legend>
      {list.map((c, i) => (
        <div key={i} className="fpe-choice" data-testid={`${p}-choice-${i}`}>
          <input
            className="fpe-input"
            type="text"
            aria-label={`Choice ${i + 1} label`}
            placeholder="Shown to the signer"
            value={c.label}
            // A value that follows its label (none of its own) keeps following it.
            onChange={(e) => set(i, c.value === c.label ? { label: e.target.value, value: '' } : { label: e.target.value })}
            data-testid={`${p}-choice-label-${i}`}
          />
          <input
            className="fpe-input"
            type="text"
            aria-label={`Choice ${i + 1} value`}
            placeholder="Value (default: the label)"
            value={c.value === c.label ? '' : c.value}
            onChange={(e) => set(i, { value: e.target.value })}
            data-testid={`${p}-choice-value-${i}`}
          />
          <span className="fpe-choice__tools">
            <button type="button" className="fpe-btn fpe-btn--sm" aria-label={`Move choice ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} data-testid={`${p}-choice-up-${i}`}>
              ↑
            </button>
            <button
              type="button"
              className="fpe-btn fpe-btn--sm"
              aria-label={`Move choice ${i + 1} down`}
              disabled={i === list.length - 1}
              onClick={() => move(i, 1)}
              data-testid={`${p}-choice-down-${i}`}
            >
              ↓
            </button>
            <button type="button" className="fpe-btn fpe-btn--sm" aria-label={`Remove choice ${i + 1}`} onClick={() => onChange(list.filter((_, j) => j !== i))} data-testid={`${p}-choice-remove-${i}`}>
              ×
            </button>
          </span>
        </div>
      ))}
      <button
        type="button"
        className="fpe-btn fpe-btn--block"
        disabled={list.length >= DROPDOWN_CHOICES_MAX}
        onClick={() => onChange([...list, { value: '', label: `Option ${list.length + 1}` }])}
        data-testid={`${p}-choice-add`}
      >
        Add choice
      </button>
    </fieldset>
  );
}
