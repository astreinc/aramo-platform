import { ApiError } from '@aramo/fe-foundation';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getClientSubmittalLayers: vi.fn(),
  getClientSubmittalHistory: vi.fn(),
  publishClientSubmittal: vi.fn(),
}));
vi.mock('../policies-api', () => m);

import { SignSubscriptionProvider } from '../../rtr/rtr-access';

import { ClientSubmittalPolicyEditor } from './ClientSubmittalPolicyEditor';

const prov = (o: Record<string, boolean> = {}) => ({
  inherited: true, client_override: false, client_added: false, tenant_floor: false, ...o,
});

beforeEach(() => {
  m.getClientSubmittalLayers.mockResolvedValue({
    layers: {
      tenant: {
        present: true,
        requirements: [
          { key: 'resume_selected', disposition: 'REQUIRED', override_class: 'HARD_DENY', override_policy: 'DEFAULT' },
          { key: 'work_authorization_present', disposition: 'REQUIRED', override_class: 'HARD_DENY', override_policy: 'FLOOR' },
        ],
      },
      client: { present: false, requirements: [] },
      requisition: null,
      effective: {
        requirements: [
          { key: 'resume_selected', effective: { disposition: 'REQUIRED', override_class: 'HARD_DENY', override_policy: 'DEFAULT' }, source: { scope: 'TENANT' }, provenance: prov() },
          { key: 'work_authorization_present', effective: { disposition: 'REQUIRED', override_class: 'HARD_DENY', override_policy: 'FLOOR' }, source: { scope: 'TENANT' }, provenance: prov({ tenant_floor: true }) },
        ],
      },
    },
  });
  m.getClientSubmittalHistory.mockResolvedValue({ versions: [] });
  m.publishClientSubmittal.mockResolvedValue({ published: {} });
});

describe('ClientSubmittalPolicyEditor', () => {
  it('renders a tri-toggle per non-floored canonical requirement key', async () => {
    render(<ClientSubmittalPolicyEditor companyId="co-1" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Bill rate setting' })).toBeInTheDocument());
    expect(screen.getByRole('group', { name: 'Right to Represent setting' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Resume selected setting' })).toBeInTheDocument();
  });

  it('a tenant-floored requirement is locked (no toggle) and shows the Tenant floor badge', async () => {
    render(<ClientSubmittalPolicyEditor companyId="co-1" onBack={vi.fn()} />);
    await screen.findByRole('group', { name: 'Bill rate setting' });
    // Work authorization is a tenant floor → rendered as a locked chip, not a toggle group.
    expect(screen.queryByRole('group', { name: 'Work authorization setting' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Tenant floor').length).toBeGreaterThanOrEqual(1);
  });

  it('publish sends ONLY the CLIENT layer (changed requirements) then refetches', async () => {
    render(<ClientSubmittalPolicyEditor companyId="co-1" onBack={vi.fn()} />);
    const billRate = await screen.findByRole('group', { name: 'Bill rate setting' });
    // Nothing changed yet → publish is disabled.
    expect(screen.getByRole('button', { name: 'Publish changes' })).toBeDisabled();
    fireEvent.click(within(billRate).getByText('Required'));
    await waitFor(() => expect(screen.getByText('1 change to publish')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Publish changes' })).not.toBeDisabled();

    const loadsBefore = m.getClientSubmittalLayers.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Publish changes' }));
    // confirm in the modal
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(m.publishClientSubmittal).toHaveBeenCalledTimes(1));
    expect(m.publishClientSubmittal).toHaveBeenCalledWith({
      scope: 'CLIENT',
      scope_ref: 'co-1',
      version: '1',
      requirements: [
        { key: 'bill_rate_present', disposition: 'REQUIRED', override_class: 'HARD_DENY', override_policy: 'DEFAULT' },
      ],
    });
    // §31 — refetch the authoritative layers after publish (never trust a local effective).
    await waitFor(() => expect(m.getClientSubmittalLayers.mock.calls.length).toBeGreaterThan(loadsBefore));
  });

  it('without Aramo Sign: warns on Required RTR and explains the server refusal inline', async () => {
    m.publishClientSubmittal.mockRejectedValue(
      new ApiError(422, 'refused', 'CLIENT_SUBMITTAL_POLICY_INVALID', { reason: 'RTR_REQUIRES_SIGN', key: 'rtr_present' }),
    );
    render(
      <SignSubscriptionProvider subscribed={false}>
        <ClientSubmittalPolicyEditor companyId="co-1" onBack={vi.fn()} />
      </SignSubscriptionProvider>,
    );
    const rtr = await screen.findByRole('group', { name: 'Right to Represent setting' });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    fireEvent.click(within(rtr).getByText('Required'));
    expect(await screen.findByRole('note')).toHaveTextContent('Requires Aramo Sign');
    fireEvent.click(screen.getByRole('button', { name: 'Publish changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('needs Aramo Sign');
    // The editor stays on screen with the unsaved choice.
    expect(screen.getByRole('group', { name: 'Right to Represent setting' })).toBeInTheDocument();
  });
});
