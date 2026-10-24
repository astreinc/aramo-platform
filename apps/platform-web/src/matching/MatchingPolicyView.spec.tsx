import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '@aramo/fe-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformSession } from '../skills/test-session';

import {
  COMPILED_DEFAULT_THRESHOLDS,
  matchingPolicyApi,
  type EvidenceThresholds,
  type MatchingPolicyState,
  type MatchingPolicyVersion,
} from './matching-policy-api';
import { MatchingPolicyView, clampCount, impactRows } from './MatchingPolicyView';

// PLATFORM-UX-1 F-8 (handoff §9 Matching policy) — active vN table / compiled
// defaults, edit as a new DRAFT version, history with Activate vN… and the
// 720px activation dialog with its impact diff; view-only for :read.

const READ = ['platform:matching_policy:read'];
const WRITE = ['platform:matching_policy:read', 'platform:matching_policy:write'];

const THRESHOLDS: EvidenceThresholds = { ...COMPILED_DEFAULT_THRESHOLDS };
const RAISED: EvidenceThresholds = {
  ...THRESHOLDS,
  architect: { count: 4, requires_ingested: true },
  business_analyst: { count: 2, requires_ingested: true },
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
  versions: [
    version({ id: 'v2', version_number: 2, status: 'DRAFT', note: 'Raise architect', activated_at: null, evidence_thresholds: RAISED }),
    version({}),
  ],
};

function renderView(scopes: string[]) {
  return render(
    <MemoryRouter>
      <MatchingPolicyView session={platformSession(scopes)} />
    </MemoryRouter>,
  );
}

describe('matching policy model', () => {
  it('builds the impact diff: every family, changed rows flagged', () => {
    const rows = impactRows(THRESHOLDS, RAISED);
    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => r.changed).map((r) => r.family)).toEqual(['architect', 'business_analyst']);
    expect(rows.find((r) => r.family === 'architect')).toMatchObject({ now: '3 · ingested', after: '4 · ingested' });
    expect(rows.find((r) => r.family === 'business_analyst')).toMatchObject({ now: '2', after: '2 · ingested' });
  });

  it('diffs against the compiled defaults when no version is active', () => {
    expect(impactRows(null, COMPILED_DEFAULT_THRESHOLDS).some((r) => r.changed)).toBe(false);
  });

  it('clamps an edited count into 1–20', () => {
    expect(clampCount('0')).toBe(1);
    expect(clampCount('')).toBe(1);
    expect(clampCount('7')).toBe(7);
    expect(clampCount('25')).toBe(20);
  });
});

describe('MatchingPolicyView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the active vN table and the version history', async () => {
    vi.spyOn(matchingPolicyApi, 'getPolicy').mockResolvedValue(STATE);
    renderView(READ);
    expect(await screen.findByRole('heading', { name: 'Active policy v1' })).toBeInTheDocument();
    expect(screen.getByText('Activated 23 Oct 2026 · Seed')).toBeInTheDocument();
    const arch = screen.getByTestId('mp-row-architect');
    expect(arch).toHaveTextContent('Architect');
    expect(arch).toHaveTextContent('3');
    expect(arch).toHaveTextContent('Required');
    expect(screen.getByTestId('mp-row-business_analyst')).toHaveTextContent('Not required');
    const v2 = screen.getByTestId('mp-version-2');
    expect(v2).toHaveTextContent('v2');
    expect(v2).toHaveTextContent('Draft');
    expect(v2).toHaveTextContent('Raise architect');
    expect(v2).toHaveTextContent('Created 23 Oct 2026 · last activated —');
  });

  it('says compiled defaults apply when no version is active', async () => {
    vi.spyOn(matchingPolicyApi, 'getPolicy').mockResolvedValue({ active: null, versions: [] });
    renderView(READ);
    expect(await screen.findByRole('heading', { name: 'No active version' })).toBeInTheDocument();
    expect(screen.getByText('Compiled defaults apply.')).toBeInTheDocument();
    expect(screen.getByTestId('mp-row-architect')).toHaveTextContent('3');
  });

  it(':read sees the view-only note, never silently missing buttons', async () => {
    vi.spyOn(matchingPolicyApi, 'getPolicy').mockResolvedValue(STATE);
    renderView(READ);
    await screen.findByTestId('mp-version-2');
    expect(screen.getByRole('note')).toHaveTextContent('View only.Changing the policy needs the Change matching policy permission.');
    expect(screen.queryByRole('button', { name: 'Edit as new version' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Activate v2…' })).toBeNull();
  });

  it('edits as a new DRAFT version with inline inputs, checkboxes and a note', async () => {
    vi.spyOn(matchingPolicyApi, 'getPolicy').mockResolvedValue(STATE);
    const create = vi.spyOn(matchingPolicyApi, 'createVersion').mockResolvedValue(version({ id: 'v3', version_number: 3, status: 'DRAFT' }));
    renderView(WRITE);
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit as new version' }));
    expect(screen.getByRole('heading', { name: 'New draft version' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit as new version' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Architect: minimum evidence'), { target: { value: '25' } });
    expect(screen.getByLabelText('Architect: minimum evidence')).toHaveValue(20);
    fireEvent.change(screen.getByLabelText('Architect: minimum evidence'), { target: { value: '4' } });
    fireEvent.click(screen.getByLabelText('Business analyst: ingested evidence required'));
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: ' Raise architect ' } });
    expect(screen.getByText('17 / 500')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft version' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const body = create.mock.calls[0]?.[0];
    expect(body?.note).toBe('Raise architect');
    expect(body?.evidence_thresholds.architect).toEqual({ count: 4, requires_ingested: true });
    expect(body?.evidence_thresholds.business_analyst).toEqual({ count: 2, requires_ingested: true });
    expect(body?.evidence_thresholds.backend_engineer).toEqual({ count: 2, requires_ingested: true });
  });

  it('cancel discards the draft; a save refusal stays in the editor', async () => {
    vi.spyOn(matchingPolicyApi, 'getPolicy').mockResolvedValue(STATE);
    vi.spyOn(matchingPolicyApi, 'createVersion').mockRejectedValue(
      new ApiError(400, 'Invalid policy', 'VALIDATION_ERROR', { errors: ['architect.count out of range'] }),
    );
    renderView(WRITE);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit as new version' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft version' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid policy: architect.count out of range');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('heading', { name: 'Active policy v1' })).toBeInTheDocument();
  });

  it('activates a version from the 720px dialog that shows the impact diff', async () => {
    vi.spyOn(matchingPolicyApi, 'getPolicy').mockResolvedValue(STATE);
    const activate = vi.spyOn(matchingPolicyApi, 'activateVersion').mockResolvedValue(version({ id: 'v2', version_number: 2 }));
    renderView(WRITE);
    expect(within(await screen.findByTestId('mp-version-1')).queryByRole('button')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Activate v2…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Activate v2' });
    expect(dialog).toHaveTextContent('v1 active');
    expect(dialog).toHaveTextContent('v2 active');
    expect(dialog).toHaveTextContent('from the next matching run. v1 is retired and can be activated again later.');
    const table = within(dialog).getByRole('table', { name: 'Impact of activation' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Role family',
      'Active now',
      'After activation',
    ]);
    const changed = table.querySelectorAll('tr[data-changed]');
    expect(Array.from(changed).map((r) => r.textContent)).toEqual([
      'Architect3 · ingested● Changed: 4 · ingested',
      'Business analyst2● Changed: 2 · ingested',
    ]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Activate v2' }));
    await waitFor(() => expect(activate).toHaveBeenCalledWith('v2'));
  });

  it('shows compiled defaults as the "from" of a first activation', async () => {
    const draft = version({ id: 'v1', status: 'DRAFT', activated_at: null });
    vi.spyOn(matchingPolicyApi, 'getPolicy').mockResolvedValue({ active: null, versions: [draft] });
    renderView(WRITE);
    fireEvent.click(await screen.findByRole('button', { name: 'Activate v1…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Activate v1' });
    expect(dialog).toHaveTextContent('Compiled defaults');
    expect(dialog).not.toHaveTextContent('is retired');
  });
});
