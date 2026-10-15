import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TechnicalScreeningView, TRUST_STATUS_LABEL, publicationLabel } from './TechnicalScreeningView';
import * as api from './technical-screening-api';
import type { ScreeningPublication, ScreeningSessionDetail } from './technical-screening-api';

// TIP-E2E INC-3 (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §5/§11) — presentation tests for
// the manual Technical Screening workspace. The API is mocked; every lifecycle
// rule is server-side — this proves the FE renders state honestly, gates
// controls by scope, sends the exact confirmed set + version, and reloads on 409.

vi.mock('./technical-screening-api');
const h = vi.hoisted(() => ({ scopes: [] as string[] }));
vi.mock('@aramo/fe-foundation', async (importActual) => {
  const actual = await importActual<typeof import('@aramo/fe-foundation')>();
  return {
    ...actual,
    useSession: () => ({
      status: 'authenticated' as const,
      session: { sub: 'u1', consumer_type: 'recruiter' as const, tenant_id: 't1', scopes: h.scopes, iat: 0, exp: 9_999_999_999 },
    }),
    hasScope: (s: { scopes?: string[] } | null, scope: string) => s?.scopes?.includes(scope) ?? false,
  };
});

const ALL = ['screening:read', 'screening:create', 'screening:edit', 'screening:confirm'];
const NOW = new Date('2026-10-15T10:00:00Z').toISOString();

function session(over: Partial<ScreeningSessionDetail['session']> = {}): ScreeningSessionDetail['session'] {
  return {
    id: 's1', talent_record_id: 't-1', interaction_id: null, state: 'DRAFT', version: 2,
    created_at: NOW, updated_at: NOW, created_by_actor_id: 'u1', confirmed_by_actor_id: null,
    confirmed_at: null, confirmed_version: null, voided_by_actor_id: null, voided_at: null, void_reason: null,
    ...over,
  };
}
const finding = {
  id: 'f1', skill_raw: 'Kubernetes', basis: 'DEMONSTRATED' as const,
  observation_raw: 'Explained disruption budgets.', demonstration_raw: 'Drained a node live.',
  limitations_raw: null, created_at: NOW, updated_at: NOW,
};
function pub(over: Partial<ScreeningPublication> = {}): ScreeningPublication {
  return {
    id: 'p1', finding_id: 'f1', evidence_record_id: 'e1', state: 'PUBLISHED', attempt_count: 1,
    last_attempt_at: NOW, last_error_code: null, published_at: NOW, created_at: NOW, trust_status: 'VALID', ...over,
  };
}

function renderAt() {
  return render(
    <MemoryRouter initialEntries={['/talent/t-1/screening']}>
      <Routes>
        <Route path="/talent/:talentId/screening" element={<TechnicalScreeningView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TechnicalScreeningView', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.scopes = [...ALL];
  });

  it('shows the honest empty state and gates "Start screening" on screening:create', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [] });
    h.scopes = ['screening:read'];
    renderAt();
    expect(await screen.findByText('No technical screenings yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start screening' })).toBeNull();
    expect(screen.getByText(/Manual record/)).toBeTruthy();
    expect(screen.queryByText(/\bAI\b|\blive\b/)).toBeNull();
  });

  it('a DRAFT shows findings with recruiter-honest basis copy and edit controls', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [session()] });
    vi.mocked(api.getScreeningSession).mockResolvedValue({ session: session(), findings: [finding], publications: [] });
    renderAt();
    expect(await screen.findByText('Kubernetes')).toBeTruthy();
    expect(screen.getAllByText('Observed by the recruiter (not independently verified)').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Add finding' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review and confirm' })).toBeTruthy();
  });

  it('confirm requires the attestation and sends the exact finding set + version', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [session()] });
    vi.mocked(api.getScreeningSession).mockResolvedValue({ session: session(), findings: [finding], publications: [] });
    vi.mocked(api.confirmScreeningSession).mockResolvedValue({
      session: session({ state: 'CONFIRMED', version: 3 }), findings: [finding], publications: [pub()],
    });
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Review and confirm' }));
    const confirmBtn = await screen.findByRole('button', { name: 'Confirm findings' });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(api.confirmScreeningSession).toHaveBeenCalledWith('s1', 2, ['f1']));
    expect(await screen.findByText('Published')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add finding' })).toBeNull();
  });

  it('a 409 reloads the session and says so', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [session()] });
    vi.mocked(api.getScreeningSession).mockResolvedValue({ session: session(), findings: [finding], publications: [] });
    vi.mocked(api.removeScreeningFinding).mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(/changed since you opened it/)).toBeTruthy();
    expect(vi.mocked(api.getScreeningSession).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a CONFIRMED session is read-only; a PENDING intent offers retry to a confirm holder', async () => {
    const confirmed = session({ state: 'CONFIRMED', version: 3 });
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [confirmed] });
    vi.mocked(api.getScreeningSession).mockResolvedValue({
      session: confirmed, findings: [finding], publications: [pub({ state: 'PENDING', trust_status: null, published_at: null })],
    });
    renderAt();
    expect(await screen.findByRole('button', { name: 'Retry publishing' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull();
  });

  it('trust-status labels are honest — "corrected" is never shown (directive §5)', () => {
    expect(Object.values(TRUST_STATUS_LABEL).some((l) => /corrected/i.test(l) && !/not corrected/i.test(l))).toBe(false);
    expect(publicationLabel(pub({ trust_status: 'REVOKED' })).text).toBe('Withdrawn after dispute — not corrected');
    expect(publicationLabel(pub({ trust_status: 'DISPUTED' })).text).toBe('Contested — under review');
    expect(publicationLabel(pub({ state: 'CONFLICT', trust_status: null })).text).toMatch(/operator action/);
    const old = new Date(Date.parse(NOW) - 11 * 60 * 1000).toISOString();
    expect(publicationLabel(pub({ state: 'PENDING', last_attempt_at: old, trust_status: null }), Date.parse(NOW)).text).toMatch(/delayed/);
  });
});
