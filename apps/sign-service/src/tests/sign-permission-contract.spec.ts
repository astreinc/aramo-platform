import 'reflect-metadata';
import type { AuthContextType } from '@aramo/auth';
import { AramoError } from '@aramo/common';
import { ESIGN_ROLE_KEYS, ESIGN_ROLE_PERMISSIONS, ESIGN_SCOPE } from '@aramo/identity';
import { describe, expect, it, vi } from 'vitest';

import { canManageBilling } from '../app/billing/esign-billing.controller.js';
import { SenderContextService } from '../app/sender/sender-context.service.js';
import { SenderEnvelopeService } from '../app/sender/sender-envelope.service.js';
import { EsignSenderController } from '../app/sender/esign-sender.controller.js';

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
// ROLES-1 PR-3 — the Sign Owner role is retired; the organization owner (tenant_owner)
// carries every Sign permission incl. billing (= Sign Admin + sign:billing:manage) on a
// sign session (ADR-0035 R1; Conforming Amendment 6).
const ORG_OWNER_SIGN_SCOPES: readonly string[] = [...ESIGN_ROLE_PERMISSIONS.sign_admin, ESIGN_SCOPE.BILLING_MANAGE];
const orgOwnerAuth = (sub = ME): AuthContextType => auth(ORG_OWNER_SIGN_SCOPES, sub);

function ctx(kind = 'BUSINESS') {
  const tenants = {
    findById: vi.fn(async () => ({ id: TENANT, name: 'Astre', kind, is_active: true, status: 'ACTIVE' })),
    findSlugById: vi.fn(async () => 'astre'),
    findOrganizationNameById: vi.fn(async () => 'Astre Consulting Services Inc'),
  };
  return new SenderContextService(tenants as never, { findUserById: vi.fn(async () => null), findMembership: vi.fn(async () => null), findRoleKeysForMembership: vi.fn(async () => []) } as never);
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

describe('Sign role contract — three distinct built-in roles (ROLES-1 PR-3: Sign Owner retired)', () => {
  const set = (r: (typeof ESIGN_ROLE_KEYS)[number]) => new Set(ESIGN_ROLE_PERMISSIONS[r]);
  it('the Sign roles are exactly Admin, Sender and Viewer, pairwise distinct; sign_owner is not one', () => {
    expect([...ESIGN_ROLE_KEYS]).toEqual(['sign_admin', 'sign_sender', 'sign_viewer']);
    expect(Object.keys(ESIGN_ROLE_PERMISSIONS).sort()).toEqual(['sign_admin', 'sign_sender', 'sign_viewer']);
    const sigs = ESIGN_ROLE_KEYS.map((r) => [...set(r)].sort().join(','));
    expect(new Set(sigs).size).toBe(3);
  });
  it('no Sign role holds billing (billing belongs to the organization owner)', () => {
    for (const r of ESIGN_ROLE_KEYS) expect(set(r).has(ESIGN_SCOPE.BILLING_MANAGE)).toBe(false);
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
  ] as const)('%s lists with owner filter %s', async (role, expected) => {
    const { svc, repo } = envelopeSvc(ME);
    await svc.list(roleAuth(role), {}, 'r');
    expect(repo.listEnvelopes).toHaveBeenCalledWith(expect.objectContaining({ created_by: expected }));
  });

  it('the organization owner lists every organization envelope', async () => {
    const { svc, repo } = envelopeSvc(ME);
    await svc.list(orgOwnerAuth(), {}, 'r');
    expect(repo.listEnvelopes).toHaveBeenCalledWith(expect.objectContaining({ created_by: undefined }));
  });

  it('a PERSONAL account reads only its own, even holding read:all', async () => {
    const { svc, repo } = envelopeSvc(ME, 'PERSONAL');
    await svc.list(orgOwnerAuth(), {}, 'r');
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

  it("Admin and the organization owner may void another member's envelope", async () => {
    for (const a of [roleAuth('sign_admin'), orgOwnerAuth()]) {
      const { svc, provider } = envelopeSvc(OTHER, 'BUSINESS', 'SENT');
      await svc.void(a, 'e1', VOID, 'r');
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
  it('the organization owner in a BUSINESS tenant', async () => {
    const v = await ctx().context(orgOwnerAuth(), 'r');
    expect(v.permissions).toEqual({ read: true, read_all: true, create: true, send: true, manage_all: true, contacts: true, members: true, billing: true, templates: false });
  });
  it('Sender', async () => {
    const v = await ctx().context(roleAuth('sign_sender'), 'r');
    expect(v.permissions).toEqual({ read: true, read_all: false, create: true, send: true, manage_all: false, contacts: true, members: false, billing: false, templates: false });
  });
  it('PERSONAL never gets organization powers', async () => {
    const v = await ctx('PERSONAL').context(orgOwnerAuth(), 'r');
    expect(v.permissions).toMatchObject({ read_all: false, manage_all: false, members: false, billing: false });
  });
  // ROLES-1 PR-2 (§3.4) — billing permission = sign:billing:manage only; organization
  // settings authority (the former fallback) no longer shows the plan controls.
  it('organization settings authority alone does not grant the billing permission', async () => {
    const admin = { ...roleAuth('sign_admin') };
    const v = await ctx().context({ ...admin, scopes: [...admin.scopes, 'tenant:admin:settings'] }, 'r');
    expect(v.permissions.billing).toBe(false);
  });
});

// ROLES-1 PR-2 (§3.4, F-3) — billing is sign:billing:manage ONLY (the tenant_owner bundle);
// the tenant:admin:settings fallback is removed.
describe('billing administration — sign:billing:manage only', () => {
  it('only sign:billing:manage authorizes; organization settings authority alone is refused', () => {
    expect(canManageBilling([ESIGN_SCOPE.BILLING_MANAGE])).toBe(true);
    expect(canManageBilling(['tenant:admin:settings'])).toBe(false);
    expect(canManageBilling(ESIGN_ROLE_PERMISSIONS.sign_admin)).toBe(false);
    expect(canManageBilling([])).toBe(false);
  });
});

// ORG-UX-1 (Directive v1.0 LOCKED §6, P7, Lead Correction C) — Sign's member role
// administration is retired: Organization → Users & product access is the single
// role-assignment surface. The members routes and SenderMembersService are gone.
describe('Sign member administration is retired (single role authority)', () => {
  it('the sender controller exposes no member list or Sign-role write', () => {
    const handlers = Object.getOwnPropertyNames(EsignSenderController.prototype);
    expect(handlers).not.toContain('listMembers');
    expect(handlers).not.toContain('setMemberRole');
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
    for (const [who, a] of [['owner', roleAuth('sign_sender')], ['organization owner', orgOwnerAuth()]] as const) {
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
