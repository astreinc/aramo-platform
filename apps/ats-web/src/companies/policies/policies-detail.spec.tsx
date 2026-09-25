import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getClientSubmittalEffective: vi.fn(),
  getEngagementEffective: vi.fn(),
  getPreStartEffective: vi.fn(),
  getClientSubmittalLayers: vi.fn(),
  getEngagementLayers: vi.fn(),
  getPreStartLayers: vi.fn(),
  getClientSubmittalHistory: vi.fn(),
  getEngagementHistory: vi.fn(),
  getPreStartHistory: vi.fn(),
}));
vi.mock('../policies-api', () => m);

import { EffectivePolicyPreview } from './EffectivePolicyPreview';
import { PolicyHistoryPanel } from './PolicyHistoryPanel';
import { CompanyPoliciesView } from './CompanyPoliciesView';

const prov = (o: Record<string, boolean> = {}) => ({
  inherited: true, client_override: false, client_added: false, tenant_floor: false, ...o,
});

beforeEach(() => {
  m.getClientSubmittalLayers.mockResolvedValue({
    layers: {
      tenant: { present: true, requirements: [{ key: 'resume_selected', disposition: 'REQUIRED', override_class: 'HARD_DENY', override_policy: 'DEFAULT' }] },
      client: { present: true, requirements: [{ key: 'bill_rate_present', disposition: 'REQUIRED', override_class: 'OVERRIDABLE', override_policy: 'DEFAULT' }] },
      requisition: null,
      effective: {
        requirements: [
          { key: 'resume_selected', effective: { disposition: 'REQUIRED', override_class: 'HARD_DENY', override_policy: 'DEFAULT' }, source: { scope: 'TENANT' }, provenance: prov() },
          { key: 'bill_rate_present', effective: { disposition: 'REQUIRED', override_class: 'OVERRIDABLE', override_policy: 'DEFAULT' }, source: { scope: 'CLIENT' }, provenance: prov({ inherited: false, client_added: true }) },
        ],
      },
    },
  });
  m.getClientSubmittalHistory.mockResolvedValue({
    versions: [
      { version: '2', published_at: '2026-09-24T00:00:00Z', published_by: 'Priya Shah', effective_to: null, checksum: 'b', status: 'current' },
      { version: '1', published_at: '2026-06-01T00:00:00Z', published_by: 'Priya Shah', effective_to: '2026-09-24T00:00:00Z', checksum: 'a', status: 'superseded' },
    ],
  });
  m.getEngagementLayers.mockResolvedValue({
    layers: { tenant: { present: true, requirements: [] }, client: null, requisition: null, effective: { requirements: [] } },
  });
  m.getPreStartLayers.mockResolvedValue({
    layers: { tenant: { present: true, definitions: [] }, client: null, requisition: null, effective: { definitions: [] } },
  });
  // Overview effective reads (for the container test).
  m.getClientSubmittalEffective.mockResolvedValue({ effective: { composite_version: 'v', layers: [], requirements: [] } });
  m.getEngagementEffective.mockResolvedValue({ governed: true, effective: { composite_version: 'v', layers: [], enforcement_mode: 'ENFORCING', requirements: [] } });
  m.getPreStartEffective.mockResolvedValue({ effective: { scope: 'TENANT', scope_ref_id: 't', version: 'v', checksum: 'x', published_at: null, published_by: null, layers: [], definitions: [] } });
});

describe('EffectivePolicyPreview', () => {
  it('renders Tenant defaults, Client changes, and Effective policy from the layers read', async () => {
    render(<EffectivePolicyPreview domain="client-submittal" companyId="co-1" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Tenant defaults')).toBeInTheDocument());
    expect(screen.getByText('Client changes')).toBeInTheDocument();
    expect(screen.getByText('Effective policy')).toBeInTheDocument();
    // Effective section surfaces the client-added badge from backend provenance.
    expect(screen.getByText('Client-added')).toBeInTheDocument();
  });
});

describe('PolicyHistoryPanel', () => {
  it('renders published versions newest-first with status + publisher', async () => {
    render(<PolicyHistoryPanel domain="client-submittal" companyId="co-1" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Version 2')).toBeInTheDocument());
    expect(screen.getByText('Version 1')).toBeInTheDocument();
    expect(screen.getByText('current')).toBeInTheDocument();
    expect(screen.getByText('superseded')).toBeInTheDocument();
    expect(screen.getAllByText(/Priya Shah/).length).toBeGreaterThanOrEqual(1);
  });
});

describe('CompanyPoliciesView routing', () => {
  it('View effective policy opens the preview and back returns to the overview', async () => {
    render(<CompanyPoliciesView companyId="co-1" />);
    await waitFor(() => expect(screen.getByText('Client Submittal Policy')).toBeInTheDocument());
    // Each card has a "View effective policy"; click the first.
    fireEvent.click(screen.getAllByText('View effective policy')[0]!);
    await waitFor(() => expect(screen.getByText('Tenant defaults')).toBeInTheDocument());
    fireEvent.click(screen.getByText('‹ Policies'));
    await waitFor(() => expect(screen.getByText('Client Submittal Policy')).toBeInTheDocument());
  });
});
