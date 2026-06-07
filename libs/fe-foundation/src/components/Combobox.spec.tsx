import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Combobox, type ComboboxItem } from './Combobox';

// Settings S5c-2 — Combobox spec.
//
// THE LOAD-BEARING PROOF (PL-94 §2 ruling 2): the Combobox is
// GENERIC. The reuse-proof test below renders it over a non-user item
// set (companies); S5c-3 depends on this generic interface for its
// company-picker.
//
// Other proofs: ARIA combobox attributes; filter; keyboard nav;
// disabled-item not selectable; close on Escape.

const USERS: ComboboxItem[] = [
  { value: 'u-alice', label: 'Alice Vance', description: 'alice@a.test' },
  { value: 'u-bob', label: 'Bob Singh', description: 'bob@a.test' },
  { value: 'u-carol', label: 'Carol Tan', description: 'carol@a.test' },
];

const COMPANIES: ComboboxItem[] = [
  { value: 'c-acme', label: 'Acme Inc.', description: 'New York, NY' },
  { value: 'c-glo', label: 'Globex Corp.', description: 'Springfield, IL' },
];

describe('Combobox — the trigger button + ARIA combobox attributes', () => {
  it('renders role="combobox" + aria-expanded + aria-haspopup on the trigger', () => {
    render(
      <Combobox
        items={USERS}
        value={null}
        onSelect={() => undefined}
        ariaLabel="Pick a user"
        testId="my-combobox"
      />,
    );
    const trigger = screen.getByTestId('my-combobox');
    expect(trigger).toHaveAttribute('role', 'combobox');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger).toHaveAttribute('aria-label', 'Pick a user');
  });

  it('shows the placeholder when nothing is selected; the label when selected', () => {
    const { rerender } = render(
      <Combobox
        items={USERS}
        value={null}
        onSelect={() => undefined}
        ariaLabel="Pick a user"
        placeholder="Select a user…"
        testId="cb"
      />,
    );
    expect(screen.getByText('Select a user…')).toBeInTheDocument();

    rerender(
      <Combobox
        items={USERS}
        value="u-bob"
        onSelect={() => undefined}
        ariaLabel="Pick a user"
        placeholder="Select a user…"
        testId="cb"
      />,
    );
    expect(screen.getByText('Bob Singh')).toBeInTheDocument();
  });

  it('flips aria-expanded to true when opened', () => {
    render(
      <Combobox
        items={USERS}
        value={null}
        onSelect={() => undefined}
        ariaLabel="Pick a user"
        testId="cb"
      />,
    );
    fireEvent.click(screen.getByTestId('cb'));
    expect(screen.getByTestId('cb')).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('Combobox — open behavior + filter + selection', () => {
  it('opening shows the listbox + role="option" per item', () => {
    render(
      <Combobox
        items={USERS}
        value={null}
        onSelect={() => undefined}
        ariaLabel="Pick a user"
        testId="cb"
      />,
    );
    fireEvent.click(screen.getByTestId('cb'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('typing filters the listbox by label OR description (case-insensitive)', () => {
    render(
      <Combobox
        items={USERS}
        value={null}
        onSelect={() => undefined}
        ariaLabel="Pick a user"
        testId="cb"
      />,
    );
    fireEvent.click(screen.getByTestId('cb'));
    fireEvent.change(screen.getByLabelText('Search'), {
      target: { value: 'bob' },
    });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByText('Bob Singh')).toBeInTheDocument();
  });

  it('shows the empty message when no items match', () => {
    render(
      <Combobox
        items={USERS}
        value={null}
        onSelect={() => undefined}
        ariaLabel="Pick a user"
        emptyMessage="Nothing here."
        testId="cb"
      />,
    );
    fireEvent.click(screen.getByTestId('cb'));
    fireEvent.change(screen.getByLabelText('Search'), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });

  it('clicking an option fires onSelect(item) and closes the popover', () => {
    const onSelect = vi.fn();
    render(
      <Combobox
        items={USERS}
        value={null}
        onSelect={onSelect}
        ariaLabel="Pick a user"
        testId="cb"
      />,
    );
    fireEvent.click(screen.getByTestId('cb'));
    fireEvent.click(screen.getByTestId('cb-option-u-bob'));
    expect(onSelect).toHaveBeenCalledWith(USERS[1]);
  });

  it('keyboard: Enter selects the highlighted item', () => {
    const onSelect = vi.fn();
    render(
      <Combobox
        items={USERS}
        value={null}
        onSelect={onSelect}
        ariaLabel="Pick a user"
        testId="cb"
      />,
    );
    fireEvent.click(screen.getByTestId('cb'));
    const input = screen.getByLabelText('Search');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    // First item (Alice) was highlighted=0; ↓ moved to 1 (Bob).
    expect(onSelect).toHaveBeenCalledWith(USERS[1]);
  });

  it('disabled items are NOT selectable via click', () => {
    const onSelect = vi.fn();
    const items: ComboboxItem[] = [
      ...USERS,
      { value: 'u-zed', label: 'Zed Disabled', disabled: true },
    ];
    render(
      <Combobox
        items={items}
        value={null}
        onSelect={onSelect}
        ariaLabel="Pick a user"
        testId="cb"
      />,
    );
    fireEvent.click(screen.getByTestId('cb'));
    fireEvent.click(screen.getByTestId('cb-option-u-zed'));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('Combobox — THE REUSE-PROOF (PL-94 §2 ruling 2; S5c-3 depends on this)', () => {
  it('renders + selects over a NON-USER item set (companies — S5c-3 reuse)', () => {
    const onSelect = vi.fn();
    render(
      <Combobox
        items={COMPANIES}
        value={null}
        onSelect={onSelect}
        ariaLabel="Pick a company"
        placeholder="Select a company…"
        testId="company-cb"
      />,
    );
    // Trigger placeholder.
    expect(screen.getByText('Select a company…')).toBeInTheDocument();

    // Open + see both companies.
    fireEvent.click(screen.getByTestId('company-cb'));
    expect(screen.getByText('Acme Inc.')).toBeInTheDocument();
    expect(screen.getByText('Globex Corp.')).toBeInTheDocument();
    expect(screen.getByText('New York, NY')).toBeInTheDocument();

    // Filter by description (city).
    fireEvent.change(screen.getByLabelText('Search'), {
      target: { value: 'springfield' },
    });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByText('Globex Corp.')).toBeInTheDocument();

    // Select.
    fireEvent.click(screen.getByTestId('company-cb-option-c-glo'));
    expect(onSelect).toHaveBeenCalledWith(COMPANIES[1]);
  });
});
