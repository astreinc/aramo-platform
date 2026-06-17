import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TalentCreateView } from './TalentCreateView';

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

// The full résumé-flow handler (presign → S3 PUT → parse → create → attach).
function resumePlan(
  parseStatus: 'parsed' | 'partial' | 'failed',
  prefill: Record<string, unknown>,
) {
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
    if (req.url.includes('/v1/talent-records/draft-from-resume') && req.method === 'POST') {
      return { status: 200, body: { prefill, parse_status: parseStatus } };
    }
    if (req.url === '/v1/talent-records' && req.method === 'POST') {
      return { status: 201, body: { id: 'tal-new', first_name: 'Ada', last_name: 'Lovelace' } };
    }
    if (req.url === '/v1/attachments' && req.method === 'POST') {
      return { status: 201, body: { id: 'att-new', is_resume: true } };
    }
    return { status: 404, body: {} };
  };
}

function fillName(first = 'Ada', last = 'Lovelace') {
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: first } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: last } });
}

function signAttestation() {
  fireEvent.click(screen.getByRole('checkbox'));
}

function noConsentGrant(calls: MockedRequest[]) {
  expect(calls.find((c) => c.url.includes('/v1/consent/'))).toBeUndefined();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TalentCreateView — intake + manual path', () => {
  it('shows the dropzone with stated-facts framing; manual entry opens the form', () => {
    installFetch(() => ({ status: 200, body: {} }));
    renderAt();
    expect(screen.getByText('New talent')).toBeInTheDocument();
    expect(screen.getByText(/shared tenant talent pool/i)).toBeInTheDocument();
    // No scoring/ranking claim — the moat assurance.
    expect(screen.getByText(/no scoring or ranking/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /enter details manually/i }));
    expect(screen.getByLabelText('First name')).toBeInTheDocument();
  });

  it('manual create: POST talent, NO attachment, NO consent grant, success → open profile', async () => {
    const calls = installFetch((req) => {
      if (req.url === '/v1/talent-records' && req.method === 'POST') {
        return { status: 201, body: { id: 'tal-m', first_name: 'Ada', last_name: 'Lovelace' } };
      }
      return { status: 404, body: {} };
    });
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: /enter details manually/i }));
    fillName();
    signAttestation();
    fireEvent.click(screen.getByRole('button', { name: /create talent/i }));
    await waitFor(() =>
      expect(screen.getByText(/added to your talent/i)).toBeInTheDocument(),
    );
    // No résumé → no attachment POST.
    expect(calls.find((c) => c.url === '/v1/attachments')).toBeUndefined();
    // Consent grants are DEFERRED — never fired (keying HALT).
    noConsentGrant(calls);
    // "Open profile" navigates to the detail.
    fireEvent.click(screen.getByRole('button', { name: /open profile/i }));
    expect(screen.getByTestId('detail')).toBeInTheDocument();
  });
});

describe('TalentCreateView — save gate', () => {
  it('Create is disabled until name + attestation are satisfied', () => {
    installFetch(() => ({ status: 200, body: {} }));
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: /enter details manually/i }));
    const create = () => screen.getByRole('button', { name: /create talent/i });
    expect(create()).toBeDisabled(); // no name, not attested
    fillName();
    expect(create()).toBeDisabled(); // name ok, still not attested
    signAttestation();
    expect(create()).toBeEnabled(); // required consent defaults satisfied
  });

  it('renders the deferred-consent + dedup + work/edu seams', () => {
    installFetch(() => ({ status: 200, body: {} }));
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: /enter details manually/i }));
    expect(screen.getByLabelText('Consent capture')).toBeInTheDocument();
    expect(screen.getByLabelText('Duplicate check')).toBeInTheDocument();
    expect(screen.getByLabelText('Work history & education')).toBeInTheDocument();
    // The grant is captured but not yet persisted — honest deferral copy.
    expect(screen.getByText(/provisioned after go-live/i)).toBeInTheDocument();
  });
});

describe('TalentCreateView — résumé path (rulings 1+2+3)', () => {
  it("'parsed': prefill populates + provenance chip; create+attach fires; no consent grant", async () => {
    const calls = installFetch(
      resumePlan('parsed', { first_name: 'Ada', last_name: 'Lovelace', email1: 'ada@example.com' }),
    );
    renderAt();
    fireEvent.change(screen.getByTestId('resume-file-input'), { target: { files: [makeFile()] } });
    await waitFor(() =>
      expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Ada'),
    );
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('ada@example.com');
    // Provenance: the prefilled fields carry a résumé chip.
    expect(screen.getAllByText('résumé').length).toBeGreaterThan(0);
    signAttestation();
    fireEvent.click(screen.getByRole('button', { name: /create talent/i }));
    await waitFor(() =>
      expect(screen.getByText(/added to your talent/i)).toBeInTheDocument(),
    );
    const attach = calls.find((c) => c.url === '/v1/attachments' && c.method === 'POST');
    expect(attach?.body).toMatchObject({
      owner_type: 'talent',
      owner_id: 'tal-new',
      is_resume: true,
      storage_key: 'tenant/draft/abc.pdf',
      file_name: 'resume.pdf',
      mime: 'application/pdf',
    });
    noConsentGrant(calls);
  });

  it("'partial': extracted field prefills + distinct banner; attach still fires (ruling 2+3)", async () => {
    const calls = installFetch(resumePlan('partial', { current_employer: 'Analytical Engines' }));
    renderAt();
    fireEvent.change(screen.getByTestId('resume-file-input'), { target: { files: [makeFile()] } });
    await waitFor(() =>
      expect((screen.getByLabelText('Current employer') as HTMLInputElement).value).toBe(
        'Analytical Engines',
      ),
    );
    fillName();
    signAttestation();
    fireEvent.click(screen.getByRole('button', { name: /create talent/i }));
    await waitFor(() =>
      expect(screen.getByText(/added to your talent/i)).toBeInTheDocument(),
    );
    const attach = calls.find((c) => c.url === '/v1/attachments' && c.method === 'POST');
    expect((attach?.body as Record<string, unknown>).is_resume).toBe(true);
    noConsentGrant(calls);
  });

  it("parse network error: manual banner, file retained, attach STILL fires (ruling 3)", async () => {
    const calls = installFetch((req) => {
      if (req.url.includes('/v1/talent-records/resume-upload-url') && req.method === 'POST') {
        return {
          status: 200,
          body: { storage_key: 'tenant/draft/abc.pdf', presigned_url: 'https://s3-stub/abc?sig=x', expires_at: '2030-01-01T00:00:00Z' },
        };
      }
      if (req.url.startsWith('https://s3-stub/') && req.method === 'PUT') return { status: 200, body: '' };
      if (req.url.includes('/v1/talent-records/draft-from-resume')) return { status: 500, body: { error: { code: 'INTERNAL' } } };
      if (req.url === '/v1/talent-records' && req.method === 'POST') {
        return { status: 201, body: { id: 'tal-new', first_name: 'Ada', last_name: 'Lovelace' } };
      }
      if (req.url === '/v1/attachments' && req.method === 'POST') return { status: 201, body: { id: 'att', is_resume: true } };
      return { status: 404, body: {} };
    });
    renderAt();
    fireEvent.change(screen.getByTestId('resume-file-input'), { target: { files: [makeFile('scan.pdf')] } });
    await waitFor(() => expect(screen.getByText(/couldn’t read this résumé/i)).toBeInTheDocument());
    fillName();
    signAttestation();
    fireEvent.click(screen.getByRole('button', { name: /create talent/i }));
    await waitFor(() => expect(screen.getByText(/added to your talent/i)).toBeInTheDocument());
    const attach = calls.find((c) => c.url === '/v1/attachments' && c.method === 'POST');
    expect((attach?.body as Record<string, unknown>).storage_key).toBe('tenant/draft/abc.pdf');
    noConsentGrant(calls);
  });
});

describe('TalentCreateView — attach soft-fail + cancel', () => {
  it('navigates to success even if the attach POST fails (talent IS created)', async () => {
    installFetch((req) => {
      if (req.url.includes('/v1/talent-records/resume-upload-url') && req.method === 'POST') {
        return { status: 200, body: { storage_key: 'tenant/draft/x.pdf', presigned_url: 'https://s3-stub/x?sig=z', expires_at: '2030-01-01T00:00:00Z' } };
      }
      if (req.url.startsWith('https://s3-stub/') && req.method === 'PUT') return { status: 200, body: '' };
      if (req.url.includes('/v1/talent-records/draft-from-resume')) {
        return { status: 200, body: { prefill: { first_name: 'Ada', last_name: 'Lovelace' }, parse_status: 'parsed' } };
      }
      if (req.url === '/v1/talent-records' && req.method === 'POST') {
        return { status: 201, body: { id: 'tal-new', first_name: 'Ada', last_name: 'Lovelace' } };
      }
      if (req.url === '/v1/attachments' && req.method === 'POST') {
        return { status: 500, body: { error: { code: 'INTERNAL', message: 'storage hiccup' } } };
      }
      return { status: 404, body: {} };
    });
    renderAt();
    fireEvent.change(screen.getByTestId('resume-file-input'), { target: { files: [makeFile()] } });
    await waitFor(() =>
      expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Ada'),
    );
    signAttestation();
    fireEvent.click(screen.getByRole('button', { name: /create talent/i }));
    await waitFor(() => expect(screen.getByText(/added to your talent/i)).toBeInTheDocument());
  });

  it('Cancel navigates to /talent (no save)', () => {
    installFetch(() => ({ status: 200, body: {} }));
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: /enter details manually/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('list')).toBeInTheDocument();
  });
});
