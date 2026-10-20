import 'reflect-metadata';
import type { AuthContextType } from '@aramo/auth';
import { ESIGN_ROLE_KEYS, ESIGN_ROLE_PERMISSIONS, ESIGN_SCOPE } from '@aramo/identity';
import { describe, expect, it, vi } from 'vitest';

import { canManageBilling } from '../app/billing/esign-billing.controller.js';
import { SenderContextService } from '../app/sender/sender-context.service.js';
import { SenderEnvelopeService } from '../app/sender/sender-envelope.service.js';
import { SenderMembersService } from '../app/sender/sender-members.service.js';

// Sign Unified Product S-1 (Aramo-Sign-Unified-Product-Permission-Contract-
// Platform-API-Directive-v1_0-LOCKED §4.3) — the role matrix, own-vs-organization
// visibility and envelope ownership, enforced in sign-service.

const TENANT = '22222222-2222-7222-8222-222222222222';
const ME = '11111111-1111-7111-8111-111111111111';
const OTHER = '33333333-3333-7333-8333-333333333333';

function auth(scopes: readonly string[], sub = ME): AuthContextType {
  return { sub, consumer_type: 'sign', actor_kind: 'user', tenant_id: TENANT, scopes: [...scopes], iat: 0, exp: 0 };
}
const roleAuth = (role: (typeof ESIGN_ROLE_KEYS)[number], sub = ME): AuthContextType => auth(ESIGN_ROLE_PERMISSIONS[role], sub);

function ctx(kind = 'BUSINESS') {
  const tenants = {
    findById: vi.fn(async () => ({ id: TENANT, name: 'Astre', kind, is_active: true, status: 'ACTIVE' })),
    findSlugById: vi.fn(async () => 'astre'),
    findOrganizationNameById: vi.fn(async () => 'Astre Consulting Services Inc'),
  };
  return new SenderContextService(tenants as never, { findUserById: vi.fn(async () => null) } as never);
}

function envelopeSvc(owner: string, kind = 'BUSINESS', status = 'DRAFT', source_application = 'aramo-sign') {
  const repo = {
    listEnvelopes: vi.fn(async () => []),
    lastEventAt: vi.fn(async () => new Map()),
    countByStatus: vi.fn(async () => ({})),
    updateDraft: vi.fn(async () => undefined),
    replaceDraftRecipients: vi.fn(async () => []),
    getEnvelopeDetail: vi.fn(async () => ({
      id: 'e1', subject: 'S', status, created_by: owner, source_application, created_at: new Date(), sent_at: null, completed_at: null,
      declined_at: null, voided_at: null, documents: [], signers: [],
    })),
  };
  const provider = { voidEnvelope: vi.fn(), sendEnvelope: vi.fn(), remindEnvelopeSigner: vi.fn() };
  const svc = new SenderEnvelopeService(
    repo as never, provider as never, ctx(kind), { findUserById: vi.fn(async () => null) } as never,
    {} as never, {} as never, { reserveUpload: vi.fn(), release: vi.fn() } as never,
  );
  return { svc, repo, provider };
}

describe('Sign role contract — four distinct built-in roles', () => {
  const set = (r: (typeof ESIGN_ROLE_KEYS)[number]) => new Set(ESIGN_ROLE_PERMISSIONS[r]);
  it('Owner, Admin, Sender and Viewer are pairwise distinct', () => {
    const sigs = ESIGN_ROLE_KEYS.map((r) => [...set(r)].sort().join(','));
    expect(new Set(sigs).size).toBe(4);
  });
  it('Owner = Admin + billing; only Owner holds billing', () => {
    expect([...set('sign_owner')].filter((s) => !set('sign_admin').has(s))).toEqual([ESIGN_SCOPE.BILLING_MANAGE]);
    for (const r of ['sign_admin', 'sign_sender', 'sign_viewer'] as const) expect(set(r).has(ESIGN_SCOPE.BILLING_MANAGE)).toBe(false);
  });
  it('Sender: own envelopes only — no organization read, no organization changes, no administration', () => {
    for (const s of [ESIGN_SCOPE.ENVELOPE_READ_ALL, ESIGN_SCOPE.ENVELOPE_MANAGE_ALL, ESIGN_SCOPE.MEMBER_MANAGE, ESIGN_SCOPE.INTEGRATION_MANAGE, ESIGN_SCOPE.SETTINGS_MANAGE]) {
      expect(set('sign_sender').has(s)).toBe(false);
    }
    expect(set('sign_sender').has(ESIGN_SCOPE.ENVELOPE_SEND)).toBe(true);
  });
  it('Viewer: organization read and reports, never authoring or sending', () => {
    expect([...set('sign_viewer')].sort()).toEqual([ESIGN_SCOPE.ENVELOPE_READ, ESIGN_SCOPE.ENVELOPE_READ_ALL, ESIGN_SCOPE.REPORT_READ].sort());
  });
  it('every Sign permission lives in the esign: namespace', () => {
    for (const r of ESIGN_ROLE_KEYS) expect(ESIGN_ROLE_PERMISSIONS[r].every((s) => s.startsWith('sign:'))).toBe(true);
  });
});

describe('visibility — own vs organization (sign:envelope:read:all)', () => {
  it.each([
    ['sign_sender', ME],
    ['sign_viewer', undefined],
    ['sign_admin', undefined],
    ['sign_owner', undefined],
  ] as const)('%s lists with owner filter %s', async (role, expected) => {
    const { svc, repo } = envelopeSvc(ME);
    await svc.list(roleAuth(role), {}, 'r');
    expect(repo.listEnvelopes).toHaveBeenCalledWith(expect.objectContaining({ created_by: expected }));
  });

  it('a PERSONAL account reads only its own, even holding read:all', async () => {
    const { svc, repo } = envelopeSvc(ME, 'PERSONAL');
    await svc.list(roleAuth('sign_owner'), {}, 'r');
    expect(repo.listEnvelopes).toHaveBeenCalledWith(expect.objectContaining({ created_by: ME }));
  });

  it("a Sender cannot open another member's envelope (reads as not found)", async () => {
    const { svc } = envelopeSvc(OTHER);
    await expect(svc.detail(roleAuth('sign_sender'), 'e1', 'r')).rejects.toMatchObject({ code: 'ENVELOPE_NOT_FOUND', statusCode: 404 });
  });

  it("a Viewer opens another member's envelope", async () => {
    const { svc } = envelopeSvc(OTHER);
    await expect(svc.detail(roleAuth('sign_viewer'), 'e1', 'r')).resolves.toMatchObject({ id: 'e1' });
  });
});

describe('ownership — changing an envelope needs ownership or sign:envelope:manage:all', () => {
  const VOID = { reason: 'wrong person' };

  it("Sender: another member's envelope is invisible → 404; nothing is changed", async () => {
    const { svc, provider } = envelopeSvc(OTHER, 'BUSINESS', 'SENT');
    await expect(svc.void(roleAuth('sign_sender'), 'e1', VOID, 'r')).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.remind(roleAuth('sign_sender'), 'e1', 'r')).rejects.toMatchObject({ statusCode: 404 });
    expect(provider.voidEnvelope).not.toHaveBeenCalled();
    expect(provider.remindEnvelopeSigner).not.toHaveBeenCalled();
  });

  it("organization read without manage:all may see but not change another member's envelope → 403 envelope_not_owned", async () => {
    const { svc, provider, repo } = envelopeSvc(OTHER, 'BUSINESS', 'SENT');
    const readAllSender = auth([...ESIGN_ROLE_PERMISSIONS.sign_sender, ESIGN_SCOPE.ENVELOPE_READ_ALL]);
    await expect(svc.void(readAllSender, 'e1', VOID, 'r')).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403, context: { details: { reason: 'envelope_not_owned' } },
    });
    await expect(svc.update(readAllSender, 'e1', { subject: 'x' }, 'r')).rejects.toMatchObject({ statusCode: 403 });
    expect(provider.voidEnvelope).not.toHaveBeenCalled();
    expect(repo.updateDraft).not.toHaveBeenCalled();
  });

  it("Admin and Owner may void another member's envelope", async () => {
    for (const role of ['sign_admin', 'sign_owner'] as const) {
      const { svc, provider } = envelopeSvc(OTHER, 'BUSINESS', 'SENT');
      await svc.void(roleAuth(role), 'e1', VOID, 'r');
      expect(provider.voidEnvelope).toHaveBeenCalledTimes(1);
    }
  });

  it('the owner of the envelope may change it with Sender permissions', async () => {
    const { svc, provider, repo } = envelopeSvc(ME, 'BUSINESS', 'SENT');
    await svc.void(roleAuth('sign_sender'), 'e1', VOID, 'r');
    expect(provider.voidEnvelope).toHaveBeenCalledTimes(1);
    const draft = envelopeSvc(ME);
    await draft.svc.update(roleAuth('sign_sender'), 'e1', { subject: 'New' }, 'r');
    expect(draft.repo.updateDraft).toHaveBeenCalledTimes(1);
    expect(repo).toBeDefined();
  });
});

describe('sender context — permissions reflect the role, BUSINESS-only organization powers', () => {
  it('Owner in a BUSINESS tenant', async () => {
    const v = await ctx().context(roleAuth('sign_owner'), 'r');
    expect(v.permissions).toEqual({ read: true, read_all: true, create: true, send: true, manage_all: true, contacts: true, members: true, billing: true });
  });
  it('Sender', async () => {
    const v = await ctx().context(roleAuth('sign_sender'), 'r');
    expect(v.permissions).toEqual({ read: true, read_all: false, create: true, send: true, manage_all: false, contacts: true, members: false, billing: false });
  });
  it('PERSONAL never gets organization powers', async () => {
    const v = await ctx('PERSONAL').context(roleAuth('sign_owner'), 'r');
    expect(v.permissions).toMatchObject({ read_all: false, manage_all: false, members: false, billing: false });
  });
});

describe('billing administration — Sign Owner or organization settings authority', () => {
  it('either authority suffices; neither is refused', () => {
    expect(canManageBilling([ESIGN_SCOPE.BILLING_MANAGE])).toBe(true);
    expect(canManageBilling(['tenant:admin:settings'])).toBe(true);
    expect(canManageBilling(ESIGN_ROLE_PERMISSIONS.sign_admin)).toBe(false);
    expect(canManageBilling([])).toBe(false);
  });
});

function membersSvc(opts: { kind?: string; callerKeys: string[]; targetKeys: string[]; owners?: number; targetIsMember?: boolean }) {
  const memberships: Record<string, { id: string; is_active: boolean } | null> = {
    [ME]: { id: 'm-me', is_active: true },
    [OTHER]: opts.targetIsMember === false ? null : { id: 'm-other', is_active: true },
  };
  let targetKeys = [...opts.targetKeys];
  const ownerRows = Array.from({ length: opts.owners ?? 1 }, (_, i) => ({ user_id: `o${i}`, is_active: true, role_keys: ['sign_owner'] }));
  const repo = {
    findMembership: vi.fn(async ({ user_id }: { user_id: string }) => memberships[user_id] ?? null),
    listTenantUsers: vi.fn(async () => [
      { user_id: OTHER, email: 'o@x.test', display_name: 'Other', is_active: true, role_keys: targetKeys },
      ...ownerRows,
    ]),
  };
  const identity = {
    findRoleKeysForMembership: vi.fn(async (id: string) => (id === 'm-me' ? opts.callerKeys : targetKeys)),
    resolveRoleIdsByKeys: vi.fn(async (keys: string[]) => keys.map((k) => `id-${k}`)),
    replaceMembershipRoles: vi.fn(async (a: { role_keys: string[] }) => {
      targetKeys = [...a.role_keys];
      return { added_role_ids: [], removed_role_ids: [] };
    }),
  };
  return { svc: new SenderMembersService(ctx(opts.kind), repo as never, identity as never), identity };
}

describe('Sign member administration', () => {
  const admin = auth(ESIGN_ROLE_PERMISSIONS.sign_admin);

  it('changes only the Sign role and keeps every other role of the member', async () => {
    const { svc, identity } = membersSvc({ callerKeys: ['sign_admin'], targetKeys: ['recruiter', 'org_admin', 'sign_viewer'] });
    const v = await svc.setRole(admin, OTHER, { sign_role: 'sign_sender' }, 'r');
    expect(identity.replaceMembershipRoles).toHaveBeenCalledWith(expect.objectContaining({ role_keys: ['recruiter', 'org_admin', 'sign_sender'], tenant_id: TENANT }));
    expect(v).toMatchObject({ sign_role: 'sign_sender', sign_role_display: 'Sign Sender' });
  });

  it('null removes Sign access only', async () => {
    const { svc, identity } = membersSvc({ callerKeys: ['sign_admin'], targetKeys: ['recruiter', 'sign_sender'] });
    await svc.setRole(admin, OTHER, { sign_role: null }, 'r');
    expect(identity.replaceMembershipRoles).toHaveBeenCalledWith(expect.objectContaining({ role_keys: ['recruiter'] }));
  });

  it('an Admin cannot grant or remove the Owner role', async () => {
    const grant = membersSvc({ callerKeys: ['sign_admin'], targetKeys: [] });
    await expect(grant.svc.setRole(admin, OTHER, { sign_role: 'sign_owner' }, 'r')).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'owner_role_requires_owner' } } });
    const remove = membersSvc({ callerKeys: ['sign_admin'], targetKeys: ['sign_owner'], owners: 2 });
    await expect(remove.svc.setRole(admin, OTHER, { sign_role: 'sign_sender' }, 'r')).rejects.toMatchObject({ statusCode: 403 });
    expect(grant.identity.replaceMembershipRoles).not.toHaveBeenCalled();
    expect(remove.identity.replaceMembershipRoles).not.toHaveBeenCalled();
  });

  it('an Owner may grant Owner; the last Owner cannot be demoted', async () => {
    const owner = auth(ESIGN_ROLE_PERMISSIONS.sign_owner);
    const grant = membersSvc({ callerKeys: ['sign_owner'], targetKeys: [] });
    await expect(grant.svc.setRole(owner, OTHER, { sign_role: 'sign_owner' }, 'r')).resolves.toMatchObject({ sign_role: 'sign_owner' });
    const last = membersSvc({ callerKeys: ['sign_owner'], targetKeys: ['sign_owner'], owners: 0 });
    await expect(last.svc.setRole(owner, OTHER, { sign_role: 'sign_sender' }, 'r')).rejects.toMatchObject({ code: 'ESIGN_LAST_OWNER', statusCode: 409 });
    expect(last.identity.replaceMembershipRoles).not.toHaveBeenCalled();
  });

  it('a non-member of this organization reads as not found; an unknown role is refused', async () => {
    const outsider = membersSvc({ callerKeys: ['sign_admin'], targetKeys: [], targetIsMember: false });
    await expect(outsider.svc.setRole(admin, OTHER, { sign_role: 'sign_sender' }, 'r')).rejects.toMatchObject({ statusCode: 404 });
    const bad = membersSvc({ callerKeys: ['sign_admin'], targetKeys: [] });
    for (const sign_role of ['tenant_admin', 'super_admin', 42, undefined]) {
      await expect(bad.svc.setRole(admin, OTHER, { sign_role }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(bad.identity.replaceMembershipRoles).not.toHaveBeenCalled();
  });

  it('PERSONAL accounts have no member administration', async () => {
    const { svc } = membersSvc({ kind: 'PERSONAL', callerKeys: ['sign_owner'], targetKeys: [] });
    await expect(svc.list(admin, 'r')).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'personal_account' } } });
  });
});

describe('S-3 — envelopes from another application are visible per permission, never changed here', () => {
  it('an ATS envelope opens for a Viewer (organization read) and reports its origin', async () => {
    const { svc } = envelopeSvc(OTHER, 'BUSINESS', 'SENT', 'aramo-ats');
    await expect(svc.detail(roleAuth('sign_viewer'), 'e1', 'r')).resolves.toMatchObject({ source_application: 'aramo-ats', editable: false });
  });

  it('a Sender sees their own ATS envelope but an ATS envelope of someone else reads as not found', async () => {
    await expect(envelopeSvc(ME, 'BUSINESS', 'SENT', 'aramo-ats').svc.detail(roleAuth('sign_sender'), 'e1', 'r')).resolves.toMatchObject({ id: 'e1' });
    await expect(envelopeSvc(OTHER, 'BUSINESS', 'SENT', 'aramo-ats').svc.detail(roleAuth('sign_sender'), 'e1', 'r')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('even the owner or an Owner cannot remind, void or edit an ATS envelope from Sign → 409 managed_by_source_application', async () => {
    for (const [who, a] of [['owner', roleAuth('sign_sender')], ['Sign Owner', roleAuth('sign_owner')]] as const) {
      const { svc, provider, repo } = envelopeSvc(ME, 'BUSINESS', 'SENT', 'aramo-ats');
      await expect(svc.void(a, 'e1', { reason: 'x' }, 'r')).rejects.toMatchObject({ code: 'ENVELOPE_ILLEGAL_TRANSITION', statusCode: 409, context: { details: { reason: 'managed_by_source_application' } } });
      await expect(svc.remind(a, 'e1', 'r')).rejects.toMatchObject({ statusCode: 409 });
      await expect(svc.update(a, 'e1', { subject: 'y' }, 'r')).rejects.toMatchObject({ statusCode: 409 });
      expect(provider.voidEnvelope, who).not.toHaveBeenCalled();
      expect(provider.remindEnvelopeSigner, who).not.toHaveBeenCalled();
      expect(repo.updateDraft, who).not.toHaveBeenCalled();
    }
  });
});
