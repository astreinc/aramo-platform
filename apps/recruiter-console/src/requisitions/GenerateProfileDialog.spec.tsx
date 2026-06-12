import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@aramo/fe-foundation';

import { GenerateProfileDialog } from './GenerateProfileDialog';

interface MockedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function installFetch(
  handler: (req: MockedRequest) => { status: number; body: unknown },
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
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = init.body;
      }
    }
    const req: MockedRequest = { url, method, body };
    calls.push(req);
    const res = handler(req);
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function renderDialog(onConfirmed = vi.fn()) {
  return render(
    <ToastProvider>
      <GenerateProfileDialog requisitionId="req-1" onConfirmed={onConfirmed} />
    </ToastProvider>,
  );
}

const DRAFT_RESPONSE = {
  draft_event_id: 'evt-1',
  jd_text: 'Drafted JD body.',
  ai_draft_audit_record_id: 'audit-1',
  golden_profile_draft: {
    role_family: 'backend_engineer',
    seniority_level: 'senior',
    jd_text: 'Drafted JD body.',
    generated_by: 'ai_draft',
    required_skills: [{ name: 'Go' }, { name: 'Postgres' }],
    preferred_skills: [{ name: 'Kafka' }],
    critical_skills: [{ name: 'AWS' }],
    experience: { total_years: 7, domain: 'fintech', industries: ['banking'] },
    constraints: { location: 'NYC', work_mode: 'hybrid' },
  },
};

describe('GenerateProfileDialog — draft → review → confirm', () => {
  it('generates from a brief, shows the editable review, then confirms and links the profile', async () => {
    const onConfirmed = vi.fn();
    const calls = installFetch((req) => {
      if (req.url.includes('/profile/draft')) {
        return { status: 200, body: DRAFT_RESPONSE };
      }
      if (req.url.includes('/profile/confirm')) {
        return { status: 200, body: { golden_profile_id: 'gp-99' } };
      }
      return { status: 404, body: {} };
    });
    renderDialog(onConfirmed);
    fireEvent.click(
      screen.getByRole('button', { name: /generate profile from brief/i }),
    );
    fireEvent.change(await screen.findByLabelText('Brief'), {
      target: { value: 'A senior backend engineer for our payments team.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    // Review phase — JD + structured fields pre-filled from the draft.
    const jd = (await screen.findByLabelText('JD text')) as HTMLTextAreaElement;
    expect(jd.value).toBe('Drafted JD body.');
    expect((screen.getByLabelText('Required skills') as HTMLTextAreaElement).value).toContain(
      'Go',
    );
    // Confirm.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
    const confirmCall = calls.find((c) => c.url.includes('/profile/confirm'));
    const confirmBody = confirmCall?.body as Record<string, unknown>;
    expect(confirmBody.draft_event_id).toBe('evt-1');
    expect(confirmBody.jd_text).toBe('Drafted JD body.');
    const profile = confirmBody.golden_profile as Record<string, unknown>;
    expect(profile.required_skills).toEqual([{ name: 'Go' }, { name: 'Postgres' }]);
  });

  it('allows fully-manual entry (Edit manually) without calling draft', async () => {
    const calls = installFetch((req) => {
      if (req.url.includes('/profile/confirm')) {
        return { status: 200, body: { golden_profile_id: 'gp-manual' } };
      }
      return { status: 404, body: {} };
    });
    renderDialog();
    fireEvent.click(
      screen.getByRole('button', { name: /generate profile from brief/i }),
    );
    fireEvent.click(await screen.findByRole('button', { name: /edit manually/i }));
    // Review phase opened with a blank draft — no /draft call was made.
    expect(calls.some((c) => c.url.includes('/profile/draft'))).toBe(false);
    fireEvent.change(await screen.findByLabelText('JD text'), {
      target: { value: 'Hand-written JD.' },
    });
    fireEvent.change(screen.getByLabelText('Required skills'), {
      target: { value: 'TypeScript, React' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/profile/confirm'))).toBe(true);
    });
    const confirmBody = calls.find((c) => c.url.includes('/profile/confirm'))
      ?.body as Record<string, unknown>;
    const profile = confirmBody.golden_profile as Record<string, unknown>;
    expect(profile.generated_by).toBe('manual');
    expect(profile.required_skills).toEqual([
      { name: 'TypeScript' },
      { name: 'React' },
    ]);
    // draft_event_id is '' for a manual (never-drafted) confirm.
    expect(confirmBody.draft_event_id).toBe('');
  });

  it('surfaces an error when draft fails, keeping manual entry possible', async () => {
    installFetch((req) => {
      if (req.url.includes('/profile/draft')) {
        return { status: 500, body: { message: 'boom' } };
      }
      return { status: 404, body: {} };
    });
    renderDialog();
    fireEvent.click(
      screen.getByRole('button', { name: /generate profile from brief/i }),
    );
    fireEvent.change(await screen.findByLabelText('Brief'), {
      target: { value: 'something' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => {
      expect(screen.getByText(/could not generate a profile/i)).toBeInTheDocument();
    });
    // Still on the brief phase; "Edit manually" remains available.
    expect(screen.getByRole('button', { name: /edit manually/i })).toBeInTheDocument();
  });
});
