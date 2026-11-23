// FIELD-PARITY-2 B-7 — "Show only when…" in the app's Send flow editor: the trigger list (the
// shared rule: same signer, a trigger type, no loop, at most 3 deep), the rule, the server's
// refusal inline, a deleted trigger clearing its dependents with a notice (undoable), a field the
// sender fills never conditional (D-4), and never offered in self-sign (C-7).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';

import { FieldEditor } from '../FieldEditor';
import { conditionIssueOf, conditionsClearedText, dependentsOfKey, describeField, usableTriggers } from '../conditions';
import { editorReducer, initialEditorState, type EditorField } from '../editorReducer';

jest.mock('../PdfPageView', () => ({
  PdfPageView: ({ children }: { children: React.ReactNode }) => {
    const { View: V } = jest.requireActual('react-native');
    return <V style={{ width: 300, height: 400 }}>{children}</V>;
  },
}));
jest.setTimeout(30_000);

const PAGE = { width: 612, height: 792 };

function f(key: string, type: EditorField['type'], over: Partial<EditorField> = {}): EditorField {
  return { key, docKey: 'd1', page: 0, recipientKey: 'r1', type, x: 50, y: 50, width: 100, height: 20, required: false, ...over };
}

const FIELDS: EditorField[] = [
  f('sig', 'SIGNATURE', { y: 600, width: 200, height: 40, required: true }),
  f('agree', 'CHECKBOX', { y: 100, width: 18, height: 18, label: 'Co-applicant' }),
  f('co', 'TEXT', { y: 150 }),
  f('plan', 'DROPDOWN', { y: 200, options: { choices: [{ value: 'basic', label: 'Basic' }, { value: '', label: 'Pro' }] } }),
  f('theirs', 'CHECKBOX', { y: 250, recipientKey: 'r2', width: 18, height: 18 }),
];

describe('the trigger list and the inline refusal (shared rule)', () => {
  it('offers same-signer check boxes and dropdowns only', () => {
    expect(usableTriggers(FIELDS, 'co').map((x) => x.key)).toEqual(['agree', 'plan']);
    expect(usableTriggers(FIELDS, 'theirs').map((x) => x.key)).toEqual([]);
    expect(describeField(FIELDS[1]!)).toBe('Checkbox “Co-applicant” · page 1');
  });

  it('a choice whose value follows its label is a valid one_of value (as saved)', () => {
    const fields = FIELDS.map((x) => (x.key === 'co' ? { ...x, condition: { trigger_key: 'plan', when: 'one_of' as const, values: ['Pro'] } } : x));
    expect(conditionIssueOf(fields, 'co')).toBeNull();
    const cross = FIELDS.map((x) => (x.key === 'co' ? { ...x, condition: { trigger_key: 'theirs', when: 'checked' as const } } : x));
    expect(conditionIssueOf(cross, 'co')?.reason).toBe('condition_cross_signer');
  });
});

describe('editorReducer — conditions (B-7)', () => {
  const withCondition = () => editorReducer(initialEditorState(FIELDS, 'r1'), { type: 'setCondition', key: 'co', condition: { trigger_key: 'agree', when: 'checked' } });

  it('setCondition is one undo step; a sender-filled field refuses one and loses it when made sender-filled', () => {
    let s = withCondition();
    expect(s.fields[2]!.condition).toEqual({ trigger_key: 'agree', when: 'checked' });
    expect(s.undo).toHaveLength(1);
    s = editorReducer(s, { type: 'configure', key: 'co', patch: { senderFilled: true } });
    expect(s.fields[2]!.condition).toBeNull();
    expect(editorReducer(s, { type: 'setCondition', key: 'co', condition: { trigger_key: 'agree', when: 'checked' } })).toBe(s);
  });

  it('deleting the trigger clears its dependents in the same step, with a notice; undo restores both', () => {
    let s = withCondition();
    expect(dependentsOfKey(s.fields, 'agree').map((x) => x.key)).toEqual(['co']);
    s = editorReducer(s, { type: 'delete', key: 'agree' });
    expect(s.fields.find((x) => x.key === 'co')!.condition).toBeNull();
    expect(s.conditionsCleared).toBe(1);
    expect(conditionsClearedText(s.conditionsCleared)).toMatch(/^1 field that showed only for an answer to the deleted field is now always shown/);
    s = editorReducer(s, { type: 'undo' });
    expect(s.fields.find((x) => x.key === 'co')!.condition).toEqual({ trigger_key: 'agree', when: 'checked' });
    expect(s.conditionsCleared).toBe(0);
  });

  it('a removed recipient’s triggers go with them: their dependents’ conditions clear', () => {
    let s = editorReducer(initialEditorState(FIELDS, 'r1'), { type: 'setCondition', key: 'theirs', condition: null });
    s = { ...s, fields: s.fields.map((x) => (x.key === 'agree' ? { ...x, recipientKey: 'r2' } : x.key === 'co' ? { ...x, recipientKey: 'r2', condition: { trigger_key: 'agree', when: 'checked' } } : x)) };
    s = editorReducer(s, { type: 'recipientsChanged', recipientKeys: ['r1'] });
    expect(s.fields.map((x) => x.key)).toEqual(['sig', 'plan']);
    const kept = { ...initialEditorState([...FIELDS.slice(0, 2), { ...FIELDS[2]!, condition: { trigger_key: 'theirs', when: 'checked' as const } }, FIELDS[4]!]) };
    const after = editorReducer(kept, { type: 'recipientsChanged', recipientKeys: ['r1'] });
    expect(after.fields.find((x) => x.key === 'co')!.condition).toBeNull();
    expect(after.conditionsCleared).toBe(1);
  });
});

function renderEditor(props: Partial<React.ComponentProps<typeof FieldEditor>> = {}) {
  const onFieldsChange = jest.fn();
  render(
    <View style={{ flex: 1 }}>
      <FieldEditor
        documents={[{ key: 'd1', title: 'Lease' }]}
        recipients={[
          { key: 'r1', name: 'Jo Signer' },
          { key: 'r2', name: 'Sam Other' },
        ]}
        initialFields={FIELDS}
        loadAsset={async () => ({ base64: 'AAAA', pages: [PAGE] })}
        onFieldsChange={onFieldsChange}
        {...props}
      />
    </View>,
  );
  const last = (): EditorField[] => onFieldsChange.mock.calls.at(-1)?.[0] ?? FIELDS;
  const byKey = (k: string) => last().find((x) => x.key === k);
  return { onFieldsChange, last, byKey };
}

describe('FieldEditor — Show only when… (Send flow)', () => {
  it('picks a trigger from the list and its rule; a dropdown trigger takes its values', async () => {
    const { byKey } = renderEditor();
    await act(async () => {});
    fireEvent(await screen.findByLabelText(/^Text, for Jo Signer/), 'accessibilityTap');
    fireEvent.press(screen.getByTestId('field-settings-open'));
    expect(screen.getByTestId('field-condition')).toBeTruthy();
    expect(screen.queryByTestId('condition-trigger-theirs')).toBeNull();
    fireEvent.press(screen.getByTestId('condition-trigger-agree'));
    await waitFor(() => expect(byKey('co')?.condition).toEqual({ trigger_key: 'agree', when: 'checked' }));
    fireEvent.press(screen.getByTestId('condition-when-unchecked'));
    await waitFor(() => expect(byKey('co')?.condition).toEqual({ trigger_key: 'agree', when: 'unchecked' }));
    fireEvent.press(screen.getByTestId('condition-trigger-plan'));
    await waitFor(() => expect(byKey('co')?.condition).toEqual({ trigger_key: 'plan', when: 'one_of', values: ['basic'] }));
    fireEvent.press(screen.getByTestId('condition-value-1'));
    await waitFor(() => expect(byKey('co')?.condition).toEqual({ trigger_key: 'plan', when: 'one_of', values: ['basic', 'Pro'] }));
    expect(screen.queryByTestId('condition-issue')).toBeNull();
    fireEvent.press(screen.getByTestId('condition-always'));
    await waitFor(() => expect(byKey('co')?.condition).toBeNull());
  });

  it('shows the server’s refusal inline (a trigger of another signer)', async () => {
    renderEditor({ initialFields: FIELDS.map((x) => (x.key === 'co' ? { ...x, condition: { trigger_key: 'theirs', when: 'checked' as const } } : x)) });
    await act(async () => {});
    fireEvent(await screen.findByLabelText(/^Text, for Jo Signer/), 'accessibilityTap');
    fireEvent.press(screen.getByTestId('field-settings-open'));
    expect(screen.getByTestId('condition-trigger-unusable')).toBeTruthy();
    expect(screen.getByTestId('condition-issue').props.children).toMatch(/another signer/);
  });

  it('deleting a trigger clears its dependents with a notice; Undo brings the condition back', async () => {
    const { byKey } = renderEditor({ initialFields: FIELDS.map((x) => (x.key === 'co' ? { ...x, condition: { trigger_key: 'agree', when: 'checked' as const } } : x)) });
    await act(async () => {});
    fireEvent(await screen.findByLabelText(/^Checkbox "Co-applicant", for Jo Signer/), 'accessibilityAction', { nativeEvent: { actionName: 'delete' } });
    await waitFor(() => expect(byKey('agree')).toBeUndefined());
    expect(byKey('co')?.condition).toBeNull();
    expect(screen.getByTestId('condition-notice')).toBeTruthy();
    fireEvent.press(screen.getByText('Undo'));
    await waitFor(() => expect(byKey('co')?.condition).toEqual({ trigger_key: 'agree', when: 'checked' }));
    expect(screen.queryByTestId('condition-notice')).toBeNull();
  });
});

describe('FieldEditor — self-sign never offers Show only when… (C-7)', () => {
  it('a selected field in Sign a document has no condition section', async () => {
    renderEditor({ selfSign: { banner: null, onFinish: jest.fn() }, hideRecipients: true, recipients: [{ key: 'r1', name: 'Jo Signer' }], initialFields: FIELDS.slice(0, 3) });
    await act(async () => {});
    fireEvent(await screen.findByTestId('field-co'), 'accessibilityTap');
    expect(screen.queryByTestId('field-settings-open')).toBeNull();
    expect(screen.queryByTestId('field-condition')).toBeNull();
  });
});
