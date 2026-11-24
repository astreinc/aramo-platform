// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §6 — the
// signing page's field editor (inside the text sheet) for every field the signer types or picks:
//   - TEXT and the profile types: a text input (email / phone / number keyboard by preset);
//   - MULTILINE_TEXT: a multi-line input with its length counter;
//   - NUMBER: a decimal keypad, the money prefix ("$"), typing normalised ("1,250.5");
//   - DATE: a month picker inside the field's date_range, stored YYYY-MM-DD and previewed in
//     the envelope's date format;
//   - DROPDOWN: the sender's choices, one chosen.
// The field's label (S-1) names it, its tooltip is the help text, its placeholder the hint
// (S-2). A value the server would refuse (@aramo/sign-client signerValueProblem) is named
// beside the input, announced, and the input focused; nothing is kept until it passes.
import { useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, TextInput, View, type KeyboardTypeOptions } from 'react-native';

import {
  dateBoundsOf,
  dropdownChoicesOf,
  fieldInputHint,
  fieldInputLimit,
  fieldValueRefusalText,
  formatChosenDate,
  isIsoDate,
  numberPrefixOf,
  signerFieldPlaceholder,
  signerFieldTooltip,
  signerInputKind,
  optionalSuffix,
} from '@aramo/sign-client';

import { Button } from '../../components/Button';
import { ErrorText } from '../send/ui';
import { useTheme } from '../../theme';
import { MONTH_NAMES, WEEKDAY_SHORT, canShift, inBounds, monthGrid, shiftMonth, startMonth, type YearMonth } from './dateGrid';
import { checkEditorValue, fieldCaption, type SigningField } from './signingMachine';

/** The text input's limit when the server sets none (the sheet's earlier cap). */
const DEFAULT_TEXT_MAX = 500;

export interface FieldEditorProps {
  readonly field: SigningField;
  readonly initial: string;
  readonly dateFormat: string | null;
  /** The checked, normalised value ('' clears the field). */
  readonly onSave: (value: string) => void;
  /** Today, for the date picker's first month (tests pass a fixed date). */
  readonly today?: Date;
}

function keyboardFor(f: SigningField): KeyboardTypeOptions {
  if (f.field_type === 'EMAIL' || f.validation === 'email') return 'email-address';
  if (f.validation === 'phone') return 'phone-pad';
  if (f.validation === 'us_zip') return 'number-pad';
  return 'default';
}

export function FieldEditor({ field, initial, dateFormat, onSave, today = new Date() }: FieldEditorProps) {
  const t = useTheme();
  const kind = signerInputKind(field.field_type);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<TextInput>(null);
  const caption = fieldCaption(field);
  const help = signerFieldTooltip(field);
  const hint = fieldInputHint(field, { date_format: dateFormat });
  const placeholder = signerFieldPlaceholder(field) ?? undefined;
  const limit = fieldInputLimit(field) ?? (kind === 'text' ? DEFAULT_TEXT_MAX : null);
  const prefix = numberPrefixOf(field);
  const o = field.options ?? {};
  // A minus sign needs the full keyboard on iOS (the decimal pad has none).
  const numberKeyboard: KeyboardTypeOptions = typeof o.min === 'number' && o.min < 0 ? 'numbers-and-punctuation' : 'decimal-pad';

  const change = (v: string) => {
    setDraft(v);
    if (error !== null) setError(null);
  };
  const save = () => {
    const { value, problem } = checkEditorValue(field, draft);
    if (problem !== null) {
      const msg = fieldValueRefusalText(problem, field, { date_format: dateFormat });
      setError(msg);
      AccessibilityInfo.announceForAccessibility(msg);
      input.current?.focus();
      return;
    }
    onSave(value);
  };

  const inputStyle = [
    styles.input,
    {
      borderColor: error !== null ? t.color.destructive : t.color.separator,
      color: t.color.text,
      backgroundColor: t.color.surface,
      minHeight: t.size.minTouch + 4,
    },
  ];
  const a11yHint = [help, hint].filter((x) => x !== null).join('. ') || undefined;

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: t.color.text }]} testID="field-editor-label">
        {`${caption}${optionalSuffix(field.required)}`}
      </Text>
      {help !== null ? (
        <Text style={[styles.help, { color: t.color.textSecondary }]} testID="field-editor-help">
          {help}
        </Text>
      ) : null}
      {kind === 'date' ? (
        <DatePicker field={field} value={draft} dateFormat={dateFormat} today={today} onPick={change} />
      ) : kind === 'dropdown' ? (
        <ChoiceList field={field} value={draft} onPick={change} />
      ) : kind === 'number' ? (
        <View style={styles.row}>
          {prefix !== null ? (
            <Text style={[styles.prefix, { color: t.color.text }]} importantForAccessibility="no" accessibilityElementsHidden testID="field-editor-prefix">
              {prefix}
            </Text>
          ) : null}
          <TextInput
            ref={input}
            testID="text-field-input"
            value={draft}
            onChangeText={change}
            accessibilityLabel={caption}
            accessibilityHint={a11yHint}
            keyboardType={numberKeyboard}
            placeholder={placeholder}
            placeholderTextColor={t.color.textTertiary}
            autoFocus
            style={[...inputStyle, { flex: 1 }]}
          />
        </View>
      ) : (
        <TextInput
          ref={input}
          testID="text-field-input"
          value={draft}
          onChangeText={change}
          accessibilityLabel={caption}
          accessibilityHint={a11yHint}
          keyboardType={keyboardFor(field)}
          autoCapitalize={field.field_type === 'EMAIL' || field.validation === 'email' ? 'none' : 'sentences'}
          placeholder={placeholder}
          placeholderTextColor={t.color.textTertiary}
          autoFocus
          multiline={kind === 'multiline'}
          maxLength={limit ?? undefined}
          style={[...inputStyle, kind === 'multiline' ? { minHeight: 120, textAlignVertical: 'top' } : null]}
        />
      )}
      {hint !== null ? (
        <Text style={[styles.help, { color: t.color.textSecondary }]} testID="field-editor-hint">
          {hint}
        </Text>
      ) : null}
      {kind === 'multiline' && limit !== null ? (
        <Text style={[styles.count, { color: t.color.textSecondary }]} accessibilityLiveRegion="polite" testID="field-editor-count">
          {`${draft.length} / ${limit}`}
        </Text>
      ) : null}
      <ErrorText>{error}</ErrorText>
      <Button testID="text-field-save" title="Save" onPress={save} />
    </View>
  );
}

/** T-3 — the month grid; a day outside the date_range is shown but cannot be chosen. */
function DatePicker({
  field,
  value,
  dateFormat,
  today,
  onPick,
}: {
  readonly field: SigningField;
  readonly value: string;
  readonly dateFormat: string | null;
  readonly today: Date;
  readonly onPick: (iso: string) => void;
}) {
  const t = useTheme();
  const { min, max } = dateBoundsOf(field);
  const [ym, setYm] = useState<YearMonth>(() => startMonth(isIsoDate(value) ? value : null, min, max, today));
  const weeks = useMemo(() => monthGrid(ym), [ym]);
  const title = `${MONTH_NAMES[ym.month]} ${ym.year}`;
  const nav = (delta: number, label: string) => {
    const ok = canShift(ym, delta, min, max);
    return (
      <Pressable
        testID={delta < 0 ? 'date-prev' : 'date-next'}
        onPress={() => ok && setYm(shiftMonth(ym, delta))}
        disabled={!ok}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: !ok }}
        style={[styles.navBtn, { minWidth: t.size.minTouch, minHeight: t.size.minTouch, opacity: ok ? 1 : 0.3 }]}
      >
        <Text style={{ color: t.color.accent, fontSize: 20, fontWeight: '600' }}>{delta < 0 ? '‹' : '›'}</Text>
      </Pressable>
    );
  };
  return (
    <View testID="date-picker">
      <View style={styles.row}>
        {nav(-1, 'Previous month')}
        <Text style={[styles.monthTitle, { color: t.color.text }]} accessibilityRole="header" accessibilityLiveRegion="polite" testID="date-month">
          {title}
        </Text>
        {nav(1, 'Next month')}
      </View>
      <View style={styles.week}>
        {WEEKDAY_SHORT.map((d) => (
          <Text key={d} style={[styles.weekday, { color: t.color.textSecondary }]} importantForAccessibility="no" accessibilityElementsHidden>
            {d}
          </Text>
        ))}
      </View>
      {weeks.map((w, i) => (
        <View key={i} style={styles.week}>
          {w.map((iso, j) => {
            if (iso === null) return <View key={j} style={styles.day} />;
            const ok = inBounds(iso, min, max);
            const on = iso === value;
            return (
              <Pressable
                key={iso}
                testID={`date-${iso}`}
                onPress={() => ok && onPick(iso)}
                disabled={!ok}
                accessibilityRole="button"
                accessibilityLabel={formatChosenDate(iso, dateFormat)}
                accessibilityState={{ selected: on, disabled: !ok }}
                style={[styles.day, on ? { backgroundColor: t.color.accent, borderRadius: 999 } : null]}
              >
                <Text style={{ color: on ? t.color.white : ok ? t.color.text : t.color.textTertiary, fontSize: 15 }}>{Number(iso.slice(8, 10))}</Text>
              </Pressable>
            );
          })}
        </View>
      ))}
      <Text style={[styles.help, { color: t.color.textSecondary }]} accessibilityLiveRegion="polite" testID="date-preview">
        {isIsoDate(value) ? `Shown on the document as ${formatChosenDate(value, dateFormat)}` : 'Choose a date'}
      </Text>
    </View>
  );
}

/** T-4 — the sender's choices; one is chosen. */
function ChoiceList({ field, value, onPick }: { readonly field: SigningField; readonly value: string; readonly onPick: (v: string) => void }) {
  const t = useTheme();
  const choices = dropdownChoicesOf(field);
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={fieldCaption(field)} testID="choice-list">
      {choices.map((c) => {
        const on = c.value === value;
        return (
          <Pressable
            key={c.value}
            testID={`choice-${c.value}`}
            onPress={() => onPick(c.value)}
            accessibilityRole="radio"
            accessibilityLabel={c.label}
            accessibilityState={{ checked: on }}
            style={[styles.choice, { minHeight: t.size.minTouch, borderBottomColor: t.color.separator }]}
          >
            <Text style={{ color: t.color.text, fontSize: 16, flex: 1 }}>{c.label}</Text>
            <Text style={{ color: t.color.accent, fontSize: 18, fontWeight: '700' }}>{on ? '✓' : ''}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  label: { fontSize: 15, fontWeight: '600' },
  help: { fontSize: 13, lineHeight: 18 },
  count: { fontSize: 12, alignSelf: 'flex-end' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  prefix: { fontSize: 18, fontWeight: '600' },
  navBtn: { alignItems: 'center', justifyContent: 'center' },
  monthTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600' },
  week: { flexDirection: 'row' },
  weekday: { flex: 1, textAlign: 'center', fontSize: 12, paddingVertical: 4 },
  day: { flex: 1, aspectRatio: 1, alignItems: 'center', justifyContent: 'center', maxHeight: 44 },
  choice: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 8 },
});
