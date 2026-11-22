// FIELD-PARITY-1 P2-4 — "Find fields" in the Send flow's editor: the server's suggestions for
// uploaded documents become dashed ghosts; tap adds one for the active signer, press and hold
// dismisses it, Accept all adds every one as ONE undo step; self-sign never shows the button.
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { View } from 'react-native';

import { FieldEditor, type SuggestDoc } from '../FieldEditor';
import { parseAllSuggestions, toEditorSuggestions } from '../senderSuggestions';

jest.mock('../PdfPageView', () => ({
  PdfPageView: ({ children }: { children: React.ReactNode }) => {
    const { View: V } = jest.requireActual('react-native');
    return <V style={{ width: 300, height: 400 }}>{children}</V>;
  },
}));
jest.setTimeout(30_000);

const PAGE = { width: 612, height: 792 };
const WIRE = [
  { type: 'SIGNATURE', page_number: 0, x: 72, y: 100, width: 230, height: 50, reason: 'label:Signature' },
  { type: 'TEXT', page_number: 0, x: 72, y: 600, width: 200, height: 22, reason: 'underscore_line' },
];

function renderEditor(suggestDocs: readonly SuggestDoc[] | undefined, extra: Partial<React.ComponentProps<typeof FieldEditor>> = {}) {
  const onFieldsChange = jest.fn();
  render(
    <View style={{ flex: 1 }}>
      <FieldEditor
        documents={[{ key: 'd1', title: 'Lease' }]}
        recipients={[
          { key: 'r1', name: 'Jo Signer' },
          { key: 'r2', name: 'Max Other' },
        ]}
        initialFields={[]}
        loadAsset={async () => ({ base64: 'AAAA', pages: [PAGE] })}
        onFieldsChange={onFieldsChange}
        {...(suggestDocs ? { suggestDocs } : {})}
        {...extra}
      />
    </View>,
  );
  return { onFieldsChange };
}

const last = (m: jest.Mock) => m.mock.calls[m.mock.calls.length - 1]?.[0] ?? [];

describe('FieldEditor — Find fields (P2-4)', () => {
  it('loads the uploaded documents’ suggestions as ghosts; tap accepts one for the active signer', async () => {
    const load = jest.fn(async () => WIRE);
    const { onFieldsChange } = renderEditor([{ docKey: 'd1', load }]);
    await act(async () => {});
    await act(async () => {
      fireEvent.press(screen.getByTestId('editor-suggest'));
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('ghost-d1:0')).toBeTruthy();
    expect(screen.getByTestId('editor-suggest-note')).toHaveTextContent(/2 suggested fields/);
    expect(screen.getByLabelText('Suggested signature field next to the label “Signature”, page 1')).toBeTruthy();
    fireEvent.press(screen.getByTestId('ghost-d1:0'));
    const f = last(onFieldsChange);
    // WIRE (bottom-left) → EDITOR (top-left): y = 792 - 100 - 50.
    expect(f).toEqual([expect.objectContaining({ type: 'SIGNATURE', docKey: 'd1', page: 0, recipientKey: 'r1', x: 72, y: 642, width: 230, height: 50 })]);
    expect(screen.queryByTestId('ghost-d1:0')).toBeNull();
  });

  it('Accept all is one undo step; press and hold dismisses; Dismiss all clears', async () => {
    const { onFieldsChange } = renderEditor([{ docKey: 'd1', load: async () => WIRE }]);
    await act(async () => {});
    await act(async () => {
      fireEvent.press(screen.getByTestId('editor-suggest'));
    });
    fireEvent.press(screen.getByTestId('suggest-accept-all'));
    expect(last(onFieldsChange)).toHaveLength(2);
    fireEvent.press(screen.getByText('Undo'));
    expect(last(onFieldsChange)).toHaveLength(0);
    fireEvent(screen.getByTestId('ghost-d1:1'), 'longPress');
    expect(screen.queryByTestId('ghost-d1:1')).toBeNull();
    expect(screen.getByTestId('ghost-d1:0')).toBeTruthy();
    fireEvent.press(screen.getByTestId('suggest-dismiss-all'));
    expect(screen.queryByTestId('ghost-d1:0')).toBeNull();
    expect(screen.getByTestId('editor-suggest-note')).toHaveTextContent('Suggestion dismissed.');
  });

  it('no Suggest button before upload (no loader) or without a source', async () => {
    renderEditor([{ docKey: 'd1', load: null }]);
    await act(async () => {});
    expect(screen.queryByTestId('editor-suggest')).toBeNull();
  });

  it('a failed load shows nothing and says so', async () => {
    renderEditor([{ docKey: 'd1', load: async () => Promise.reject(new Error('down')) }]);
    await act(async () => {});
    await act(async () => {
      fireEvent.press(screen.getByTestId('editor-suggest'));
    });
    expect(screen.getByTestId('editor-suggest-note')).toHaveTextContent('No fields found to suggest.');
  });
});

describe('senderSuggestions parsing', () => {
  it('keeps only well-formed suggestion types; converts to the editor frame per page', () => {
    const parsed = parseAllSuggestions({ suggestions: [...WIRE, { type: 'PAYMENT', page_number: 0, x: 1, y: 1, width: 1, height: 1 }, { type: 'TEXT', page_number: -1, x: 1, y: 1, width: 1, height: 1 }, null] });
    expect(parsed.map((s) => s.type)).toEqual(['SIGNATURE', 'TEXT']);
    expect(parseAllSuggestions(null)).toEqual([]);
    const ed = toEditorSuggestions('d1', [PAGE], [...parsed, { ...WIRE[1]!, page_number: 3 }]);
    expect(ed.map((s) => [s.key, s.y])).toEqual([
      ['d1:0', 642],
      ['d1:1', 170],
    ]);
  });
});
