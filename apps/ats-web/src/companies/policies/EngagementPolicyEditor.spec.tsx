import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getEngagementLayers: vi.fn(),
  getEngagementHistory: vi.fn(),
  publishEngagement: vi.fn(),
}));
vi.mock('../policies-api', () => m);

import { EngagementPolicyEditor } from './EngagementPolicyEditor';

const prov = (o: Record<string, boolean> = {}) => ({ inherited: true, client_override: false, client_added: false, ...o });

beforeEach(() => {
  m.getEngagementLayers.mockResolvedValue({
    layers: {
      tenant: {
        present: true,
        enforcement_mode: 'ENFORCING',
        requirements: [
          { channel: 'voice', required: true, condition: 'two_way_conversation', minimum_strength: 'RECRUITER_ATTESTED' },
          { channel: 'email', required: false, condition: 'recorded_evidence' },
        ],
      },
      client: null,
      requisition: null,
      effective: {
        enforcement_mode: 'ENFORCING',
        requirements: [
          { channel: 'voice', requirement: { channel: 'voice', required: true, condition: 'two_way_conversation', minimum_strength: 'RECRUITER_ATTESTED' }, source: { scope: 'TENANT' }, provenance: prov() },
          { channel: 'email', requirement: { channel: 'email', required: false, condition: 'recorded_evidence' }, source: { scope: 'TENANT' }, provenance: prov() },
        ],
      },
    },
  });
  m.getEngagementHistory.mockResolvedValue({ versions: [] });
  m.publishEngagement.mockResolvedValue({ published: {} });
});

describe('EngagementPolicyEditor', () => {
  it('renders the voice + email channels and the enforcement selector (no generic add)', async () => {
    render(<EngagementPolicyEditor companyId="co-1" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Voice engagement setting' })).toBeInTheDocument());
    expect(screen.getByRole('group', { name: 'Email engagement setting' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Enforcement mode' })).toBeInTheDocument();
    expect(screen.queryByText('+ Add requirement')).not.toBeInTheDocument();
  });

  it('choosing Required for voice reveals the minimum-strength selector', async () => {
    render(<EngagementPolicyEditor companyId="co-1" onBack={vi.fn()} />);
    const voice = await screen.findByRole('group', { name: 'Voice engagement setting' });
    expect(screen.queryByRole('group', { name: 'Voice minimum strength' })).not.toBeInTheDocument();
    fireEvent.click(within(voice).getByText('Required'));
    await waitFor(() => expect(screen.getByRole('group', { name: 'Voice minimum strength' })).toBeInTheDocument());
  });

  it('publish sends the CLIENT layer + enforcement_mode then refetches', async () => {
    render(<EngagementPolicyEditor companyId="co-1" onBack={vi.fn()} />);
    const email = await screen.findByRole('group', { name: 'Email engagement setting' });
    expect(screen.getByText('Publish changes')).toBeDisabled();
    fireEvent.click(within(email).getByText('Required'));
    await waitFor(() => expect(screen.getByText('Publish changes')).not.toBeDisabled());

    const loadsBefore = m.getEngagementLayers.mock.calls.length;
    fireEvent.click(screen.getByText('Publish changes'));
    await waitFor(() => expect(m.publishEngagement).toHaveBeenCalledTimes(1));
    expect(m.publishEngagement).toHaveBeenCalledWith({
      scope: 'CLIENT',
      scope_ref: 'co-1',
      version: '1',
      schema_version: 1,
      requirements: [{ channel: 'email', required: true, condition: 'recorded_evidence' }],
      enforcement_mode: 'ENFORCING',
    });
    await waitFor(() => expect(m.getEngagementLayers.mock.calls.length).toBeGreaterThan(loadsBefore));
  });
});
