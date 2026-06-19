import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DataTable, type TableColumn } from './DataTable';

interface Row {
  readonly id: string;
  readonly name: string;
  readonly city: string;
  readonly closed?: boolean;
}

const ROWS: readonly Row[] = [
  { id: '1', name: 'Marcus Adeyemi', city: 'Austin' },
  { id: '2', name: 'Sofia Ramos', city: 'Remote', closed: true },
];

// The primary cell carries a REAL focusable anchor — the keyboard/SR nav path.
const COLUMNS: ReadonlyArray<TableColumn<Row>> = [
  {
    key: 'name',
    header: 'Talent',
    render: (r) => <a href={`/talent/${r.id}`}>{r.name}</a>,
  },
  { key: 'city', header: 'Location', render: (r) => r.city },
];

describe('DataTable', () => {
  it('renders a real focusable link in the primary cell (a11y nav path)', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    const link = screen.getByRole('link', { name: 'Marcus Adeyemi' });
    expect(link).toHaveAttribute('href', '/talent/1');
  });

  it('fires onRowClick when a non-interactive part of the row is clicked', () => {
    const onRowClick = vi.fn();
    render(
      <DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} onRowClick={onRowClick} />,
    );
    fireEvent.click(screen.getByText('Austin'));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it('does NOT fire onRowClick when the in-cell link is clicked (no double-nav)', () => {
    const onRowClick = vi.fn();
    render(
      <DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} onRowClick={onRowClick} />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Sofia Ramos' }));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('marks clickable rows and muted rows with classes', () => {
    const { container } = render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        onRowClick={() => undefined}
        rowMuted={(r) => r.closed === true}
      />,
    );
    const bodyRows = container.querySelectorAll('tbody tr');
    expect(bodyRows[0]?.className).toContain('rc-row--clickable');
    expect(bodyRows[1]?.className).toContain('rc-table__row--muted');
  });

  it('renders the empty message when there are no rows', () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        rowKey={(r) => r.id}
        emptyMessage="No talent in this working set."
      />,
    );
    expect(screen.getByText('No talent in this working set.')).toBeInTheDocument();
  });

  it('does not attach a row handler when onRowClick is absent', () => {
    const { container } = render(
      <DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />,
    );
    expect(container.querySelector('tbody tr.rc-row--clickable')).toBeNull();
  });
});
