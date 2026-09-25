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
  it('renders the voice + email channels in the 4-column table; the catalog is the closed verifiable set (no generic rule builder)', async () => {
    render(<EngagementPolicyEditor companyId="co-1" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Voice engagement setting' })).toBeInTheDocument());
    expect(screen.getByRole('group', { name: 'Email engagement setting' })).toBeInTheDocument();
    // the "+ Add requirement" affordance exists, but opens the closed catalog — never a
    // generic predicate builder. For engagement the verifiable set is exactly voice + email.
    fireEvent.click(screen.getByText('+ Add requirement'));
    expect(screen.getByText(/only channels Aramo can verify/i)).toBeInTheDocument();
  });

  it('choosing Required for a channel reveals its runtime-override control', async () => {
    render(<EngagementPolicyEditor companyId="co-1" onBack={vi.fn()} />);
    const email = await screen.findByRole('group', { name: 'Email engagement setting' });
    expect(screen.queryByRole('group', { name: 'Email engagement runtime override' })).not.toBeInTheDocument();
    fireEvent.click(within(email).getByText('Required'));
    await waitFor(() => expect(screen.getByRole('group', { name: 'Email engagement runtime override' })).toBeInTheDocument());
  });

  it('publish sends the CLIENT layer + derived enforcement_mode then refetches', async () => {
    render(<EngagementPolicyEditor companyId="co-1" onBack={vi.fn()} />);
    const email = await screen.findByRole('group', { name: 'Email engagement setting' });
    expect(screen.getByRole('button', { name: 'Publish changes' })).toBeDisabled();
    fireEvent.click(within(email).getByText('Required'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish changes' })).not.toBeDisabled());

    const loadsBefore = m.getEngagementLayers.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Publish changes' }));
    // confirm in the modal
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
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
