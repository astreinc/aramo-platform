import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  // Company Party/Role (ADR-0032, R7) — the requisition client picker shows
  // only companies with a CLIENT relationship, so the mock must carry one.
  relationships: [
    {
      id: 'rel-1', type: 'CLIENT', status: 'ACTIVE',
      effective_from: null, effective_to: null,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    },
  ],
  master_status: 'ACTIVE',
  communication_restricted: false,
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

// §4 — the review form is reached only via Draft or Import (no manual path).
// Import is deterministic + network-free (local parse), so tests paste a minimal
// requirement and click "Import Client Requisition" to reveal the grouped form.
async function openFormViaImport() {
  fireEvent.change(await screen.findByLabelText('Requisition intake'), {
    target: { value: 'Contract role, remote. Review the details.' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: /import client requisition/i }),
  );
  await screen.findByLabelText('Job title');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NewRequisitionView (New Requisition — mockup parity)', () => {
  it('§4: opens on the intake lane with Draft/Import and NO manual-entry path', async () => {
    mockApi();
    renderView(['requisition:create']);
    expect(await screen.findByText('New requisition')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /draft with ai/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /import client requisition/i }),
    ).toBeInTheDocument();
    // §4 — the manual-entry link is removed; the form is only reached via
    // Draft or Import.
    expect(
      screen.queryByRole('button', { name: /enter the requisition manually/i }),
    ).toBeNull();
  });

  it('import reveals the grouped form and creates → navigates to detail', async () => {
    mockApi((url, method) => {
      if (url === '/v1/requisitions' && method === 'POST') {
        return json({ id: 'new-req', title: 'New Role' }, 201);
      }
      return null;
    });
    renderView(['requisition:create']);
    await openFormViaImport();
    fireEvent.change(await screen.findByLabelText('Job title'), {
      target: { value: 'New Role' },
    });
    // T10-B4/F-042 — the company selector is labelled "Company" (canonical entity).
    fireEvent.click(screen.getByRole('combobox', { name: 'Company' }));
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

  it('has no right-rail Matching / Duplicate / run-match cards (removed per prototype)', async () => {
    mockApi();
    renderView(['requisition:create']);
    await openFormViaImport();
    expect(screen.queryByText('Match results')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: /run match when created/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /create & run match/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Duplicate check')).not.toBeInTheDocument();
  });

  it('"View pasted source" opens a read-only drawer with the pasted text', async () => {
    mockApi();
    renderView(['requisition:create']);
    await openFormViaImport();
    fireEvent.click(screen.getByRole('button', { name: /view pasted source/i }));
    const drawer = screen.getByRole('dialog', { name: 'Pasted source' });
    expect(within(drawer).getByText(/Read-only/)).toBeInTheDocument();
    expect(within(drawer).getByText(/Contract role, remote/)).toBeInTheDocument();
    // Closing the drawer removes it; the form stays mounted (editable throughout).
    fireEvent.click(within(drawer).getByRole('button', { name: /close pasted source/i }));
    expect(screen.queryByRole('dialog', { name: 'Pasted source' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Job title')).toBeInTheDocument();
  });

  it('offers a non-AI "Import Client Requisition" action on the intake lane', async () => {
    mockApi();
    renderView(['requisition:create']);
    expect(
      await screen.findByRole('button', { name: /import client requisition/i }),
    ).toBeInTheDocument();
  });

  it('imports a pasted requirement WITHOUT AI: parsed fields, "Parsed" chips, no "AI draft", no intake call', async () => {
    const calls: string[] = [];
    mockApi((url, method) => {
      calls.push(`${method} ${url}`);
      return null;
    });
    renderView(['requisition:create']);
    fireEvent.change(await screen.findByLabelText('Requisition intake'), {
      target: {
        value:
          'Need a Senior Backend Engineer. Contract, Austin, TX or mostly remote. Nice to have gRPC.',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /import client requisition/i }));

    // The SAME manual form opens, prefilled from the parse (no loading spinner,
    // no network round-trip).
    expect(await screen.findByDisplayValue('Senior Backend Engineer')).toBeInTheDocument();
    // Honest provenance: parsed fields carry the "Parsed" chip and NEVER the
    // "AI draft" chip — client-stated facts are not dressed up as AI-authored.
    expect(screen.getAllByText('Parsed').length).toBeGreaterThan(0);
    expect(screen.queryByText('AI draft')).not.toBeInTheDocument();
    // The stated nice-to-have skill seeded an editable chip.
    expect(screen.getByText('gRPC')).toBeInTheDocument();
    // No AI: the AI intake endpoint was never called on this lane.
    expect(calls.some((c) => c.includes('/v1/requisitions/intake'))).toBe(false);
  });

  it('flips a parsed field from "Parsed" to "edited" when the recruiter edits it', async () => {
    mockApi();
    renderView(['requisition:create']);
    fireEvent.change(await screen.findByLabelText('Requisition intake'), {
      target: { value: 'Need a Senior Backend Engineer. Austin, TX.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /import client requisition/i }));
    const title = await screen.findByLabelText('Job title');
    expect(screen.getAllByText('Parsed').length).toBeGreaterThan(0);
    fireEvent.change(title, { target: { value: 'Staff Backend Engineer' } });
    expect(screen.getByText('edited')).toBeInTheDocument();
  });
});

describe('RATE_TYPE_VALUES — hand-mirror of the BE allowlist', () => {
  it('matches the BE rate-type closed set exactly (C2C|W2|1099|Any)', () => {
    expect([...RATE_TYPE_VALUES]).toEqual(['C2C', 'W2', '1099', 'Any']);
  });
});

describe('NewRequisitionView — shared-form create semantics (G2.5c)', () => {
  it('entering a Bill rate (max) sets the CONTRACT discriminator so the create body sends it', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      if (url.includes('/v1/companies') && method === 'GET') return json({ items: [ACME] });
      if (url.includes('/v1/contacts')) return json({ items: [] });
      if (url.endsWith('/v1/requisitions') && method === 'POST') {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ id: 'r1', title: 'Rate Role' }, 201);
      }
      return new Response('{}', { status: 404 });
    });
    // compensation:view:bill makes Bill rate (max) a visible, writable field.
    renderView(['requisition:create', 'compensation:view:bill']);
    await openFormViaImport();
    fireEvent.change(await screen.findByLabelText('Job title'), {
      target: { value: 'Rate Role' },
    });
    fireEvent.click(screen.getByRole('combobox', { name: 'Company' }));
    fireEvent.click(await screen.findByRole('option', { name: /Acme Corp/i }));
    fireEvent.change(screen.getByLabelText('Bill rate (max)'), {
      target: { value: '85' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^create requisition$/i }));
    await waitFor(() => expect(bodies.length).toBe(1));
    // The discriminator (compensation_model=CONTRACT) was set → the bill rate ships.
    expect(bodies[0]['bill_rate_amount']).toBe('85');
  });
});
