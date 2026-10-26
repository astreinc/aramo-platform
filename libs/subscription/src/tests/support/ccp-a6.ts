import { randomUUID } from 'node:crypto';

import type { Client } from 'pg';

import { AllowanceService } from '../../lib/allowance.service.js';
import type { BillingProviderPort, ProviderSubscriptionState } from '../../lib/billing/billing-provider.port.js';
import { BillingProviderUnavailableError } from '../../lib/billing/billing-provider.port.js';
import { SubscriptionLifecycleService } from '../../lib/billing/subscription-lifecycle.service.js';
import { CapacityService } from '../../lib/capacity.service.js';
import { CommercialApplyService, type CommercialApplyFaultHook } from '../../lib/commercial/commercial-apply.service.js';
import { CommercialCatalogApplyService, type CommercialCatalogApplyFaultHook } from '../../lib/commercial/commercial-catalog-apply.service.js';
import { CommercialPolicyApplyService, type CommercialPolicyApplyFaultHook } from '../../lib/commercial/commercial-policy-apply.service.js';
import { PlanVersionRepository } from '../../lib/plan-version.repository.js';
import { CommercialAuditRepository } from '../../lib/commercial/commercial-audit.repository.js';
import { type CommercialActor, CommercialChangeRequestService } from '../../lib/commercial/commercial-change-request.service.js';
import { CommercialOperatorRepository } from '../../lib/commercial/commercial-operator.repository.js';
import { CommercialPolicyRepository } from '../../lib/commercial/commercial-policy.repository.js';
import { SupportExtensionService } from '../../lib/commercial/support-extension.service.js';
import type { PrismaService } from '../../lib/prisma/prisma.service.js';
import { FakeOrganizationBillingProfile } from '../fixtures/organization-billing-profile.fake.js';

import { CCP_BUNDLES, PLATFORM_TENANT } from './ccp-a3-database.js';

// CCP-A6 — ONE shared harness for the A6 specs (CLAUDE.md: one shared test helper): the real
// change-request, apply and lifecycle services on one Prisma client, a fake billing provider,
// and the fixture builders (tenants, approved requests, provider-linked rows, snapshots).

export const A6_CTX = { platform_tenant_id: PLATFORM_TENANT, correlation_id: 'ccp-a6-spec' };
export const INCLUDED = 'aramo-sign-included-v1';
export const ENTERPRISE = 'aramo-sign-enterprise-v1';
export const BUSINESS = 'aramo-sign-standard-business-v1';
export const FREE_PERSONAL = 'aramo-sign-free-personal-v1';

export const as = (user_id: string, role: string, extra: Partial<CommercialActor> = {}): CommercialActor => ({ user_id, actor_kind: 'user', scopes: [...(CCP_BUNDLES[role] ?? [])], ...extra });

export class FakeBilling implements BillingProviderPort {
  readonly provider = 'STRIPE' as const;
  subs = new Map<string, ProviderSubscriptionState>();
  checkouts: { intent_id: string; tenant_id: string; account_ref: string | null }[] = [];
  accounts: string[] = [];
  isConfigured() {
    return true;
  }
  mode(): 'test' | 'live' {
    return 'test';
  }
  async upsertBillingAccount(account_ref: string | null, details: { tenant_id: string }) {
    this.accounts.push(details.tenant_id);
    return account_ref ?? `acct_${details.tenant_id}`;
  }
  async createCheckoutSession(req: { intent_id: string; tenant_id: string; account_ref: string | null }) {
    this.checkouts.push(req);
    return { session_ref: `cs_${req.intent_id}`, url: `https://checkout.test/${req.intent_id}` };
  }
  async createPortalSession(account_ref: string) {
    return { url: `https://portal.test/${account_ref}` };
  }
  async retrieveSubscription(ref: string) {
    const s = this.subs.get(ref);
    if (s === undefined) throw new BillingProviderUnavailableError('no such subscription');
    return s;
  }
  verifyWebhook(): never {
    throw new Error('not used');
  }
  /** The provider state of a subscription created from `intent_id` (set it with `subs.set`). */
  state(tenant_id: string, intent_id: string, o: Partial<ProviderSubscriptionState> = {}): ProviderSubscriptionState {
    const s: ProviderSubscriptionState = {
      provider: 'STRIPE',
      subscription_ref: `sub_${intent_id}`,
      account_ref: `acct_${tenant_id}`,
      provider_status: 'active',
      current_period_start: new Date('2026-10-25T00:00:00Z'),
      current_period_end: new Date('2026-11-25T00:00:00Z'),
      cancel_at_period_end: false,
      price_ref: 'price_business',
      tenant_id,
      intent_id,
      account_country: 'US',
      ...o,
    };
    this.subs.set(s.subscription_ref, s);
    return s;
  }
}

export interface A6Harness {
  changeRequests: CommercialChangeRequestService;
  apply: CommercialApplyService;
  catalog: CommercialCatalogApplyService;
  versions: PlanVersionRepository;
  lifecycle: SubscriptionLifecycleService;
  billing: FakeBilling;
  orgProfile: FakeOrganizationBillingProfile;
  allowance: AllowanceService;
  /** CCP-A8 — the support exception overlay on the same services (the shared harness). */
  supportExtensions: SupportExtensionService;
  /** CCP-B5-R — the requester-only POLICY_ACTIVATE apply, reached through `apply` as in the module. */
  policyApply: CommercialPolicyApplyService;
}

export function a6Harness(prisma: PrismaService, now: () => Date, fault?: CommercialApplyFaultHook, catalogFault?: CommercialCatalogApplyFaultHook, policyFault?: CommercialPolicyApplyFaultHook): A6Harness {
  const audit = new CommercialAuditRepository(prisma);
  const policies = new CommercialPolicyRepository(prisma);
  const operators = new CommercialOperatorRepository(prisma, audit, policies);
  const changeRequests = new CommercialChangeRequestService(prisma, audit, policies, operators, now);
  const versions = new PlanVersionRepository(prisma);
  const catalog = new CommercialCatalogApplyService(prisma, audit, operators, changeRequests, versions, now, catalogFault);
  const policyApply = new CommercialPolicyApplyService(prisma, audit, operators, changeRequests, now, policyFault);
  const apply = new CommercialApplyService(prisma, audit, operators, changeRequests, now, fault, catalog, policyApply);
  const billing = new FakeBilling();
  const orgProfile = new FakeOrganizationBillingProfile();
  const allowance = new AllowanceService(prisma);
  const lifecycle = new SubscriptionLifecycleService(prisma, allowance, billing, new CapacityService(prisma), undefined, undefined, orgProfile);
  const supportExtensions = new SupportExtensionService(prisma, audit, policies, operators, changeRequests, apply, now);
  return { changeRequests, apply, catalog, versions, lifecycle, billing, orgProfile, allowance, supportExtensions, policyApply };
}

export async function newTenant(pg: Client, kind: 'BUSINESS' | 'PERSONAL' = 'BUSINESS'): Promise<string> {
  const id = randomUUID();
  await pg.query(`INSERT INTO identity."Tenant" (id, name, kind, updated_at) VALUES ($1, $2, $3, now())`, [id, `A6 ${id.slice(0, 8)}`, kind]);
  return id;
}

export async function publishedVersion(pg: Client, plan_key: string): Promise<string> {
  const r = await pg.query(`SELECT v.id FROM subscription."PlanVersion" v JOIN subscription."Plan" p ON p.id = v.plan_id WHERE p.key = $1 AND v.status = 'PUBLISHED'`, [plan_key]);
  return r.rows[0].id as string;
}

/** An open BASE row inserted raw (a pre-existing subscription). Provider-linked when `ref` is given. */
export async function rawSubscription(pg: Client, tenant_id: string, o: { source: string; plan?: string; ref?: string; status?: string }): Promise<string> {
  const id = randomUUID();
  await pg.query(
    `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by, status, billing_provider, billing_account_ref, billing_subscription_ref)
     SELECT $1::uuid, $2::uuid, p.id, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'), p.product_key, 'BASE', '2026-10-01T00:00:00Z', $3, 'ccp-a6-spec', $4,
            $5, $6, $7
       FROM subscription."Plan" p WHERE p.key = $8`,
    [id, tenant_id, o.source, o.status ?? 'ACTIVE', o.ref === undefined ? null : 'STRIPE', o.ref === undefined ? null : `acct_${tenant_id}`, o.ref ?? null, o.plan ?? (o.source === 'SELF_SERVICE' ? BUSINESS : INCLUDED)],
  );
  return id;
}

/** Everything one tenant's apply could touch, as comparable JSON (the no-partial-state oracle). */
export async function domainSnapshot(pg: Client, tenant_id: string, change_request_id?: string): Promise<Record<string, unknown>> {
  const q = async (sql: string, p: unknown[]) => (await pg.query(sql, p)).rows.map((r) => r.j as string);
  return {
    subscriptions: await q(`SELECT row_to_json(s)::text j FROM subscription."TenantSubscription" s WHERE tenant_id = $1 ORDER BY id`, [tenant_id]),
    entitlements: await q(`SELECT (tenant_id::text || ':' || capability::text) j FROM entitlement."TenantEntitlement" WHERE tenant_id = $1 ORDER BY capability`, [tenant_id]),
    pin_events: await q(`SELECT row_to_json(e)::text j FROM subscription."SubscriptionVersionPinEvent" e WHERE tenant_id = $1 ORDER BY id`, [tenant_id]),
    applications: await q(`SELECT row_to_json(a)::text j FROM subscription."CommercialChangeApplication" a WHERE tenant_id = $1 ORDER BY id`, [tenant_id]),
    domain_audit: await q(
      `SELECT event_type j FROM subscription."CommercialAuditEvent" WHERE tenant_id = $1 AND event_type IN ('COMMERCIAL_SUBSCRIPTION_OPENED','COMMERCIAL_SUBSCRIPTION_CHANGED','COMMERCIAL_SUBSCRIPTION_ENDED','COMMERCIAL_ENTITLEMENT_GRANTED','COMMERCIAL_CHANGE_REQUEST_APPLIED') ORDER BY created_at, id`,
      [tenant_id],
    ),
    ...(change_request_id === undefined
      ? {}
      : { approvals: await q(`SELECT row_to_json(a)::text j FROM subscription."CommercialApproval" a WHERE change_request_id = $1 ORDER BY step_index`, [change_request_id]) }),
  };
}

/** Polls pg_locks until some backend is WAITING on an advisory lock (proves it blocked). */
export async function waitForAdvisoryWaiter(pg: Client, n = 1, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await pg.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
    if ((r.rows[0].n as number) >= n) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`no ${n} backend(s) waiting on an advisory lock within ${timeoutMs} ms`);
}
