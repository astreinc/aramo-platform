import { ToastProvider } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ComplianceSection } from './ComplianceSection';

// Settings Rebuild Directive 1 — Data & compliance: Export LIVE, RTBF/Retention
// honest seams.

function renderSection() {
  return render(
    <ToastProvider>
      <ComplianceSection />
    </ToastProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('ComplianceSection — Export live + honest seams', () => {
  it('offers a real CSV export for each of the 5 R10-bounded entities', () => {
    renderSection();
    for (const e of ['talent_record', 'requisition', 'company', 'contact', 'pipeline']) {
      expect(screen.getByTestId(`export-${e}`)).toBeInTheDocument();
    }
  });

  it('clicking an export hits the live endpoint for that entity', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('id,name\n1,Acme', {
        status: 200,
        headers: { 'Content-Type': 'text/csv' },
      }),
    );
    renderSection();
    fireEvent.click(screen.getByTestId('export-company'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain('/v1/exports/company');
  });

  it('RTBF is surfaced honestly as manual-runbook status, not a fake toggle', () => {
    renderSection();
    expect(screen.getByText(/Manual runbook/i)).toBeInTheDocument();
    expect(screen.getByText(/Portal-enabled/i)).toBeInTheDocument();
    // No switch/toggle controlling RTBF or retention.
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('Retention is a clearly-marked coming-soon seam', () => {
    renderSection();
    expect(screen.getByText('Retention policy')).toBeInTheDocument();
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });
});
