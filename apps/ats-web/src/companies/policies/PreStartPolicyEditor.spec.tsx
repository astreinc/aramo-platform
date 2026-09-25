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
  it('renders every requirement type in the closed registry as an ordered checklist card', async () => {
    render(<PreStartPolicyEditor companyId="co-1" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Background check')).toBeInTheDocument());
    for (const label of ['Drug screen', 'I-9 verification', 'Credential verification', 'Badge provisioning', 'Client paperwork', 'NDA']) {
      expect(screen.getByText(label)).toBeInTheDocument();
      // non-floored requirements expose the presence toggle
      expect(screen.getByRole('group', { name: `${label} presence` })).toBeInTheDocument();
    }
  });

  it('a tenant-floored requirement shows the Tenant floor badge and locks presence (cannot be weakened)', async () => {
    render(<PreStartPolicyEditor companyId="co-1" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Background check')).toBeInTheDocument());
    // the floor is surfaced …
    expect(screen.getAllByText('Tenant floor').length).toBeGreaterThanOrEqual(1);
    // … and its presence is a locked chip, never an editable toggle
    expect(screen.queryByRole('group', { name: 'Background check presence' })).not.toBeInTheDocument();
  });

  it('adding a requirement publishes the CLIENT set (draft→publish) then refetches', async () => {
    render(<PreStartPolicyEditor companyId="co-1" onBack={vi.fn()} />);
    const drug = await screen.findByRole('group', { name: 'Drug screen presence' });
    expect(screen.getByRole('button', { name: 'Publish changes' })).toBeDisabled();
    fireEvent.click(within(drug).getByText('Required'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish changes' })).not.toBeDisabled());

    const loadsBefore = m.getPreStartLayers.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Publish changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(m.publishPreStart).toHaveBeenCalledTimes(1));
    const arg = m.publishPreStart.mock.calls[0]![0];
    expect(arg.scope_ref_id).toBe('co-1');
    expect(arg.version).toBe('1');
    expect(arg.definitions.map((d: { requirement_type: string }) => d.requirement_type)).toContain('DRUG_SCREEN');
    await waitFor(() => expect(m.getPreStartLayers.mock.calls.length).toBeGreaterThan(loadsBefore));
  });
});
