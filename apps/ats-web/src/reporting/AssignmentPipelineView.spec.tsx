import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssignmentPipelineView } from './AssignmentPipelineView';
import type { AssignmentPipelineReport } from './assignment-pipeline-types';

// T9-B3 — the dedicated assignment-pipeline view. Fetches on mount (no params);
// renders the five live-state counts, UTC start-date buckets incl. Unspecified,
// and the visible forward-materialized coverage label. No commercial fields.

afterEach(() => vi.restoreAllMocks());

const REPORT: AssignmentPipelineReport = {
  total_live: 7,
  by_state: [
    { state: 'OFFER_ACCEPTED', count: 1 },
    { state: 'PRE_START', count: 1 },
    { state: 'BLOCKED', count: 1 },
    { state: 'READY_TO_START', count: 1 },
    { state: 'STARTED', count: 3 },
  ],
  start_date: { overdue: 0, today: 0, next_7_days: 1, later: 1, unspecified: 1, timezone_basis: 'UTC' },
  contract_assignments: { active: 1, ended: 1, coverage: 'forward_materialized' },
};

function mock(report: AssignmentPipelineReport): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(report), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
}

describe('AssignmentPipelineView', () => {
  it('renders the five live-state counts, buckets, and the coverage label', async () => {
    mock(REPORT);
    render(<AssignmentPipelineView />);
    await waitFor(() => expect(screen.getByTestId('ap-content')).toBeInTheDocument());
    expect(screen.getByTestId('ap-state-STARTED')).toHaveTextContent('3');
    expect(screen.getByTestId('ap-state-BLOCKED')).toHaveTextContent('1');
    expect(screen.getByTestId('ap-unspecified')).toHaveTextContent('1');
    expect(screen.getByTestId('ap-active')).toHaveTextContent('1');
    expect(screen.getByTestId('ap-coverage-note')).toHaveTextContent(
      'Forward-materialized assignments only',
    );
    // no commercial/financial text anywhere in the rendered surface
    for (const banned of ['pay', 'bill', 'margin', 'rate', 'revenue', 'currency']) {
      expect(document.body.textContent?.toLowerCase()).not.toContain(banned);
    }
  });

  it('renders all five state buckets even when counts are zero', async () => {
    mock({
      ...REPORT,
      total_live: 0,
      by_state: [
        { state: 'OFFER_ACCEPTED', count: 0 },
        { state: 'PRE_START', count: 0 },
        { state: 'BLOCKED', count: 0 },
        { state: 'READY_TO_START', count: 0 },
        { state: 'STARTED', count: 0 },
      ],
      start_date: { overdue: 0, today: 0, next_7_days: 0, later: 0, unspecified: 0, timezone_basis: 'UTC' },
      contract_assignments: { active: 0, ended: 0, coverage: 'forward_materialized' },
    });
    render(<AssignmentPipelineView />);
    await waitFor(() => expect(screen.getByTestId('ap-content')).toBeInTheDocument());
    for (const s of ['OFFER_ACCEPTED', 'PRE_START', 'BLOCKED', 'READY_TO_START', 'STARTED']) {
      expect(screen.getByTestId(`ap-state-${s}`)).toHaveTextContent('0');
    }
    // coverage disclaimer stays visible in the zero state (§22)
    expect(screen.getByTestId('ap-coverage-note')).toBeInTheDocument();
  });

  it('shows an error state when the request fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    render(<AssignmentPipelineView />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});
