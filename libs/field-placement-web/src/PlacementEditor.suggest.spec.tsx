import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PlacementEditor, type PlacementEditorProps } from './PlacementEditor';
import { fieldsFromSuggestions, pendingGhosts, suggestionsFromWire, type PlacementSuggestion } from './lib/suggestions';
import { DEFAULT_SETTINGS, type PlacedField } from './lib/model';

// FIELD-PARITY-1 §5 P2-4 — Suggestions in the shared editor, as both hosts get them: find, the
// ghosts (palette types only), accept one (click / Enter), accept all on a page or everywhere as
// ONE undo step, dismiss one (Delete / ×) or all, the assignee, read-only.

const LETTER = { width: 612, height: 792 };
const DOCS = [{ id: 'd1', title: 'Contract', pages: [LETTER, LETTER] }];
const sug = (id: string, over: Partial<PlacementSuggestion> = {}): PlacementSuggestion => ({ id, type: 'TEXT', docId: 'd1', page: 0, x: 100, y: 500, width: 200, height: 22, reason: 'underscore_line', ...over });
const SUGGESTIONS = [
  sug('a', { type: 'SIGNATURE', x: 72, y: 100, width: 230, height: 50, reason: 'label:Signature' }),
  // FIELD-PARITY-1 P3 — TITLE is now on the fixed-form palette; PAYMENT never is (P1-6).
  sug('b', { type: 'PAYMENT', x: 72, y: 300, reason: 'label:Title' }),
  sug('c', { type: 'CHECKBOX', x: 72, y: 400, width: 12, height: 12, reason: 'checkbox_glyph' }),
  sug('d', { page: 1, x: 72, y: 600, reason: 'empty_cell' }),
];

let seq = 0;
const nextId = (type: string) => `${type.toLowerCase()}_${(seq += 1)}`;

function setup(over: Partial<PlacementEditorProps> = {}) {
  const onChange = vi.fn();
  const loadSuggestions = vi.fn(async () => SUGGESTIONS);
  const props: PlacementEditorProps = {
    documents: DOCS,
    renderPage: async () => undefined,
    surface: 'template_fixed_form',
    fields: [],
    resetKey: 'k',
    onChange,
    assignees: [
      { id: 's1', label: 'Ada Lovelace' },
      { id: 's2', label: 'Bo Diddley' },
    ],
    capabilities: { settings: [] },
    newFieldId: nextId,
    pageWidth: 612,
    loadSuggestions,
    ...over,
  };
  const utils = render(<PlacementEditor {...props} />);
  const last = (): readonly PlacedField[] => (onChange.mock.calls.at(-1)?.[0] as readonly PlacedField[]) ?? [];
  return { ...utils, onChange, last, loadSuggestions };
}

const find = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('fpe-find-fields'));
  });
};
const ghost = (id: string) => screen.queryByTestId(`fpe-ghost-${id}`);
const announce = () => screen.getByTestId('fpe-announce');

describe('P2-4 suggestions in the shared editor', () => {
  it('Find fields shows the palette types as ghosts (PAYMENT is not on the fixed-form palette)', async () => {
    const { loadSuggestions } = setup();
    expect(ghost('a')).toBeNull();
    await find();
    expect(loadSuggestions).toHaveBeenCalledTimes(1);
    expect(ghost('a')).not.toBeNull();
    expect(ghost('b')).toBeNull();
    expect(ghost('c')).not.toBeNull();
    expect(ghost('d')).not.toBeNull();
    expect(screen.getByTestId('fpe-suggestions-count')).toHaveTextContent('3 suggested fields');
    expect(announce()).toHaveTextContent('3 suggested fields shown as dashed boxes');
    expect(ghost('a')).toHaveAttribute('aria-label', expect.stringContaining('Suggested signature field next to the label “Signature”, page 1'));
  });

  it('a click accepts one: an ordinary field at the box, for the active assignee, with the catalog required default; undo brings the ghost back', async () => {
    const { last } = setup();
    await find();
    fireEvent.click(screen.getByTestId('fpe-assignee-s2'));
    fireEvent.click(ghost('a')!);
    expect(last()).toHaveLength(1);
    expect(last()[0]).toMatchObject({ type: 'SIGNATURE', docId: 'd1', page: 0, x: 72, y: 100, width: 230, height: 50, required: true, assignee: 's2', binding: null });
    expect(ghost('a')).toBeNull();
    expect(announce()).toHaveTextContent('Suggestion accepted: 1 field added for Bo Diddley.');
    fireEvent.click(screen.getByTestId('fpe-undo'));
    expect(last()).toHaveLength(0);
    expect(ghost('a')).not.toBeNull();
  });

  it('Enter accepts and Delete dismisses a focused ghost; × dismisses too', async () => {
    const { last } = setup();
    await find();
    fireEvent.keyDown(ghost('c')!, { key: 'Enter' });
    expect(last().map((f) => f.type)).toEqual(['CHECKBOX']);
    fireEvent.keyDown(ghost('a')!, { key: 'Delete' });
    expect(ghost('a')).toBeNull();
    expect(announce()).toHaveTextContent('Suggestion dismissed.');
    fireEvent.click(screen.getByTestId('fpe-ghost-dismiss-d'));
    expect(ghost('d')).toBeNull();
    // Dismissing changes no field.
    expect(last()).toHaveLength(1);
  });

  it('Accept all is ONE undo step; Accept all on this page takes only that page', async () => {
    const { last } = setup();
    await find();
    fireEvent.click(screen.getByTestId('fpe-accept-page'));
    expect(last().map((f) => f.type)).toEqual(['SIGNATURE', 'CHECKBOX']);
    expect(ghost('d')).not.toBeNull();
    fireEvent.click(screen.getByTestId('fpe-undo'));
    expect(last()).toHaveLength(0);
    fireEvent.click(screen.getByTestId('fpe-accept-all'));
    expect(last().map((f) => [f.type, f.page])).toEqual([
      ['SIGNATURE', 0],
      ['CHECKBOX', 0],
      ['TEXT', 1],
    ]);
    expect(announce()).toHaveTextContent('Accepted every suggestion: 3 fields added for Ada Lovelace.');
    expect(screen.getByTestId('fpe-suggestions-none')).toHaveTextContent('No suggestions left.');
    // One undo removes all three.
    fireEvent.click(screen.getByTestId('fpe-undo'));
    expect(last()).toHaveLength(0);
    expect(ghost('a')).not.toBeNull();
  });

  it('Dismiss all clears the ghosts; Find fields again brings them back', async () => {
    const { loadSuggestions } = setup();
    await find();
    fireEvent.click(screen.getByTestId('fpe-dismiss-all'));
    expect(ghost('a')).toBeNull();
    expect(announce()).toHaveTextContent('3 suggestions dismissed.');
    await find();
    expect(loadSuggestions).toHaveBeenCalledTimes(2);
    expect(ghost('a')).not.toBeNull();
  });

  it('a suggestion already covered by a field is not offered; a failed load says so', async () => {
    const covering: PlacedField = { id: 'x', type: 'SIGNATURE', docId: 'd1', page: 0, x: 74, y: 102, width: 230, height: 50, required: true, assignee: 's1', binding: null, settings: DEFAULT_SETTINGS };
    setup({ fields: [covering] });
    await find();
    expect(ghost('a')).toBeNull();
    expect(ghost('c')).not.toBeNull();
  });

  it('a load failure is announced and shows nothing', async () => {
    setup({ loadSuggestions: async () => Promise.reject(new Error('down')) });
    await find();
    expect(announce()).toHaveTextContent('Suggestions are not available right now.');
    expect(screen.getByTestId('fpe-suggestions-none')).toHaveTextContent('No fields found.');
  });

  it('read-only or without a source: no Suggestions section; a type off the palette is never offered', async () => {
    const { unmount } = setup({ readOnly: true });
    expect(screen.queryByTestId('fpe-suggestions')).toBeNull();
    unmount();
    const r2 = setup({ loadSuggestions: undefined });
    expect(screen.queryByTestId('fpe-suggestions')).toBeNull();
    r2.unmount();
    // PAYMENT (ghost b) is off the send palette too while payments are not available.
    setup({ surface: 'send_web' });
    await find();
    expect(ghost('a')).not.toBeNull();
    expect(ghost('b')).toBeNull();
  });

  it('without an assignee and none allowed, accepting is refused with a reason', async () => {
    const { last } = setup({ assignees: [] });
    await find();
    expect(screen.getByTestId('fpe-accept-all')).toBeDisabled();
    fireEvent.click(ghost('a')!);
    expect(last()).toHaveLength(0);
    expect(announce()).toHaveTextContent('Add someone to fill the fields first');
  });
});

describe('suggestions helpers', () => {
  it('suggestionsFromWire maps page_number and keeps ids unique per document', () => {
    const out = suggestionsFromWire('d2', [{ type: 'TEXT', page_number: 1, x: 1, y: 2, width: 3, height: 4, reason: 'empty_box' }, { type: 'CHECKBOX', page_number: 0, x: 1, y: 2, width: 9, height: 9 }]);
    expect(out).toEqual([
      { id: 'd2:0', type: 'TEXT', docId: 'd2', page: 1, x: 1, y: 2, width: 3, height: 4, reason: 'empty_box' },
      { id: 'd2:1', type: 'CHECKBOX', docId: 'd2', page: 0, x: 1, y: 2, width: 9, height: 9, reason: 'found' },
    ]);
  });

  it('fieldsFromSuggestions keeps each box on its page and gives sequential ids', () => {
    const pageSize = () => LETTER;
    const fields = fieldsFromSuggestions([sug('a', { x: 600, width: 100 }), sug('b', { type: 'UNKNOWN' }), sug('c')], { assignee: null, fields: [], newId: (t, fs) => `${t}_${fs.length + 1}`, pageSize });
    expect(fields.map((f) => [f.id, f.x, f.width])).toEqual([
      ['TEXT_1', 512, 100],
      ['TEXT_2', 100, 200],
    ]);
  });

  it('pendingGhosts drops a suggestion on a page the editor does not show', () => {
    const out = pendingGhosts([sug('a', { page: 5 }), sug('b')], [], { types: ['TEXT'], dismissed: new Set(), pageSize: (r) => (r.page < 2 ? LETTER : undefined) });
    expect(out.map((s) => s.id)).toEqual(['b']);
  });
});
