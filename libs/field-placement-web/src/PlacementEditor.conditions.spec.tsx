import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PlacementEditor, type PlacementEditorProps } from './PlacementEditor';
import { DEFAULT_SETTINGS, type PlacedField, type PlacementSettings } from './lib/model';

// FIELD-PARITY-2 B-7 — "Show only when…" in the shared editor (sign-web Prepare and the console
// Studio): pick the trigger from the list or on the page, pick the rule, the link line, dependent
// fields dimmed until the preview answers show them, the shared rule's refusal inline, and a
// deleted trigger clearing its dependents with a warning (undoable). A host that does not list
// 'condition' (self-sign) shows none of it.

const DOCS = [{ id: 'd1', title: 'Contract', pages: [{ width: 612, height: 792 }, { width: 612, height: 792 }] }];
const SETTINGS = ['label', 'options', 'group_key', 'group_rule', 'min_selected', 'condition'] as const;

function f(id: string, type: string, over: Partial<Omit<PlacedField, 'settings'>> & { settings?: Partial<PlacementSettings> } = {}): PlacedField {
  const { settings, ...rest } = over;
  return { id, type, docId: 'd1', page: 0, x: 50, y: 600, width: 100, height: 20, required: false, assignee: 's1', binding: null, settings: { ...DEFAULT_SETTINGS, ...settings }, ...rest };
}

const FIELDS: PlacedField[] = [
  f('sig', 'SIGNATURE', { y: 100 }),
  f('agree', 'CHECKBOX', { y: 700, settings: { label: 'Co-applicant' } }),
  f('co', 'TEXT', { y: 650 }),
  f('plan', 'DROPDOWN', { y: 500, settings: { options: { choices: [{ value: 'basic', label: 'Basic' }, { value: 'pro', label: 'Pro' }] } } }),
  f('theirs', 'CHECKBOX', { y: 400, assignee: 's2' }),
];

function setup(over: Partial<PlacementEditorProps> = {}) {
  const onChange = vi.fn();
  const props: PlacementEditorProps = {
    documents: DOCS,
    renderPage: async () => undefined,
    surface: 'send_web',
    fields: FIELDS,
    resetKey: 'k',
    onChange,
    assignees: [
      { id: 's1', label: 'Ada Lovelace' },
      { id: 's2', label: 'Grace Hopper' },
    ],
    capabilities: { settings: SETTINGS },
    newFieldId: () => 'new1',
    ...over,
  };
  render(<PlacementEditor {...props} />);
  const last = (): readonly PlacedField[] => (onChange.mock.calls.at(-1)?.[0] as readonly PlacedField[]) ?? FIELDS;
  const byId = (id: string) => last().find((x) => x.id === id)!;
  return { onChange, last, byId };
}

const selectField = (id: string) => fireEvent.pointerDown(screen.getByTestId(`fpe-field-${id}`));
const optionTexts = (el: HTMLElement) => within(el).getAllByRole('option').map((o) => o.textContent);

describe('PlacementEditor — Show only when… (B-7)', () => {
  it('lists only valid triggers (same signer, a trigger type) and sets the condition with its rule', () => {
    const { byId } = setup();
    selectField('co');
    const trigger = screen.getByTestId('fpe-condition-trigger');
    expect(optionTexts(trigger)).toEqual(['Always', 'When Checkbox “Co-applicant” · page 1', 'When Dropdown · page 1']);
    fireEvent.change(trigger, { target: { value: 'agree' } });
    expect(byId('co').settings.condition).toEqual({ trigger_key: 'agree', when: 'checked' });
    fireEvent.change(screen.getByTestId('fpe-condition-rule'), { target: { value: 'unchecked' } });
    expect(byId('co').settings.condition).toEqual({ trigger_key: 'agree', when: 'unchecked' });
    // A dropdown trigger: one of its choices (at least one stays ticked).
    fireEvent.change(screen.getByTestId('fpe-condition-trigger'), { target: { value: 'plan' } });
    expect(byId('co').settings.condition).toEqual({ trigger_key: 'plan', when: 'one_of', values: ['basic'] });
    fireEvent.click(screen.getByTestId('fpe-condition-value-1'));
    expect(byId('co').settings.condition).toEqual({ trigger_key: 'plan', when: 'one_of', values: ['basic', 'pro'] });
    expect(screen.getByTestId('fpe-condition-value-0')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('fpe-condition-value-0'));
    expect(screen.getByTestId('fpe-condition-value-1')).toBeDisabled();
    fireEvent.change(screen.getByTestId('fpe-condition-trigger'), { target: { value: '' } });
    expect(byId('co').settings.condition).toBeNull();
  });

  it('picks the trigger by clicking it on the page; a field the rule refuses cancels', () => {
    const { byId } = setup();
    selectField('co');
    fireEvent.click(screen.getByTestId('fpe-condition-pick'));
    expect(screen.getByTestId('fpe-picking')).toBeInTheDocument();
    expect(screen.getByTestId('fpe-field-agree')).toHaveClass('is-pickable');
    expect(screen.getByTestId('fpe-field-theirs')).toHaveClass('is-unpickable');
    fireEvent.pointerDown(screen.getByTestId('fpe-field-theirs'));
    expect(screen.getByTestId('fpe-announce')).toHaveTextContent('can’t show or hide this one');
    expect(byId('co').settings.condition).toBeNull();
    fireEvent.click(screen.getByTestId('fpe-condition-pick'));
    fireEvent.pointerDown(screen.getByTestId('fpe-field-agree'));
    expect(byId('co').settings.condition).toEqual({ trigger_key: 'agree', when: 'checked' });
    expect(screen.queryByTestId('fpe-picking')).toBeNull();
    // The dependent stays selected, and the link line joins it to its trigger.
    expect(screen.getByTestId('fpe-inspector')).toBeInTheDocument();
    expect(screen.getByTestId('fpe-link-co')).toBeInTheDocument();
  });

  it('a dependent is dimmed until the preview answers show it', () => {
    setup({ fields: [FIELDS[0]!, FIELDS[1]!, f('co', 'TEXT', { y: 650, settings: { condition: { trigger_key: 'agree', when: 'checked' } } })] });
    expect(screen.getByTestId('fpe-field-co')).toHaveAttribute('data-dimmed', 'true');
    fireEvent.click(screen.getByTestId('fpe-preview'));
    // In preview, a click on the check box answers it (nothing is saved).
    fireEvent.pointerDown(screen.getByTestId('fpe-field-agree'));
    expect(screen.getByTestId('fpe-field-co')).not.toHaveAttribute('data-dimmed');
    expect(screen.getByTestId('fpe-preview-answer')).toBeChecked();
    fireEvent.click(screen.getByTestId('fpe-preview-answer'));
    expect(screen.getByTestId('fpe-field-co')).toHaveAttribute('data-dimmed', 'true');
    // Leaving preview clears the answers.
    fireEvent.click(screen.getByTestId('fpe-preview'));
    expect(screen.getByTestId('fpe-field-co')).toHaveAttribute('data-dimmed', 'true');
  });

  // Field test 2026-11-25 — "Preview answers" showed no change: it now explains itself on screen,
  // and is offered only when a field has a "Show only when" condition.
  it('Preview answers shows a note on screen while it is on', () => {
    setup({ fields: [FIELDS[0]!, FIELDS[1]!, f('co', 'TEXT', { y: 650, settings: { condition: { trigger_key: 'agree', when: 'checked' } } })] });
    expect(screen.queryByTestId('fpe-preview-note')).toBeNull();
    fireEvent.click(screen.getByTestId('fpe-preview'));
    expect(screen.getByTestId('fpe-preview-note')).toHaveTextContent('Nothing is saved');
    fireEvent.click(screen.getByTestId('fpe-preview'));
    expect(screen.queryByTestId('fpe-preview-note')).toBeNull();
  });

  it('Preview answers is not offered when no field has a condition', () => {
    setup({ fields: [FIELDS[0]!, FIELDS[1]!] });
    expect(screen.queryByTestId('fpe-preview')).toBeNull();
  });

  it('shows the shared rule’s refusal inline (a trigger of another signer)', () => {
    setup({ fields: [...FIELDS.slice(0, 2), f('co', 'TEXT', { y: 650, settings: { condition: { trigger_key: 'theirs', when: 'checked' } } }), FIELDS[4]!] });
    selectField('co');
    expect(screen.getByTestId('fpe-condition-issue')).toHaveTextContent('belongs to another signer');
    expect(optionTexts(screen.getByTestId('fpe-condition-trigger'))[1]).toMatch(/can’t be used/);
  });

  it('deleting a trigger clears its dependents with a warning; Undo brings both back', () => {
    const fields = [FIELDS[0]!, FIELDS[1]!, f('co', 'TEXT', { y: 650, settings: { condition: { trigger_key: 'agree', when: 'checked' } } })];
    const { last, byId } = setup({ fields });
    selectField('agree');
    expect(screen.getByTestId('fpe-condition-dependents')).toHaveTextContent('Shows or hides: Text · page 1');
    fireEvent.click(screen.getByTestId('fpe-delete'));
    expect(last().map((x) => x.id)).toEqual(['sig', 'co']);
    expect(byId('co').settings.condition).toBeNull();
    expect(screen.getByTestId('fpe-condition-notice')).toHaveTextContent('1 field that showed only for an answer to it is now always shown');
    fireEvent.click(screen.getByTestId('fpe-undo'));
    expect(byId('co').settings.condition).toEqual({ trigger_key: 'agree', when: 'checked' });
    expect(last().map((x) => x.id)).toEqual(['sig', 'agree', 'co']);
  });

  it('a host without the condition setting (self-sign) offers none of it', () => {
    setup({ capabilities: { settings: SETTINGS.filter((s) => s !== 'condition') } });
    selectField('co');
    expect(screen.queryByTestId('fpe-condition')).toBeNull();
    expect(screen.queryByTestId('fpe-preview')).toBeNull();
  });

  it('names a trigger on another page in the inspector', () => {
    setup({ fields: [FIELDS[0]!, f('agree', 'CHECKBOX', { page: 1 }), f('co', 'TEXT', { settings: { condition: { trigger_key: 'agree', when: 'checked' } } })] });
    selectField('co');
    expect(screen.getByTestId('fpe-condition-elsewhere')).toHaveTextContent('Its trigger is on another page: Checkbox · page 2.');
    expect(screen.queryByTestId('fpe-link-co')).toBeNull();
  });
});
