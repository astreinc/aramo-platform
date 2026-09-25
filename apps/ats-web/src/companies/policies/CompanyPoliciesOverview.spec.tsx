import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// PA-3 — the overview renders three cards straight from the effective reads. Every
// badge (Tenant floor / Client-added / …) is backend truth off `provenance`; the test
// pins that the FE surfaces it rather than recomputing it.
const { getClientSubmittalEffective, getEngagementEffective, getPreStartEffective } = vi.hoisted(() => ({
  getClientSubmittalEffective: vi.fn(),
  getEngagementEffective: vi.fn(),
  getPreStartEffective: vi.fn(),
}));
vi.mock('../policies-api', () => ({
  getClientSubmittalEffective,
  getEngagementEffective,
  getPreStartEffective,
}));

import { CompanyPoliciesOverview } from './CompanyPoliciesOverview';

const prov = (o: Record<string, boolean> = {}) => ({
  inherited: true,
  client_override: false,
  client_added: false,
  tenant_floor: false,
  ...o,
});

beforeEach(() => {
  getClientSubmittalEffective.mockResolvedValue({
    effective: {
      composite_version: 'TENANT:1|CLIENT:1',
      layers: [],
      requirements: [
        {
          key: 'work_authorization_present',
          effective: { disposition: 'REQUIRED', override_class: 'HARD_DENY', override_policy: 'FLOOR' },
          source: { scope: 'TENANT' },
          provenance: prov({ tenant_floor: true }),
        },
        {
          key: 'bill_rate_present',
          effective: { disposition: 'REQUIRED', override_class: 'OVERRIDABLE', override_policy: 'DEFAULT' },
          source: { scope: 'CLIENT' },
          provenance: prov({ inherited: false, client_added: true }),
        },
      ],
    },
  });
  getEngagementEffective.mockResolvedValue({
    governed: true,
    effective: {
      composite_version: 'TENANT:1',
      layers: [],
      enforcement_mode: 'ENFORCING',
      requirements: [
        {
          channel: 'email',
          requirement: { channel: 'email', required: true, condition: 'recorded_evidence' },
          source: { scope: 'TENANT' },
          provenance: prov(),
        },
      ],
    },
  });
  getPreStartEffective.mockResolvedValue({
    effective: {
      scope: 'TENANT',
      scope_ref_id: 't',
      version: 'TENANT:2',
      checksum: 'x',
      published_at: null,
      published_by: null,
      layers: [],
      definitions: [
        {
          requirement_type: 'BACKGROUND_CHECK',
          label: 'Background check',
          blocking: true,
          owner_role: null,
          sequence: 1,
          waiver_mode: 'NOT_WAIVABLE',
          satisfaction_policy: 'VERIFICATION_REQUIRED',
          override_policy: 'FLOOR',
          source: { scope: 'TENANT', scope_ref_id: 't', version: '2' },
          provenance: prov({ tenant_floor: true }),
        },
      ],
    },
  });
});

describe('CompanyPoliciesOverview', () => {
  it('renders three policy cards from the effective reads', async () => {
    render(<CompanyPoliciesOverview companyId="co-1" />);
    await waitFor(() => expect(screen.getByText('Client Submittal Policy')).toBeInTheDocument());
    expect(screen.getByText('Engagement Policy')).toBeInTheDocument();
    expect(screen.getByText('Pre-Start Policy')).toBeInTheDocument();
  });

  it('surfaces backend provenance badges (tenant floor, client-added) — not FE-inferred', async () => {
    render(<CompanyPoliciesOverview companyId="co-1" />);
    await waitFor(() => expect(screen.getByText('Work authorization')).toBeInTheDocument());
    // Two floored requirements across the cards (work auth + background check).
    expect(screen.getAllByText('Tenant floor').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Client-added')).toBeInTheDocument();
    expect(screen.getByText('Bill rate')).toBeInTheDocument();
  });

  it('shows Configure only where the domain write scope is present', async () => {
    render(<CompanyPoliciesOverview companyId="co-1" canConfigure={{ 'client-submittal': true }} />);
    await waitFor(() => expect(screen.getByText('Client Submittal Policy')).toBeInTheDocument());
    expect(screen.getAllByText('Configure policy').length).toBe(1);
  });

  it('summarizes counts from backend truth (required · tenant floor)', async () => {
    render(<CompanyPoliciesOverview companyId="co-1" />);
    await waitFor(() => expect(screen.getByText(/2 required/)).toBeInTheDocument());
  });
});
