import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PlacementEditor, type PlacementEditorProps } from './PlacementEditor';
import { DEFAULT_SETTINGS, type PlacedField } from './lib/model';
import { useAutosave } from './lib/useAutosave';

// FIELD-PARITY-1 P1-5 — the shared editor as both hosts use it (jsdom: no layout, no pdf.js —
// the host's renderer is a stub; with no visible region a new field takes the fixed fallback spot).

const DOCS = [{ id: 'd1', title: 'Contract', pages: [{ width: 612, height: 792 }] }];
const field = (id: string, over: Partial<PlacedField> = {}): PlacedField => ({
  id,
  type: 'TEXT',
  docId: 'd1',
  page: 0,
  x: 100,
  y: 500,
  width: 230,
  height: 22,
  required: false,
  assignee: 's1',
  binding: null,
  settings: DEFAULT_SETTINGS,
  ...over,
});

let n = 0;
function setup(over: Partial<PlacementEditorProps> = {}) {
  const onChange = vi.fn();
  const props: PlacementEditorProps = {
    documents: DOCS,
    renderPage: async () => undefined,
    surface: 'send_web',
    fields: [],
    resetKey: 'k',
    onChange,
    assignees: [
      { id: 's1', label: 'Ada Lovelace' },
      { id: 's2', label: 'Bo Diddley' },
    ],
    capabilities: { settings: ['label', 'group_key', 'group_rule', 'min_selected', 'name_mode'] },
    newFieldId: () => `new${(n += 1)}`,
    ...over,
  };
  const utils = render(<PlacementEditor {...props} />);
  const last = (): readonly PlacedField[] => (onChange.mock.calls.at(-1)?.[0] as readonly PlacedField[]) ?? [];
  return { ...utils, onChange, last, props };
}

describe('PlacementEditor — arm mode (sign-web)', () => {
  it('the palette is the send_web projection; pick a type, then click the page to place it for the active recipient', () => {
    const { last } = setup();
    expect(screen.queryByTestId('fpe-add-PAYMENT')).toBeNull();
    expect(screen.queryByTestId('fpe-add-ACKNOWLEDGEMENT')).toBeNull();
    fireEvent.click(screen.getByTestId('fpe-assignee-s2'));
    fireEvent.click(screen.getByTestId('fpe-add-SIGNATURE'));
    expect(screen.getByTestId('fpe-add-SIGNATURE')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.pointerDown(screen.getByTestId('fpe-page-0'), { clientX: 0, clientY: 0 });
    const f = last()[0];
    expect(f).toMatchObject({ type: 'SIGNATURE', assignee: 's2', width: 230, height: 50, required: true });
    // Focus moves to the new field; it is announced.
    expect(document.activeElement).toBe(screen.getByTestId(`fpe-field-${f!.id}`));
    expect(screen.getByTestId('fpe-announce')).toHaveTextContent('Signature field added on page 1 for Bo Diddley.');
  });

  it('keyboard path: "Place on page 1 (keyboard)" adds the armed type; arrows nudge, Alt resizes, Delete removes, Ctrl+Z undoes', () => {
    const { last } = setup();
    fireEvent.click(screen.getByTestId('fpe-add-TEXT'));
    fireEvent.click(screen.getByTestId('fpe-place-keyboard'));
    const added = last()[0]!;
    // No visible region under jsdom → the fallback spot 72pt in, 144pt below the top.
    expect(added).toMatchObject({ x: 72, y: 792 - 144 - 22 });
    const box = screen.getByTestId(`fpe-field-${added.id}`);
    fireEvent.keyDown(box, { key: 'ArrowRight', shiftKey: true });
    expect(last()[0]).toMatchObject({ x: 82 });
    fireEvent.keyDown(box, { key: 'ArrowDown', altKey: true });
    expect(last()[0]).toMatchObject({ height: 24 });
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(last()[0]).toMatchObject({ height: 22 });
    fireEvent.keyDown(box, { key: 'Delete' });
    expect(last()).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByTestId('fpe-center'));
    fireEvent.click(screen.getByTestId('fpe-undo'));
    expect(last()).toHaveLength(1);
    expect(screen.getByTestId('fpe-announce')).toHaveTextContent('Undone: Delete text field.');
  });

  it('inspector: recipient reassign, required, name mode and check-box settings', () => {
    const { last } = setup({ fields: [field('cb', { type: 'CHECKBOX', width: 18, height: 18 }), field('nm', { type: 'SIGNER_NAME' })] });
    fireEvent.focus(screen.getByTestId('fpe-field-cb'));
    fireEvent.change(screen.getByTestId('fpe-assignee-select'), { target: { value: 'role:s2' } });
    expect(last()[0]).toMatchObject({ assignee: 's2' });
    fireEvent.click(screen.getByTestId('fpe-required'));
    expect(last()[0]).toMatchObject({ required: true });
    fireEvent.change(screen.getByTestId('fpe-checkbox-label'), { target: { value: 'I agree' } });
    fireEvent.change(screen.getByTestId('fpe-checkbox-group'), { target: { value: 'g' } });
    fireEvent.change(screen.getByTestId('fpe-checkbox-rule'), { target: { value: 'SELECT_ONE' } });
    expect(last()[0]?.settings).toMatchObject({ label: 'I agree', groupKey: 'g', groupRule: 'SELECT_ONE' });
    fireEvent.focus(screen.getByTestId('fpe-field-nm'));
    fireEvent.change(screen.getByTestId('fpe-name-mode'), { target: { value: 'SIGNER_ENTERED' } });
    expect(last()[1]?.settings.nameMode).toBe('SIGNER_ENTERED');
  });

  it('a locked (engine-only) field shows the rule, is not moved by the keyboard, and can be deleted', () => {
    const { last, onChange } = setup({ fields: [field('ack', { type: 'ACKNOWLEDGEMENT', locked: true })] });
    const box = screen.getByTestId('fpe-field-ack');
    fireEvent.focus(box);
    expect(screen.getByTestId('fpe-field-locked')).toBeInTheDocument();
    expect(screen.queryByTestId('fpe-required')).toBeNull();
    fireEvent.keyDown(box, { key: 'ArrowLeft' });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('fpe-delete'));
    expect(last()).toHaveLength(0);
  });

  it('zoom changes the page width; a reset (new key) is not an edit', () => {
    const { rerender, props, onChange } = setup({ pageWidth: 600 });
    expect(screen.getByTestId('fpe-page-0')).toHaveStyle({ width: '600px' });
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByTestId('fpe-zoom')).toHaveTextContent('110%');
    expect(screen.getByTestId('fpe-page-0')).toHaveStyle({ width: '660px' });
    rerender(<PlacementEditor {...props} pageWidth={600} fields={[field('x')]} resetKey="k2" />);
    expect(screen.getByTestId('fpe-field-x')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('PlacementEditor — add mode, prefill, capabilities, read-only (console)', () => {
  const consoleProps: Partial<PlacementEditorProps> = {
    surface: 'template_fixed_form',
    paletteMode: 'add',
    idPrefix: 'ffs',
    allowUnassigned: true,
    assignees: [{ id: 'employee', label: 'Employee' }],
    capabilities: { settings: [], prefillTypes: ['TEXT'] },
    prefills: [{ key: 'organization.name', label: 'Organization name' }],
    copy: { assigneeLabel: 'Filled by' },
    showFieldKey: true,
  };

  it('a palette click adds the field in view at once; settings the API does not accept are hidden', () => {
    const { last } = setup(consoleProps);
    expect(screen.getByTestId('ffs-target')).toHaveTextContent('Fields are added to page 1.');
    fireEvent.click(screen.getByTestId('ffs-add-CHECKBOX'));
    const f = last()[0]!;
    expect(f).toMatchObject({ type: 'CHECKBOX', assignee: 'employee', width: 18, height: 18, required: false });
    expect(screen.getByTestId('ffs-inspector')).toHaveTextContent(f.id);
    expect(screen.queryByTestId('ffs-checkbox-label')).toBeNull();
    expect(screen.queryByTestId('ffs-checkbox-group')).toBeNull();
  });

  it('a text field may be prefilled by a variable (required then off-limits)', () => {
    const { last } = setup(consoleProps);
    fireEvent.click(screen.getByTestId('ffs-add-TEXT'));
    fireEvent.change(screen.getByLabelText('Filled by'), { target: { value: 'var:organization.name' } });
    expect(last()[0]).toMatchObject({ assignee: null, binding: 'organization.name' });
    expect(screen.getByTestId('ffs-required')).toBeDisabled();
    expect(screen.getByTestId(`ffs-field-${last()[0]!.id}`)).toHaveTextContent('Prefilled: Organization name');
  });

  it('read-only: no palette, no tab stops, no inspector', () => {
    setup({ ...consoleProps, readOnly: true, fields: [field('sig', { type: 'SIGNATURE', assignee: 'employee' })] });
    expect(screen.queryByTestId('ffs-add-TEXT')).toBeNull();
    expect(screen.getByTestId('ffs-field-sig')).not.toHaveAttribute('role');
    expect(screen.queryByTestId('ffs-undo')).toBeNull();
  });
});

describe('useAutosave', () => {
  it('saves 600ms after the last edit, restarting on each edit; flush saves now', async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async () => undefined);
      const { result, rerender } = renderHook(({ rev }) => useAutosave({ revision: rev, enabled: true, save }), { initialProps: { rev: 0 } });
      expect(save).not.toHaveBeenCalled();
      rerender({ rev: 1 });
      act(() => vi.advanceTimersByTime(400));
      rerender({ rev: 2 });
      act(() => vi.advanceTimersByTime(400));
      expect(save).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(save).toHaveBeenCalledTimes(1);
      expect(result.current.state).toBe('saved');
      rerender({ rev: 3 });
      await act(async () => {
        await result.current.flush();
      });
      act(() => vi.advanceTimersByTime(1000));
      expect(save).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed save', async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async () => Promise.reject(new Error('Refused')));
      const { result, rerender } = renderHook(({ rev }) => useAutosave({ revision: rev, enabled: true, save }), { initialProps: { rev: 0 } });
      rerender({ rev: 1 });
      await act(async () => {
        vi.advanceTimersByTime(600);
      });
      expect(result.current.state).toBe('error');
      expect(result.current.error).toBe('Refused');
    } finally {
      vi.useRealTimers();
    }
  });
});
