import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, ToastProvider } from '@aramo/fe-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PolicyList, PolicyVersion } from '../commercial-governance/governance-api';

import { ChangeRequestDrawer, FINANCE_NOTES_RESTRICTED, RESTRICTED_FINANCIAL, YOUR_DETAILS } from './ChangeRequestDrawer';
import { commercialApi, type ChangeRequest, type ChangeRequestDetail } from './commercial-api';
import { chainName, expiresCell, splitEvidence, stateSteps, tabRows, timelineOf } from './commercial-model';
import { deadlineOf, type DeadlineSources } from './deadline';
import { ME_ID, NOW, OTHER_ID, POLICY_ID, detail, request } from './test-fixtures';

// CCP-UI-V12 — the v1.0 amendments on the Approvals inbox and the change-request drawer
// (CCP-UI v1.1 AM-3…AM-6, AM-8; v1.2 §17.1 D-1, D-4, §17.2) and the W-3 markers of the R3-W
// contract (reason_withheld, notes_withheld, payload.evidence_withheld).

const H = 3_600_000;
const POLICY_V2 = '019a0000-0000-7000-8000-0000000cc202';
const content = { format_version: 1, currency: 'USD', discount_escalation_threshold_bps: 2000, credit_escalation_threshold_minor: 50000, support_extension_max_days: 14, support_extension_frequency_window_days: 90, support_extension_cumulative_max_days: 30, support_extension_cumulative_window_days: 365, approval_expiry_hours: 72, past_due_grace_days: 7 };
const ver = (id: string, n: number, status: PolicyVersion['status'], extra: Record<string, unknown> = {}): PolicyVersion => ({
  id, version_number: n, status, content: { ...content, ...extra }, content_checksum: 'c'.repeat(64), note: null, created_by: null, created_at: '2026-01-01T00:00:00Z', activated_by: null, activated_at: null, retired_at: null, open_request: null, latest_request: null,
});
const policies = (withdrawFor?: string): PolicyList => ({
  versions: [ver(POLICY_ID, 1, 'ACTIVE'), { ...ver(POLICY_V2, 2, 'DRAFT', { apply_expiry_hours: 72 }), open_request: withdrawFor ? { id: withdrawFor, state: 'APPLY_FAILED', apply_actionable: true, withdraw_actionable: true } : null }],
  active_version_id: POLICY_ID,
  open_request: null,
  caller: { can_author: false, can_request_activation: false },
});
const SRC: DeadlineSources = { policies: policies(), nearHours: 12 };
const me = { id: ME_ID, name: 'Priya Shah' };

function renderDrawer(d: ChangeRequestDetail, o: { sources?: DeadlineSources; amountHolder?: boolean } = {}) {
  vi.spyOn(commercialApi, 'getChangeRequest').mockResolvedValue(d);
  return render(
    <ToastProvider>
      <MemoryRouter>
        <ChangeRequestDrawer id={d.request.id} me={me} tenantName={() => 'Northwind Logistics'} initial={d} onClose={() => undefined} onChanged={() => undefined} now={() => NOW} sources={o.sources ?? SRC} amountHolder={o.amountHolder ?? true} />
      </MemoryRouter>
    </ToastProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('CCP-UI-V12 model (AM-3, AM-4, AM-8; D-1, D-2)', () => {
  const approvedV2 = request({ id: 'a1', state: 'APPROVED', policy_version_id: POLICY_V2, approved_at: new Date(NOW.getTime() - 64 * H).toISOString(), requested_by: ME_ID });
  const approvedV1 = request({ id: 'a2', state: 'APPROVED', approved_at: new Date(NOW.getTime() - 2 * H).toISOString() });

  it('V12-M-1 the deadline is the creation policy’s apply_expiry_hours after approval; v1 declares none', () => {
    expect(deadlineOf(approvedV2, SRC)).toEqual({ applyBy: new Date(NOW.getTime() + 8 * H), policyVersion: 2, nearHours: 12 });
    expect(deadlineOf(approvedV1, SRC)).toEqual({ applyBy: null, policyVersion: 1, nearHours: 12 });
    expect(deadlineOf(approvedV1, { policies: null, nearHours: 12 })).toBeUndefined();
  });

  it('V12-M-2 the inbox cell: "Apply within n h" (amber under the configured lead), "No apply deadline", "Apply expired"', () => {
    expect(expiresCell(approvedV2, NOW, deadlineOf(approvedV2, SRC))).toEqual({ text: 'Apply within 8 h', tone: 'warn' });
    expect(expiresCell(approvedV2, NOW, deadlineOf(approvedV2, { ...SRC, nearHours: 6 }))).toEqual({ text: 'Apply within 8 h', tone: 'ink' });
    expect(expiresCell(approvedV1, NOW, deadlineOf(approvedV1, SRC))).toEqual({ text: 'No apply deadline', tone: 'ink' });
    expect(expiresCell(request({ id: 'x', state: 'APPLY_EXPIRED' }), NOW)).toEqual({ text: 'Apply expired', tone: 'danger' });
  });

  it('V12-M-3 tabs (AM-4): Waiting on me adds my Approved requests; All pending includes Approved; History excludes it', () => {
    const pending = request({ id: 'p' });
    const others = request({ id: 'o', state: 'APPROVED', approved_at: NOW.toISOString() });
    const all = [approvedV2, others, pending];
    expect(tabRows('me', all, new Set(), ME_ID).map((r) => r.id)).toEqual(['a1']);
    expect(tabRows('pending', all, new Set(), ME_ID).map((r) => r.id)).toEqual(['a1', 'o', 'p']);
    expect(tabRows('history', all, new Set(), ME_ID)).toEqual([]);
  });

  it('V12-M-4 the stepper: Apply expired is terminal after Applying; a withdrawal after a failed apply keeps Approved done', () => {
    const exp = stateSteps('APPLY_EXPIRED');
    expect(exp.map((s) => s.mark)).toEqual(['done', 'done', 'done', 'failed', 'todo', 'terminal']);
    expect(exp.at(-1)?.label).toBe('Apply expired');
    expect(stateSteps('WITHDRAWN', 'POLICY_ACTIVATE', { afterFail: true }).map((s) => s.mark)).toEqual(['done', 'done', 'done', 'failed', 'todo', 'terminal']);
    expect(stateSteps('APPROVED', 'CREDIT', { approvedLabel: 'Approved · apply by 2026-10-24 22:00 UTC' })[2]?.label).toBe('Approved · apply by 2026-10-24 22:00 UTC');
  });

  it('V12-M-5 AM-8: an escalated support extension carries "Extension outside policy bounds"; a removal does not', () => {
    expect(chainName(request({ id: 'e', action_type: 'SUPPORT_EXTENSION', payload: { requested_days: 20 } }))).toBe('Extension outside policy bounds');
    expect(chainName(request({ id: 'r', action_type: 'SUPPORT_EXTENSION', payload: { operation: 'REMOVE' } }))).toBe('Below threshold');
  });

  it('V12-M-6 the timeline names the apply deadline; evidence splits from the reason (TD-MERGE-10)', () => {
    const ev = timelineOf(detail(approvedV2, { signed: 1 }), me, deadlineOf(approvedV2, SRC));
    expect(ev.find((e) => e.id === 'approved')).toMatchObject({ label: 'Approved · apply by 2026-10-24 22:00 UTC', actor: { label: 'All steps signed · only the requester can apply' } });
    expect(splitEvidence('Q3 review\n\nEvidence: FIN-2026-Q3')).toEqual({ reason: 'Q3 review', evidence: 'FIN-2026-Q3' });
    expect(splitEvidence('plain')).toEqual({ reason: 'plain', evidence: '' });
  });
});

describe('CCP-UI-V12 drawer (AM-5, AM-6; D-1, D-4)', () => {
  const approved = (o: Partial<ChangeRequest> = {}) => request({ id: '0f3a91c2-0000-7000-8000-00000000aa01', state: 'APPROVED', policy_version_id: POLICY_V2, approved_at: new Date(NOW.getTime() - 64 * H).toISOString(), ...o });

  it('V12-D-1 the requester with apply_actionable sees Apply; the Apply window fact names the deadline', async () => {
    const d = { ...detail(approved({ requested_by: ME_ID }), { signed: 1 }), apply_actionable: true };
    const apply = vi.spyOn(commercialApi, 'apply').mockResolvedValue({ request: d.request });
    renderDrawer(d);
    const drawer = await screen.findByTestId('cr-drawer');
    expect(within(drawer).getByText('Apply window')).toBeInTheDocument();
    expect(within(drawer).getByText('Apply by 2026-10-24 22:00 UTC · 8 h left · requester applies')).toBeInTheDocument();
    // The stepper chip and the timeline event.
    expect(within(drawer).getAllByText('Approved · apply by 2026-10-24 22:00 UTC')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith(d.request.id, 'CREDIT'));
  });

  it('V12-D-2 not actionable → no Apply; another person reads the requester-only footnote', async () => {
    renderDrawer(detail(approved(), { signed: 1 }));
    await screen.findByTestId('cr-drawer');
    expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
    expect(screen.getByTestId('cr-footnote').textContent).toMatch(/^Only the requester, .+, can apply this request\.$/);
  });

  it('V12-D-3 under a policy without an apply window: "No apply deadline (policy v1)"', async () => {
    renderDrawer(detail(approved({ policy_version_id: POLICY_ID }), { signed: 1 }));
    expect(await screen.findByText('No apply deadline (policy v1) · requester applies')).toBeInTheDocument();
  });

  it('V12-D-4 Apply expired: the window closed line and the footnote; Retry apply only when actionable', async () => {
    const { unmount } = renderDrawer(detail(approved({ state: 'APPLY_EXPIRED' }), { signed: 1 }));
    expect(await screen.findByText('Apply window closed 2026-10-24 22:00 UTC — make a new request')).toBeInTheDocument();
    expect(screen.getByTestId('cr-footnote')).toHaveTextContent('The apply window closed. Make a new request to try again.');
    unmount();
    renderDrawer({ ...detail(approved({ state: 'APPLY_FAILED', requested_by: ME_ID }), { signed: 1 }), apply_actionable: true });
    expect(await screen.findByRole('button', { name: 'Retry apply' })).toBeInTheDocument();
  });

  it('V12-D-5 D-4: the requester of a failed policy activation withdraws it; both refusals render inline', async () => {
    const id = '0f3a91c2-0000-7000-8000-00000000aa05';
    const r = approved({ id, action_type: 'POLICY_ACTIVATE', tenant_id: null, payload: { policy_version_id: POLICY_V2 }, state: 'APPLY_FAILED', requested_by: ME_ID });
    const withdraw = vi
      .spyOn(commercialApi, 'withdraw')
      .mockRejectedValueOnce(new ApiError(409, 'busy', 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', { reason: 'apply_in_progress' }))
      .mockRejectedValueOnce(new ApiError(409, 'applied', 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', { reason: 'already_applied' }));
    renderDrawer({ ...detail(r, { signed: 1 }), apply_actionable: true }, { sources: { policies: policies(id), nearHours: 12 } });
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw…' }));
    const dialog = await screen.findByRole('dialog', { name: /^Withdraw .+ · Activate policy v2$/ });
    expect(within(dialog).getByText('This request ends. Activating this version again needs a new request.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw request' }));
    expect(await within(dialog).findByText('An apply is still in progress. Try again shortly.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw request' }));
    expect(await within(dialog).findByText('This activation was applied. It can’t be withdrawn.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Withdraw request' })).toBeDisabled();
    expect(withdraw).toHaveBeenCalledTimes(2);
  });

  it('V12-D-6 no Withdraw… without the policy read’s withdraw_actionable', async () => {
    const r = approved({ action_type: 'POLICY_ACTIVATE', tenant_id: null, state: 'APPLY_FAILED', requested_by: ME_ID });
    renderDrawer({ ...detail(r, { signed: 1 }), apply_actionable: true });
    await screen.findByRole('button', { name: 'Retry apply' });
    expect(screen.queryByRole('button', { name: 'Withdraw…' })).toBeNull();
  });
});

describe('CCP-UI-V12 drawer — W-3 (R3-W markers) and §17.2 amounts', () => {
  const credit = (o: Partial<ChangeRequest>) => request({ id: '0f3a91c2-0000-7000-8000-00000000bb01', ...o });

  it('V12-W3-1 another non-holder: reason_withheld → reason and evidence restricted', async () => {
    const r = credit({ reason: undefined, reason_withheld: 'FINANCE_SCOPE_REQUIRED', notes_withheld: 'FINANCE_SCOPE_REQUIRED', payload: { currency: 'USD', amount_withheld: 'FINANCE_SCOPE_REQUIRED' } });
    renderDrawer(detail(r), { amountHolder: false });
    const block = await screen.findByTestId('cr-reason-block');
    expect(within(block).getAllByText(RESTRICTED_FINANCIAL)).toHaveLength(2);
    expect(screen.getByTestId('cr-drawer')).not.toHaveTextContent('Envelopes failed');
    expect(screen.getAllByLabelText('Amount withheld: finance access required').length).toBeGreaterThan(0);
  });

  it('V12-W3-2 the requester without amount access sees their own text as "Your request details" and the notes notice', async () => {
    const r = credit({ requested_by: ME_ID, reason: 'Incident credit\n\nEvidence: INC-77', notes_withheld: 'FINANCE_SCOPE_REQUIRED' });
    renderDrawer(detail(r), { amountHolder: false });
    expect(await screen.findByText(YOUR_DETAILS)).toBeInTheDocument();
    expect(screen.getByText('Incident credit')).toBeInTheDocument();
    expect(screen.getByTestId('cr-evidence')).toHaveTextContent('INC-77');
    expect(screen.getByTestId('cr-finance-notes-restricted')).toHaveTextContent(FINANCE_NOTES_RESTRICTED);
  });

  it('V12-W3-3 a REFUND’s payload.evidence_withheld restricts the evidence only', async () => {
    const r = credit({ action_type: 'REFUND', reason: 'Duplicate charge\n\nEvidence: hidden', payload: { evidence_withheld: 'FINANCE_SCOPE_REQUIRED' }, requested_by: OTHER_ID });
    renderDrawer(detail(r), { amountHolder: false });
    expect(await screen.findByTestId('cr-evidence')).toHaveTextContent(RESTRICTED_FINANCIAL);
    expect(screen.getByText('Duplicate charge')).toBeInTheDocument();
  });

  it('V12-W3-4 a non-financial request is unchanged for a non-holder', async () => {
    const r = credit({ action_type: 'SUBSCRIPTION_CHANGE', payload: {}, reason: 'Two regional teams.' });
    renderDrawer(detail(r), { amountHolder: false });
    expect(await screen.findByText('Two regional teams.')).toBeInTheDocument();
    expect(screen.queryByText(RESTRICTED_FINANCIAL)).toBeNull();
    expect(screen.queryByText(YOUR_DETAILS)).toBeNull();
  });
});
