import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// vitest hoists vi.mock above the imports (keeps the import group contiguous).
vi.mock('./rtr-api', () => ({
  requestRtr: vi.fn(),
  sendRtr: vi.fn(),
  getRtrStatus: vi.fn(),
}));

import { RtrPanel } from './RtrPanel';
import { requestRtr, sendRtr, getRtrStatus } from './rtr-api';

// DOC-5 (R-5-12) — the recruiter RTR panel: request → send → derived status.

describe('RtrPanel', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requests, sends, and reflects the derived status from the backend', async () => {
    vi.mocked(requestRtr).mockResolvedValue({ document_id: 'doc-1' });
    vi.mocked(sendRtr).mockResolvedValue({ document_id: 'doc-1', envelope_id: 'env-1', status: 'SENT' });
    vi.mocked(getRtrStatus).mockResolvedValue({ document_id: 'doc-1', status: 'EXECUTED', document_status: 'EXECUTED' });

    render(<RtrPanel talentId="t-1" requisitionId="r-1" companyId="c-1" />);

    fireEvent.click(screen.getByText('Request RTR'));
    await waitFor(() => screen.getByText('Send for signature'));
    expect(requestRtr).toHaveBeenCalledWith({ talent_id: 't-1', requisition_id: 'r-1', company_id: 'c-1' });
    expect(screen.getByText('Requested — preparing')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Send for signature'));
    await waitFor(() => screen.getByText('Awaiting signature'));
    expect(sendRtr).toHaveBeenCalledWith('doc-1', 't-1');

    fireEvent.click(screen.getByText('Refresh status'));
    await waitFor(() => screen.getByText('Executed'));
    expect(getRtrStatus).toHaveBeenCalledWith('doc-1');
  });

  it('surfaces a backend error', async () => {
    vi.mocked(requestRtr).mockRejectedValue(new Error('talent has no email for RTR signing'));
    render(<RtrPanel talentId="t-1" requisitionId="r-1" companyId="c-1" />);
    fireEvent.click(screen.getByText('Request RTR'));
    await waitFor(() => screen.getByRole('alert'));
    expect(screen.getByRole('alert').textContent).toContain('talent has no email');
  });
});
