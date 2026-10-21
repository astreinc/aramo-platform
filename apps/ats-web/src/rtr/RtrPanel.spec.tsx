import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// vitest hoists vi.mock above the imports (keeps the import group contiguous).
vi.mock('../talent-360/t360-previews', () => ({
  DocumentPreviewDialog: ({ talentId, documentId }: { talentId: string; documentId: string }) => (
    <div data-testid="rtr-viewer">{`${talentId}:${documentId}`}</div>
  ),
}));
vi.mock('./rtr-api', () => ({
  requestRtr: vi.fn(),
  sendRtr: vi.fn(),
  remindRtr: vi.fn(),
  getCurrentRtr: vi.fn(),
  getRtrPreview: vi.fn(),
}));

import { RtrPanel } from './RtrPanel';
import { requestRtr, sendRtr, remindRtr, getCurrentRtr, getRtrPreview, type RtrCurrentResponse } from './rtr-api';

// RTR-TEMPLATE-1 (§36) — the recruiter RTR panel: mount reconciliation, the locked
// states, pinned-template provenance, preview, executed evidence, scope-gated
// visibility, and the explicit absence of template-admin / copy-link / resend / void.

function current(partial: Partial<RtrCurrentResponse>): RtrCurrentResponse {
  return {
    document_id: 'doc-1',
    status: 'REQUESTED',
    document_status: 'DRAFT',
    template: { name: 'Standard Right to Represent', version_number: 1 },
    preview_available: true,
    executed_available: false,
    certificate_available: false,
    ...partial,
  };
}

function renderPanel(over?: { canRead?: boolean; canRequest?: boolean; canSend?: boolean; stage?: string; rtrRequired?: boolean }) {
  return render(
    <RtrPanel
      talentId="t-1"
      requisitionId="r-1"
      companyId="c-1"
      canRead={over?.canRead ?? true}
      canRequest={over?.canRequest ?? true}
      canSend={over?.canSend ?? true}
      {...(over?.stage === undefined ? {} : { stage: over.stage })}
      {...(over?.rtrRequired === undefined ? {} : { rtrRequired: over.rtrRequired })}
    />,
  );
}

describe('RtrPanel', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('A — mount with no current RTR shows Request RTR', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValue(null);
    renderPanel();
    expect(await screen.findByText('Request RTR')).toBeInTheDocument();
    expect(getCurrentRtr).toHaveBeenCalledWith('t-1', 'r-1');
  });

  it('B — mount with an existing REQUESTED RTR shows no Request, plus provenance + Preview + Send', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValue(current({ status: 'REQUESTED' }));
    renderPanel();
    expect(await screen.findByText('Requested')).toBeInTheDocument();
    expect(screen.queryByText('Request RTR')).not.toBeInTheDocument();
    expect(screen.getByText('Standard Right to Represent · v1')).toBeInTheDocument();
    expect(screen.getByText('Preview RTR')).toBeInTheDocument();
    expect(screen.getByText('Send for signature')).toBeInTheDocument();
  });

  it('C — request calls the API with talent/requisition/company and reconciles to Requested', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValueOnce(null).mockResolvedValue(current({ status: 'REQUESTED' }));
    vi.mocked(requestRtr).mockResolvedValue({ document_id: 'doc-1' });
    renderPanel();
    fireEvent.click(await screen.findByText('Request RTR'));
    await waitFor(() => screen.getByText('Requested'));
    expect(requestRtr).toHaveBeenCalledWith({ talent_id: 't-1', requisition_id: 'r-1', company_id: 'c-1' });
  });

  it('D — Preview RTR fetches the protected preview and opens it', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValue(current({ status: 'REQUESTED' }));
    vi.mocked(getRtrPreview).mockResolvedValue({ url: 'https://presigned.example/x', expires_at: 'e', content_sha256: 's' });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPanel();
    fireEvent.click(await screen.findByText('Preview RTR'));
    await waitFor(() => expect(getRtrPreview).toHaveBeenCalledWith('doc-1'));
    expect(openSpy).toHaveBeenCalledWith('https://presigned.example/x', '_blank', 'noopener');
    openSpy.mockRestore();
  });

  it('E — Send for signature opens the §2.7 modal; confirming sends and transitions to Awaiting', async () => {
    vi.mocked(getCurrentRtr)
      .mockResolvedValueOnce(current({ status: 'REQUESTED' }))
      .mockResolvedValue(current({ status: 'AWAITING_SIGNATURE' }));
    vi.mocked(sendRtr).mockResolvedValue({ document_id: 'doc-1', envelope_id: 'env-1', status: 'SENT' });
    renderPanel();
    // The cell action opens the confirmation modal (no direct send).
    fireEvent.click(await screen.findByText('Send for signature'));
    const modal = await screen.findByTestId('send-rtr-modal');
    expect(within(modal).getByText('Send Right to Represent')).toBeInTheDocument();
    // The modal's Send performs the actual send.
    fireEvent.click(screen.getByTestId('send-rtr-send'));
    await waitFor(() => expect(sendRtr).toHaveBeenCalledWith('doc-1', 't-1'));
    await waitFor(() => screen.getByText('Awaiting signature'));
  });

  it('W1-C3 — AWAITING_SIGNATURE shows Send Reminder (document:execute); click reminds the SAME document + shows "Reminder sent"', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValue(current({ status: 'AWAITING_SIGNATURE' }));
    vi.mocked(remindRtr).mockResolvedValue({ document_id: 'doc-1', status: 'AWAITING_SIGNATURE', reminder_sent: true });
    renderPanel();
    fireEvent.click(await screen.findByTestId('rtr-send-reminder'));
    await waitFor(() => expect(remindRtr).toHaveBeenCalledWith('doc-1'));
    expect(await screen.findByTestId('rtr-reminder-notice')).toHaveTextContent('Reminder sent');
    // Still awaiting — reminder is not a lifecycle transition.
    expect(screen.getByText('Awaiting signature')).toBeInTheDocument();
  });

  it('W1-C3 — Send Reminder is hidden without document:execute, and never shown while REQUESTED', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValue(current({ status: 'AWAITING_SIGNATURE' }));
    const { unmount } = renderPanel({ canSend: false });
    await screen.findByText('Awaiting signature');
    expect(screen.queryByTestId('rtr-send-reminder')).toBeNull();
    unmount();

    vi.mocked(getCurrentRtr).mockResolvedValue(current({ status: 'REQUESTED' }));
    renderPanel();
    await screen.findByText('Requested');
    expect(screen.queryByTestId('rtr-send-reminder')).toBeNull(); // no reminder before send
  });

  it('F — reload restores an existing AWAITING_SIGNATURE RTR (no Request RTR)', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValue(current({ status: 'AWAITING_SIGNATURE' }));
    renderPanel();
    expect(await screen.findByText('Awaiting signature')).toBeInTheDocument();
    expect(screen.queryByText('Request RTR')).not.toBeInTheDocument();
    expect(screen.getByText('Refresh status')).toBeInTheDocument();
  });

  it('G — EXECUTED: View RTR opens the frozen signed PDF in the viewer (not a raw API link); no Send', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValue(
      current({ status: 'EXECUTED', document_status: 'EXECUTED', executed_available: true, certificate_available: true }),
    );
    renderPanel();
    const viewRtr = await screen.findByRole('button', { name: 'View RTR' });
    expect(viewRtr.getAttribute('href')).toBeNull();
    // No byte-serving certificate route exists yet → no dead link.
    expect(screen.queryByText('Certificate')).not.toBeInTheDocument();
    fireEvent.click(viewRtr);
    expect(await screen.findByTestId('rtr-viewer')).toHaveTextContent('t-1:doc-1');
    expect(screen.queryByText('Send for signature')).not.toBeInTheDocument();
  });

  it('H — a backend error is surfaced with a safe retry', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValueOnce(null);
    vi.mocked(requestRtr).mockRejectedValue(new Error('talent has no email for RTR signing'));
    renderPanel();
    fireEvent.click(await screen.findByText('Request RTR'));
    await waitFor(() => screen.getByRole('alert'));
    expect(screen.getByRole('alert').textContent).toContain('talent has no email');
    expect(screen.getByText('Try again')).toBeInTheDocument();
  });

  it('I — permission visibility: no document:create hides Request; no document:execute hides Send', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValueOnce(null);
    const { unmount } = renderPanel({ canRequest: false });
    await waitFor(() => expect(getCurrentRtr).toHaveBeenCalled());
    expect(screen.queryByText('Request RTR')).not.toBeInTheDocument();
    unmount();

    vi.mocked(getCurrentRtr).mockResolvedValue(current({ status: 'REQUESTED' }));
    renderPanel({ canSend: false });
    expect(await screen.findByText('Requested')).toBeInTheDocument();
    expect(screen.queryByText('Send for signature')).not.toBeInTheDocument();
    expect(screen.getByText('Preview RTR')).toBeInTheDocument();
  });

  it('J/K — no template chooser/editor/settings and no Copy-link / Resend / Void controls', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValue(current({ status: 'REQUESTED' }));
    renderPanel();
    await screen.findByText('Requested');
    expect(screen.queryByText(/choose template|edit template|template settings|configure template/i)).toBeNull();
    expect(screen.queryByText(/copy link|copy signing|resend|void/i)).toBeNull();
    // Provenance is read-only text, never an interactive control.
    expect(screen.getByText('Standard Right to Represent · v1').tagName).toBe('SPAN');
  });

  it('L — provenance reflects the exact pinned version returned by the backend', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValue(
      current({ status: 'AWAITING_SIGNATURE', template: { name: 'Standard Right to Represent', version_number: 3 } }),
    );
    renderPanel();
    expect(await screen.findByText('Standard Right to Represent · v3')).toBeInTheDocument();
  });

  // DOC-TEMPLATE-ADMIN-RTR-1 (§26) — template governance makes "no approved template"
  // a real recruiter state. The panel refuses honestly and does NOT offer a useless
  // retry (an admin must approve one first).
  it('M — no approved RTR template is an honest, non-retryable refusal (admin must act)', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValueOnce(null);
    vi.mocked(requestRtr).mockRejectedValue(
      Object.assign(new Error('not configured'), { code: 'RTR_TEMPLATE_NOT_CONFIGURED' }),
    );
    renderPanel();
    fireEvent.click(await screen.findByText('Request RTR'));
    await waitFor(() => screen.getByRole('alert'));
    expect(screen.getByRole('alert').textContent).toContain('has not approved a Right to Represent template');
    expect(screen.queryByText('Try again')).toBeNull();
  });

  // §26 — a missing authoritative binding fails CLOSED (never substituted); fixing the
  // requisition data can help, so this one stays retryable.
  it('N — a missing binding fails closed INSIDE the send modal (no substitution; send disabled)', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValueOnce(current({ status: 'REQUESTED' }));
    vi.mocked(sendRtr).mockRejectedValue(
      Object.assign(new Error('binding missing'), { code: 'RTR_TEMPLATE_BINDING_MISSING', details: { binding_key: 'recruiting_company.name' } }),
    );
    renderPanel();
    fireEvent.click(await screen.findByText('Send for signature'));
    const send = await screen.findByTestId('send-rtr-send');
    fireEvent.click(send);
    const missing = await screen.findByTestId('send-rtr-missing');
    expect(missing.textContent).toContain('Your organization’s legal name isn’t set');
    expect(missing.textContent).not.toContain('requisition reference');
    // Fail-closed: the modal stays open and Send is disabled (Aramo never substitutes).
    expect(screen.getByTestId('send-rtr-send')).toBeDisabled();
  });

  // ---- Pipeline & RTR Recon Remediation Directive v1.0 R2 ----
  it('R2 DEF-7 — before Talent responded, no Request RTR (explained)', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValue(null);
    renderPanel({ stage: 'contacted' });
    expect(await screen.findByText('Available once the talent responds')).toBeInTheDocument();
    expect(screen.queryByText('Request RTR')).not.toBeInTheDocument();
  });

  it('R2 DEF-7 — from Talent responded, Request RTR is offered', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValue(null);
    renderPanel({ stage: 'talent_responded' });
    expect(await screen.findByText('Request RTR')).toBeInTheDocument();
  });

  it('R2 DEF-12 — a declined RTR shows its outcome and offers a new request', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValueOnce(current({ status: 'DECLINED', document_status: 'DECLINED', preview_available: false })).mockResolvedValue(current({ status: 'REQUESTED' }));
    vi.mocked(requestRtr).mockResolvedValue({ document_id: 'doc-2' });
    renderPanel({ stage: 'qualifying' });
    expect(await screen.findByText('Declined by the talent')).toBeInTheDocument();
    expect(screen.queryByText('Awaiting signature')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Request a new RTR'));
    await waitFor(() => expect(requestRtr).toHaveBeenCalledTimes(1));
  });

  it('R2 DEF-12 — an expired RTR shows "Expired unsigned"', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValue(current({ status: 'EXPIRED', document_status: 'EXPIRED', preview_available: false }));
    renderPanel({ stage: 'qualified' });
    expect(await screen.findByText('Expired unsigned')).toBeInTheDocument();
    expect(screen.getByText('Request a new RTR')).toBeInTheDocument();
  });

  it('R2 DEF-15(a) — the "required before qualifying" line appears only when the policy requires it', async () => {
    vi.mocked(getCurrentRtr).mockResolvedValue(current({ status: 'REQUESTED' }));
    // The line lives in the Send-for-signature dialog's footnote.
    const { unmount } = renderPanel();
    fireEvent.click(await screen.findByText('Send for signature'));
    expect(await screen.findByText(/The document is frozen from v1 when sent\./)).toBeInTheDocument();
    expect(screen.queryByText(/A signed RTR is required before qualifying/)).not.toBeInTheDocument();
    unmount();
    renderPanel({ rtrRequired: true });
    fireEvent.click(await screen.findByText('Send for signature'));
    expect(await screen.findByText(/A signed RTR is required before qualifying/)).toBeInTheDocument();
  });
});
