// M-A13 #2 (panel cap, "More fields", pinned "Place at center"), #3 (place request) and
// #11 (R-5 "Fit" zoom label) on the shared field editor.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';

import { FieldEditor } from '../FieldEditor';
import { COMMON_FIELD_TYPES, visibleTools, zoomLabel, type AuthoringFieldType } from '../fieldTypes';

jest.mock('../PdfPageView', () => ({
  PdfPageView: ({ children }: { children: React.ReactNode }) => {
    const { View: V } = jest.requireActual('react-native');
    return <V style={{ width: 300, height: 400 }}>{children}</V>;
  },
}));
jest.setTimeout(30_000);

const PAGE = { width: 612, height: 792 };

function renderEditor(
  props: Partial<React.ComponentProps<typeof FieldEditor>> = {},
): { onFieldsChange: jest.Mock } {
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
  return { onFieldsChange };
}

describe('zoomLabel (R-5)', () => {
  it('the base level reads "Fit"; larger levels keep their percentages', () => {
    expect(zoomLabel(1)).toEqual({ text: 'Fit', accessibility: 'Zoom fit to width' });
    expect(zoomLabel(1.5)).toEqual({ text: '150%', accessibility: 'Zoom 150 percent' });
    expect(zoomLabel(2).text).toBe('200%');
  });
});

describe('visibleTools (#2)', () => {
  const all: AuthoringFieldType[] = [
    'SIGNATURE',
    'INITIALS',
    'SIGN_DATE',
    'TEXT',
    'SIGNER_NAME',
    'CHECKBOX',
    'FIRST_NAME',
    'LAST_NAME',
    'EMAIL',
  ];
  it('more than 8 tools: the common ones until expanded', () => {
    expect(visibleTools(all, false)).toEqual(COMMON_FIELD_TYPES);
    expect(visibleTools(all, true)).toEqual(all);
  });
  it('a picked other tool stays visible while collapsed', () => {
    expect(visibleTools(all, false, 'EMAIL')).toEqual([...COMMON_FIELD_TYPES, 'EMAIL']);
  });
  it('8 or fewer: everything, no collapsing', () => {
    expect(visibleTools(all.slice(0, 8), false)).toEqual(all.slice(0, 8));
  });
});

describe('FieldEditor', () => {
  it('shows "Fit", caps the panel at 40% and keeps the canvas at least 50%', async () => {
    renderEditor({ bottomInset: 34 });
    expect(screen.getByText('Fit')).toBeTruthy();
    expect(screen.getByLabelText('Zoom fit to width')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Zoom in'));
    expect(screen.getByText('150%')).toBeTruthy();
    const panel = StyleSheet.flatten(screen.getByTestId('editor-panel').props.style);
    expect(panel.maxHeight).toBe('40%');
    // The bottom inset is cleared so "Place at center" is never under the system bar.
    expect(panel.paddingBottom).toBe(12 + 34);
    await act(async () => {});
  });

  it('"More fields" expands the less common tools', async () => {
    renderEditor();
    await act(async () => {});
    expect(screen.getByLabelText('Signature field')).toBeTruthy();
    expect(screen.getByLabelText('Checkbox field')).toBeTruthy();
    expect(screen.queryByLabelText('Email field')).toBeNull();
    fireEvent.press(screen.getByTestId('editor-more-fields'));
    expect(screen.getByLabelText('Email field')).toBeTruthy();
    expect(screen.getByText('Fewer fields')).toBeTruthy();
  });

  it('a place request places the field at the centre and selects it (#3)', async () => {
    const { onFieldsChange } = renderEditor({ placeRequest: null });
    // Let the page sizes load, then request a placement.
    await act(async () => {});
    screen.rerender(
      <View style={{ flex: 1 }}>
        <FieldEditor
          documents={[{ key: 'd1', title: 'Lease' }]}
          recipients={[{ key: 'r1', name: 'Jo Signer' }]}
          initialFields={[]}
          loadAsset={async () => ({ base64: 'AAAA', pages: [PAGE] })}
          onFieldsChange={onFieldsChange}
          placeRequest={{ type: 'SIGNATURE', id: 1 }}
        />
      </View>,
    );
    await waitFor(() => expect(onFieldsChange).toHaveBeenCalled());
    const placed = onFieldsChange.mock.calls.at(-1)![0];
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ type: 'SIGNATURE', docKey: 'd1', page: 0 });
    const cx = placed[0].x + placed[0].width / 2;
    expect(Math.abs(cx - PAGE.width / 2)).toBeLessThanOrEqual(1);
    // Selected: the selection panel is open on it.
    expect(screen.getByText('Signature · Jo Signer')).toBeTruthy();
  });
});
