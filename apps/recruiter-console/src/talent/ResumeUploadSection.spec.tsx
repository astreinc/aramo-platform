import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ResumeUploadSection,
  type ResumeUploadState,
} from './ResumeUploadSection';
import type { ParseStatus, TalentRecordPrefill } from './types';

afterEach(() => {
  vi.restoreAllMocks();
});

interface FetchPlan {
  presign?: { status: number; body: unknown };
  s3put?: { status: number };
  parse?: { status: number; body: unknown };
}

function installFetch(plan: FetchPlan): ReturnType<typeof vi.fn> {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const method = init?.method ?? 'GET';
      if (url.includes('/v1/talent-records/resume-upload-url') && plan.presign) {
        return new Response(JSON.stringify(plan.presign.body), {
          status: plan.presign.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.startsWith('https://s3-stub/') && method === 'PUT' && plan.s3put) {
        return new Response('', { status: plan.s3put.status });
      }
      if (url.includes('/v1/talent-records/draft-from-resume') && plan.parse) {
        return new Response(JSON.stringify(plan.parse.body), {
          status: plan.parse.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    },
  );
  return spy as unknown as ReturnType<typeof vi.fn>;
}

function makeFile(name = 'resume.pdf', type = 'application/pdf'): File {
  return new File(['%PDF-1.4 stub'], name, { type });
}

function makePrefill(over: Partial<TalentRecordPrefill> = {}): TalentRecordPrefill {
  return { first_name: 'Ada', last_name: 'Lovelace', email1: 'ada@example.com', ...over };
}

function renderHook(initial: ResumeUploadState = { status: 'idle' }) {
  let currentValue = initial;
  let prefilled: TalentRecordPrefill | undefined;
  const onChange = vi.fn((next: ResumeUploadState) => {
    currentValue = next;
    rerender();
  });
  const onPrefill = vi.fn((p: TalentRecordPrefill) => {
    prefilled = p;
  });
  function rerender() {
    result.rerender(
      <ResumeUploadSection
        value={currentValue}
        onChange={onChange}
        onPrefill={onPrefill}
      />,
    );
  }
  const result = render(
    <ResumeUploadSection
      value={currentValue}
      onChange={onChange}
      onPrefill={onPrefill}
    />,
  );
  return { onChange, onPrefill, getCurrent: () => currentValue, getPrefilled: () => prefilled };
}

const PRESIGN = {
  status: 200,
  body: {
    storage_key: 'tenant/draft/abc.pdf',
    presigned_url: 'https://s3-stub/tenant/draft/abc.pdf?sig=xyz',
    expires_at: '2030-01-01T00:00:00Z',
  },
};

describe('ResumeUploadSection — happy path (parse_status: parsed)', () => {
  it('completes the 3-step flow and hands the prefill to the parent', async () => {
    installFetch({
      presign: PRESIGN,
      s3put: { status: 200 },
      parse: {
        status: 200,
        body: { prefill: makePrefill(), parse_status: 'parsed' as ParseStatus },
      },
    });
    const { onChange, onPrefill, getCurrent } = renderHook();
    const input = screen.getByTestId('resume-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile()] } });
    await waitFor(() => expect(getCurrent().status).toBe('parsed'));
    expect(onPrefill).toHaveBeenCalledWith(expect.objectContaining({
      first_name: 'Ada',
      email1: 'ada@example.com',
    }));
    expect(onChange).toHaveBeenCalled();
    expect(getCurrent().storage_key).toBe('tenant/draft/abc.pdf');
    expect(screen.getByText(/Résumé extracted/i)).toBeInTheDocument();
    // The file is held in state for the parent to attach on save.
    expect(screen.getByTestId('resume-attached')).toBeInTheDocument();
  });
});

describe('ResumeUploadSection — partial parse (ruling 2: same prefill, distinct banner)', () => {
  it('shows the extracted fields banner when parse_status=partial', async () => {
    installFetch({
      presign: PRESIGN,
      s3put: { status: 200 },
      parse: {
        status: 200,
        body: {
          prefill: { current_employer: 'Analytical Engines' },
          parse_status: 'partial' as ParseStatus,
        },
      },
    });
    const { onPrefill, getCurrent } = renderHook();
    fireEvent.change(screen.getByTestId('resume-file-input'), {
      target: { files: [makeFile()] },
    });
    await waitFor(() => expect(getCurrent().status).toBe('partial'));
    // Ruling 2: partial still hands the prefill back (extracted fields
    // are useful even without minimal identity).
    expect(onPrefill).toHaveBeenCalledWith({
      current_employer: 'Analytical Engines',
    });
    // The distinct banner names the missing-identity case.
    expect(
      screen.getByText(/couldn't find a name or contact/i),
    ).toBeInTheDocument();
    // File still attached on save (ruling 3).
    expect(screen.getByTestId('resume-attached')).toBeInTheDocument();
  });
});

describe('ResumeUploadSection — failed parse (ruling 3: still attaches)', () => {
  it('shows the manual-entry banner + keeps storage_key for attach-on-save', async () => {
    installFetch({
      presign: PRESIGN,
      s3put: { status: 200 },
      parse: {
        status: 200,
        body: { prefill: {}, parse_status: 'failed' as ParseStatus },
      },
    });
    const { getCurrent } = renderHook();
    fireEvent.change(screen.getByTestId('resume-file-input'), {
      target: { files: [makeFile('scan.pdf')] },
    });
    await waitFor(() => expect(getCurrent().status).toBe('failed'));
    expect(
      screen.getByText(/couldn't read this résumé/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/file will still be attached/i)).toBeInTheDocument();
    // Ruling 3 — the file remains in state for the parent to attach.
    expect(getCurrent().storage_key).toBe('tenant/draft/abc.pdf');
    expect(getCurrent().file?.name).toBe('scan.pdf');
  });
});

describe('ResumeUploadSection — direct-to-S3 PUT contract', () => {
  it('PUTs the file directly to the presigned URL with the matching Content-Type (NOT through apiClient)', async () => {
    const spy = installFetch({
      presign: PRESIGN,
      s3put: { status: 200 },
      parse: {
        status: 200,
        body: { prefill: makePrefill(), parse_status: 'parsed' as ParseStatus },
      },
    });
    const { getCurrent } = renderHook();
    fireEvent.change(screen.getByTestId('resume-file-input'), {
      target: { files: [makeFile('cv.pdf', 'application/pdf')] },
    });
    await waitFor(() => expect(getCurrent().status).toBe('parsed'));
    // Find the PUT call.
    const calls = (spy as unknown as { mock: { calls: Array<[unknown, RequestInit | undefined]> } }).mock.calls;
    const putCall = calls.find(([, init]) => init?.method === 'PUT');
    expect(putCall).toBeDefined();
    const url = String(putCall?.[0]);
    expect(url).toBe('https://s3-stub/tenant/draft/abc.pdf?sig=xyz');
    const headers = (putCall?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/pdf');
    // CRITICAL: the FE does NOT send any x-amz-tagging header (the
    // orphan-pending tag is baked into the signed URL server-side).
    expect(headers['x-amz-tagging']).toBeUndefined();
  });
});

describe('ResumeUploadSection — error paths (network / 4xx)', () => {
  it('surfaces an error if the presigned-URL request fails', async () => {
    installFetch({
      presign: { status: 403, body: { error: { code: 'FORBIDDEN' } } },
    });
    const { getCurrent } = renderHook();
    fireEvent.change(screen.getByTestId('resume-file-input'), {
      target: { files: [makeFile()] },
    });
    await waitFor(() => expect(getCurrent().status).toBe('error'));
    expect(
      screen.getByText(/do not have permission to upload résumés/i),
    ).toBeInTheDocument();
  });

  it('surfaces an error if the S3 PUT fails', async () => {
    installFetch({
      presign: PRESIGN,
      s3put: { status: 500 },
    });
    const { getCurrent } = renderHook();
    fireEvent.change(screen.getByTestId('resume-file-input'), {
      target: { files: [makeFile()] },
    });
    await waitFor(() => expect(getCurrent().status).toBe('error'));
    // Status 500 → generic upload-failed fallback.
    expect(screen.getByText(/résumé upload failed/i)).toBeInTheDocument();
  });
});

describe('ResumeUploadSection — never auto-submits', () => {
  it('renders no "Saved" affordance during the flow (the parent owns the save)', async () => {
    installFetch({
      presign: PRESIGN,
      s3put: { status: 200 },
      parse: {
        status: 200,
        body: { prefill: makePrefill(), parse_status: 'parsed' as ParseStatus },
      },
    });
    renderHook();
    fireEvent.change(screen.getByTestId('resume-file-input'), {
      target: { files: [makeFile()] },
    });
    await waitFor(() =>
      expect(screen.getByText(/Résumé extracted/i)).toBeInTheDocument(),
    );
    // The abandon-case guarantee: no "Saved" copy until the parent's
    // create+attach completes (the parent navigates to /talent/:id).
    expect(screen.queryByText(/saved/i)).toBeNull();
    expect(screen.queryByText(/created/i)).toBeNull();
  });
});
