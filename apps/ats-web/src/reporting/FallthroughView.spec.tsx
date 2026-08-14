import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FallthroughView } from './FallthroughView';
import type { FallthroughReport } from './fallthrough-types';

// T9-B2 — the dedicated fallthrough report view (§20). Proves the run flow
// renders rate + reason breakdown (incl. the null→"Unspecified" bucket), a null
// rate (empty cohort) shows an em dash + empty-state, and an invalid range is
// rejected without calling the API.

afterEach(() => vi.restoreAllMocks());

function mockReport(report: FallthroughReport): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(report), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function runWith(report: FallthroughReport): void {
  mockReport(report);
  render(<FallthroughView />);
  fireEvent.change(screen.getByTestId('ft-from'), { target: { value: '2026-05-01T00:00' } });
  fireEvent.change(screen.getByTestId('ft-to'), { target: { value: '2026-06-01T00:00' } });
  fireEvent.click(screen.getByTestId('ft-run'));
}

describe('FallthroughView', () => {
  it('renders rate + reason breakdown including an Unspecified bucket', async () => {
    runWith({
      period: { from: 'x', to: 'y' },
      accepted_attempts: 4,
      fallthrough_attempts: 3,
      fallthrough_rate: 75,
      reasons: [
        { reason_code: 'start_date_failed', reason_label: 'Start date failed', count: 2, rate: 67 },
        { reason_code: null, reason_label: 'Unspecified', count: 1, rate: 33 },
      ],
    });
    await waitFor(() => expect(screen.getByTestId('ft-rate')).toHaveTextContent('75%'));
    const table = screen.getByTestId('ft-reasons');
    expect(table).toHaveTextContent('Start date failed');
    expect(table).toHaveTextContent('Unspecified');
  });

  it('renders a null rate (empty cohort) as an em dash + empty reasons state', async () => {
    runWith({
      period: { from: 'x', to: 'y' },
      accepted_attempts: 0,
      fallthrough_attempts: 0,
      fallthrough_rate: null,
      reasons: [],
    });
    await waitFor(() => expect(screen.getByTestId('ft-rate')).toHaveTextContent('—'));
    expect(screen.getByTestId('ft-no-reasons')).toBeInTheDocument();
  });

  it('rejects a start not before end without calling the API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    render(<FallthroughView />);
    fireEvent.change(screen.getByTestId('ft-from'), { target: { value: '2026-06-01T00:00' } });
    fireEvent.change(screen.getByTestId('ft-to'), { target: { value: '2026-05-01T00:00' } });
    fireEvent.click(screen.getByTestId('ft-run'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
