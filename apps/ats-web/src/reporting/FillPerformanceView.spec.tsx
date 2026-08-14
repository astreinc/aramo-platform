import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FillPerformanceView } from './FillPerformanceView';
import type { FillPerformanceReport } from './types';

// T9-B1 — the dedicated operational report view. Proves the run flow renders
// fill-rate + time-to-fill, and that a null fill_rate (empty cohort) shows as
// an em dash rather than "0%" or a crash.

afterEach(() => vi.restoreAllMocks());

function mockReport(report: FillPerformanceReport): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(report), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

async function runWith(report: FillPerformanceReport): Promise<void> {
  mockReport(report);
  render(<FillPerformanceView />);
  fireEvent.change(screen.getByTestId('fp-from'), {
    target: { value: '2026-03-01T00:00' },
  });
  fireEvent.change(screen.getByTestId('fp-to'), {
    target: { value: '2026-04-01T00:00' },
  });
  fireEvent.click(screen.getByTestId('fp-run'));
}

describe('FillPerformanceView', () => {
  it('runs a report and renders fill-rate + time-to-fill', async () => {
    await runWith({
      period: { from: 'x', to: 'y' },
      openings: 2,
      filled_openings: 2,
      fill_rate: 100,
      fully_filled_requisitions: 1,
      time_to_fill: { count: 1, average_days: 5 },
    });
    await waitFor(() =>
      expect(screen.getByTestId('fp-fill-rate')).toHaveTextContent('100%'),
    );
    expect(screen.getByTestId('fp-ttf-avg')).toHaveTextContent('5');
  });

  it('renders a null fill_rate (empty cohort) as an em dash', async () => {
    await runWith({
      period: { from: 'x', to: 'y' },
      openings: 0,
      filled_openings: 0,
      fill_rate: null,
      fully_filled_requisitions: 0,
      time_to_fill: { count: 0, average_days: null },
    });
    await waitFor(() =>
      expect(screen.getByTestId('fp-fill-rate')).toHaveTextContent('—'),
    );
    expect(screen.getByTestId('fp-ttf-avg')).toHaveTextContent('—');
  });

  it('rejects a start that is not before the end without calling the API', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    render(<FillPerformanceView />);
    fireEvent.change(screen.getByTestId('fp-from'), {
      target: { value: '2026-04-01T00:00' },
    });
    fireEvent.change(screen.getByTestId('fp-to'), {
      target: { value: '2026-03-01T00:00' },
    });
    fireEvent.click(screen.getByTestId('fp-run'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
