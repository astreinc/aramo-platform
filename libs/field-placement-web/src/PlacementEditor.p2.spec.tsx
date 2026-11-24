import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PlacementEditor, type PlacementEditorProps } from './PlacementEditor';
import { DEFAULT_SETTINGS, type PlacedField } from './lib/model';

// FIELD-PARITY-1 §5 P2-1..P2-3 — duplicate, copy / paste, Repeat down, multi-select, arrange,
// snap toggles and redo in the shared editor, as both hosts get them (jsdom: no layout; where a
// gesture needs geometry the page is given a 612 × 792 px rect, so 1px = 1pt).

const LETTER = { width: 612, height: 792 };
const DOCS = [{ id: 'd1', title: 'Contract', pages: [LETTER, LETTER] }];
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

// The console's id rule (fixed-form-model nextFieldKey): <type>_<n>, the next free n.
const consoleId = (type: string, fields: readonly PlacedField[]): string => {
  const taken = new Set(fields.map((f) => f.id));
  let i = 1;
  while (taken.has(`${type.toLowerCase()}_${i}`)) i += 1;
  return `${type.toLowerCase()}_${i}`;
};

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
    capabilities: { settings: ['label', 'group_key', 'group_rule', 'min_selected', 'name_mode'], limits: { groupKeyMax: 64 } },
    newFieldId: consoleId,
    pageWidth: 612,
    ...over,
  };
  const utils = render(<PlacementEditor {...props} />);
  const last = (): readonly PlacedField[] => (onChange.mock.calls.at(-1)?.[0] as readonly PlacedField[]) ?? [];
  return { ...utils, onChange, last, props };
}

const announce = () => screen.getByTestId('fpe-announce');
const shiftClick = (id: string) => fireEvent.pointerDown(screen.getByTestId(`fpe-field-${id}`), { shiftKey: true });

describe('P2-2 multi-select and arrange', () => {
  it('shift-click builds a selection; the inspector arranges it; each arrange is one undo step; redo by button and Shift+Ctrl+Z', () => {
    const { last } = setup({ fields: [field('a', { x: 100 }), field('b', { x: 200, y: 400, width: 60 }), field('c', { x: 40, y: 300, width: 80 })] });
    fireEvent.focus(screen.getByTestId('fpe-field-a'));
    shiftClick('b');
    shiftClick('c');
    expect(screen.getByTestId('fpe-selection-count')).toHaveTextContent('3 fields selected');
    expect(announce()).toHaveTextContent('3 fields selected');
    fireEvent.click(screen.getByTestId('fpe-align-left'));
    expect(last().map((f) => f.x)).toEqual([40, 40, 40]);
    expect(announce()).toHaveTextContent('3 fields aligned left.');
    fireEvent.click(screen.getByTestId('fpe-undo'));
    expect(last().map((f) => f.x)).toEqual([100, 200, 40]);
    fireEvent.click(screen.getByTestId('fpe-redo'));
    expect(last().map((f) => f.x)).toEqual([40, 40, 40]);
    expect(announce()).toHaveTextContent('Redone: Align left.');
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(last().map((f) => f.x)).toEqual([40, 40, 40]);
    // Same width copies the first selected (a: 230).
    fireEvent.click(screen.getByTestId('fpe-same-width'));
    expect(last().map((f) => f.width)).toEqual([230, 230, 230]);
    fireEvent.click(screen.getByTestId('fpe-distribute-vertical'));
    expect(announce()).toHaveTextContent('3 fields distributed vertically.');
    // Shift-click again removes one.
    shiftClick('c');
    expect(screen.getByTestId('fpe-selection-count')).toHaveTextContent('2 fields selected');
    expect(screen.getByTestId('fpe-distribute-vertical')).toBeDisabled();
  });

  it('arrows move, Delete deletes and the select reassigns the whole selection', () => {
    const { last } = setup({ fields: [field('a', { x: 100 }), field('b', { x: 300 }), field('c', { x: 10 })] });
    fireEvent.focus(screen.getByTestId('fpe-field-a'));
    fireEvent.keyDown(screen.getByTestId('fpe-field-b'), { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(screen.getByTestId('fpe-field-a'), { key: 'ArrowRight', shiftKey: true });
    expect(last().map((f) => f.x)).toEqual([110, 310, 10]);
    fireEvent.change(screen.getByTestId('fpe-multi-assignee'), { target: { value: 'role:s2' } });
    expect(last().map((f) => f.assignee)).toEqual(['s2', 's2', 's1']);
    expect(announce()).toHaveTextContent('2 fields now for Bo Diddley.');
    fireEvent.keyDown(screen.getByTestId('fpe-field-b'), { key: 'Delete' });
    expect(last().map((f) => f.id)).toEqual(['c']);
    expect(announce()).toHaveTextContent('2 fields deleted.');
    fireEvent.click(screen.getByTestId('fpe-undo'));
    expect(last()).toHaveLength(3);
  });

  it('drag-a-box on the page selects the fields it touches (Shift adds); Ctrl+A selects the page', () => {
    setup({ fields: [field('a', { x: 100, y: 700, width: 50, height: 20 }), field('b', { x: 300, y: 700, width: 50, height: 20 }), field('c', { x: 100, y: 100, width: 50, height: 20 }), field('p2', { page: 1 })] });
    const page = screen.getByTestId('fpe-page-0');
    page.getBoundingClientRect = () => ({ left: 0, top: 0, right: 612, bottom: 792, width: 612, height: 792, x: 0, y: 0, toJSON: () => ({}) });
    // a and b sit 72..92 from the top; the box from (90, 60) to (400, 100) touches both.
    fireEvent.pointerDown(page, { clientX: 90, clientY: 60 });
    fireEvent.pointerMove(page, { clientX: 200, clientY: 80 });
    expect(screen.getByTestId('fpe-marquee')).toBeInTheDocument();
    fireEvent.pointerMove(page, { clientX: 400, clientY: 100 });
    fireEvent.pointerUp(page, { clientX: 400, clientY: 100 });
    expect(screen.queryByTestId('fpe-marquee')).toBeNull();
    expect(screen.getByTestId('fpe-selection-count')).toHaveTextContent('2 fields selected');
    expect(screen.getByTestId('fpe-field-a')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('fpe-field-c')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(screen.getByTestId('fpe-field-a'), { key: 'a', ctrlKey: true });
    expect(screen.getByTestId('fpe-selection-count')).toHaveTextContent('3 fields selected');
    expect(screen.getByTestId('fpe-field-p2')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('P2-1 duplicate, copy / paste, Repeat down', () => {
  it('Ctrl+D duplicates the selection 10pt right and down with new ids, as one undo step', () => {
    const { last } = setup({ fields: [field('text_1'), field('checkbox_1', { type: 'CHECKBOX', width: 18, height: 18, settings: { ...DEFAULT_SETTINGS, groupKey: 'g' } })] });
    fireEvent.focus(screen.getByTestId('fpe-field-text_1'));
    shiftClick('checkbox_1');
    fireEvent.keyDown(screen.getByTestId('fpe-field-text_1'), { key: 'd', ctrlKey: true });
    expect(last().map((f) => f.id)).toEqual(['text_1', 'checkbox_1', 'text_2', 'checkbox_2']);
    expect(last()[2]).toMatchObject({ x: 110, y: 490, assignee: 's1' });
    expect(last()[3]!.settings.groupKey).toBe('g');
    expect(announce()).toHaveTextContent('2 fields duplicated.');
    // The copies are selected and focused.
    expect(document.activeElement).toBe(screen.getByTestId('fpe-field-text_2'));
    expect(screen.getByTestId('fpe-selection-count')).toHaveTextContent('2 fields selected');
    fireEvent.click(screen.getByTestId('fpe-undo'));
    expect(last()).toHaveLength(2);
  });

  it('a locked field cannot be duplicated (the P1-5 rule)', () => {
    const { onChange } = setup({ fields: [field('ack', { type: 'ACKNOWLEDGEMENT', locked: true })] });
    fireEvent.focus(screen.getByTestId('fpe-field-ack'));
    expect(screen.queryByTestId('fpe-duplicate')).toBeNull();
    fireEvent.keyDown(screen.getByTestId('fpe-field-ack'), { key: 'd', metaKey: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(announce()).toHaveTextContent('Locked fields can’t be duplicated.');
  });

  it('copy, then paste onto another page at the same position (Ctrl+V and the toolbar button)', () => {
    const { last } = setup({ fields: [field('text_1', { x: 120, y: 333 })] });
    expect(screen.getByTestId('fpe-paste')).toBeDisabled();
    fireEvent.focus(screen.getByTestId('fpe-field-text_1'));
    fireEvent.click(screen.getByTestId('fpe-copy'));
    expect(announce()).toHaveTextContent('1 field copied.');
    // Choose page 2 as the target (the page list), then paste.
    fireEvent.click(screen.getAllByRole('button', { name: /Contract\s*2/ })[0]!);
    fireEvent.click(screen.getByTestId('fpe-paste'));
    expect(last()[1]).toMatchObject({ id: 'text_2', page: 1, x: 120, y: 333 });
    expect(announce()).toHaveTextContent('1 field pasted on page 2.');
    // Back on page 1, a paste steps 10pt right and down so copies never stack.
    fireEvent.click(screen.getAllByRole('button', { name: /Contract\s*1/ })[0]!);
    fireEvent.keyDown(screen.getByTestId('fpe-field-text_1'), { key: 'v', ctrlKey: true });
    expect(last()[2]).toMatchObject({ id: 'text_3', page: 0, x: 130, y: 323 });
  });

  it('Repeat down: one attendee row nine times (one undo step), announced; groups per row', () => {
    const row = [field('text_1', { x: 72, y: 600, width: 200, height: 20 }), field('checkbox_1', { type: 'CHECKBOX', x: 300, y: 601, width: 18, height: 18, settings: { ...DEFAULT_SETTINGS, groupKey: 'present' } })];
    const { last } = setup({ fields: row });
    fireEvent.focus(screen.getByTestId('fpe-field-text_1'));
    shiftClick('checkbox_1');
    // Suggested distance: the row's height (20) + 6.
    expect(screen.getByTestId('fpe-repeat-pitch')).toHaveValue(26);
    fireEvent.change(screen.getByTestId('fpe-repeat-count'), { target: { value: '9' } });
    fireEvent.change(screen.getByTestId('fpe-repeat-pitch'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('fpe-repeat'));
    expect(last()).toHaveLength(20);
    expect(announce()).toHaveTextContent('9 rows added.');
    const texts = last().filter((f) => f.type === 'TEXT');
    expect(texts.map((f) => f.y)).toEqual([600, 570, 540, 510, 480, 450, 420, 390, 360, 330]);
    expect(new Set(last().filter((f) => f.type === 'CHECKBOX').map((f) => f.settings.groupKey)).size).toBe(10);
    // Only the last new row is selected (so Repeat down again continues the column).
    expect(screen.getByTestId('fpe-selection-count')).toHaveTextContent('2 fields selected');
    fireEvent.click(screen.getByTestId('fpe-undo'));
    expect(last()).toHaveLength(2);
    expect(announce()).toHaveTextContent('Undone: Repeat down 9 rows.');
  });

  it('Repeat down twice continues the column at the same spacing (it does not double)', () => {
    const { last } = setup({ fields: [field('t', { x: 72, y: 600, width: 200, height: 20 })] });
    fireEvent.focus(screen.getByTestId('fpe-field-t'));
    fireEvent.change(screen.getByTestId('fpe-repeat-count'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('fpe-repeat'));
    expect(last().map((f) => f.y)).toEqual([600, 574, 548]);
    // Only the last new row is selected.
    expect(screen.getByTestId(`fpe-field-${last()[2]!.id}`)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId(`fpe-field-${last()[1]!.id}`)).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('fpe-field-t')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('fpe-repeat-pitch')).toHaveValue(26);
    fireEvent.click(screen.getByTestId('fpe-repeat'));
    expect(last().map((f) => f.y)).toEqual([600, 574, 548, 522, 496]);
  });

  it('a typed row spacing is kept for the next Repeat down', () => {
    const { last } = setup({ fields: [field('t', { x: 72, y: 600, width: 200, height: 20 })] });
    fireEvent.focus(screen.getByTestId('fpe-field-t'));
    fireEvent.change(screen.getByTestId('fpe-repeat-pitch'), { target: { value: '40' } });
    fireEvent.click(screen.getByTestId('fpe-repeat'));
    expect(screen.getByTestId('fpe-repeat-pitch')).toHaveValue(40);
    fireEvent.click(screen.getByTestId('fpe-repeat'));
    expect(last().map((f) => f.y)).toEqual([600, 560, 520]);
  });

  it('the Copies box can be cleared and retyped (an empty box is not snapped back to 1)', () => {
    const { last } = setup({ fields: [field('t', { x: 72, y: 600, width: 200, height: 20 })] });
    fireEvent.focus(screen.getByTestId('fpe-field-t'));
    const count = screen.getByTestId('fpe-repeat-count');
    fireEvent.change(count, { target: { value: '' } });
    expect(count).toHaveValue(null);
    // Repeat down with the box empty adds nothing and says why.
    fireEvent.click(screen.getByTestId('fpe-repeat'));
    expect(announce()).toHaveTextContent('Enter how many copies to add (1 to 50).');
    fireEvent.change(count, { target: { value: '5' } });
    expect(count).toHaveValue(5);
    fireEvent.click(screen.getByTestId('fpe-repeat'));
    expect(last()).toHaveLength(6);
    // Leaving the box empty puts back 1.
    fireEvent.change(count, { target: { value: '' } });
    fireEvent.blur(count);
    expect(count).toHaveValue(1);
  });

  it('the Row spacing box can be cleared; left empty it goes back to the suggested spacing', () => {
    setup({ fields: [field('t', { x: 72, y: 600, width: 200, height: 20 })] });
    fireEvent.focus(screen.getByTestId('fpe-field-t'));
    const pitch = screen.getByTestId('fpe-repeat-pitch');
    fireEvent.change(pitch, { target: { value: '' } });
    expect(pitch).toHaveValue(null);
    fireEvent.blur(pitch);
    expect(pitch).toHaveValue(26);
  });

  it('Repeat down near the bottom adds what fits and says how many did not', () => {
    setup({ fields: [field('t', { y: 60 })] });
    fireEvent.focus(screen.getByTestId('fpe-field-t'));
    fireEvent.change(screen.getByTestId('fpe-repeat-count'), { target: { value: '9' } });
    fireEvent.change(screen.getByTestId('fpe-repeat-pitch'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('fpe-repeat'));
    expect(announce()).toHaveTextContent('2 rows added. 7 rows did not fit on the page.');
  });
});

describe('P2-3 snap, grid and the keymap', () => {
  it('Snap is on and Grid off by default; Grid draws the grid on every page; the keymap is listed', () => {
    setup({ fields: [field('a')] });
    expect(screen.getByTestId('fpe-snap')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('fpe-grid')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('fpe-grid-0')).toBeNull();
    fireEvent.click(screen.getByTestId('fpe-grid'));
    expect(screen.getByTestId('fpe-grid-0')).toBeInTheDocument();
    expect(screen.getByTestId('fpe-grid-1')).toBeInTheDocument();
    expect(screen.getByTestId('fpe-keymap')).toHaveTextContent('Cmd/Ctrl+D');
    expect(screen.getByTestId('fpe-keymap')).toHaveTextContent('Shift while dragging');
  });

  it('a drag snaps to another field’s edge and shows a guide; Shift turns snapping off', () => {
    const { last } = setup({ fields: [field('a', { x: 100, y: 500 }), field('t', { x: 50, y: 300 })] });
    const page = screen.getByTestId('fpe-page-0');
    page.getBoundingClientRect = () => ({ left: 0, top: 0, right: 612, bottom: 792, width: 612, height: 792, x: 0, y: 0, toJSON: () => ({}) });
    const a = screen.getByTestId('fpe-field-a');
    fireEvent.pointerDown(a, { clientX: 200, clientY: 300 });
    fireEvent.pointerMove(a, { clientX: 153, clientY: 150 });
    expect(screen.getAllByTestId('fpe-guide-v').length).toBeGreaterThan(0);
    fireEvent.pointerUp(a);
    expect(last()[0]).toMatchObject({ x: 50 });
    expect(screen.queryByTestId('fpe-guide-v')).toBeNull();
    fireEvent.pointerDown(a, { clientX: 200, clientY: 300 });
    fireEvent.pointerMove(a, { clientX: 203, clientY: 300, shiftKey: true });
    fireEvent.pointerUp(a);
    expect(last()[0]).toMatchObject({ x: 53 });
  });
});
