import {
  render as rawRender,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@aramo/fe-foundation';

import { ProfileWorkbenchPanel } from './ProfileWorkbenchPanel';
import type { RequisitionProfileView } from './golden-profile';

// PR-A2 §4 P3/P4 — the profile workbench: read-for-all, generate/edit gated
// to the 5-role tier, Match-talent DISABLED until PR-C (no matching call).

function render(ui: ReactElement) {
  return rawRender(<ToastProvider>{ui}</ToastProvider>);
}

const PROFILE_LESS: RequisitionProfileView = {
  requisition_id: 'req-1',
  golden_profile_id: null,
  has_profile: false,
  jd_text: '',
  role_family: null,
  seniority_level: null,
  generated_by: null,
  required_skills: [],
  preferred_skills: [],
  critical_skills: [],
  experience: { industries: [] },
  constraints: {},
};

const WITH_PROFILE: RequisitionProfileView = {
  requisition_id: 'req-1',
  golden_profile_id: 'gp-1',
  has_profile: true,
  jd_text: 'Senior backend engineer.',
  role_family: 'backend_engineer',
  seniority_level: 'senior',
  generated_by: 'ai_draft',
  required_skills: [{ name: 'TypeScript' }],
  preferred_skills: [{ name: 'Kafka' }],
  critical_skills: [{ name: 'TypeScript' }],
  experience: { industries: ['fintech'] },
  constraints: {},
};

interface MockedRequest {
  readonly url: string;
  readonly method: string;
}

function installFetch(
  body: RequisitionProfileView,
): MockedRequest[] {
  const calls: MockedRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, method: init?.method ?? 'GET' });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProfileWorkbenchPanel — read + gating', () => {
  it('profile-less requisition shows the empty state; recruiter sees no generate affordance', async () => {
    installFetch(PROFILE_LESS);
    render(
      <ProfileWorkbenchPanel requisitionId="req-1" scopes={['requisition:read']} />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/no profile has been generated/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: /generate from brief/i }),
    ).toBeNull();
  });

  it('a profile renders READ-ONLY for a non-editor (no edit affordances)', async () => {
    installFetch(WITH_PROFILE);
    render(
      <ProfileWorkbenchPanel requisitionId="req-1" scopes={['requisition:read']} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('profile-jd-text')).toHaveTextContent(
        'Senior backend engineer.',
      ),
    );
    expect(screen.queryByRole('button', { name: /edit jd text/i })).toBeNull();
  });

  it('profile:edit holder gets inline-edit affordances on the profile fields', async () => {
    installFetch(WITH_PROFILE);
    render(
      <ProfileWorkbenchPanel
        requisitionId="req-1"
        scopes={['requisition:read', 'requisition:profile:edit']}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /edit jd text/i }),
      ).toBeInTheDocument(),
    );
  });

  it('profile:generate holder sees the Generate affordance', async () => {
    installFetch(WITH_PROFILE);
    render(
      <ProfileWorkbenchPanel
        requisitionId="req-1"
        scopes={['requisition:read', 'requisition:profile:generate']}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /regenerate from brief/i }),
      ).toBeInTheDocument(),
    );
  });
});

describe('ProfileWorkbenchPanel — Match-talent disabled (PR-C not landed)', () => {
  it('renders a DISABLED Match-talent button and fires no matching call', async () => {
    const calls = installFetch(WITH_PROFILE);
    render(
      <ProfileWorkbenchPanel
        requisitionId="req-1"
        scopes={['requisition:read', 'requisition:profile:generate']}
      />,
    );
    const matchBtn = await screen.findByRole('button', {
      name: /match talent/i,
    });
    expect(matchBtn).toBeDisabled();
    // Only the profile GET fired — no matching endpoint was called.
    expect(calls.every((c) => c.url.includes('/profile'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/match'))).toBe(false);
  });
});
