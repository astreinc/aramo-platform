import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformSession } from '../skills/test-session';

import {
  matchingPolicyApi,
  type EvidenceThresholds,
  type MatchingPolicyState,
  type MatchingPolicyVersion,
} from './matching-policy-api';
import { MatchingPolicyView } from './MatchingPolicyView';

const READ = ['platform:matching_policy:read'];
const WRITE = ['platform:matching_policy:read', 'platform:matching_policy:write'];

const THRESHOLDS: EvidenceThresholds = {
  backend_engineer: { count: 2, requires_ingested: true },
  frontend_engineer: { count: 2, requires_ingested: true },
  fullstack_engineer: { count: 2, requires_ingested: true },
  devops_sre: { count: 2, requires_ingested: true },
  data_engineer: { count: 2, requires_ingested: true },
  architect: { count: 3, requires_ingested: true },
  qa_test_engineer: { count: 2, requires_ingested: true },
  product_project_manager: { count: 2, requires_ingested: false },
  business_analyst: { count: 2, requires_ingested: false },
};

function version(over: Partial<MatchingPolicyVersion>): MatchingPolicyVersion {
  return {
    id: 'v1',
    version_number: 1,
    status: 'ACTIVE',
    evidence_thresholds: THRESHOLDS,
    note: 'Seed',
    created_by: null,
    created_at: '2026-10-23T00:00:00.000Z',
    activated_by: null,
    activated_at: '2026-10-23T00:00:00.000Z',
    retired_at: null,
    ...over,
  };
}

const STATE: MatchingPolicyState = {
  active: version({}),
  versions: [version({ id: 'v2', version_number: 2, status: 'DRAFT', note: 'raise', activated_at: null }), version({})],
};

function renderView(scopes: string[]) {
  return render(
    <MemoryRouter>
      <MatchingPolicyView session={platformSession(scopes)} />
    </MemoryRouter>,
  );
}

describe('MatchingPolicyView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the active policy and the version history', async () => {
    vi.spyOn(matchingPolicyApi, 'getPolicy').mockResolvedValue(STATE);
    renderView(READ);
    expect(await screen.findByText('Active policy — v1')).toBeInTheDocument();
    expect(screen.getAllByText('Architect').length).toBeGreaterThan(0);
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText('DRAFT')).toBeInTheDocument();
  });

  it('read-only scope sees no edit or activate controls', async () => {
    vi.spyOn(matchingPolicyApi, 'getPolicy').mockResolvedValue(STATE);
    renderView(READ);
    await screen.findByText('Active policy — v1');
    expect(screen.queryByRole('button', { name: 'Edit as new version' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate v2' })).not.toBeInTheDocument();
  });

  it('write scope creates a new DRAFT version from the active thresholds', async () => {
    vi.spyOn(matchingPolicyApi, 'getPolicy').mockResolvedValue(STATE);
    const create = vi
      .spyOn(matchingPolicyApi, 'createVersion')
      .mockResolvedValue(version({ id: 'v3', version_number: 3, status: 'DRAFT' }));
    renderView(WRITE);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit as new version' }));
    fireEvent.change(screen.getByLabelText('Architect evidence count'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as draft version' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const body = create.mock.calls[0]?.[0];
    expect(body?.evidence_thresholds.architect).toEqual({ count: 4, requires_ingested: true });
    expect(body?.evidence_thresholds.backend_engineer).toEqual({ count: 2, requires_ingested: true });
  });

  it('refuses to save an out-of-bounds count client-side', async () => {
    vi.spyOn(matchingPolicyApi, 'getPolicy').mockResolvedValue(STATE);
    renderView(WRITE);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit as new version' }));
    fireEvent.change(screen.getByLabelText('Architect evidence count'), { target: { value: '0' } });
    expect(screen.getByRole('button', { name: 'Save as draft version' })).toBeDisabled();
  });

  it('write scope activates a non-active version', async () => {
    vi.spyOn(matchingPolicyApi, 'getPolicy').mockResolvedValue(STATE);
    const activate = vi
      .spyOn(matchingPolicyApi, 'activateVersion')
      .mockResolvedValue(version({ id: 'v2', version_number: 2 }));
    renderView(WRITE);
    fireEvent.click(await screen.findByRole('button', { name: 'Activate v2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(activate).toHaveBeenCalledWith('v2'));
  });
});
