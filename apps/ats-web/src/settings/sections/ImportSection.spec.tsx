import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ImportBatchView, ImportFailureView } from '../admin-types';

import { ImportSection } from './ImportSection';

// Settings Rebuild Directive 1 — Import data is LIVE (read-only).

const BATCHES: ImportBatchView[] = [
  {
    id: 'imp-1',
    tenant_id: 't',
    site_id: null,
    imported_by_id: 'u',
    target_entity: 'talent_record',
    source_filename: 'Q1_talent.csv',
    row_count: 1204,
    success_count: 1192,
    failure_count: 12,
    status: 'partial',
    created_at: '2026-06-10T10:00:00.000Z',
    committed_at: '2026-06-10T10:01:00.000Z',
    reverted_at: null,
  },
  {
    id: 'imp-2',
    tenant_id: 't',
    site_id: null,
    imported_by_id: 'u',
    target_entity: 'company',
    source_filename: 'accounts.csv',
    row_count: 86,
    success_count: 86,
    failure_count: 0,
    status: 'committed',
    created_at: '2026-06-09T10:00:00.000Z',
    committed_at: '2026-06-09T10:01:00.000Z',
    reverted_at: null,
  },
];

const FAILURES: ImportFailureView[] = [
  {
    id: 'f-1',
    tenant_id: 't',
    import_batch_id: 'imp-1',
    row_number: 7,
    failure_reason: 'invalid email',
    offending_fields: ['email1'],
    original_row_data: {},
    created_at: '2026-06-10T10:00:30.000Z',
  },
];

describe('ImportSection — live read surface', () => {
  it('renders the import history from the live endpoint', async () => {
    render(
      <ImportSection fetchImportsFn={() => Promise.resolve(BATCHES)} />,
    );
    expect(
      await screen.findByText(/Talent — Q1_talent\.csv/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Companies — accounts\.csv/)).toBeInTheDocument();
    expect(screen.getByText(/Partial/)).toBeInTheDocument();
    expect(screen.getByText(/Completed/)).toBeInTheDocument();
  });

  it('has NO run/start-import button (read-only — no dead knob)', async () => {
    render(<ImportSection fetchImportsFn={() => Promise.resolve(BATCHES)} />);
    await screen.findByText(/Talent — Q1_talent\.csv/);
    expect(screen.queryByRole('button', { name: /start import|run import|upload/i })).toBeNull();
  });

  it('loads per-batch failures only when expanded', async () => {
    const fetchFailures = vi.fn(() => Promise.resolve(FAILURES));
    render(
      <ImportSection
        fetchImportsFn={() => Promise.resolve(BATCHES)}
        fetchFailuresFn={fetchFailures}
      />,
    );
    await screen.findByText(/Talent — Q1_talent\.csv/);
    // The clean batch has no "View failures" affordance.
    expect(screen.queryByTestId('import-failures-toggle-imp-2')).toBeNull();
    // Not fetched until expanded.
    expect(fetchFailures).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('import-failures-toggle-imp-1'));
    await waitFor(() => expect(fetchFailures).toHaveBeenCalledWith('imp-1'));
    expect(await screen.findByText(/Row 7/)).toBeInTheDocument();
    expect(screen.getByText(/invalid email/)).toBeInTheDocument();
  });

  it('surfaces a load error honestly', async () => {
    render(
      <ImportSection
        fetchImportsFn={() => Promise.reject(new Error('boom'))}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});
