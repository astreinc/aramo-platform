import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GuaranteeTermsPanel } from './GuaranteeTermsPanel';
import type { GuaranteeTermVersionView } from './guarantee-terms-types';

// Track 7 / T7-P5 — least-visibility gating for the requisition Guarantee Terms tab body.
// Read follows placement:permanent:read (no read issued, whole panel hidden without it); the
// create/revise actions follow placement:permanent:terms:write (hidden without it). The panel
// is (tenant, requisition)-keyed reusable terms — distinct from the immutable per-placement
// snapshot; revisions apply to FUTURE activations only (copy asserted).

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}

const READ = makeSession(['placement:permanent:read']);
const READ_WRITE = makeSession(['placement:permanent:read', 'placement:permanent:terms:write']);
const NO_READ = makeSession(['requisition:read']);

function version(overrides: Partial<GuaranteeTermVersionView> = {}): GuaranteeTermVersionView {
  return {
    id: 'v1',
    tenant_id: 't1',
    requisition_id: 'r1',
    effective_from: '2026-06-01',
    effective_to: null,
    guarantee_duration_days: 90,
    remedy_policy: 'REPLACEMENT',
    guarantee_exposure_amount: '10000.00',
    currency: 'USD',
    source_type: 'MANUAL',
    source_reference: null,
    source_version: null,
    recorded_by: 'u1',
    recorded_at: '2026-06-01T00:00:00.000Z',
    supersedes_version_id: null,
    correlation_id: null,
    ...overrides,
  };
}

let listFn: ReturnType<typeof vi.fn>;
let effectiveFn: ReturnType<typeof vi.fn>;

function renderPanel(session: Session) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <GuaranteeTermsPanel requisitionId="r1" sessionOverride={session} listFn={listFn} effectiveFn={effectiveFn} nowMs={Date.UTC(2026, 7, 15)} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in test'))));
  listFn = vi.fn().mockResolvedValue({ items: [version()] });
  effectiveFn = vi.fn().mockResolvedValue(version());
});

describe('GuaranteeTermsPanel — least-visibility gating', () => {
  it('hides the whole panel and issues NO read without placement:permanent:read', () => {
    renderPanel(NO_READ);
    expect(screen.queryByTestId('guarantee-terms-panel')).toBeNull();
    expect(listFn).not.toHaveBeenCalled();
    expect(effectiveFn).not.toHaveBeenCalled();
  });

  it('read-only: renders the timeline + the future-activations copy, but NO create/revise action', async () => {
    renderPanel(READ);
    expect(await screen.findByTestId('guarantee-terms-panel')).toBeInTheDocument();
    expect(listFn).toHaveBeenCalledWith('r1');
    expect(screen.getByText(/Revisions apply to future permanent-placement\s+activations only/i)).toBeInTheDocument();
    expect(screen.queryByTestId('guarantee-terms-create-action')).toBeNull();
    expect(screen.queryByTestId('guarantee-terms-revise-action')).toBeNull();
  });

  it('write + existing versions ⇒ a Revise action', async () => {
    renderPanel(READ_WRITE);
    expect(await screen.findByTestId('guarantee-terms-revise-action')).toBeInTheDocument();
    expect(screen.queryByTestId('guarantee-terms-create-action')).toBeNull();
  });

  it('write + NO versions ⇒ a Create initial terms action', async () => {
    listFn.mockResolvedValue({ items: [] });
    effectiveFn.mockRejectedValue(new Error('404'));
    renderPanel(READ_WRITE);
    expect(await screen.findByTestId('guarantee-terms-create-action')).toBeInTheDocument();
    expect(screen.queryByTestId('guarantee-terms-revise-action')).toBeNull();
  });

  it('an effective 404 is a legit empty state, not an error', async () => {
    listFn.mockResolvedValue({ items: [] });
    effectiveFn.mockRejectedValue(new Error('404'));
    renderPanel(READ);
    await waitFor(() => expect(screen.queryByTestId('guarantee-terms-loading')).toBeNull());
    expect(screen.queryByText(/could not load guarantee terms/i)).toBeNull();
  });
});
