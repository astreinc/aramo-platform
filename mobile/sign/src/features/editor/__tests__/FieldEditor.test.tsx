// M-A13 #2 (panel cap, pinned "Place at center"), #3 (place request), #11 (R-5 "Fit" zoom
// label) and M-A19 (Send-flow tool row, ✕ on the page, no grid / "More fields" / Delete
// button) on the shared field editor.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';

import { FieldEditor } from '../FieldEditor';
import { selfSignTools, toolFieldTypes, zoomLabel } from '../fieldTypes';

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
    // UAT AP-241 retest — it shrinks to the space left, never running off the screen.
    expect(panel.flexShrink).toBe(1);
    await act(async () => {});
  });

  // Android field test 2026-11-25 — with a large system font (or a short screen) the tool row
  // was squeezed and the field icons cut in half: the row and "Place at center" never shrink,
  // and the pages may give up space down to 35% there; at normal sizes they keep 50%.
  it('the tool row and "Place at center" never shrink; the pages keep 50%, or 35% when compact', async () => {
    const RN = jest.requireActual('react-native') as typeof import('react-native');
    const dims = jest.spyOn(RN, 'useWindowDimensions');
    try {
      dims.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 });
      renderEditor();
      await act(async () => {});
      expect(StyleSheet.flatten(screen.getByTestId('send-tools').props.style)).toMatchObject({ flexGrow: 0, flexShrink: 0 });
      expect(StyleSheet.flatten(screen.getByTestId('editor-canvas').props.style).minHeight).toBe('50%');
      const center = screen.getByText('Place at center');
      let host: { props: { style?: unknown }; parent: unknown } | null = center as unknown as { props: { style?: unknown }; parent: unknown };
      let pinned = false;
      while (host !== null && !pinned) {
        const st = StyleSheet.flatten(host.props.style as never) as { flexShrink?: number } | undefined;
        pinned = st?.flexShrink === 0;
        host = host.parent as typeof host;
      }
      expect(pinned).toBe(true);
      screen.unmount();
      dims.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1.3 });
      renderEditor();
      await act(async () => {});
      expect(StyleSheet.flatten(screen.getByTestId('editor-canvas').props.style).minHeight).toBe('35%');
    } finally {
      dims.mockRestore();
    }
  });

  it('M-A19 — every field type in one horizontal tool row; no grid and no "More fields"', async () => {
    renderEditor();
    await act(async () => {});
    const row = screen.getByTestId('send-tools');
    expect(row.props.horizontal).toBe(true);
    for (const x of selfSignTools(toolFieldTypes())) expect(screen.getByLabelText(`${x.label} field`)).toBeTruthy();
    expect(screen.getByLabelText('Email field')).toBeTruthy();
    expect(screen.queryByTestId('editor-more-fields')).toBeNull();
    expect(screen.queryByText('More fields')).toBeNull();
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
    // M-A19 — no Delete button in the panel; the ✕ on the page deletes the field.
    expect(screen.queryByText('Delete')).toBeNull();
    fireEvent.press(screen.getByTestId('field-remove'));
    await waitFor(() => expect(onFieldsChange.mock.calls.at(-1)![0]).toHaveLength(0));
    // Undo restores it.
    fireEvent.press(screen.getByText('Undo'));
    await waitFor(() => expect(onFieldsChange.mock.calls.at(-1)![0]).toHaveLength(1));
  });
});
