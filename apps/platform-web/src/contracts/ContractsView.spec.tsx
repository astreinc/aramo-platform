import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '@aramo/fe-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformSession } from '../skills/test-session';

import { ContractsView } from './ContractsView';
import { contractRequestErrorText, contractsApi, type ContractDetail, type ContractSummary } from './contracts-api';
import { contractFacts, contractRowLine, contractTimeline, shortHash } from './contracts-format';

// CCP-B4 (handoff §5.5) — the Contracts screen: list + detail, the designed empty
// and loading states, UI gating of the two actions (the backend refusal is in
// apps/platform-admin ccp-b4-commercial-contract-authorization.spec.ts), and the
// two actions creating change requests only (never a direct mutation).

const NOW = Date.parse('2026-10-24T15:00:00Z');
const OPS = ['platform:tenant:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:approval:read'];
const AUDITOR = ['platform:tenant:read', 'platform:subscription:read', 'platform:approval:read'];
const TOMAS = { user_id: '0190cccc-0000-7000-8000-00000000000a', display_name: 'Tomás Silva', email: 'tomas.silva@aramo.ai' };

const SUMMARY: ContractSummary = {
  id: '019a0000-0000-7000-8000-0000000b4c07',
  contract_ref: 'CT-2024-007',
  tenant: { id: 't_halcyon', name: 'Halcyon Health', slug: 'halcyon' },
  product_key: 'sign',
  status: 'ACTIVE',
  subscription: {
    id: 's1',
    source: 'MANUAL',
    status: 'ACTIVE',
    ended_at: null,
    commitment_start: '2023-12-08T00:00:00.000Z',
    commitment_end: '2026-12-08T00:00:00.000Z',
    plan: { key: 'aramo-sign-enterprise-v1', name: 'Sign Enterprise' },
    plan_version: { id: 'v1', version_number: 1, status: 'PUBLISHED' },
  },
  provenance: 'MIGRATION',
  recorded_at: '2025-11-14T03:00:00.000Z',
};
const ENDED: ContractSummary = {
  ...SUMMARY,
  id: '019a0000-0000-7000-8000-0000000b4c19',
  contract_ref: 'CT-2024-019',
  tenant: { id: 't_bright', name: 'Brightline Retail', slug: 'brightline' },
  status: 'ENDED',
  provenance: 'CHANGE_REQUEST',
  subscription: { ...SUMMARY.subscription, ended_at: '2026-10-18T00:00:00.000Z', commitment_start: '2024-10-18T00:00:00.000Z', commitment_end: '2026-10-17T00:00:00.000Z' },
};
const DETAIL: ContractDetail = {
  ...SUMMARY,
  terms: ['Allowance of 25,000 envelopes per month', 'Invoiced monthly, net 45'],
  recorded_terms: ['Allowance of 25,000 envelopes per month'],
  evidence_ref: 'OF-7781',
  recorded_by: { user_id: 'mig', display_name: 'Migration job', email: null },
  recorded_by_change_request_id: 'cr0',
  documents: [{ name: 'Master services agreement.pdf', sha256: `9f2c61d0${'0'.repeat(50)}a84b1e`, byte_size: null, media_type: null, recorded_by: TOMAS, recorded_at: '2023-12-04T00:00:00.000Z', amendment_sequence: null }],
  amendments: [{ sequence: 1, kind: 'AMENDMENT', summary: 'Allowance raised from 20,000 to 25,000 envelopes per month.', terms: null, document_count: 0, evidence_ref: null, change_request_id: 'cr1', recorded_by: TOMAS, recorded_at: '2024-06-11T00:00:00.000Z' }],
  invoicing: { enabled: false, reason: 'enterprise_invoicing_choice_pending' },
};

function renderView(scopes: string[]) {
  return render(<ContractsView session={platformSession(scopes)} now={() => NOW} />);
}

describe('contracts format helpers', () => {
  it('formats the row line, the hash, the facts and the timeline as the design does', () => {
    expect(contractRowLine(SUMMARY)).toBe('36 months · ends 8 Dec 2026');
    expect(contractRowLine(ENDED)).toBe('24 months · ends 17 Oct 2026');
    expect(shortHash(DETAIL.documents[0]!.sha256)).toBe('sha256:9f2c61d0…a84b1e');
    expect(contractFacts(DETAIL, NOW)).toEqual([
      { k: 'Commitment', v: '36 months', s: '8 Dec 2023 – 8 Dec 2026' },
      { k: 'Ends', v: '8 Dec 2026', s: 'in 44 days' },
      { k: 'Source', v: 'MANUAL', s: 'Governed contract' },
      { k: 'Provenance', v: 'Migration', s: 'Backfilled from legacy billing' },
    ]);
    expect(contractTimeline(DETAIL).map((e) => e.title)).toEqual(['Amendment 1', 'Migrated into the commercial control plane']);
  });

  it('maps the change-request refusals', () => {
    expect(contractRequestErrorText(new ApiError(409, 'open', 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', { reason: 'open_request_exists' }))).toMatch(/already has an open change request/);
    expect(contractRequestErrorText(new ApiError(403, 'no', 'INSUFFICIENT_PERMISSIONS', { reason: 'requester_scope_missing' }))).toBe('Contract changes need the Commercial ops role.');
    expect(contractRequestErrorText(new Error('x'))).toBe('The change request couldn’t be created. Try again.');
  });
});

describe('ContractsView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the designed empty state', async () => {
    vi.spyOn(contractsApi, 'list').mockResolvedValue({ contracts: [] });
    renderView(OPS);
    expect(await screen.findByText('No contracts recorded')).toBeInTheDocument();
    expect(screen.getByText('MANUAL subscriptions appear here once a contract is recorded.')).toBeInTheDocument();
  });

  it('shows the skeleton while loading', () => {
    vi.spyOn(contractsApi, 'list').mockReturnValue(new Promise(() => undefined));
    renderView(OPS);
    expect(screen.getByRole('status')).toHaveTextContent('Loading contracts…');
  });

  it('lists contracts, selects the first, and renders the detail (facts, terms, hashed documents, timeline); no invoicing control', async () => {
    vi.spyOn(contractsApi, 'list').mockResolvedValue({ contracts: [SUMMARY, ENDED] });
    const get = vi.spyOn(contractsApi, 'get').mockResolvedValue(DETAIL);
    renderView(OPS);
    expect(await screen.findByRole('heading', { name: 'Halcyon Health · Sign Enterprise' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(SUMMARY.id);
    expect(screen.getByRole('button', { name: /CT-2024-007/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Migrated — provenance: migration')).toBeInTheDocument();
    expect(screen.getByText('sha256:9f2c61d0…a84b1e')).toBeInTheDocument();
    expect(screen.getByText('Tomás Silva · 4 Dec 2023')).toBeInTheDocument();
    expect(screen.getByText('Amendment 1')).toBeInTheDocument();
    expect(screen.queryByText(/invoice now|send invoice/i)).toBeNull();
  });

  it('V12-W2-1 (R3-W): terms_withheld in place of terms → "Contract terms restricted — Finance access required"; the amendment summary stays', async () => {
    const { terms: _t, recorded_terms: _r, ...rest } = DETAIL;
    vi.spyOn(contractsApi, 'list').mockResolvedValue({ contracts: [SUMMARY] });
    vi.spyOn(contractsApi, 'get').mockResolvedValue({ ...rest, terms_withheld: 'FINANCE_SCOPE_REQUIRED', amendments: DETAIL.amendments.map(({ terms: _x, ...a }) => ({ ...a, terms_withheld: 'FINANCE_SCOPE_REQUIRED' as const })) });
    renderView(OPS);
    expect(await screen.findByTestId('contract-terms-restricted')).toHaveTextContent('Contract terms restricted — Finance access required');
    expect(screen.queryByText('Invoiced monthly, net 45')).toBeNull();
    expect(screen.getByText('Allowance raised from 20,000 to 25,000 envelopes per month.')).toBeInTheDocument();
  });

  it('V12-W2-2 a holder sees the terms as recorded', async () => {
    vi.spyOn(contractsApi, 'list').mockResolvedValue({ contracts: [SUMMARY] });
    vi.spyOn(contractsApi, 'get').mockResolvedValue(DETAIL);
    renderView(OPS);
    expect(await screen.findByText('Invoiced monthly, net 45')).toBeInTheDocument();
    expect(screen.queryByTestId('contract-terms-restricted')).toBeNull();
  });

  it('a role without platform:subscription:request sees both actions disabled with the reason', async () => {
    vi.spyOn(contractsApi, 'list').mockResolvedValue({ contracts: [SUMMARY] });
    vi.spyOn(contractsApi, 'get').mockResolvedValue(DETAIL);
    renderView(AUDITOR);
    const amend = await screen.findByRole('button', { name: 'Record amendment…' });
    expect(amend).toHaveAttribute('aria-disabled', 'true');
    expect(amend).toHaveAttribute('title', 'Needs the Commercial ops role.');
    fireEvent.click(amend);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'End contract…' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('an ended contract has no actions', async () => {
    vi.spyOn(contractsApi, 'list').mockResolvedValue({ contracts: [ENDED] });
    vi.spyOn(contractsApi, 'get').mockResolvedValue({ ...DETAIL, ...ENDED });
    renderView(OPS);
    await screen.findByRole('heading', { name: 'Brightline Retail · Sign Enterprise' });
    expect(screen.queryByRole('button', { name: 'Record amendment…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'End contract…' })).toBeNull();
  });

  it('Record amendment… creates a change request (commit disabled until amendment, reason and evidence are filled); a refusal shows in the dialog', async () => {
    vi.spyOn(contractsApi, 'list').mockResolvedValue({ contracts: [SUMMARY] });
    vi.spyOn(contractsApi, 'get').mockResolvedValue(DETAIL);
    const req = vi.spyOn(contractsApi, 'requestAmendment').mockRejectedValueOnce(new ApiError(409, 'open', 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', { reason: 'open_request_exists' })).mockResolvedValueOnce({ id: 'cr-new-0001', state: 'PENDING_APPROVAL' });
    renderView(OPS);
    fireEvent.click(await screen.findByRole('button', { name: 'Record amendment…' }));
    const dialog = screen.getByRole('dialog', { name: 'Record amendment · CT-2024-007' });
    const commit = within(dialog).getByRole('button', { name: 'Submit for approval' });
    expect(commit).toBeDisabled();
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Amendment'));
    fireEvent.change(within(dialog).getByLabelText('Amendment'), { target: { value: 'Allowance raised to 30,000 envelopes per month' } });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Seasonal volume' } });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Evidence'), { target: { value: 'Email 19 Oct' } });
    expect(commit).toBeEnabled();
    expect(within(dialog).getByText('Below threshold')).toBeInTheDocument();
    fireEvent.click(commit);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/already has an open change request/);
    fireEvent.click(commit);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(req).toHaveBeenLastCalledWith(DETAIL, { amendment: 'Allowance raised to 30,000 envelopes per month', reason: 'Seasonal volume', evidence: 'Email 19 Oct' });
  });

  it('End contract… needs the contract id typed back exactly; Esc closes and returns focus', async () => {
    vi.spyOn(contractsApi, 'list').mockResolvedValue({ contracts: [SUMMARY] });
    vi.spyOn(contractsApi, 'get').mockResolvedValue(DETAIL);
    const end = vi.spyOn(contractsApi, 'requestEnd').mockResolvedValue({ id: 'cr-end-0001', state: 'PENDING_APPROVAL' });
    renderView(OPS);
    const opener = await screen.findByRole('button', { name: 'End contract…' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'End contract · CT-2024-007' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Not renewed' } });
    fireEvent.change(within(dialog).getByLabelText('Evidence'), { target: { value: 'Notice 30 Sep' } });
    const commit = within(dialog).getByRole('button', { name: 'Submit for approval' });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'ct-2024-007' } });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'CT-2024-007' } });
    expect(commit).toBeEnabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(end).not.toHaveBeenCalled();
  });
});
