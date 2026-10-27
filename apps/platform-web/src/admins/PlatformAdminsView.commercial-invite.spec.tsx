import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import { governanceApi, type Roster, type RosterOperator } from '../commercial-governance/governance-api';
import { platformSession } from '../skills/test-session';

import { adminInviteErrorText, adminsApi, isHumanRefHash } from './admins-api';
import { PlatformAdminsView } from './PlatformAdminsView';

// CCP-INV-UI-1 (LOCKED 2026-10-26) — an attested platform_owner invites a NEW member straight into
// one platform role from the console (R-2…R-7); everyone else gets the unchanged super_admin-only
// dialog (R-3, fail closed while the roster loads or fails); the refusals map to copy (R-6, R-8).

const OWNER = 'u-owner';
const HASH = 'a'.repeat(64);
const SCOPES = ['platform:approval:read', 'platform:admin:invite'];
const sess = (sub: string): Session => ({ ...platformSession(SCOPES), sub });
const op = (o: Partial<RosterOperator> & { user_id: string }): RosterOperator => ({
  email: `${o.user_id}@aramo.ai`,
  display_name: null,
  role_keys: [],
  commercial_role_keys: [],
  attested: true,
  is_last_owner: false,
  pending_role_requests: [],
  ...o,
});
const roster = (operators: RosterOperator[]): Roster => ({ operators, chains: [], all_fulfillable: false });
const ownerRoster = roster([
  op({ user_id: OWNER, role_keys: ['super_admin', 'platform_owner'], commercial_role_keys: ['platform_owner'], is_last_owner: true }),
]);
const RESULT = { tenant_id: 't0', user_id: 'u9', membership_id: 'm9', role_keys: ['finance_admin'], status: 'invitation_sent' as const };

async function openDialog(email = 'finance_admin@aramo.ai'): Promise<HTMLElement> {
  fireEvent.change(screen.getByLabelText('Staff email'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: 'Review invitation…' }));
  return screen.findByRole('dialog', { name: 'Invite platform admin' });
}

describe('CCP-INV-UI-1 admins invite — commercial role picker', () => {
  beforeEach(() => {
    vi.spyOn(governanceApi, 'listPolicyVersions').mockRejectedValue(new Error('not needed'));
  });
  afterEach(() => vi.restoreAllMocks());

  it('INV-UI-1 an attested owner picks a commercial role; the hash gates commit; the body carries role_keys + human_ref_hash; the roster re-reads', async () => {
    const list = vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(ownerRoster);
    const invite = vi.spyOn(adminsApi, 'invitePlatformAdmin').mockResolvedValue(RESULT);
    render(<PlatformAdminsView session={sess(OWNER)} />);
    expect(await screen.findByText(/you choose the role in the review step/)).toBeInTheDocument();
    const dialog = await openDialog();
    const role = within(dialog).getByLabelText('Role');
    expect(within(role).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Super admin',
      'Platform owner',
      'Finance admin',
      'Commercial ops',
      'Catalog manager',
      'Support admin',
      'Read-only auditor',
    ]);
    expect(within(dialog).queryByLabelText('Identity reference hash')).toBeNull();
    fireEvent.change(role, { target: { value: 'finance_admin' } });
    expect(dialog).toHaveTextContent('This person joins as Finance admin');
    expect(dialog).toHaveTextContent('You are recorded as the person who attests their identity.');
    const hash = within(dialog).getByLabelText('Identity reference hash');
    fireEvent.change(within(dialog).getByLabelText('Type the email to confirm'), { target: { value: 'finance_admin@aramo.ai' } });
    const commit = within(dialog).getByRole('button', { name: 'Send admin invitation' });
    expect(commit).toBeDisabled();
    fireEvent.change(hash, { target: { value: 'A'.repeat(64) } });
    expect(hash).toHaveAttribute('aria-invalid', 'true');
    expect(commit).toBeDisabled();
    fireEvent.change(hash, { target: { value: ` ${HASH} ` } });
    expect(commit).toBeEnabled();
    const reads = list.mock.calls.length;
    fireEvent.click(commit);
    await waitFor(() =>
      expect(invite).toHaveBeenCalledWith({ email: 'finance_admin@aramo.ai', role_keys: ['finance_admin'], human_ref_hash: HASH }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Invitation sent to finance_admin@aramo.ai.');
    await waitFor(() => expect(list.mock.calls.length).toBe(reads + 1));
  });

  it('INV-UI-2 an owner who leaves Super admin selected sends today’s body (no role_keys, no hash)', async () => {
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(ownerRoster);
    const invite = vi.spyOn(adminsApi, 'invitePlatformAdmin').mockResolvedValue({ ...RESULT, role_keys: ['super_admin'] });
    render(<PlatformAdminsView session={sess(OWNER)} />);
    await screen.findByText(/you choose the role in the review step/);
    const dialog = await openDialog('ops@aramo.ai');
    expect(dialog).toHaveTextContent('with all 10 platform permissions');
    fireEvent.change(within(dialog).getByLabelText('Type the email to confirm'), { target: { value: 'ops@aramo.ai' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send admin invitation' }));
    await waitFor(() => expect(invite).toHaveBeenCalledWith({ email: 'ops@aramo.ai' }));
  });

  it.each([
    ['not attested', roster([op({ user_id: OWNER, commercial_role_keys: ['platform_owner'], attested: false })])],
    ['not an owner', roster([op({ user_id: OWNER, role_keys: ['super_admin'], commercial_role_keys: ['finance_admin'] })])],
    ['absent from the roster', roster([])],
  ])('INV-UI-3 no picker when the signed-in operator is %s', async (_label, r) => {
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(r);
    render(<PlatformAdminsView session={sess(OWNER)} />);
    await waitFor(() => expect(governanceApi.listOperators).toHaveBeenCalled());
    expect(screen.getByText(/joins the Aramo Platform tenant as/)).toBeInTheDocument();
    const dialog = await openDialog();
    expect(within(dialog).queryByLabelText('Role')).toBeNull();
    expect(dialog).toHaveTextContent('with all 10 platform permissions');
  });

  it('INV-UI-4 fail closed: no picker while the roster is loading or after it fails', async () => {
    vi.spyOn(governanceApi, 'listOperators').mockReturnValue(new Promise(() => undefined));
    const { unmount } = render(<PlatformAdminsView session={sess(OWNER)} />);
    let dialog = await openDialog();
    expect(within(dialog).queryByLabelText('Role')).toBeNull();
    unmount();
    vi.spyOn(governanceApi, 'listOperators').mockRejectedValue(new ApiError(503, 'down', 'SERVICE_UNAVAILABLE'));
    render(<PlatformAdminsView session={sess(OWNER)} />);
    dialog = await openDialog();
    expect(within(dialog).queryByLabelText('Role')).toBeNull();
  });

  it('INV-UI-5 a super_admin without the commercial read scope keeps the PLATFORM-UX-1 page and dialog', async () => {
    const list = vi.spyOn(governanceApi, 'listOperators');
    render(<PlatformAdminsView session={platformSession(['platform:admin:invite'])} />);
    const dialog = await openDialog();
    expect(within(dialog).queryByLabelText('Role')).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it('INV-UI-6 a server refusal shows inside the dialog', async () => {
    vi.spyOn(governanceApi, 'listOperators').mockResolvedValue(ownerRoster);
    vi.spyOn(adminsApi, 'invitePlatformAdmin').mockRejectedValue(
      new ApiError(400, 'in use', 'VALIDATION_ERROR', { reason: 'human_ref_in_use' }),
    );
    render(<PlatformAdminsView session={sess(OWNER)} />);
    await screen.findByText(/you choose the role in the review step/);
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'catalog_manager' } });
    fireEvent.change(within(dialog).getByLabelText('Identity reference hash'), { target: { value: HASH } });
    fireEvent.change(within(dialog).getByLabelText('Type the email to confirm'), { target: { value: 'finance_admin@aramo.ai' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send admin invitation' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already belongs to another account');
  });
});

describe('CCP-INV-UI-1 helpers', () => {
  it('INV-UI-7 the hash rule mirrors the server (64 lowercase hex)', () => {
    expect(isHumanRefHash(HASH)).toBe(true);
    expect(isHumanRefHash('A'.repeat(64))).toBe(false);
    expect(isHumanRefHash('a'.repeat(63))).toBe(false);
    expect(isHumanRefHash(`${'a'.repeat(63)}g`)).toBe(false);
  });

  it('INV-UI-8 the commercial refusals and the existing-member case map to operator copy; the old mappings hold', () => {
    const t = (reason: string, code = 'VALIDATION_ERROR', status = 400) =>
      adminInviteErrorText(new ApiError(status, 'x', code, { reason }));
    expect(t('attester_not_platform_owner', 'INSUFFICIENT_PERMISSIONS', 403)).toBe('Only an attested Platform owner can invite a commercial role.');
    expect(t('human_ref_required')).toContain('identity reference hash');
    expect(t('human_ref_in_use')).toContain('One person, one account');
    expect(t('human_ref_not_applicable')).toContain('only to a commercial role');
    expect(t('existing_platform_admin', 'INVITATION_ALREADY_EXISTS', 409)).toContain('Request role change…');
    expect(adminInviteErrorText(new ApiError(409, 'dup', 'INVITATION_ALREADY_EXISTS'))).toBe('This person is already a platform admin.');
  });
});
