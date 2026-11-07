// M-A14 — the field editor's Sign Document look (`selfSign`): R-6 tool row, Find in
// Document listed by page, the red ✕ and grey handles on a selected field, Finish, and
// the arm request; the Send flow look is unchanged without the prop.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';

import { FieldEditor, type SelfSignChrome } from '../FieldEditor';
import { SELF_SIGN_TOOLS, selfSignTools } from '../fieldTypes';

jest.mock('../PdfPageView', () => ({
  PdfPageView: ({ children }: { children: React.ReactNode }) => {
    const { View: V } = jest.requireActual('react-native');
    return <V style={{ width: 300, height: 400 }}>{children}</V>;
  },
}));
jest.setTimeout(30_000);

const PAGE = { width: 612, height: 792 };
const words = (s: string) => s.split(' ').map((t, i) => ({ t, x: i / 20, y: 0.1, w: 0.04, h: 0.01 }));
const LAYER = {
  document_id: 'srv',
  pages: [
    { page: 1, words: words('This Lease Agreement is made between the Landlord and the Tenant') },
    { page: 2, words: words('The lease term is twelve months') },
  ],
};

function renderSelf(chrome: Partial<SelfSignChrome> = {}, extra: Partial<React.ComponentProps<typeof FieldEditor>> = {}) {
  const onFinish = jest.fn();
  const onFieldsChange = jest.fn();
  const props = {
    documents: [{ key: 'd1', title: 'Lease' }],
    recipients: [{ key: 'self', name: 'Sam Example' }],
    initialFields: [],
    loadAsset: async () => ({ base64: 'AAAA', pages: [PAGE, PAGE] }),
    onFieldsChange,
    findDocs: [{ docKey: 'd1', load: async () => LAYER }],
    hideRecipients: true,
    selfSign: { banner: null, onFinish, ...chrome },
    ...extra,
  } as React.ComponentProps<typeof FieldEditor>;
  const view = render(
    <View style={{ flex: 1 }}>
      <FieldEditor {...props} />
    </View>,
  );
  return { onFinish, onFieldsChange, props, view };
}

describe('R-6 tool row', () => {
  it('prototype order, then Last Name and Email', () => {
    expect(SELF_SIGN_TOOLS.map((x) => x.label)).toEqual([
      'Signature',
      'Initials',
      'Date',
      'Textbox',
      'Name',
      'First Name',
      'Company',
      'Title',
      'Checkbox',
      'Last Name',
      'Email',
    ]);
    expect(selfSignTools(['SIGNATURE', 'SIGN_DATE', 'TEXT']).map((x) => x.type)).toEqual(['SIGNATURE', 'SIGN_DATE', 'TEXT']);
  });
});

describe('FieldEditor selfSign', () => {
  it('no zoom, Undo or "More fields"; ▲▼, Finish and the page label', async () => {
    const { onFinish } = renderSelf();
    await act(async () => {});
    expect(screen.queryByLabelText('Zoom in')).toBeNull();
    expect(screen.queryByText('Undo')).toBeNull();
    expect(screen.queryByTestId('editor-more-fields')).toBeNull();
    fireEvent.press(screen.getByTestId('self-finish'));
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('self-page-label')).toHaveTextContent('Page 1 of 2');
  });

  it('a picked tool shows the hint; tapping the page places it, selected, with ✕ to remove', async () => {
    const { onFieldsChange } = renderSelf();
    await act(async () => {});
    fireEvent.press(screen.getByLabelText('Date field'));
    expect(screen.getByTestId('self-hint')).toHaveTextContent('Tap the document where the date goes');
    fireEvent.press(screen.getByTestId('self-place-center'));
    await waitFor(() => expect(onFieldsChange).toHaveBeenCalled());
    expect(onFieldsChange.mock.calls.at(-1)![0]).toHaveLength(1);
    fireEvent.press(screen.getByTestId('field-remove'));
    await waitFor(() => expect(onFieldsChange.mock.calls.at(-1)![0]).toHaveLength(0));
  });

  it('an arm request arms the tool once per id', async () => {
    renderSelf({ armRequest: { type: 'SIGNATURE', id: 1 } });
    await act(async () => {});
    expect(screen.getByTestId('self-tool-SIGNATURE').props.accessibilityState).toMatchObject({ selected: true });
  });

  it('a banner replaces the Find toolbar', async () => {
    const { Text } = jest.requireActual('react-native');
    renderSelf({ banner: <Text>Banner here</Text> });
    await act(async () => {});
    expect(screen.getByText('Banner here')).toBeTruthy();
    expect(screen.queryByLabelText('Find in document')).toBeNull();
  });

  it('Find in Document lists the matches by page with the words around them', async () => {
    renderSelf();
    await act(async () => {});
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Find in document'));
    });
    expect(screen.getByText('Find')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('find-input'), 'lease');
    await waitFor(() => expect(screen.getByTestId('find-count')).toHaveTextContent('2 matches · highlighted on the page'));
    expect(screen.getByTestId('find-result-0')).toHaveTextContent(/p\. 1.*This Lease Agreement/);
    expect(screen.getByTestId('find-result-1')).toHaveTextContent(/p\. 2.*The lease term/);
    fireEvent.press(screen.getByTestId('find-result-1'));
    expect(screen.queryByTestId('find-sheet')).toBeNull();
  });

  it('a tapped field is reported (e.g. an unadopted signature opens the adopt sheet)', async () => {
    const onFieldTap = jest.fn();
    renderSelf(
      { onFieldTap },
      { initialFields: [{ key: 'f1', docKey: 'd1', page: 0, recipientKey: 'self', type: 'SIGNATURE', required: true, x: 72, y: 600, width: 200, height: 46 }] },
    );
    await act(async () => {});
    fireEvent(screen.getByTestId('field-f1'), 'accessibilityTap');
    expect(onFieldTap).toHaveBeenCalledWith(expect.objectContaining({ key: 'f1' }));
  });
});
