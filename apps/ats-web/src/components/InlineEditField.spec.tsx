import {
  fireEvent,
  render as rawRender,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@aramo/fe-foundation';

import {
  InlineChipInput,
  InlineEditField,
  InlineSelectField,
} from './InlineEditField';

// PR-A2 §4 P2 — the inline-edit primitive. Proves: read-only when !canEdit
// (no affordance), click-to-edit, Enter commits, Esc cancels, the house
// submitting/error machine (error keeps the editor open), and the chip/select
// variants.

function render(ui: ReactElement) {
  return rawRender(<ToastProvider>{ui}</ToastProvider>);
}

describe('InlineEditField', () => {
  it('canEdit=false → plain read-only display, no edit button', () => {
    render(
      <InlineEditField
        label="Title"
        value="Senior Engineer"
        canEdit={false}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText('Senior Engineer')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /edit title/i }),
    ).toBeNull();
  });

  it('empty value renders the em-dash placeholder', () => {
    render(
      <InlineEditField label="City" value={null} canEdit={false} onSave={vi.fn()} />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('canEdit=true → click reveals editor; Enter commits via onSave', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <InlineEditField label="Title" value="Old" canEdit onSave={onSave} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /edit title/i }));
    const input = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New Title' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('New Title'));
  });

  it('Esc cancels without calling onSave and restores the display', () => {
    const onSave = vi.fn();
    render(<InlineEditField label="Title" value="Old" canEdit onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /edit title/i }));
    const input = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Discard me' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Old')).toBeInTheDocument();
  });

  it('a no-op commit (unchanged value) closes without calling onSave', () => {
    const onSave = vi.fn();
    render(<InlineEditField label="Title" value="Same" canEdit onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /edit title/i }));
    const input = screen.getByLabelText('Title');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('clearing to empty saves null', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<InlineEditField label="City" value="NYC" canEdit onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /edit city/i }));
    const input = screen.getByLabelText('City');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });

  it('a 403 from onSave surfaces a permission error and KEEPS the editor open', async () => {
    const onSave = vi.fn().mockRejectedValue({ status: 403 });
    render(<InlineEditField label="Pay rate" value="50" canEdit onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /edit pay rate/i }));
    const input = screen.getByLabelText('Pay rate');
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(
        screen.getByText(/do not have permission to change this field/i),
      ).toBeInTheDocument(),
    );
    // Editor still open (value preserved).
    expect(screen.getByLabelText('Pay rate')).toBeInTheDocument();
  });
});

describe('InlineSelectField', () => {
  it('canEdit=false → read-only label, no select', () => {
    render(
      <InlineSelectField
        label="Status"
        value="active"
        canEdit={false}
        options={[{ value: 'active', label: 'Active' }]}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.queryByLabelText('Status')).toBeNull();
  });

  it('changing the select commits the new value', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <InlineSelectField
        label="Status"
        value="active"
        canEdit
        allowEmpty={false}
        options={[
          { value: 'active', label: 'active' },
          { value: 'closed', label: 'closed' },
        ]}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /edit status/i }));
    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'closed' },
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('closed'));
  });
});

describe('InlineChipInput', () => {
  it('canEdit=false → chips render read-only', () => {
    render(
      <InlineChipInput
        label="Required skills"
        values={['TypeScript', 'React']}
        canEdit={false}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText('TypeScript')).toBeInTheDocument();
    expect(screen.getByText('React')).toBeInTheDocument();
  });

  it('add a chip + Save commits the new list', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <InlineChipInput
        label="Required skills"
        values={['TypeScript']}
        canEdit
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /edit required skills/i }));
    const entry = screen.getByLabelText('Required skills new value');
    fireEvent.change(entry, { target: { value: 'Kafka' } });
    fireEvent.keyDown(entry, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(['TypeScript', 'Kafka']),
    );
  });
});
