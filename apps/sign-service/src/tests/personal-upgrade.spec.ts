import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdentityRepository, IdentityService, PersonalRiskService, PersonalUpgradeRepository, TenantRepository } from '@aramo/identity';
import { LEGAL_DOCUMENTS, type FreePersonalSubscriptionService, type LegalAcceptanceService, type LegalDocumentVersion } from '@aramo/subscription';

import { PersonalUpgradeService, personalUpgradeEnabled, upgradeProfileFields } from '../app/account/personal-upgrade.service.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §5 — the Personal → Business
// upgrade: the service rules with the identity / subscription collaborators stubbed (the
// real transaction runs in personal-upgrade.integration.spec.ts).

const TENANT = '01900000-0000-7000-8000-0000000000a1';
const USER = '01900000-0000-7000-8000-0000000000b1';
const AUTH = { tenant_id: TENANT, sub: USER };
const T0 = new Date('2026-11-01T10:00:00.000Z');

const APPROVED_TERMS: LegalDocumentVersion = {
  key: 'sign.terms_of_service',
  version: '9.9-test',
  status: 'APPROVED',
  path: 'doc/legal/aramo-sign/terms-of-service.md',
  sha256: 'a'.repeat(64),
  url: 'https://sign.aramo.ai/legal/terms/9.9-test',
  effective_from: '2026-10-01T00:00:00Z',
};
const WITH_TERMS = [...LEGAL_DOCUMENTS, APPROVED_TERMS];

const ORG = {
  legal_name: 'Pat Lee Consulting LLC',
  address_line1: '1 Main St',
  city: 'Vienna',
  state_province: 'VA',
  postal_code: '22181',
  primary_contact_email: 'pat@gmail.com',
  primary_contact_name: 'Pat Lee',
  signer_title: 'Owner',
  authority_attested: true,
};
const BODY = { confirm: 'UPGRADE', organization_name: 'Pat Lee Consulting', organization: ORG, accept_terms: true };
const META = { ip: '203.0.113.9', request_id: 'req-1' };

interface Opts {
  kind?: string;
  status?: string;
  roles?: string[];
  risk?: { state: string; review_pending?: boolean; restricted_until?: Date | null } | null;
  open?: { source: string; plan_key: string } | null;
  registry?: readonly LegalDocumentVersion[];
  nameTakenBy?: string | null;
  endResult?: unknown;
  upgraded?: boolean;
}

function make(o: Opts = {}) {
  const tenant = { id: TENANT, name: 'Pat Lee (Personal 1a2b3c4d)', kind: o.kind ?? 'PERSONAL', status: o.status ?? 'ACTIVE' };
  const tenants = {
    findById: vi.fn(async () => tenant),
    findByNameCaseInsensitive: vi.fn(async () => (o.nameTakenBy ? { id: o.nameTakenBy } : null)),
  } as unknown as TenantRepository;
  const repo = { findMembership: vi.fn(async () => ({ id: 'm1', is_active: true })) } as unknown as IdentityRepository;
  const identity = {
    findRoleKeysForMembership: vi.fn(async () => o.roles ?? ['tenant_owner']),
    findUserById: vi.fn(async () => ({ id: USER, email: 'pat@gmail.com' })),
    resolveRoleIdsByKeys: vi.fn(async () => ['role-owner', 'role-admin']),
  } as unknown as IdentityService;
  const riskView = o.risk === undefined ? { state: 'clear', review_pending: false, restricted_until: null } : o.risk;
  const risk = { riskStateOf: vi.fn(async () => (riskView === null ? null : { review_pending: false, restricted_until: null, ...riskView })) } as unknown as PersonalRiskService;
  const upgradeToBusiness = vi.fn(async () => (o.upgraded === false ? { upgraded: false } : { upgraded: true, previous_name: tenant.name, roles_added: 1 }));
  const upgrades = { upgradeToBusiness } as unknown as PersonalUpgradeRepository;
  const open = o.open === undefined ? { source: 'FREE', plan_key: 'aramo-sign-free-personal-v1' } : o.open;
  const endForBusinessUpgrade = vi.fn(async () => o.endResult ?? { ended: open === null ? null : { id: 'sub-1', plan_key: open.plan_key, source: open.source } });
  const free = {
    openBaseOf: vi.fn(async () => (open === null ? null : { id: 'sub-1', status: 'ACTIVE', billing_provider: null, plan_tenant_kind: 'PERSONAL', ...open })),
    endForBusinessUpgrade,
  } as unknown as FreePersonalSubscriptionService;
  const recordInApp = vi.fn(async () => 'RECORDED');
  const acceptances = { recordInApp } as unknown as LegalAcceptanceService;
  const svc = new PersonalUpgradeService(tenants, repo, identity, risk, upgrades, free, acceptances, o.registry ?? WITH_TERMS, () => T0);
  return { svc, upgradeToBusiness, endForBusinessUpgrade, recordInApp };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return { status: (e as { statusCode?: number }).statusCode, reason: (e as { context?: { details?: { reason?: string } } }).context?.details?.reason };
  }
  return null;
};

describe('PersonalUpgradeService', () => {
  beforeEach(() => vi.stubEnv('SIGN_PERSONAL_UPGRADE_ENABLED', '1'));
  afterEach(() => vi.unstubAllEnvs());

  it('is dark unless SIGN_PERSONAL_UPGRADE_ENABLED=1: both calls answer 404 and nothing is written', async () => {
    vi.stubEnv('SIGN_PERSONAL_UPGRADE_ENABLED', '');
    expect(personalUpgradeEnabled()).toBe(false);
    const { svc, upgradeToBusiness, recordInApp } = make();
    expect(await failure(svc.status(AUTH, 'r'))).toEqual({ status: 404, reason: undefined });
    expect(await failure(svc.upgrade(AUTH, BODY, META))).toEqual({ status: 404, reason: undefined });
    vi.stubEnv('SIGN_PERSONAL_UPGRADE_ENABLED', 'true');
    expect(await failure(svc.upgrade(AUTH, BODY, META))).toEqual({ status: 404, reason: undefined });
    expect(upgradeToBusiness).not.toHaveBeenCalled();
    expect(recordInApp).not.toHaveBeenCalled();
  });

  it('status: eligible for the owner of an active Personal account in good standing on the FREE plan with approved Business terms', async () => {
    expect(await make().svc.status(AUTH, 'r')).toEqual({
      eligible: true,
      reason: null,
      current_name: 'Pat Lee (Personal 1a2b3c4d)',
      terms: { key: 'sign.terms_of_service', version: '9.9-test', url: APPROVED_TERMS.url },
      subscription: { plan_key: 'aramo-sign-free-personal-v1', source: 'FREE' },
    });
  });

  it('status names the first rule that fails', async () => {
    const reason = async (o: Opts) => (await make(o).svc.status(AUTH, 'r')).reason;
    expect(await reason({ kind: 'BUSINESS' })).toBe('not_personal_account');
    expect(await reason({ roles: ['sign_sender'] })).toBe('not_account_owner');
    expect(await reason({ status: 'PROVISIONED' })).toBe('personal_account_not_active');
    expect(await reason({ risk: null })).toBe('personal_account_not_in_good_standing');
    expect(await reason({ risk: { state: 'review' } })).toBe('personal_account_not_in_good_standing');
    expect(await reason({ risk: { state: 'restricted', restricted_until: new Date('2026-12-01T00:00:00Z') } })).toBe('personal_account_not_in_good_standing');
    expect(await reason({ risk: { state: 'closed' } })).toBe('personal_account_not_in_good_standing');
    expect(await reason({ risk: { state: 'clear', review_pending: true } })).toBe('personal_account_not_in_good_standing');
    // The registry as shipped: Business terms are DRAFT → fail closed.
    expect(await reason({ registry: LEGAL_DOCUMENTS })).toBe('business_terms_not_available');
    expect(await reason({ open: { source: 'SELF_SERVICE', plan_key: 'aramo-sign-standard-personal-v1' } })).toBe('personal_paid_subscription_upgrade_unsupported');
    expect(await reason({ open: null })).toBeNull();
  });

  it('upgrade validates the confirmation, name, organization details, attestation and terms before anything else', async () => {
    const { svc, upgradeToBusiness, recordInApp, endForBusinessUpgrade } = make();
    for (const confirm of [undefined, 'upgrade', 'UPGRADE ', true]) {
      expect(await failure(svc.upgrade(AUTH, { ...BODY, confirm }, META))).toEqual({ status: 400, reason: 'upgrade_confirmation_required' });
    }
    expect(await failure(svc.upgrade(AUTH, { ...BODY, organization_name: 'x' }, META))).toEqual({ status: 400, reason: 'invalid_organization_name' });
    expect((await failure(svc.upgrade(AUTH, { ...BODY, organization: { ...ORG, state_province: 'ON' } }, META)))?.status).toBe(400);
    expect(await failure(svc.upgrade(AUTH, { ...BODY, organization: { ...ORG, authority_attested: false } }, META))).toEqual({ status: 400, reason: 'authority_attestation_required' });
    expect(await failure(svc.upgrade(AUTH, { ...BODY, accept_terms: 'yes' }, META))).toEqual({ status: 400, reason: 'terms_not_accepted' });
    expect(upgradeToBusiness).not.toHaveBeenCalled();
    expect(recordInApp).not.toHaveBeenCalled();
    expect(endForBusinessUpgrade).not.toHaveBeenCalled();
  });

  it('upgrade refuses an ineligible account with its stable reason and writes nothing', async () => {
    for (const [o, reason] of [
      [{ kind: 'BUSINESS' }, 'not_personal_account'],
      [{ roles: ['sign_sender'] }, 'not_account_owner'],
      [{ status: 'SUSPENDED' }, 'personal_account_not_active'],
      [{ risk: { state: 'review' } }, 'personal_account_not_in_good_standing'],
      [{ registry: LEGAL_DOCUMENTS }, 'business_terms_not_available'],
      [{ open: { source: 'SELF_SERVICE', plan_key: 'p' } }, 'personal_paid_subscription_upgrade_unsupported'],
    ] as const) {
      const { svc, upgradeToBusiness, recordInApp, endForBusinessUpgrade } = make(o as Opts);
      expect(await failure(svc.upgrade(AUTH, BODY, META))).toEqual({ status: 403, reason });
      expect(upgradeToBusiness).not.toHaveBeenCalled();
      expect(recordInApp).not.toHaveBeenCalled();
      expect(endForBusinessUpgrade).not.toHaveBeenCalled();
    }
    const taken = make({ nameTakenBy: 'other-tenant' });
    expect(await failure(taken.svc.upgrade(AUTH, BODY, META))).toEqual({ status: 409, reason: 'organization_name_taken' });
    expect(taken.upgradeToBusiness).not.toHaveBeenCalled();
    // The account's own current name is not "taken".
    expect((await make({ nameTakenBy: TENANT }).svc.upgrade(AUTH, BODY, META)).state).toBe('upgraded');
  });

  it('upgrade records the terms, ends the FREE subscription, then runs the identity transaction', async () => {
    const { svc, upgradeToBusiness, recordInApp, endForBusinessUpgrade } = make();
    const order: string[] = [];
    recordInApp.mockImplementation(async () => (order.push('terms'), 'RECORDED'));
    endForBusinessUpgrade.mockImplementation(async () => (order.push('subscription'), { ended: { id: 'sub-1', plan_key: 'aramo-sign-free-personal-v1', source: 'FREE' } }));
    upgradeToBusiness.mockImplementation(async () => (order.push('identity'), { upgraded: true, previous_name: 'x', roles_added: 1 }));
    expect(await svc.upgrade(AUTH, BODY, META)).toEqual({ state: 'upgraded', kind: 'BUSINESS', organization_name: 'Pat Lee Consulting', upgraded_at: T0.toISOString() });
    expect(order).toEqual(['terms', 'subscription', 'identity']);
    expect(recordInApp).toHaveBeenCalledWith(expect.objectContaining({ document: APPROVED_TERMS, tenant_id: TENANT, user_id: USER, subject_email: 'pat@gmail.com', ip: '203.0.113.9' }));
    expect(endForBusinessUpgrade).toHaveBeenCalledWith({ tenant_id: TENANT, product_key: 'sign', at: T0 });
    expect(upgradeToBusiness).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT,
        owner_user_id: USER,
        membership_id: 'm1',
        organization_name: 'Pat Lee Consulting',
        owner_role_ids: ['role-owner', 'role-admin'],
        terms_ref: `sign.terms_of_service@9.9-test#${'a'.repeat(64)}`,
        ended_subscription: { id: 'sub-1', plan_key: 'aramo-sign-free-personal-v1', source: 'FREE' },
        attestation: { signer_email: 'pat@gmail.com', signer_name: 'Pat Lee', signer_title: 'Owner', organization_legal_name: 'Pat Lee Consulting LLC', ip: '203.0.113.9' },
        profile: expect.objectContaining({ legal_name: 'Pat Lee Consulting LLC', state_province: 'VA', country_code: 'US', postal_code: '22181' }),
      }),
    );
  });

  it('a paid subscription opened concurrently stops the upgrade before the identity change; a lost race answers not_personal_account', async () => {
    const paid = make({ endResult: { refused: 'not_free', subscription_id: 's', source: 'SELF_SERVICE' } });
    expect(await failure(paid.svc.upgrade(AUTH, BODY, META))).toEqual({ status: 403, reason: 'personal_paid_subscription_upgrade_unsupported' });
    expect(paid.upgradeToBusiness).not.toHaveBeenCalled();
    const raced = make({ upgraded: false });
    expect(await failure(raced.svc.upgrade(AUTH, BODY, META))).toEqual({ status: 403, reason: 'not_personal_account' });
  });

  it('upgradeProfileFields maps the validated details to the tenant profile columns only', () => {
    const p = upgradeProfileFields({ ...ORG, address_line2: null, country_code: 'US', primary_contact_phone: null, tax_id: null, registration_number: null });
    expect(Object.keys(p).sort()).toEqual(
      ['address_line1', 'address_line2', 'city', 'country_code', 'legal_name', 'postal_code', 'primary_contact_email', 'primary_contact_name', 'primary_contact_phone', 'registration_number', 'state_province', 'tax_id'].sort(),
    );
  });
});
