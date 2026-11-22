// FIELD-PARITY-1 P3 §6 — the Send flow editor's settings sheet for the new types: the tool row
// has them; a DROPDOWN's choices, a RADIO's "Add option", a NUMBER's money format, and
// sender-filled shown only while the server flag is on.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';

import { FieldEditor } from '../FieldEditor';
import type { EditorField } from '../editorReducer';

jest.mock('../PdfPageView', () => ({
  PdfPageView: ({ children }: { children: React.ReactNode }) => {
    const { View: V } = jest.requireActual('react-native');
    return <V style={{ width: 300, height: 400 }}>{children}</V>;
  },
}));
jest.setTimeout(30_000);

const PAGE = { width: 612, height: 792 };

function renderEditor(props: Partial<React.ComponentProps<typeof FieldEditor>> = {}) {
  const onFieldsChange = jest.fn();
  render(
    <View style={{ flex: 1 }}>
      <FieldEditor
        documents={[{ key: 'd1', title: 'Lease' }]}
        recipients={[{ key: 'r1', name: 'Jo Signer' }]}
        initialFields={[]}
        loadAsset={async () => ({ base64: 'AAAA', pages: [PAGE] })}
        onFieldsChange={onFieldsChange}
        {...props}
      />
    </View>,
  );
  const last = (): EditorField[] => onFieldsChange.mock.calls.at(-1)?.[0] ?? [];
  return { onFieldsChange, last };
}

async function placeCenter(type: string) {
  fireEvent.press(screen.getByTestId(`tool-${type}`));
  fireEvent.press(screen.getByText('Place at center'));
  await act(async () => {});
}

describe('FieldEditor — Phase 3 tools and settings sheet', () => {
  it('the tool row has the new types and Acknowledgement', async () => {
    renderEditor();
    await act(async () => {});
    for (const t of ['DATE', 'DROPDOWN', 'RADIO', 'NUMBER', 'MULTILINE_TEXT', 'ACKNOWLEDGEMENT']) expect(screen.getByTestId(`tool-${t}`)).toBeTruthy();
  });

  it('DROPDOWN: add a choice and remove one in the sheet', async () => {
    const { last } = renderEditor();
    await act(async () => {});
    await placeCenter('DROPDOWN');
    fireEvent.press(screen.getByTestId('field-settings-open'));
    expect(screen.getByTestId('dropdown-choices')).toBeTruthy();
    fireEvent.press(screen.getByTestId('choice-add'));
    await waitFor(() => expect(last()[0]?.options?.choices).toHaveLength(3));
    fireEvent.press(screen.getByTestId('choice-remove-0'));
    await waitFor(() => expect(last()[0]?.options?.choices?.map((c) => c.label)).toEqual(['Option 2', 'Option 3']));
    expect(screen.queryByTestId('sender-filled-on')).toBeNull();
  });

  it('RADIO: "Add option" adds a second option to the group', async () => {
    const { last } = renderEditor();
    await act(async () => {});
    await placeCenter('RADIO');
    fireEvent.press(screen.getByTestId('field-settings-open'));
    expect(screen.getByTestId('radio-count').props.children).toMatch(/1 option in this group/);
    fireEvent.press(screen.getByTestId('radio-add-option'));
    await waitFor(() => expect(last()).toHaveLength(2));
    expect(last()[1]).toMatchObject({ type: 'RADIO', groupKey: last()[0]!.groupKey, label: 'Option 2' });
  });

  it('NUMBER: money format; sender-filled with a value while the server flag is on', async () => {
    const { last } = renderEditor({ senderFilledEnabled: true });
    await act(async () => {});
    await placeCenter('NUMBER');
    fireEvent.press(screen.getByTestId('field-settings-open'));
    fireEvent.press(screen.getByTestId('number-format-money'));
    await waitFor(() => expect(last()[0]?.options).toEqual({ format: 'money', currency: 'USD', decimals: 2 }));
    fireEvent.press(screen.getByTestId('sender-filled-on'));
    fireEvent.changeText(screen.getByTestId('sender-value'), 'abc');
    fireEvent(screen.getByTestId('sender-value'), 'endEditing');
    await waitFor(() => expect(screen.getByTestId('sender-value-issue')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('sender-value'), '12.5');
    fireEvent(screen.getByTestId('sender-value'), 'endEditing');
    fireEvent.press(screen.getByTestId('read-only-on'));
    await waitFor(() => expect(last()[0]).toMatchObject({ senderFilled: true, senderValue: '12.5', readOnly: true }));
  });

  it('TEXT: a bad data name shows the server rule’s refusal', async () => {
    renderEditor();
    await act(async () => {});
    await placeCenter('TEXT');
    fireEvent.press(screen.getByTestId('field-settings-open'));
    fireEvent.changeText(screen.getByTestId('field-data-name'), 'Bad Name');
    fireEvent(screen.getByTestId('field-data-name'), 'endEditing');
    await waitFor(() => expect(screen.getByTestId('settings-issue')).toBeTruthy());
  });
});
