import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// vitest hoists vi.mock above the imports.
vi.mock('./rtr-api', () => ({
  composeRtr: vi.fn(),
  requestRtr: vi.fn(),
  sendRtr: vi.fn(),
}));
// The review step shows the frozen document; its content read is not under test here.
vi.mock('../talent-360/t360-previews', () => ({
  DocumentPreviewDialog: (p: { documentId: string; footer?: unknown }) => (
    <div data-testid="rtr-review" data-doc={p.documentId}>
      {p.footer as never}
    </div>
  ),
}));

import { SendRtrLauncher } from './SendRtrLauncher';
import { composeRtr, requestRtr, sendRtr, type RtrComposeResponse } from './rtr-api';

// SEAM 4 — the compose-driven "Send RTR" panel for a not-yet-requested RTR. Opened from the
// Talent-in-play List (RTR column) and the Board (chip) — the SAME component. Proves: the read
// composes template provenance + a real-bound preview; "Send for signature" runs the EXISTING
// governed request→send lifecycle; and a fail-closed compose/send refuses honestly (no substitute).

const COMPOSE: RtrComposeResponse = {
  template: { name: 'Standard Right to Represent', version_number: 2 },
  preview: {
    title: 'Right to Represent — Business Analyst',
    blocks: [
      { type: 'HEADING', text: 'Authorization' },
      { type: 'TEXT', text: 'I authorize Astre Consulting Services Inc to represent me.' },
    ],
  },
};

function renderLauncher(over?: { onClose?: () => void; onSent?: () => void }) {
  return render(
    <SendRtrLauncher
      talentId="t-1"
      requisitionId="r-1"
      companyId="c-1"
      talentName="Ada Lovelace"
      clientName="Mindlance"
      requisitionTitle="Business Analyst"
      recipientEmail="ada@example.com"
      onClose={over?.onClose ?? vi.fn()}
      onSent={over?.onSent}
    />,
  );
}

describe('SendRtrLauncher (SEAM 4 — compose-driven pre-request panel)', () => {
  afterEach(() => vi.clearAllMocks());

  it('composes template provenance + locked recipient from composeRtr', async () => {
    vi.mocked(composeRtr).mockResolvedValue(COMPOSE);
    renderLauncher();
    expect(await screen.findByText('Standard Right to Represent · v2')).toBeInTheDocument();
    // Provenance is ONE line: `{name} · v{n} · Approved by your organization` + lock.
    expect(screen.getByTestId('send-rtr-provenance').textContent).toBe('Standard Right to Represent · v2 · Approved by your organization');
    expect(screen.getByTestId('send-rtr-provenance').querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('send-rtr-recipient').textContent).toContain('ada@example.com');
    expect(composeRtr).toHaveBeenCalledWith('t-1', 'r-1');
    // No template selector (locked ruling).
    expect(screen.queryByText(/choose template|select template/i)).toBeNull();
  });

  it('"Preview document" shows the composed real-bound preview (title + blocks)', async () => {
    vi.mocked(composeRtr).mockResolvedValue(COMPOSE);
    renderLauncher();
    await screen.findByText('Standard Right to Represent · v2');
    fireEvent.click(screen.getByTestId('send-rtr-preview'));
    const preview = await screen.findByTestId('send-rtr-compose-preview');
    expect(within(preview).getByText('Right to Represent — Business Analyst')).toBeInTheDocument();
    expect(within(preview).getByText('Authorization')).toBeInTheDocument();
    expect(within(preview).getByText(/I authorize Astre/)).toBeInTheDocument();
  });

  it('"Preview document" renders an rtr-html-v1 compose preview (formatted, real-bound, no raw markup)', async () => {
    vi.mocked(composeRtr).mockResolvedValue({
      ...COMPOSE,
      preview: {
        title: 'Right to Represent',
        blocks: [],
        html: '<h2>Scope</h2><p>I authorize <b>Astre</b> to represent <span data-sample="talent.full_name">Ada Lovelace</span>.</p><ul><li>Only this requisition.</li></ul><script>alert(1)</script>',
      },
    });
    renderLauncher();
    await screen.findByText('Standard Right to Represent · v2');
    fireEvent.click(screen.getByTestId('send-rtr-preview'));
    const doc = await screen.findByTestId('send-rtr-compose-html');
    expect(within(doc).getByText('Scope').tagName).toBe('H2');
    expect(within(doc).getByText('Astre').tagName).toBe('B');
    expect(within(doc).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(doc).getByText('Only this requisition.').tagName).toBe('LI');
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.textContent).not.toContain('alert(1)');
  });

  it('"Review document" freezes the RTR and shows it; only then "Send for signature" sends that same document', async () => {
    const onClose = vi.fn();
    const onSent = vi.fn();
    vi.mocked(composeRtr).mockResolvedValue(COMPOSE);
    vi.mocked(requestRtr).mockResolvedValue({ document_id: 'doc-9' });
    vi.mocked(sendRtr).mockResolvedValue({ document_id: 'doc-9', envelope_id: 'env-1', status: 'SENT' });
    renderLauncher({ onClose, onSent });
    await screen.findByText('Standard Right to Represent · v2');
    expect(screen.getByTestId('send-rtr-send')).toHaveTextContent('Review document');
    fireEvent.click(screen.getByTestId('send-rtr-send'));
    await waitFor(() => expect(requestRtr).toHaveBeenCalledWith({ talent_id: 't-1', requisition_id: 'r-1', company_id: 'c-1' }));
    // RTR-TEMPLATE-1 §16 — the recruiter sees the exact frozen document before anything is sent.
    expect(await screen.findByTestId('rtr-review')).toHaveAttribute('data-doc', 'doc-9');
    expect(sendRtr).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('rtr-review-send'));
    await waitFor(() => expect(sendRtr).toHaveBeenCalledWith('doc-9', 't-1'));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('fails CLOSED when composeRtr refuses (no approved template) — honest message + Send disabled', async () => {
    vi.mocked(composeRtr).mockRejectedValue(
      Object.assign(new Error('not configured'), { code: 'RTR_TEMPLATE_NOT_CONFIGURED' }),
    );
    renderLauncher();
    const missing = await screen.findByTestId('send-rtr-missing');
    expect(missing.textContent).toContain('has not approved a Right to Represent template');
    expect(screen.getByTestId('send-rtr-send')).toBeDisabled();
  });

  it('fails CLOSED when send hits a missing binding (no substitution; Send disabled)', async () => {
    vi.mocked(composeRtr).mockResolvedValue(COMPOSE);
    vi.mocked(requestRtr).mockResolvedValue({ document_id: 'doc-9' });
    vi.mocked(sendRtr).mockRejectedValue(
      Object.assign(new Error('binding missing'), { code: 'RTR_TEMPLATE_BINDING_MISSING', details: { binding_key: 'recruiting_company.name' } }),
    );
    renderLauncher();
    await screen.findByText('Standard Right to Represent · v2');
    fireEvent.click(screen.getByTestId('send-rtr-send'));
    await screen.findByTestId('rtr-review');
    fireEvent.click(screen.getByTestId('rtr-review-send'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Your organization’s legal name isn’t set');
    expect(alert.textContent).not.toContain('requisition reference');
  });

  it('fails CLOSED when the request itself is refused — honest message, nothing frozen or shown', async () => {
    vi.mocked(composeRtr).mockResolvedValue(COMPOSE);
    vi.mocked(requestRtr).mockRejectedValue(
      Object.assign(new Error('binding missing'), { code: 'RTR_TEMPLATE_BINDING_MISSING', details: { binding_key: 'recruiting_company.name' } }),
    );
    renderLauncher();
    await screen.findByText('Standard Right to Represent · v2');
    fireEvent.click(screen.getByTestId('send-rtr-send'));
    const missing = await screen.findByTestId('send-rtr-missing');
    expect(missing.textContent).toContain('Your organization’s legal name isn’t set');
    expect(screen.queryByTestId('rtr-review')).toBeNull();
    expect(sendRtr).not.toHaveBeenCalled();
    expect(screen.getByTestId('send-rtr-send')).toBeDisabled();
  });
});
