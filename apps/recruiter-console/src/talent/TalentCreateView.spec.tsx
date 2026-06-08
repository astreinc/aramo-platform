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
      // S3 PUT body is the File object (not JSON); skip parsing for those.
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TalentCreateView — manual path (no résumé)', () => {
  it('submits POST then navigates to /talent/:id (no attach when no résumé)', async () => {
    const calls = installFetch((req) => {
      if (req.url === '/v1/talent-records' && req.method === 'POST') {
        return {
          status: 201,
          body: { id: 'tal-new', first_name: 'Ada', last_name: 'Lovelace' },
        };
      }
      return { status: 404, body: {} };
    });
    renderAt();
    fireEvent.change(screen.getByLabelText('First name'), {
      target: { value: 'Ada' },
    });
    fireEvent.change(screen.getByLabelText('Last name'), {
      target: { value: 'Lovelace' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create talent/i }));
    await waitFor(() => expect(screen.getByTestId('detail')).toBeInTheDocument());
    // NO attachment POST was made (no résumé uploaded).
    expect(
      calls.find((c) => c.url.includes('/v1/attachments') && c.method === 'POST'),
    ).toBeUndefined();
  });
});

describe('TalentCreateView — résumé path (the load-bearing rulings 1+2+3)', () => {
  function plan(parseStatus: 'parsed' | 'partial' | 'failed', prefill: Record<string, unknown>) {
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
        return {
          status: 201,
          body: { id: 'tal-new', first_name: 'Ada', last_name: 'Lovelace' },
        };
      }
      if (req.url === '/v1/attachments' && req.method === 'POST') {
        return { status: 201, body: { id: 'att-new', is_resume: true } };
      }
      return { status: 404, body: {} };
    };
  }

  it("'parsed' path: prefill populates the form, then create+attach fires", async () => {
    const calls = installFetch(
      plan('parsed', { first_name: 'Ada', last_name: 'Lovelace', email1: 'ada@example.com' }),
    );
    renderAt();
    fireEvent.change(screen.getByTestId('resume-file-input'), {
      target: { files: [makeFile()] },
    });
    // Wait for the prefill to land.
    await waitFor(() =>
      expect(
        (screen.getByLabelText('First name') as HTMLInputElement).value,
      ).toBe('Ada'),
    );
    expect((screen.getByLabelText('Primary email') as HTMLInputElement).value).toBe(
      'ada@example.com',
    );
    fireEvent.click(screen.getByRole('button', { name: /create talent/i }));
    await waitFor(() => expect(screen.getByTestId('detail')).toBeInTheDocument());
    // The attachment POST fired with is_resume=true and owner_type=talent.
    const attachCall = calls.find(
      (c) => c.url === '/v1/attachments' && c.method === 'POST',
    );
    expect(attachCall).toBeDefined();
    const attachBody = attachCall?.body as Record<string, unknown>;
    expect(attachBody).toMatchObject({
      owner_type: 'talent',
      owner_id: 'tal-new',
      is_resume: true,
      storage_key: 'tenant/draft/abc.pdf',
      file_name: 'resume.pdf',
      mime: 'application/pdf',
    });
  });

  it("'partial' path: extracted fields prefill + the distinct banner; attach still fires (ruling 2 + 3)", async () => {
    const calls = installFetch(
      plan('partial', { current_employer: 'Analytical Engines' }),
    );
    renderAt();
    fireEvent.change(screen.getByTestId('resume-file-input'), {
      target: { files: [makeFile()] },
    });
    await waitFor(() =>
      expect(screen.getByText(/couldn't find a name or contact/i)).toBeInTheDocument(),
    );
    // The extracted field IS prefilled (ruling 2: don't discard the
    // parser's signal even when minimal-identity isn't met).
    expect(
      (screen.getByLabelText('Current employer') as HTMLInputElement).value,
    ).toBe('Analytical Engines');
    // The recruiter completes the required fields manually.
    fireEvent.change(screen.getByLabelText('First name'), {
      target: { value: 'Ada' },
    });
    fireEvent.change(screen.getByLabelText('Last name'), {
      target: { value: 'Lovelace' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create talent/i }));
    await waitFor(() => expect(screen.getByTestId('detail')).toBeInTheDocument());
    // RULING 3: attach still fires on partial.
    const attachCall = calls.find(
      (c) => c.url === '/v1/attachments' && c.method === 'POST',
    );
    expect(attachCall).toBeDefined();
    expect((attachCall?.body as Record<string, unknown>).is_resume).toBe(true);
  });

  it("'failed' path: empty prefill + manual-entry banner; attach STILL fires (ruling 3)", async () => {
    const calls = installFetch(plan('failed', {}));
    renderAt();
    fireEvent.change(screen.getByTestId('resume-file-input'), {
      target: { files: [makeFile('scan.pdf')] },
    });
    await waitFor(() =>
      expect(screen.getByText(/couldn't read this résumé/i)).toBeInTheDocument(),
    );
    // No prefill landed (form fields stay empty).
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('');
    // The recruiter manually fills the required fields.
    fireEvent.change(screen.getByLabelText('First name'), {
      target: { value: 'Ada' },
    });
    fireEvent.change(screen.getByLabelText('Last name'), {
      target: { value: 'Lovelace' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create talent/i }));
    await waitFor(() => expect(screen.getByTestId('detail')).toBeInTheDocument());
    // RULING 3: attach STILL fires on failed parse — the original file
    // is preserved on the talent record (a human can read what the
    // parser couldn't).
    const attachCall = calls.find(
      (c) => c.url === '/v1/attachments' && c.method === 'POST',
    );
    expect(attachCall).toBeDefined();
    expect((attachCall?.body as Record<string, unknown>).is_resume).toBe(true);
    expect((attachCall?.body as Record<string, unknown>).storage_key).toBe(
      'tenant/draft/abc.pdf',
    );
  });
});

describe('TalentCreateView — pool-open framing + cancel', () => {
  it('renders the pool-open framing in the page description', () => {
    installFetch(() => ({ status: 200, body: {} }));
    renderAt();
    expect(screen.getByText('New talent')).toBeInTheDocument();
    expect(screen.getByText(/shared tenant pool/i)).toBeInTheDocument();
  });

  it('clicking Cancel navigates back to /talent (NO save implied)', () => {
    installFetch(() => ({ status: 200, body: {} }));
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('list')).toBeInTheDocument();
  });
});

describe('TalentCreateView — attach soft-fail (talent still created)', () => {
  it('navigates to detail even if the attach POST fails (the talent IS saved; only the attachment failed)', async () => {
    installFetch((req) => {
      if (req.url.includes('/v1/talent-records/resume-upload-url') && req.method === 'POST') {
        return {
          status: 200,
          body: {
            storage_key: 'tenant/draft/x.pdf',
            presigned_url: 'https://s3-stub/x?sig=z',
            expires_at: '2030-01-01T00:00:00Z',
          },
        };
      }
      if (req.url.startsWith('https://s3-stub/') && req.method === 'PUT') {
        return { status: 200, body: '' };
      }
      if (req.url.includes('/v1/talent-records/draft-from-resume')) {
        return {
          status: 200,
          body: {
            prefill: { first_name: 'Ada', last_name: 'Lovelace' },
            parse_status: 'parsed',
          },
        };
      }
      if (req.url === '/v1/talent-records' && req.method === 'POST') {
        return {
          status: 201,
          body: { id: 'tal-new', first_name: 'Ada', last_name: 'Lovelace' },
        };
      }
      if (req.url === '/v1/attachments' && req.method === 'POST') {
        return {
          status: 500,
          body: { error: { code: 'INTERNAL', message: 'storage hiccup' } },
        };
      }
      return { status: 404, body: {} };
    });
    renderAt();
    fireEvent.change(screen.getByTestId('resume-file-input'), {
      target: { files: [makeFile()] },
    });
    await waitFor(() =>
      expect(
        (screen.getByLabelText('First name') as HTMLInputElement).value,
      ).toBe('Ada'),
    );
    fireEvent.click(screen.getByRole('button', { name: /create talent/i }));
    // Even with the attach failure, we navigate to the detail (the
    // talent IS saved; the recruiter can re-attach later from the
    // DETAIL attachments tab).
    await waitFor(() => expect(screen.getByTestId('detail')).toBeInTheDocument());
  });
});
