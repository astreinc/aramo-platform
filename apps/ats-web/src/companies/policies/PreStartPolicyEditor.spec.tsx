import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getPreStartLayers: vi.fn(),
  getPreStartHistory: vi.fn(),
  publishPreStart: vi.fn(),
}));
vi.mock('../policies-api', () => m);

import { PreStartPolicyEditor } from './PreStartPolicyEditor';

const prov = (o: Record<string, boolean> = {}) => ({ inherited: true, client_override: false, client_added: false, tenant_floor: false, ...o });

beforeEach(() => {
  m.getPreStartLayers.mockResolvedValue({
    layers: {
      tenant: {
        present: true,
        definitions: [
          { requirement_type: 'BACKGROUND_CHECK', label: 'Background check', blocking: true, owner_role: null, sequence: 1, waiver_mode: 'NOT_WAIVABLE', satisfaction_policy: 'VERIFICATION_REQUIRED', override_policy: 'FLOOR' },
        ],
      },
      client: { present: false, definitions: [] },
      requisition: null,
      effective: {
        scope: 'TENANT', scope_ref_id: 't', version: 'TENANT:1', checksum: 'x', published_at: null, published_by: null, layers: [],
        definitions: [
          { requirement_type: 'BACKGROUND_CHECK', label: 'Background check', blocking: true, owner_role: null, sequence: 1, waiver_mode: 'NOT_WAIVABLE', satisfaction_policy: 'VERIFICATION_REQUIRED', override_policy: 'FLOOR', source: { scope: 'TENANT', scope_ref_id: 't', version: '1' }, provenance: prov({ tenant_floor: true }) },
        ],
      },
    },
  });
  m.getPreStartHistory.mockResolvedValue({ versions: [] });
  m.publishPreStart.mockResolvedValue(undefined);
});

describe('PreStartPolicyEditor', () => {
  it('renders a presence toggle for every requirement type in the closed registry', async () => {
    render(<PreStartPolicyEditor companyId="co-1" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Background check presence' })).toBeInTheDocument());
    for (const label of ['Drug screen', 'I-9 verification', 'Credential verification', 'Badge provisioning', 'Client paperwork', 'NDA']) {
      expect(screen.getByRole('group', { name: `${label} presence` })).toBeInTheDocument();
    }
  });

  it('a tenant-floored requirement shows the Tenant floor badge and can be inherited but not weakened', async () => {
    render(<PreStartPolicyEditor companyId="co-1" onBack={vi.fn()} />);
    const grp = await screen.findByRole('group', { name: 'Background check presence' });
    expect(screen.getAllByText('Tenant floor').length).toBeGreaterThanOrEqual(1);
    // Inherit is allowed (inheriting a floor is valid) …
    expect(within(grp).getByText('Inherit')).not.toBeDisabled();
    // … but overriding it locks the dimensions (can't weaken below the floor).
    fireEvent.click(within(grp).getByText('Required'));
    const blocking = await screen.findByRole('group', { name: 'Background check blocking' });
    expect(within(blocking).getByText('Non-blocking')).toBeDisabled();
  });

  it('adding a requirement publishes the CLIENT set (draft→publish) then refetches', async () => {
    render(<PreStartPolicyEditor companyId="co-1" onBack={vi.fn()} />);
    const drug = await screen.findByRole('group', { name: 'Drug screen presence' });
    expect(screen.getByText('Publish changes')).toBeDisabled();
    fireEvent.click(within(drug).getByText('Required'));
    await waitFor(() => expect(screen.getByText('Publish changes')).not.toBeDisabled());

    const loadsBefore = m.getPreStartLayers.mock.calls.length;
    fireEvent.click(screen.getByText('Publish changes'));
    await waitFor(() => expect(m.publishPreStart).toHaveBeenCalledTimes(1));
    const arg = m.publishPreStart.mock.calls[0]![0];
    expect(arg.scope_ref_id).toBe('co-1');
    expect(arg.version).toBe('1');
    expect(arg.definitions.map((d: { requirement_type: string }) => d.requirement_type)).toContain('DRUG_SCREEN');
    await waitFor(() => expect(m.getPreStartLayers.mock.calls.length).toBeGreaterThan(loadsBefore));
  });
});
