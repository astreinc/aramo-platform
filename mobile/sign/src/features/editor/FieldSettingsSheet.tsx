// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §6.2 —
// the settings sheet's Phase 3 sections in the app's sender editor, the app's counterpart of the
// web editor's settings panel: the same settings per type (fieldSettingsOf, through
// editableSettings) and the same rule (parseFieldSettings, shown as the refusal). Every change is
// a reducer action (one undo step); text commits when editing ends, like the check-box label.
//   RadioSettings — option text, the group's option count and "Add option" (T-5).
//   GeneralSettings — label (types other than check box / radio), placeholder, tooltip, data
//     name, validation preset and its parameters, font size auto / fixed, DROPDOWN choices,
//     NUMBER format, and sender-filled with its value and read-only (only when the server flag
//     is on: sender_filled_fields_enabled).
//   ConditionSettings — FIELD-PARITY-2 B-7 "Show only when…" (the Send flow only).
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View, Pressable } from 'react-native';
import {
  DEFAULT_MONEY_CURRENCY,
  DROPDOWN_CHOICES_MAX,
  FIELD_FONT_SIZE_MAX,
  FIELD_FONT_SIZE_MIN,
  FIELD_PLACEHOLDER_MAX,
  FIELD_TOOLTIP_MAX,
  NUMBER_DECIMALS_MAX,
  VALIDATIONS_BY_TYPE,
  type DropdownChoice,
  type FieldOptions,
  type FieldValidation,
} from '@aramo/sign-client';

import { Button } from '../../components/Button';
import { useTheme } from '../../theme';
import { randomId } from '../../util/ids';
import { conditionFor, conditionIssueOf, conditionWhensFor, dependentsOfKey, describeField, usableTriggers } from './conditions';
import { groupMembers, type EditorAction, type EditorField } from './editorReducer';
import { cleanChoices, editableSettings, senderValueIssue, settingsIssue, type EditorFieldSettings } from './fieldSettings';
import { MAX_LABEL } from './fieldTypes';
import type { PageSize } from './geometry';

const VALIDATION_LABELS: Readonly<Record<FieldValidation, string>> = {
  email: 'Email',
  phone: 'Phone',
  us_zip: 'US ZIP',
  max_length: 'Max length',
  number_range: 'Number range',
  date_range: 'Date range',
};

function useInputStyle() {
  const t = useTheme();
  return [styles.input, { borderColor: t.color.separator, color: t.color.text, backgroundColor: t.color.surface }];
}

/** A text input that commits when editing ends (one undo step per edit, not per key). */
function CommitInput({
  testID,
  label,
  value,
  onCommit,
  maxLength,
  keyboardType,
  placeholder,
  multiline,
}: {
  readonly testID: string;
  readonly label: string;
  readonly value: string;
  readonly onCommit: (v: string) => void;
  readonly maxLength?: number;
  readonly keyboardType?: 'default' | 'numeric' | 'decimal-pad' | 'email-address';
  readonly placeholder?: string;
  readonly multiline?: boolean;
}) {
  const t = useTheme();
  const input = useInputStyle();
  const [v, setV] = useState(value);
  // A new value from the field (undo, another control) replaces the draft text.
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setV(value);
  }
  const commit = () => {
    if (v !== value) onCommit(v);
  };
  return (
    <>
      <Text style={{ color: t.color.textSecondary, fontFamily: t.font.family, fontSize: 14 }}>{label}</Text>
      <TextInput
        testID={testID}
        value={v}
        onChangeText={setV}
        onEndEditing={commit}
        onSubmitEditing={commit}
        onBlur={commit}
        accessibilityLabel={label}
        maxLength={maxLength}
        keyboardType={keyboardType}
        placeholder={placeholder}
        multiline={multiline}
        style={input}
      />
    </>
  );
}

function Chip({ title, selected, onPress, testID }: { readonly title: string; readonly selected: boolean; readonly onPress: () => void; readonly testID?: string }) {
  const t = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={[
        styles.chip,
        {
          minHeight: t.size.minTouch,
          borderColor: selected ? t.color.accent : t.color.separator,
          borderWidth: selected ? 1.5 : 1,
          backgroundColor: selected ? t.color.tint : t.color.surface,
        },
      ]}
    >
      <Text style={{ color: selected ? t.color.onTint : t.color.text, fontFamily: t.font.family, fontSize: 15 }}>{title}</Text>
    </Pressable>
  );
}

const num = (v: string): number | undefined => {
  if (v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** T-5 — a radio button: its option text, its group's options and "Add option". */
export function RadioSettings({
  field,
  fields,
  pageSize,
  dispatch,
}: {
  readonly field: EditorField;
  readonly fields: readonly EditorField[];
  readonly pageSize: PageSize | undefined;
  readonly dispatch: (a: EditorAction) => void;
}) {
  const t = useTheme();
  const size = groupMembers(fields, field.groupKey).length;
  return (
    <View style={styles.body}>
      <CommitInput
        testID="radio-label"
        label="Option text"
        value={field.label ?? ''}
        maxLength={MAX_LABEL}
        onCommit={(label) => dispatch({ type: 'setLabel', key: field.key, label })}
      />
      <Text testID="radio-count" style={{ color: t.color.textSecondary, fontFamily: t.font.family, fontSize: 14 }}>
        {`${size} option${size === 1 ? '' : 's'} in this group. The signer picks exactly one.`}
      </Text>
      <Button
        testID="radio-add-option"
        variant="secondary"
        title="Add option"
        disabled={!pageSize}
        onPress={() => pageSize && dispatch({ type: 'addRadioOption', key: field.key, newKey: randomId(), pageSize })}
      />
    </View>
  );
}

/** The other settings of any type (each shown only when the type takes it). */
export function GeneralSettings({
  field,
  senderFilledEnabled,
  dispatch,
}: {
  readonly field: EditorField;
  readonly senderFilledEnabled: boolean;
  readonly dispatch: (a: EditorAction) => void;
}) {
  const t = useTheme();
  const shown = editableSettings(field.type, senderFilledEnabled);
  const has = (k: string) => (shown as readonly string[]).includes(k);
  const configure = (patch: EditorFieldSettings) => dispatch({ type: 'configure', key: field.key, patch });
  const opts: FieldOptions = field.options ?? {};
  const setOptions = (patch: Partial<Record<keyof FieldOptions, unknown>>) => {
    const next: Record<string, unknown> = { ...opts, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    configure({ options: Object.keys(next).length > 0 ? (next as FieldOptions) : null });
  };
  const secondary = { color: t.color.textSecondary, fontFamily: t.font.family, fontSize: 14 };
  const presets = VALIDATIONS_BY_TYPE[field.type] ?? [];
  const issue = settingsIssue(field, senderFilledEnabled);
  const valueIssue = senderValueIssue(field);
  const labelHere = has('label') && field.type !== 'CHECKBOX' && field.type !== 'RADIO';
  return (
    <View style={styles.body} testID="field-settings-general">
      {labelHere ? (
        <CommitInput testID="field-label" label="Label" value={field.label ?? ''} maxLength={MAX_LABEL} onCommit={(label) => dispatch({ type: 'setLabel', key: field.key, label })} />
      ) : null}
      {field.type === 'DROPDOWN' && has('options') ? <ChoicesEditor choices={opts.choices ?? []} onChange={(choices) => setOptions({ choices })} /> : null}
      {field.type === 'NUMBER' && has('options') ? (
        <>
          <Text style={secondary}>Format</Text>
          <View style={styles.row} accessibilityRole="radiogroup">
            <Chip testID="number-format-plain" title="Number" selected={opts.format !== 'money'} onPress={() => setOptions({ format: undefined, currency: undefined })} />
            <Chip
              testID="number-format-money"
              title="Money"
              selected={opts.format === 'money'}
              onPress={() => setOptions({ format: 'money', currency: opts.currency ?? DEFAULT_MONEY_CURRENCY, decimals: opts.decimals ?? 2 })}
            />
          </View>
          {opts.format === 'money' ? (
            <CommitInput testID="number-currency" label="Currency (ISO code)" value={opts.currency ?? ''} maxLength={3} onCommit={(v) => setOptions({ currency: v.trim().toUpperCase() || undefined })} />
          ) : null}
          <CommitInput
            testID="number-decimals"
            label="Decimal places"
            value={opts.decimals === undefined ? '' : String(opts.decimals)}
            keyboardType="numeric"
            onCommit={(v) => {
              const n = num(v);
              setOptions({ decimals: n === undefined ? undefined : Math.max(0, Math.min(NUMBER_DECIMALS_MAX, Math.floor(n))) });
            }}
          />
        </>
      ) : null}
      {has('validation') && presets.length > 0 ? (
        <>
          <Text style={secondary}>Validation</Text>
          <View style={styles.row} accessibilityRole="radiogroup">
            <Chip testID="validation-none" title="None" selected={!field.validation} onPress={() => configure({ validation: null })} />
            {presets.map((v) => (
              <Chip
                key={v}
                testID={`validation-${v}`}
                title={VALIDATION_LABELS[v]}
                selected={field.validation === v}
                onPress={() =>
                  v === 'max_length' && opts.max_length === undefined
                    ? configure({ validation: v, options: { ...opts, max_length: field.type === 'MULTILINE_TEXT' ? 1000 : 100 } })
                    : configure({ validation: v })
                }
              />
            ))}
          </View>
          {field.validation === 'max_length' ? (
            <CommitInput
              testID="validation-max-length"
              label="Most characters"
              value={opts.max_length === undefined ? '' : String(opts.max_length)}
              keyboardType="numeric"
              onCommit={(v) => setOptions({ max_length: num(v) === undefined ? undefined : Math.floor(num(v) as number) })}
            />
          ) : null}
          {field.validation === 'number_range' ? (
            <>
              <CommitInput testID="validation-min" label="Minimum" value={opts.min === undefined ? '' : String(opts.min)} keyboardType="decimal-pad" onCommit={(v) => setOptions({ min: num(v) })} />
              <CommitInput testID="validation-max" label="Maximum" value={opts.max === undefined ? '' : String(opts.max)} keyboardType="decimal-pad" onCommit={(v) => setOptions({ max: num(v) })} />
            </>
          ) : null}
          {field.validation === 'date_range' ? (
            <>
              <CommitInput testID="validation-min-date" label="Earliest (YYYY-MM-DD)" value={opts.min_date ?? ''} onCommit={(v) => setOptions({ min_date: v.trim() || undefined })} />
              <CommitInput testID="validation-max-date" label="Latest (YYYY-MM-DD)" value={opts.max_date ?? ''} onCommit={(v) => setOptions({ max_date: v.trim() || undefined })} />
            </>
          ) : null}
        </>
      ) : null}
      {has('placeholder') ? (
        <CommitInput testID="field-placeholder" label="Placeholder" value={field.placeholder ?? ''} maxLength={FIELD_PLACEHOLDER_MAX} onCommit={(v) => configure({ placeholder: v.trim() || null })} />
      ) : null}
      {has('tooltip') ? <CommitInput testID="field-tooltip" label="Tooltip" value={field.tooltip ?? ''} maxLength={FIELD_TOOLTIP_MAX} onCommit={(v) => configure({ tooltip: v.trim() || null })} /> : null}
      {has('font_size') ? (
        <>
          <Text style={secondary}>Font size</Text>
          <View style={styles.row} accessibilityRole="radiogroup">
            <Chip testID="font-size-auto" title="Auto" selected={field.fontSize == null} onPress={() => configure({ fontSize: null })} />
            <Chip testID="font-size-fixed" title="Fixed" selected={field.fontSize != null} onPress={() => configure({ fontSize: field.fontSize ?? 10 })} />
          </View>
          {field.fontSize != null ? (
            <View style={styles.row}>
              <Button
                title="−"
                variant="text"
                accessibilityLabel="Smaller text"
                disabled={field.fontSize <= FIELD_FONT_SIZE_MIN}
                onPress={() => configure({ fontSize: Math.max(FIELD_FONT_SIZE_MIN, (field.fontSize ?? 10) - 1) })}
              />
              <Text testID="font-size-value" style={[secondary, styles.grow]}>{`${field.fontSize} pt`}</Text>
              <Button
                title="+"
                variant="text"
                accessibilityLabel="Larger text"
                disabled={field.fontSize >= FIELD_FONT_SIZE_MAX}
                onPress={() => configure({ fontSize: Math.min(FIELD_FONT_SIZE_MAX, (field.fontSize ?? 10) + 1) })}
              />
            </View>
          ) : null}
        </>
      ) : null}
      {has('data_name') ? (
        <CommitInput testID="field-data-name" label="Data name" value={field.dataName ?? ''} placeholder="e.g. effective_date" onCommit={(v) => configure({ dataName: v.trim() || null })} />
      ) : null}
      {has('sender_filled') ? (
        <>
          <Text style={secondary}>Who fills it</Text>
          <View style={styles.row} accessibilityRole="radiogroup">
            <Chip testID="sender-filled-off" title="The signer" selected={field.senderFilled !== true} onPress={() => configure({ senderFilled: false })} />
            <Chip testID="sender-filled-on" title="You, before sending" selected={field.senderFilled === true} onPress={() => configure({ senderFilled: true })} />
          </View>
          {field.senderFilled === true ? (
            <>
              <SenderValue field={field} onCommit={(senderValue) => configure({ senderValue })} />
              {has('read_only') ? (
                <View style={styles.row} accessibilityRole="radiogroup">
                  <Chip testID="read-only-off" title="Signer can change it" selected={field.readOnly !== true} onPress={() => configure({ readOnly: false })} />
                  <Chip testID="read-only-on" title="Read-only" selected={field.readOnly === true} onPress={() => configure({ readOnly: true })} />
                </View>
              ) : null}
              {valueIssue !== null ? (
                <Text testID="sender-value-issue" accessibilityRole="alert" style={{ color: t.color.destructive, fontFamily: t.font.family, fontSize: 14 }}>
                  {`This value doesn’t fit the field (${valueIssue.replace(/_/g, ' ')}).`}
                </Text>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      {issue !== null ? (
        <Text testID="settings-issue" accessibilityRole="alert" style={{ color: t.color.destructive, fontFamily: t.font.family, fontSize: 14 }}>
          {issue.message}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * FIELD-PARITY-2 B-7 — "Show only when…": the trigger, picked from the fields the shared rule
 * accepts (same signer, a check box / acknowledgement / radio option / dropdown, no loop, the chain
 * at most 3 deep), the rule its type offers, and the server's refusal inline. A field the sender
 * fills is always shown. The Send flow only (never self-sign).
 */
export function ConditionSettings({
  field,
  fields,
  dispatch,
}: {
  readonly field: EditorField;
  readonly fields: readonly EditorField[];
  readonly dispatch: (a: EditorAction) => void;
}) {
  const t = useTheme();
  const secondary = { color: t.color.textSecondary, fontFamily: t.font.family, fontSize: 14 };
  const c = field.condition ?? null;
  const usable = usableTriggers(fields, field.key);
  const trigger = c === null ? undefined : fields.find((f) => f.key === c.trigger_key);
  const issue = conditionIssueOf(fields, field.key);
  const dependents = dependentsOfKey(fields, field.key);
  const set = (condition: EditorField['condition']) => dispatch({ type: 'setCondition', key: field.key, condition: condition ?? null });
  return (
    <View style={styles.body} testID="field-condition">
      <Text style={[secondary, { fontWeight: '600' }]}>Show only when…</Text>
      {field.senderFilled === true ? (
        <Text testID="condition-sender-filled" style={secondary}>
          A field you fill before sending is always shown.
        </Text>
      ) : (
        <>
          <View style={styles.row} accessibilityRole="radiogroup">
            <Chip testID="condition-always" title="Always shown" selected={c === null} onPress={() => set(null)} />
            {c !== null && !usable.some((f) => f.key === c.trigger_key) ? (
              <Chip testID="condition-trigger-unusable" title={`${trigger ? describeField(trigger) : 'A deleted field'} (can’t be used)`} selected onPress={() => undefined} />
            ) : null}
            {usable.map((f) => (
              <Chip key={f.key} testID={`condition-trigger-${f.key}`} title={describeField(f)} selected={c?.trigger_key === f.key} onPress={() => set(conditionFor(f))} />
            ))}
          </View>
          {usable.length === 0 && c === null ? (
            <Text testID="condition-none" style={secondary}>
              Add a checkbox, radio button or dropdown for the same signer to show this field only for some answers.
            </Text>
          ) : null}
          {c !== null && trigger ? <ConditionRule field={field} trigger={trigger} set={set} /> : null}
        </>
      )}
      {dependents.length > 0 ? (
        <Text testID="condition-dependents" style={secondary}>
          {`Shows or hides: ${dependents.map(describeField).join('; ')}.`}
        </Text>
      ) : null}
      {issue !== null ? (
        <Text testID="condition-issue" accessibilityRole="alert" style={{ color: t.color.destructive, fontFamily: t.font.family, fontSize: 14 }}>
          {`This condition can’t be saved: ${issue.message}.`}
        </Text>
      ) : null}
    </View>
  );
}

/** The rule of a condition, as its trigger's type offers it. */
function ConditionRule({ field, trigger, set }: { readonly field: EditorField; readonly trigger: EditorField; readonly set: (c: EditorField['condition']) => void }) {
  const t = useTheme();
  const secondary = { color: t.color.textSecondary, fontFamily: t.font.family, fontSize: 14 };
  const c = field.condition;
  if (!c) return null;
  if (c.when === 'chosen') {
    return (
      <Text testID="condition-rule" style={secondary}>
        …when the signer chooses this option.
      </Text>
    );
  }
  if (c.when === 'one_of') {
    const values = new Set(c.values ?? []);
    const choices = cleanChoices(trigger.options?.choices);
    const toggle = (v: string) => {
      const on = !values.has(v);
      const next = choices.map((ch) => ch.value).filter((x) => (x === v ? on : values.has(x)));
      if (next.length > 0) set({ trigger_key: c.trigger_key, when: 'one_of', values: next });
    };
    return (
      <>
        <Text style={secondary}>…when the signer picks one of</Text>
        <View style={styles.row} testID="condition-rule">
          {choices.map((ch, i) => (
            <Chip key={ch.value} testID={`condition-value-${i}`} title={ch.label} selected={values.has(ch.value)} onPress={() => toggle(ch.value)} />
          ))}
        </View>
      </>
    );
  }
  return (
    <View style={styles.row} accessibilityRole="radiogroup" testID="condition-rule">
      {conditionWhensFor(trigger.type).map((w) => (
        <Chip key={w} testID={`condition-when-${w}`} title={w === 'checked' ? 'Is checked' : 'Is not checked'} selected={c.when === w} onPress={() => set({ trigger_key: c.trigger_key, when: w })} />
      ))}
    </View>
  );
}

/** S-5 — the sender's value, with the control its type needs. */
function SenderValue({ field, onCommit }: { readonly field: EditorField; readonly onCommit: (v: string | null) => void }) {
  const v = field.senderValue ?? '';
  if (field.type === 'CHECKBOX' || field.type === 'RADIO') {
    return (
      <View style={styles.row} accessibilityRole="radiogroup">
        <Chip testID="sender-value-true" title={field.type === 'RADIO' ? 'Chosen' : 'Checked'} selected={v === 'true'} onPress={() => onCommit('true')} />
        <Chip testID="sender-value-false" title={field.type === 'RADIO' ? 'Not chosen' : 'Unchecked'} selected={v !== 'true'} onPress={() => onCommit('false')} />
      </View>
    );
  }
  if (field.type === 'DROPDOWN') {
    return (
      <View style={styles.row} accessibilityRole="radiogroup">
        {(field.options?.choices ?? []).map((c) => (
          <Chip key={c.value} testID={`sender-value-${c.value}`} title={c.label} selected={v === c.value} onPress={() => onCommit(c.value)} />
        ))}
      </View>
    );
  }
  return (
    <CommitInput
      testID="sender-value"
      label={field.type === 'DATE' ? 'Your value (YYYY-MM-DD)' : 'Your value'}
      value={v}
      multiline={field.type === 'MULTILINE_TEXT'}
      keyboardType={field.type === 'NUMBER' ? 'decimal-pad' : 'default'}
      onCommit={(x) => onCommit(x === '' ? null : x)}
    />
  );
}

/** T-4 — the DROPDOWN choices: add, rename, reorder, remove (a choice's value is its label). */
function ChoicesEditor({ choices, onChange }: { readonly choices: readonly DropdownChoice[]; readonly onChange: (c: DropdownChoice[]) => void }) {
  const t = useTheme();
  const list = [...choices];
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j] as DropdownChoice, next[i] as DropdownChoice];
    onChange(next);
  };
  return (
    <View style={styles.body} testID="dropdown-choices">
      <Text style={{ color: t.color.textSecondary, fontFamily: t.font.family, fontSize: 14 }}>{`Choices (${list.length})`}</Text>
      {list.map((c, i) => (
        <View key={i} style={styles.choiceRow}>
          <View style={styles.grow}>
            <CommitInput
              testID={`choice-label-${i}`}
              label={`Choice ${i + 1}`}
              value={c.label}
              onCommit={(label) => onChange(list.map((x, j) => (j === i ? (x.value === x.label ? { value: label, label } : { ...x, label }) : x)))}
            />
          </View>
          <Button title="↑" variant="text" accessibilityLabel={`Move choice ${i + 1} up`} disabled={i === 0} onPress={() => move(i, -1)} />
          <Button title="↓" variant="text" accessibilityLabel={`Move choice ${i + 1} down`} disabled={i === list.length - 1} onPress={() => move(i, 1)} />
          <Button testID={`choice-remove-${i}`} title="✕" variant="text" accessibilityLabel={`Remove choice ${i + 1}`} onPress={() => onChange(list.filter((_, j) => j !== i))} />
        </View>
      ))}
      <Button
        testID="choice-add"
        variant="secondary"
        title="Add choice"
        disabled={list.length >= DROPDOWN_CHOICES_MAX}
        onPress={() => onChange([...list, { value: `Option ${list.length + 1}`, label: `Option ${list.length + 1}` }])}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  grow: { flexGrow: 1, flexShrink: 1 },
  chip: { paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  choiceRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 4 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 16 },
});
