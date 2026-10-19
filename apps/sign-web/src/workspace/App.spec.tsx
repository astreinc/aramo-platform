import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { readinessOf } from './pages/readiness';
import { clampBox, toPdf, toTopLeft } from './geometry';
import type { EnvelopeDetail, SenderContext } from './api';

// PX-1 — the Sign sender console. The backend context decides the workspace; the
// URL prefix never authorizes. Refusal states for an unentitled tenant and a
// user without a Sign role; sending UI only when the backend says can_send.

vi.mock('./pdf', () => ({ loadPdf: vi.fn() }));

const SESSION = { sub: 'u1', consumer_type: 'esign', tenant_id: 't1', scopes: ['esign:envelope:read', 'esign:envelope:create', 'esign:envelope:send'], iat: 0, exp: 9_999_999_999 };

function ctx(over: Partial<SenderContext> = {}): SenderContext {
  return {
    user: { id: 'u1', email: 'priya@northwind.test', display_name: 'Priya Nair' },
    tenant: { id: 't1', name: 'Northwind Staffing', kind: 'BUSINESS' },
    workspace: 'sign',
    permissions: { read: true, create: true, send: true },
    can_send: true,
    personal_sending_enabled: false,
    organization_url: 'https://northwind.aramo.ai/org/profile',
    app_home_url: 'https://northwind.aramo.ai/',
    ...over,
  };
}

const SUMMARY = {
  counts: { draft: 1, sent: 1, in_progress: 1, completed: 2, declined: 1, voided: 0, expired: 1 },
  awaiting_signatures: 2,
  completed_this_month: 2,
  declined_or_expired: 2,
  months: [{ month: '2026-10', sent: 4, completed: 2, declined_or_expired: 1 }],
  completion_rate: 50,
  expiring_soon: [],
  signing_window_days: 7,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(context: SenderContext | { error: { code: string }; status: number }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/esign/session')) return json(SESSION);
    if (url.endsWith('/v1/esign/sender/context')) return 'status' in context ? json({ error: context.error }, context.status) : json(context);
    if (url.endsWith('/v1/esign/sender/summary')) return json(SUMMARY);
    if (url.includes('/v1/esign/sender/envelopes')) return json({ items: [{ id: 'e1', subject: 'Vendor NDA — BluePeak', status: 'COMPLETED', created_at: '2026-10-01T00:00:00Z', sent_at: '2026-10-01T00:00:00Z', completed_at: '2026-10-02T00:00:00Z', last_activity_at: '2026-10-02T00:00:00Z', document_count: 1, recipients: [{ id: 's1', name: 'Sam Rivera', email: 'sam@x.test', status: 'SIGNED' }] }], counts: { COMPLETED: 1 } });
    return json({ items: [] });
  });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('Sign workspace App', () => {
  beforeEach(() => configureAuthConsumer('esign'));
  afterEach(() => vi.unstubAllGlobals());

  it('/ resolves the BUSINESS workspace from the backend and shows the dashboard', async () => {
    vi.stubGlobal('fetch', stubFetch(ctx()));
    renderAt('/');
    expect(await screen.findByText('Recent envelopes')).toBeInTheDocument();
    expect(screen.getByText('Vendor NDA — BluePeak')).toBeInTheDocument();
    expect(screen.getByTestId('new-envelope')).toHaveAttribute('href', '/sign/envelopes/new');
  });

  it('a PERSONAL account landing on /sign is redirected to /personal, with sending disabled', async () => {
    vi.stubGlobal('fetch', stubFetch(ctx({ workspace: 'personal', can_send: false, tenant: { id: 't1', name: 'Priya Nair', kind: 'PERSONAL' }, organization_url: null })));
    renderAt('/sign/reports');
    expect(await screen.findByTestId('personal-note')).toBeInTheDocument();
    expect(screen.getByTestId('new-envelope-disabled')).toBeDisabled();
    expect(screen.queryByText('Reports')).not.toBeInTheDocument();
  });

  it('a tenant without the Sign subscription sees the not-part-of-your-plan page', async () => {
    vi.stubGlobal('fetch', stubFetch({ error: { code: 'TENANT_CAPABILITY_NOT_ENTITLED' }, status: 403 }));
    renderAt('/sign');
    expect(await screen.findByTestId('state-not-entitled')).toHaveTextContent('isn’t part of your plan');
  });

  it('a user without a Sign role sees the no-access page', async () => {
    vi.stubGlobal('fetch', stubFetch({ error: { code: 'INSUFFICIENT_PERMISSIONS' }, status: 403 }));
    renderAt('/sign');
    expect(await screen.findByTestId('state-no-access')).toBeInTheDocument();
  });

  it('a read-only (viewer) business user gets no New envelope action', async () => {
    vi.stubGlobal('fetch', stubFetch(ctx({ can_send: false, permissions: { read: true, create: false, send: false } })));
    renderAt('/sign/envelopes');
    await waitFor(() => expect(screen.getByTestId('new-envelope-disabled')).toBeDisabled());
    expect(screen.queryByRole('link', { name: '+ New envelope' })).not.toBeInTheDocument();
  });

  // Sign Unified Product S-1 — Members appears only for holders of esign:member:manage.
  it('Settings shows Members only when the backend grants member administration', async () => {
    vi.stubGlobal('fetch', stubFetch(ctx({ permissions: { read: true, create: true, send: true, members: true } })));
    const first = renderAt('/sign/settings/personal');
    expect(await screen.findByRole('link', { name: 'Members' })).toBeInTheDocument();
    first.unmount();
    vi.stubGlobal('fetch', stubFetch(ctx()));
    renderAt('/sign/settings/personal');
    await screen.findByTestId('settings-account');
    expect(screen.queryByRole('link', { name: 'Members' })).not.toBeInTheDocument();
  });

  // Sign Unified Product S-3 — ATS envelopes are listed with their origin.
  it('an envelope sent by the ATS is marked "From Aramo ATS" in the list', async () => {
    const base = stubFetch(ctx());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/v1/esign/sender/envelopes')) {
          return json({ items: [{ id: 'e9', subject: 'Right to Represent — Jordan', status: 'SENT', created_at: '2026-10-01T00:00:00Z', sent_at: '2026-10-01T00:00:00Z', completed_at: null, last_activity_at: '2026-10-01T00:00:00Z', document_count: 1, source_application: 'aramo-ats', recipients: [] }], counts: { SENT: 1 } });
        }
        return base(input, init);
      }),
    );
    renderAt('/sign/envelopes');
    expect(await screen.findByText('From Aramo ATS')).toBeInTheDocument();
  });

  it('Templates is labelled a future capability with no create action', async () => {
    vi.stubGlobal('fetch', stubFetch(ctx()));
    renderAt('/sign/templates');
    expect(await screen.findByText('Future capability')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Create template' })).toBeDisabled();
  });
});

describe('send readiness (mirrors the server)', () => {
  const base = { documents: [{ id: 'd1' }], recipients: [{ id: 's1', name: 'Alex' }, { id: 's2', name: 'Priya' }], fields: [{ signer_id: 's1', field_type: 'SIGNATURE' }] } as unknown as EnvelopeDetail;
  it('every signer needs a signature field', () => {
    expect(readinessOf(base)).toMatchObject({ ok: false });
    expect(readinessOf(base).items.at(-1)?.t).toBe('Priya needs a signature field');
    expect(readinessOf({ ...base, fields: [...base.fields, { signer_id: 's2', field_type: 'SIGNATURE' }] } as unknown as EnvelopeDetail).ok).toBe(true);
  });
  it('needs a document and a signer', () => {
    expect(readinessOf({ documents: [], recipients: [], fields: [] } as unknown as EnvelopeDetail).items.map((i) => i.t)).toEqual(['Add at least one document', 'Add at least one signer']);
  });
});

describe('editor geometry (top-left editor ⇄ bottom-left PDF)', () => {
  it('round-trips a box and matches the stamper frame', () => {
    const tl = { x: 72, y: 100, width: 220, height: 48 };
    const pdf = toPdf(tl, 792);
    expect(pdf).toEqual({ x: 72, y: 644, width: 220, height: 48 });
    expect(toTopLeft(pdf, 792)).toEqual(tl);
  });
  it('clamps a box inside its page with a 14pt minimum', () => {
    expect(clampBox({ x: 600, y: -5, width: 220, height: 4 }, { width: 612, height: 792 })).toEqual({ x: 392, y: 0, width: 220, height: 14 });
  });
});
