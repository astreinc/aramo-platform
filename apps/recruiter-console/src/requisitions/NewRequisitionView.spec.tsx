import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import { RequisitionCreateView } from './RequisitionCreateView';
import { RATE_TYPE_VALUES } from './types';

function makeSession(scopes: string[]): Session {
  return {
    sub: 'u1',
    consumer_type: 'recruiter',
    tenant_id: 't',
    scopes,
    iat: 0,
    exp: 0,
  };
}

const ACME = {
  id: 'co-1',
  tenant_id: 't',
  site_id: null,
  name: 'Acme Corp',
  address: null,
  address2: null,
  city: null,
  state: null,
  zip: null,
  phone1: null,
  phone2: null,
  fax_number: null,
  url: null,
  key_technologies: null,
  notes: null,
  is_hot: false,
  billing_contact_id: null,
  owner_id: null,
  entered_by_id: null,
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
};

function mockApi(
  overrides: (url: string, method: string) => Response | null = () => null,
): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    const o = overrides(url, method);
    if (o !== null) return o;
    if (url.includes('/v1/companies') && method === 'GET') {
      return json({ items: [ACME] });
    }
    if (url.includes('/v1/contacts')) return json({ items: [] });
    return new Response('{}', { status: 404 });
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderView(scopes: string[]) {
  render(
    <MemoryRouter initialEntries={['/requisitions/new']}>
      <Routes>
        <Route
          path="/requisitions/new"
          element={<RequisitionCreateView sessionOverride={makeSession(scopes)} />}
        />
        <Route
          path="/requisitions/:reqId"
          element={<p data-testid="detail">DETAIL</p>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NewRequisitionView (New Requisition — mockup parity)', () => {
  it('opens on the AI intake lane with a manual fallback', async () => {
    mockApi();
    renderView(['requisition:create']);
    expect(await screen.findByText('New requisition')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /draft with ai/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /enter the requisition manually/i }),
    ).toBeInTheDocument();
  });

  it('manual entry reveals the grouped form and creates → navigates to detail', async () => {
    mockApi((url, method) => {
      if (url === '/v1/requisitions' && method === 'POST') {
        return json({ id: 'new-req', title: 'New Role' }, 201);
      }
      return null;
    });
    renderView(['requisition:create']);
    fireEvent.click(
      await screen.findByRole('button', { name: /enter the requisition manually/i }),
    );
    fireEvent.change(await screen.findByLabelText('Job title'), {
      target: { value: 'New Role' },
    });
    fireEvent.click(screen.getByRole('combobox', { name: 'Client' }));
    fireEvent.click(await screen.findByRole('option', { name: /Acme Corp/i }));
    fireEvent.click(screen.getByRole('button', { name: /^create requisition$/i }));
    // The success screen confirms the create; "Open requisition" then navigates.
    expect(await screen.findByText(/New Role created/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /open requisition/i }));
    await waitFor(() => {
      expect(screen.getByTestId('detail')).toBeInTheDocument();
    });
  });

  it('AI draft populates editable fields tagged “AI draft” and seeds skills', async () => {
    mockApi((url, method) => {
      if (url.includes('/v1/requisitions/intake') && method === 'POST') {
        return json({
          fields: { title: 'Senior Backend Engineer', rate_type: 'C2C', city: 'Austin' },
          jd_text: 'Build high-throughput services.',
          required_skills: [{ name: 'Go' }, { name: 'Kubernetes' }],
          nice_to_have_skills: [{ name: 'gRPC' }],
          ai_draft_audit_record_id: 'aud-1',
        });
      }
      return null;
    });
    renderView(['requisition:create']);
    fireEvent.change(
      await screen.findByLabelText('Requisition intake'),
      { target: { value: 'Need a senior backend engineer, Go, C2C, Austin.' } },
    );
    fireEvent.click(screen.getByRole('button', { name: /draft with ai/i }));

    expect(await screen.findByDisplayValue('Senior Backend Engineer')).toBeInTheDocument();
    // Provenance: AI-populated fields carry the honest "AI draft" chip.
    expect(screen.getAllByText('AI draft').length).toBeGreaterThan(0);
    // The drafted requirement skills seed the editable chips.
    expect(screen.getByText('Go')).toBeInTheDocument();
    expect(screen.getByText('gRPC')).toBeInTheDocument();
  });

  it('surfaces an honest failure (never a fabricated draft) on provider outage', async () => {
    mockApi((url, method) => {
      if (url.includes('/v1/requisitions/intake') && method === 'POST') {
        return json(
          { error: { code: 'AI_PROVIDER_UNAVAILABLE', message: 'down' } },
          502,
        );
      }
      return null;
    });
    renderView(['requisition:create']);
    fireEvent.change(await screen.findByLabelText('Requisition intake'), {
      target: { value: 'Need a backend engineer.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /draft with ai/i }));
    // Honest failure state — an AI outage is surfaced as "AI drafting is
    // unavailable" (NOT a fabricated draft, NOT a misleading create error),
    // steering to the always-available manual lane.
    expect(
      await screen.findByText(/ai drafting is unavailable/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Job title')).not.toBeInTheDocument();
  });

  it('reserves matching as a stored flag + a disabled seam (no scores)', async () => {
    mockApi();
    renderView(['requisition:create']);
    fireEvent.click(
      await screen.findByRole('button', { name: /enter the requisition manually/i }),
    );
    // The match RESULT is a reserved seam — coming with Core, not a result.
    expect(screen.getByText('Match results')).toBeInTheDocument();
    expect(screen.getByText(/coming with aramo core/i)).toBeInTheDocument();
    // Toggling the run-match intent reveals the "Create & run match" action.
    expect(
      screen.queryByRole('button', { name: /create & run match/i }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: /run match when created/i }));
    expect(
      screen.getByRole('button', { name: /create & run match/i }),
    ).toBeInTheDocument();
  });
});

describe('RATE_TYPE_VALUES — hand-mirror of the BE allowlist', () => {
  it('matches the BE rate-type closed set exactly (C2C|W2|1099|Any)', () => {
    expect([...RATE_TYPE_VALUES]).toEqual(['C2C', 'W2', '1099', 'Any']);
  });
});
