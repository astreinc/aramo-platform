import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TalentCreateView } from './TalentCreateView';

// Add-Talent — the résumé-FIRST flow (LOCKED: Governed-LLM Resume Extraction +
// Deterministic Fallback). A résumé upload is REQUIRED (no manual-entry path);
// consent capture is governed separately (NOT here); the tenant's
// resume.extraction_mode selects the sole extractor SERVER-side and the FE
// consumes { mode, prefill, warning }. Provenance is honest about the extractor.

interface MockedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function installFetch(
  handler: (req: MockedRequest) =>
    | { status: number; body: unknown }
    | Promise<{ status: number; body: unknown }>,
): MockedRequest[] {
  const calls: MockedRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = init?.method ?? 'GET';
    let body: unknown = undefined;
    if (init?.body !== undefined && init.body !== null) {
      if (typeof init.body === 'string') {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
      } else {
        body = '__binary__';
      }
    }
    calls.push({ url, method, body });
    const res = await handler({ url, method, body });
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

function renderAt() {
  return render(
    <MemoryRouter initialEntries={['/talent/new']}>
      <Routes>
        <Route path="/talent/new" element={<TalentCreateView />} />
        <Route path="/talent" element={<p data-testid="list">talent list</p>} />
        <Route path="/talent/:id" element={<p data-testid="detail">talent detail</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function makeFile(name = 'resume.pdf', type = 'application/pdf'): File {
  return new File(['%PDF-1.4 stub'], name, { type });
}

// The résumé-first handler: presign → S3 PUT → draft-from-resume ({mode,prefill,
// parse_status,warning?}) → create → attach. Also answers the proactive
// duplicate-check (default: no match) so the effect never 404s.
function resumePlan(opts: {
  mode: 'governed_llm' | 'deterministic';
  parse_status?: 'parsed' | 'partial' | 'failed';
  prefill?: Record<string, unknown>;
  warning?: string;
  attachStatus?: number;
  duplicateMatch?: Record<string, unknown> | null;
}) {
  return (req: MockedRequest) => {
    if (req.url.includes('/v1/talent-records/resume-upload-url') && req.method === 'POST') {
      return {
        status: 200,
        body: {
          storage_key: 'tenant/draft/abc.pdf',
          presigned_url: 'https://s3-stub/abc?sig=xyz',
          expires_at: '2030-01-01T00:00:00Z',
        },
      };
    }
    if (req.url.startsWith('https://s3-stub/') && req.method === 'PUT') {
      return { status: 200, body: '' };
    }
    if (req.url.includes('/v1/talent-records/duplicate-check')) {
      return { status: 200, body: { match: opts.duplicateMatch ?? null } };
    }
    if (req.url.includes('/v1/talent-records/draft-from-resume') && req.method === 'POST') {
      return {
        status: 200,
        body: {
          mode: opts.mode,
          prefill: opts.prefill ?? {},
          parse_status: opts.parse_status ?? 'parsed',
          ...(opts.warning !== undefined ? { warning: opts.warning } : {}),
        },
      };
    }
    if (req.url === '/v1/talent-records' && req.method === 'POST') {
      return { status: 201, body: { id: 'tal-new', first_name: 'Ada', last_name: 'Lovelace' } };
    }
    if (req.url === '/v1/attachments' && req.method === 'POST') {
      return { status: opts.attachStatus ?? 201, body: { id: 'att-new', is_resume: true } };
    }
    return { status: 404, body: {} };
  };
}

async function uploadResume(name = 'resume.pdf') {
  fireEvent.change(screen.getByTestId('resume-file-input'), {
    target: { files: [makeFile(name)] },
  });
}

// Fill the required set the admission gate enforces (name may be prefilled).
function fillRequired(withName = true) {
  if (withName) {
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Lovelace' } });
  }
  fireEvent.change(screen.getByLabelText('Primary email'), { target: { value: 'ada@example.com' } });
  fireEvent.change(screen.getByLabelText('Mobile'), { target: { value: '555-0100' } });
  fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Austin' } });
  fireEvent.change(screen.getByLabelText('State'), { target: { value: 'TX' } });
  fireEvent.change(screen.getByLabelText('Work authorization'), { target: { value: 'US_CITIZEN' } });
  fireEvent.change(screen.getByLabelText('Desired rate'), { target: { value: '$80/hr' } });
}

function noConsentGrant(calls: MockedRequest[]) {
  expect(calls.find((c) => c.url.includes('/v1/consent/'))).toBeUndefined();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TalentCreateView — résumé-first intake (no manual path)', () => {
  it('opens on the résumé-required Step 1 — no "enter details manually"', () => {
    installFetch(() => ({ status: 200, body: {} }));
    renderAt();
    expect(screen.getByText('Add talent')).toBeInTheDocument();
    expect(screen.getByText(/A resume is required to create a Talent record/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enter details manually/i })).toBeNull();
  });
});

describe('TalentCreateView — deterministic mode', () => {
  it('parse → prefill (resume chip) → fill required → create + attach; NO consent', async () => {
    const calls = installFetch(
      resumePlan({
        mode: 'deterministic',
        prefill: { first_name: 'Ada', last_name: 'Lovelace', city: 'Austin', state: 'TX' },
      }),
    );
    renderAt();
    await uploadResume();
    await waitFor(() =>
      expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Ada'),
    );
    // Deterministic provenance chip.
    expect(screen.getAllByText('resume').length).toBeGreaterThan(0);
    fillRequired(false);
    fireEvent.click(screen.getByRole('button', { name: /create talent/i }));
    await waitFor(() =>
      expect(screen.getByText(/added to your talent/i)).toBeInTheDocument(),
    );
    expect(calls.find((c) => c.url === '/v1/attachments' && c.method === 'POST')).toBeDefined();
    noConsentGrant(calls);
    fireEvent.click(screen.getByRole('button', { name: /open profile/i }));
    expect(screen.getByTestId('detail')).toBeInTheDocument();
  });
});

describe('TalentCreateView — governed_llm mode', () => {
  it('clean skills flow into free-text key_skills with an AI-résumé chip; email/phone recruiter-entered', async () => {
    installFetch(
      resumePlan({
        mode: 'governed_llm',
        prefill: {
          first_name: 'Ada',
          last_name: 'Lovelace',
          city: 'Austin',
          state: 'TX',
          key_skills: 'C#, Azure SQL',
        },
      }),
    );
    renderAt();
    await uploadResume();
    await waitFor(() =>
      expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Ada'),
    );
    expect((screen.getByLabelText('Key skills') as HTMLTextAreaElement).value).toBe('C#, Azure SQL');
    // Governed provenance chip (distinct from the deterministic one, §16).
    expect(screen.getAllByText('resume · AI').length).toBeGreaterThan(0);
    // Email/phone were NOT LLM-proposed (redacted) — the recruiter fills them.
    expect((screen.getByLabelText('Primary email') as HTMLInputElement).value).toBe('');
  });

  it('LLM-unavailable warning is non-blocking — form still usable + retry', async () => {
    installFetch(
      resumePlan({
        mode: 'governed_llm',
        parse_status: 'partial',
        prefill: {},
        warning: 'Résumé extraction is temporarily unavailable. Please retry, or enter the details manually.',
      }),
    );
    renderAt();
    await uploadResume();
    await waitFor(() =>
      expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument(),
    );
    // The form is usable (manual entry proceeds); no silent deterministic switch.
    expect(screen.getByLabelText('First name')).toBeInTheDocument();
  });
});

describe('TalentCreateView — save gate + duplicate block', () => {
  it('Create is disabled until every required field is present (no attestation gate)', async () => {
    installFetch(resumePlan({ mode: 'deterministic', prefill: {} }));
    renderAt();
    await uploadResume();
    await waitFor(() => expect(screen.getByLabelText('First name')).toBeInTheDocument());
    const create = () => screen.getByRole('button', { name: /create talent/i });
    expect(create()).toBeDisabled();
    fillRequired(true);
    await waitFor(() => expect(create()).toBeEnabled());
  });

  it('a proactive duplicate match blocks Create (§ Delta-2)', async () => {
    installFetch(
      resumePlan({
        mode: 'deterministic',
        prefill: { first_name: 'Ada', last_name: 'Lovelace', city: 'Austin', state: 'TX' },
        duplicateMatch: { id: 'tal-dup', first_name: 'Ada', last_name: 'Lovelace', title: null, city: 'Austin', state: 'TX' },
      }),
    );
    renderAt();
    await uploadResume();
    await waitFor(() => expect(screen.getByLabelText('First name')).toBeInTheDocument());
    fillRequired(false);
    // The proactive check (debounced) surfaces the card + blocks Create.
    await waitFor(() =>
      expect(screen.getByText(/Possible existing Talent/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /create talent/i })).toBeDisabled();
  });
});

describe('TalentCreateView — attach soft-fail + cancel', () => {
  it('reaches success even if the attach POST fails (talent IS created)', async () => {
    installFetch(
      resumePlan({
        mode: 'deterministic',
        prefill: { first_name: 'Ada', last_name: 'Lovelace', city: 'Austin', state: 'TX' },
        attachStatus: 500,
      }),
    );
    renderAt();
    await uploadResume();
    await waitFor(() =>
      expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Ada'),
    );
    fillRequired(false);
    fireEvent.click(screen.getByRole('button', { name: /create talent/i }));
    await waitFor(() =>
      expect(screen.getByText(/added to your talent/i)).toBeInTheDocument(),
    );
  });

  it('Cancel on Step 1 navigates to /talent (no save)', () => {
    installFetch(() => ({ status: 200, body: {} }));
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('list')).toBeInTheDocument();
  });
});
