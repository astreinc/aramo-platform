import { ApiError } from '@aramo/fe-foundation';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TalentRecordView } from '../talent/types';

import { CallDrawer } from './CallDrawer';
import type { ZoomEmbedLoader } from './ZoomPhoneEmbed';
import type { CommunicationProviderIdentity } from './types';

// COMM-B4 Boundary C — the Call drawer shell. Proves: phone suppression is
// backend-authoritative (a null number never appears in the picker); "calling
// as" resolves from the recruiter's own provider-identity; a 404
// COMMUNICATION_USER_NOT_MAPPED renders a not-mapped explanation with NO admin
// controls; the submit stays DISABLED (call initiation = COMM-B5); and the Zoom
// embed loader is injected through to the boundary.

function makeTalent(overrides: Partial<TalentRecordView> = {}): TalentRecordView {
  return {
    id: 'tal-1',
    tenant_id: 't',
    site_id: null,
    first_name: 'Ada',
    last_name: 'Lovelace',
    email1: 'ada@example.com',
    email2: null,
    phone_home: null,
    phone_cell: '555-0100',
    phone_work: null,
    address: null,
    address2: null,
    city: 'London',
    state: null,
    zip: null,
    source: null,
    key_skills: null,
    current_employer: null,
    current_pay: null,
    desired_pay: null,
    availability_status: null,
    engagement_type: null,
    work_authorization: null,
    date_available: null,
    can_relocate: true,
    is_hot: false,
    notes: null,
    web_site: null,
    best_time_to_call: null,
    owner_id: null,
    entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

const IDENTITY: CommunicationProviderIdentity = {
  recruiter_id: 'u1',
  provider_user_id: 'zoom-user-1',
  provider_extension_id: 'ext-1',
  display_phone_number: '+1 (555) 010-9000',
  extension: '9000',
  voice_enabled: true,
  sms_enabled: false,
  status: 'active',
};

describe('CallDrawer — phone picker suppression', () => {
  it('shows only non-null numbers and never a suppressed one', async () => {
    const talent = makeTalent({
      phone_cell: '555-0100',
      phone_work: '555-0200',
      phone_home: null, // suppressed/absent — backend-authoritative
    });
    render(
      <CallDrawer
        talent={talent}
        onClose={vi.fn()}
        providerIdentityFn={vi.fn().mockResolvedValue(IDENTITY)}
      />,
    );

    expect(screen.getByText(/Mobile · 555-0100/)).toBeInTheDocument();
    expect(screen.getByText(/Work · 555-0200/)).toBeInTheDocument();
    expect(screen.queryByText(/Home/)).not.toBeInTheDocument();
    // Two radios for the two present numbers; the null home number is absent.
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('renders an empty-state when the talent has no number on file', () => {
    const talent = makeTalent({ phone_cell: null, phone_work: null, phone_home: null });
    render(
      <CallDrawer
        talent={talent}
        onClose={vi.fn()}
        providerIdentityFn={vi.fn().mockResolvedValue(IDENTITY)}
      />,
    );
    expect(screen.getByText(/No phone number on file/i)).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
});

describe('CallDrawer — calling identity', () => {
  it('resolves "calling as" from the recruiter provider-identity', async () => {
    render(
      <CallDrawer
        talent={makeTalent()}
        onClose={vi.fn()}
        providerIdentityFn={vi.fn().mockResolvedValue(IDENTITY)}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText('+1 (555) 010-9000')).toBeInTheDocument(),
    );
  });

  it('explains not-mapped with no admin controls on 404 USER_NOT_MAPPED', async () => {
    const providerIdentityFn = vi
      .fn()
      .mockRejectedValue(
        new ApiError(404, 'not mapped', 'COMMUNICATION_USER_NOT_MAPPED'),
      );
    render(
      <CallDrawer
        talent={makeTalent()}
        onClose={vi.fn()}
        providerIdentityFn={providerIdentityFn}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/isn’t mapped to a phone provider/i)).toBeInTheDocument(),
    );
    // Recruiter sees only "ask an administrator" — no provisioning controls.
    expect(screen.getByText(/Ask a tenant administrator/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /map|provision|configure/i }),
    ).not.toBeInTheDocument();
  });
});

describe('CallDrawer — submit deferral (COMM-B5)', () => {
  it('keeps the Call submit disabled', async () => {
    render(
      <CallDrawer
        talent={makeTalent()}
        onClose={vi.fn()}
        providerIdentityFn={vi.fn().mockResolvedValue(IDENTITY)}
      />,
    );
    const submit = screen.getByRole('button', { name: 'Call' });
    expect(submit).toBeDisabled();
  });
});

describe('CallDrawer — embed boundary', () => {
  it('injects the embed loader through to ZoomPhoneEmbed', async () => {
    const attach = vi.fn();
    const embedLoader: ZoomEmbedLoader = { attach };
    render(
      <CallDrawer
        talent={makeTalent()}
        onClose={vi.fn()}
        providerIdentityFn={vi.fn().mockResolvedValue(IDENTITY)}
        embedLoader={embedLoader}
      />,
    );
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
  });
});
