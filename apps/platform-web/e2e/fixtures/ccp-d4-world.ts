// CCP-D4 — one stateful Commercial world shared by every persona of a journey (TEST-ONLY;
// src/ never imports e2e/). The B1–B6 fixtures each freeze one persona's view of one screen; a
// D4 journey crosses people (a requester, then Finance, then the Owner, then the requester
// again), so this world keeps the change requests, their approvals, their applies and the audit
// stream in one place and answers each persona's reads from that shared state:
//
//   • the A3 engine's per-caller verdict, computed the way
//     libs/subscription/src/lib/commercial/commercial-approval-eligibility.ts orders it:
//     SELF_APPROVAL → USER_ALREADY_APPROVED → (qualifies for a later step) OUT_OF_ORDER →
//     STEP_SCOPE_MISSING; a step qualifies by role AND its scope keys (TD-A3-6: a Finance step
//     needs finance_admin, a platform_owner cannot fill it);
//   • the chains of TD-A3-2: Finance-only for subscription / entitlement / conversion /
//     escalated support extension; Finance → Owner for catalog publish and retire;
//   • `apply_actionable` and the apply route, requester-only (TD-B2-3 / TD-A6-3);
//   • the audit events each transition records (COMMERCIAL_* event types).
//
// The screen reads that do not change in a journey (the catalog's plans, the subscription
// workbench, Tenant › Commercial facts, contracts, policy versions) come from the existing
// fixtures (ccp-catalog.ts, ccp-subscriptions.ts, contracts.ts, ccp-governance.ts); this world
// only overlays the parts a journey changes (open requests, version status, extensions).

import type { Handler, MockOptions, Reply } from './mock-api';
import { catalogHandlers } from './ccp-catalog';
import { B3_TENANTS, subsMock, workbenchRows } from './ccp-subscriptions';
import { contractsMock } from './contracts';
import { ccpMock as governanceMock } from './ccp-governance';
import { ALL_SCOPES, CCP_SCOPES, PERSONAS, PLATFORM_TENANT_ID } from './session';

export const D4_NOW = '2026-10-24T14:00:00Z';
const POLICY_V1 = '019a0000-0000-7000-8000-0000000cc201';
const H = 3_600_000;

export type D4Role = keyof typeof CCP_SCOPES | 'super_admin';

/** The people of a journey. Each holds exactly one role, except Arjun (the two-role negative check). */
export const D4_PEOPLE = {
  daniel: { sub: PERSONAS.ccpOwner.sub, name: 'Daniel Reyes', email: 'daniel.reyes@aramo.ai', roles: ['platform_owner'] },
  priya: { sub: PERSONAS.ccpFinance.sub, name: 'Priya Shah', email: 'priya.shah@aramo.ai', roles: ['finance_admin'] },
  tomas: { sub: PERSONAS.ccpOps.sub, name: 'Tomás Silva', email: 'tomas.silva@aramo.ai', roles: ['commercial_ops'] },
  lena: { sub: PERSONAS.ccpCatalog.sub, name: 'Lena Fischer', email: 'lena.fischer@aramo.ai', roles: ['catalog_manager'] },
  kwame: { sub: PERSONAS.ccpSupport.sub, name: 'Kwame Mensah', email: 'kwame.mensah@aramo.ai', roles: ['support_admin'] },
  ines: { sub: PERSONAS.ccpAuditor.sub, name: 'Ines Duarte', email: 'ines.duarte@aramo.ai', roles: ['read_only_auditor'] },
  maya: { sub: PERSONAS.operator.sub, name: 'Maya Okafor', email: 'maya.okafor@aramo.ai', roles: ['super_admin'] },
  arjun: { sub: 'cc000000-0000-7000-8000-00000000a12a', name: 'Arjun Rao', email: 'arjun.rao@aramo.ai', roles: ['finance_admin', 'platform_owner'] },
} as const satisfies Record<string, { sub: string; name: string; email: string; roles: readonly D4Role[] }>;
export type D4Person = keyof typeof D4_PEOPLE;

/** The single-role person of each role (the per-role describes). */
export const PERSON_OF: Readonly<Record<D4Role, D4Person>> = {
  platform_owner: 'daniel',
  finance_admin: 'priya',
  commercial_ops: 'tomas',
  catalog_manager: 'lena',
  support_admin: 'kwame',
  read_only_auditor: 'ines',
  super_admin: 'maya',
};

const BUNDLE: Readonly<Record<D4Role, readonly string[]>> = { ...CCP_SCOPES, super_admin: ALL_SCOPES };
export const scopesOf = (p: D4Person): string[] => [...new Set(D4_PEOPLE[p].roles.flatMap((r) => BUNDLE[r]))];

interface Step {
  step_index: number;
  role_key: string;
  scope_keys: string[];
}
const FIN_SUB: Step = { step_index: 0, role_key: 'finance_admin', scope_keys: ['platform:subscription:approve'] };
const CHAINS = {
  FINANCE_ONLY: { rule: 'FINANCE_ONLY', basis: {}, steps: [FIN_SUB] },
  CATALOG: {
    rule: 'FINANCE_THEN_OWNER',
    basis: {},
    steps: [
      { step_index: 0, role_key: 'finance_admin', scope_keys: ['platform:catalog:approve'] },
      { step_index: 1, role_key: 'platform_owner', scope_keys: ['platform:catalog:approve', 'platform:catalog:publish'] },
    ],
  },
  POLICY: {
    rule: 'FINANCE_THEN_OWNER',
    basis: {},
    steps: [
      { step_index: 0, role_key: 'finance_admin', scope_keys: ['platform:billing:approve'] },
      { step_index: 1, role_key: 'platform_owner', scope_keys: ['platform:billing:approve'] },
    ],
  },
} as const;

/** The requester scope of each action (A3), checked on create. */
const REQUESTER_SCOPE: Readonly<Record<string, string>> = {
  PLAN_VERSION_PUBLISH: 'platform:catalog:draft',
  PLAN_RETIRE: 'platform:catalog:draft',
  CONVERSION: 'platform:subscription:request',
  SUBSCRIPTION_CHANGE: 'platform:subscription:request',
  SUBSCRIPTION_END: 'platform:subscription:request',
  ENTITLEMENT_GRANT: 'platform:entitlement:request',
  ENTITLEMENT_REVOKE: 'platform:entitlement:request',
  SUPPORT_EXTENSION: 'platform:subscription:support',
};

export interface D4Request {
  id: string;
  action_type: string;
  kind: string;
  state: string;
  tenant_id: string | null;
  product_key: string | null;
  payload: Record<string, unknown>;
  payload_checksum: string;
  required_chain: { rule: string; basis: Record<string, unknown>; steps: Step[] };
  policy_version_id: string;
  policy_checksum: string;
  requested_by: string;
  reason: string;
  created_at: string;
  submitted_at: string | null;
  expires_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  withdrawn_at: string | null;
  expired_at: string | null;
  applied_at: string | null;
}

interface Approval {
  id: string;
  step_index: number;
  approver_user_id: string;
  step_role_key: string;
  step_scope_keys: string[];
  approver_role_keys: string[];
  comment: string | null;
  created_at: string;
}

interface Extension {
  id: string;
  tenant_id: string;
  days: number;
  is_exception: boolean;
  applied_by: string;
  applied_at: string;
  change_request_id: string;
  roles: string[];
}

export interface AuditRow {
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_type: string;
  actor_role_keys: string[];
  event_type: string;
  is_exception: boolean;
  tenant_id: string | null;
  subject: string;
  change_request_id: string | null;
  policy_version_id: string;
  payload: Record<string, unknown>;
  correlation_id: string;
}

const ok = (body: unknown, status = 200): Reply => ({ status, body });
const err = (status: number, code: string, details: Record<string, unknown> = {}): Reply => ({ status, body: { error: { code, message: 'refused', request_id: 'req-d4', details } } });

/** The support-extension clause of the active policy v1 (the B6 fixture's). */
const CLAUSE = { support_extension_max_days: 14, support_extension_frequency_window_days: 90, support_extension_cumulative_max_days: 30, support_extension_cumulative_window_days: 365 };
const POLICY = { version_id: POLICY_V1, version_number: 1, clause: CLAUSE, approval_expiry_hours: 72 };
/** The PAST_DUE self-service rows a support journey works on (ccp-subscriptions.ts T0). */
const SX_SUBS: Readonly<Record<string, { id: string; grace_until: string; current_period_end: string }>> = {
  [B3_TENANTS.fernhill]: { id: 'cb300000-0000-7000-8000-000000000055', grace_until: '2026-10-29T00:00:00.000Z', current_period_end: '2026-10-23T00:00:00.000Z' },
  [B3_TENANTS.quarry]: { id: 'cb300000-0000-7000-8000-000000000058', grace_until: '2026-10-15T00:00:00.000Z', current_period_end: '2026-10-08T00:00:00.000Z' },
};

const OPEN = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'APPLYING', 'APPLY_FAILED'];
const APPLY_ACTIONS = new Set(['PLAN_VERSION_PUBLISH', 'PLAN_RETIRE', 'CONVERSION', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT', 'ENTITLEMENT_REVOKE', 'SUPPORT_EXTENSION']);

export class D4World {
  readonly log: string[] = [];
  readonly requests: D4Request[] = [];
  readonly audit: AuditRow[] = [];
  private readonly approvals = new Map<string, Approval[]>();
  private readonly extensions: Extension[] = [];
  private readonly published = new Set<string>();
  private seq = 0;
  private clock = 0;

  private tick(): string {
    this.clock += 1;
    return new Date(Date.parse(D4_NOW) + this.clock * 60_000).toISOString();
  }

  private nextId(): string {
    this.seq += 1;
    const n = String(this.seq).padStart(4, '0');
    return `0d4c${n}-0000-7000-8000-000000000d4c`;
  }

  private record(actor: D4Person | null, event_type: string, r: D4Request | null, extra: Partial<AuditRow> = {}): void {
    this.audit.push({
      id: `019a0000-0000-7000-8000-0000000d${String(4000 + this.audit.length).padStart(4, '0')}`,
      created_at: this.tick(),
      actor_id: actor === null ? null : D4_PEOPLE[actor].sub,
      actor_type: actor === null ? 'system' : 'user',
      actor_role_keys: actor === null ? [] : D4_PEOPLE[actor].roles.filter((x) => x !== 'super_admin'),
      event_type,
      is_exception: false,
      tenant_id: r?.tenant_id ?? null,
      subject: r === null ? 'commercial' : `commercial_change_request:${r.id}`,
      change_request_id: r?.id ?? null,
      policy_version_id: POLICY_V1,
      payload: { product_key: r?.product_key ?? 'sign' },
      correlation_id: 'd4',
      ...extra,
    });
  }

  find(id: string): D4Request | undefined {
    return this.requests.find((r) => r.id === id);
  }

  /** Who holds this request's approvals (signed steps). */
  approvalsOf(id: string): Approval[] {
    return this.approvals.get(id) ?? [];
  }

  // ── the A3 engine (fixture) ──────────────────────────────────────────────────

  private qualifies(p: D4Person, s: Step): boolean {
    const scopes = scopesOf(p);
    return (D4_PEOPLE[p].roles as readonly string[]).includes(s.role_key) && s.scope_keys.every((k) => scopes.includes(k));
  }

  /** null = eligible for the next step; else the refusal. */
  verdict(r: D4Request, p: D4Person): string | null {
    if (r.state !== 'PENDING_APPROVAL') return 'NOT_PENDING';
    const me = D4_PEOPLE[p].sub;
    if (r.requested_by === me) return 'SELF_APPROVAL';
    const signed = this.approvalsOf(r.id);
    if (signed.some((a) => a.approver_user_id === me)) return 'USER_ALREADY_APPROVED';
    const next = r.required_chain.steps[signed.length];
    if (next === undefined) return 'NOT_PENDING';
    if (this.qualifies(p, next)) return null;
    if (r.required_chain.steps.slice(signed.length + 1).some((s) => this.qualifies(p, s))) return 'OUT_OF_ORDER';
    return 'STEP_SCOPE_MISSING';
  }

  applyActionable(r: D4Request, p: D4Person): boolean {
    return (r.state === 'APPROVED' || r.state === 'APPLY_FAILED') && r.requested_by === D4_PEOPLE[p].sub && APPLY_ACTIONS.has(r.action_type);
  }

  private detail(r: D4Request, p: D4Person) {
    const signed = this.approvalsOf(r.id);
    const pending = r.state === 'PENDING_APPROVAL';
    const v = this.verdict(r, p);
    return {
      request: r,
      approvals: signed,
      is_expired: false,
      chain_satisfiable: pending ? true : null,
      steps: r.required_chain.steps.map((s) => {
        const a = signed.find((x) => x.step_index === s.step_index);
        const status = a ? 'APPROVED' : s.step_index === signed.length ? 'NEXT' : 'WAITING';
        const caller = a ? null : pending ? (v === null && s.step_index === signed.length ? { eligible: true, refusal: null } : { eligible: false, refusal: v ?? 'OUT_OF_ORDER' }) : { eligible: false, refusal: 'NOT_PENDING' };
        return { step_index: s.step_index, role_key: s.role_key, scope_keys: s.scope_keys, status, approval_id: a?.id ?? null, caller };
      }),
      apply_actionable: this.applyActionable(r, p),
    };
  }

  // ── seeding (a journey that starts mid-chain) ───────────────────────────────

  /** Creates (and by default submits) a request as `by`, the way the console would. */
  seed(by: D4Person, action_type: string, o: { tenant_id?: string | null; payload?: Record<string, unknown>; reason?: string; submit?: boolean; signedBy?: D4Person[] } = {}): D4Request {
    const r = this.create(by, { action_type, tenant_id: o.tenant_id ?? null, payload: o.payload ?? {}, reason: o.reason ?? 'Seeded for the journey.' });
    if (o.submit !== false) this.submit(by, r);
    for (const who of o.signedBy ?? []) this.sign(who, r);
    return r;
  }

  /** Signs the next step as `who` (state set-up only: the journey under test signs through the UI). */
  sign(who: D4Person, r: D4Request): void {
    if (this.verdict(r, who) !== null) throw new Error(`fixture: ${who} cannot sign ${r.id} (${String(this.verdict(r, who))})`);
    this.approve(who, r, this.approvalsOf(r.id).length);
  }

  /** Applies as `who` (state set-up only); the requester-only rule holds here too. */
  applyAs(who: D4Person, r: D4Request): void {
    if (!this.applyActionable(r, who)) throw new Error(`fixture: ${who} cannot apply ${r.id}`);
    this.applyEffect(who, r);
  }

  /** The Team v3 publish request (the B2 catalog fixture's draft). */
  seedTeamV3Publish(signedBy: D4Person[] = []): D4Request {
    return this.seed('lena', 'PLAN_VERSION_PUBLISH', { payload: { plan_version_id: 'team-v3' }, reason: 'Annual price review.\n\nEvidence: PR-2026-Q4', signedBy });
  }

  /** An escalated support extension (20 days on Fernhill) by Kwame. */
  seedEscalatedExtension(signedBy: D4Person[] = []): D4Request {
    const out = this.extend('kwame', { tenant_id: B3_TENANTS.fernhill, requested_days: 20, reason: 'The practice moved offices.' });
    for (const who of signedBy) this.sign(who, out.request);
    return out.request;
  }

  // ── transitions ──────────────────────────────────────────────────────────────

  private create(by: D4Person, b: { action_type: string; tenant_id: string | null; payload: Record<string, unknown>; reason: string; product_key?: string | null }): D4Request {
    const at = this.tick();
    const chain = b.action_type.startsWith('PLAN_') ? CHAINS.CATALOG : b.action_type === 'POLICY_ACTIVATE' ? CHAINS.POLICY : CHAINS.FINANCE_ONLY;
    const r: D4Request = {
      id: this.nextId(),
      action_type: b.action_type,
      kind: 'NORMAL',
      state: 'DRAFT',
      tenant_id: b.tenant_id,
      product_key: b.product_key ?? 'sign',
      payload: b.payload,
      payload_checksum: 'a'.repeat(64),
      required_chain: JSON.parse(JSON.stringify(chain)) as D4Request['required_chain'],
      policy_version_id: POLICY_V1,
      policy_checksum: 'b'.repeat(64),
      requested_by: D4_PEOPLE[by].sub,
      reason: b.reason,
      created_at: at,
      submitted_at: null,
      expires_at: null,
      approved_at: null,
      rejected_at: null,
      rejected_by: null,
      rejection_reason: null,
      withdrawn_at: null,
      expired_at: null,
      applied_at: null,
    };
    this.requests.push(r);
    this.record(by, 'COMMERCIAL_CHANGE_REQUEST_CREATED', r);
    return r;
  }

  private submit(by: D4Person, r: D4Request): void {
    const at = this.tick();
    Object.assign(r, { state: 'PENDING_APPROVAL', submitted_at: at, expires_at: new Date(Date.parse(at) + 72 * H).toISOString() });
    this.record(by, 'COMMERCIAL_CHANGE_REQUEST_SUBMITTED', r);
  }

  private approve(who: D4Person, r: D4Request, step: number): Approval {
    const s = r.required_chain.steps[step]!;
    const list = this.approvalsOf(r.id);
    const a: Approval = {
      id: `0d4ca${String(list.length)}00-0000-7000-8000-0000000${r.id.slice(0, 5)}`,
      step_index: step,
      approver_user_id: D4_PEOPLE[who].sub,
      step_role_key: s.role_key,
      step_scope_keys: s.scope_keys,
      approver_role_keys: [...D4_PEOPLE[who].roles],
      comment: null,
      created_at: this.tick(),
    };
    list.push(a);
    this.approvals.set(r.id, list);
    this.record(who, 'COMMERCIAL_APPROVAL_RECORDED', r, { payload: { product_key: r.product_key, step_role_key: s.role_key } });
    if (list.length === r.required_chain.steps.length) {
      Object.assign(r, { state: 'APPROVED', approved_at: a.created_at });
      this.record(null, 'COMMERCIAL_CHANGE_REQUEST_APPROVED', r);
    }
    return a;
  }

  private applyEffect(by: D4Person, r: D4Request): void {
    Object.assign(r, { state: 'APPLIED', applied_at: this.tick() });
    if (r.action_type === 'PLAN_VERSION_PUBLISH') this.published.add(String(r.payload['plan_version_id']));
    if (r.action_type === 'SUPPORT_EXTENSION' && r.tenant_id !== null) {
      this.extensions.push({ id: `0d4ce${String(this.extensions.length)}00-0000-7000-8000-00000000e0d4`, tenant_id: r.tenant_id, days: Number(r.payload['requested_days'] ?? 0), is_exception: false, applied_by: D4_PEOPLE[by].sub, applied_at: r.applied_at!, change_request_id: r.id, roles: [...D4_PEOPLE[by].roles] });
    }
    this.record(by, r.action_type === 'SUPPORT_EXTENSION' ? 'SUPPORT_EXTENSION_APPLIED' : 'COMMERCIAL_CHANGE_REQUEST_APPLIED', r);
  }

  private extend(by: D4Person, b: { tenant_id: string; requested_days: number; reason: string }): { outcome: 'APPLIED' | 'ESCALATED'; request: D4Request; extension: unknown; decision: unknown } {
    const sub = SX_SUBS[b.tenant_id];
    const prior = this.extensions.filter((e) => e.tenant_id === b.tenant_id);
    const breaches = [...(b.requested_days > CLAUSE.support_extension_max_days ? ['LENGTH'] : []), ...(prior.length > 0 ? ['FREQUENCY'] : [])];
    const r = this.create(by, { action_type: 'SUPPORT_EXTENSION', tenant_id: b.tenant_id, payload: { operation: 'EXTEND', subscription_id: sub?.id ?? null, requested_days: b.requested_days }, reason: b.reason });
    const decision = { within_bounds: breaches.length === 0, breaches, eligibility: [], counters: { requested_days: b.requested_days, extensions_in_frequency_window: prior.length, cumulative_days_before: 0, cumulative_days_after: b.requested_days }, clause: CLAUSE };
    if (breaches.length === 0) {
      r.kind = 'EXCEPTION';
      Object.assign(r, { state: 'APPLIED', applied_at: this.tick() });
      this.extensions.push({ id: `0d4ce${String(this.extensions.length)}00-0000-7000-8000-00000000e0d4`, tenant_id: b.tenant_id, days: b.requested_days, is_exception: true, applied_by: D4_PEOPLE[by].sub, applied_at: r.applied_at!, change_request_id: r.id, roles: [...D4_PEOPLE[by].roles] });
      this.record(by, 'SUPPORT_EXTENSION_APPLIED', r, { is_exception: true });
      return { outcome: 'APPLIED', request: r, extension: null, decision };
    }
    this.submit(by, r);
    return { outcome: 'ESCALATED', request: r, extension: null, decision };
  }

  private extensionRows(tenantId: string) {
    return this.extensions
      .filter((e) => e.tenant_id === tenantId)
      .map((e) => ({
        id: e.id,
        tenant_id: e.tenant_id,
        product_key: 'sign',
        subscription_id: SX_SUBS[tenantId]?.id ?? null,
        change_request_id: e.change_request_id,
        is_exception: e.is_exception,
        days: e.days,
        grace_until_at_apply: SX_SUBS[tenantId]?.grace_until ?? null,
        base_until: SX_SUBS[tenantId]?.grace_until ?? null,
        extends_until: new Date(Date.parse(SX_SUBS[tenantId]?.grace_until ?? D4_NOW) + e.days * 24 * H).toISOString(),
        policy_version_id: POLICY_V1,
        applied_by: e.applied_by,
        applied_at: e.applied_at,
        removed_at: null,
        removed_by: null,
        remove_change_request_id: null,
        active: true,
        context: { policy_version_number: 1, clause: CLAUSE, counters: { requested_days: e.days, extensions_in_frequency_window: 0, cumulative_days_before: 0, cumulative_days_after: e.days }, roles_at_apply: e.roles },
      }));
  }

  // ── the mock for one persona ─────────────────────────────────────────────────

  mock(p: D4Person): MockOptions & { clock: string } {
    const person = D4_PEOPLE[p];
    const me = person.sub;
    const IAT = Math.floor(Date.parse(D4_NOW) / 1000);
    const can = (scope: string): boolean => scopesOf(p).includes(scope);
    const rid = (path: string): string => decodeURIComponent(path.split('/')[4] ?? '');
    const forbid = (scope: string): Reply => err(403, 'INSUFFICIENT_PERMISSIONS', { required_scope: scope });

    // The unchanged screen reads, from the existing fixtures.
    const subs = subsMock('ccpOps');
    const tenantCommercialBase = subs.overrides!.find((o) => o.path.test('/platform/commercial/tenants/x/commercial'))!.reply as Handler;
    const catalogBase = catalogHandlers({ noOpenRequest: true }).find(([m, re]) => m === 'GET' && re.test('/platform/commercial/catalog'))![2];
    const contractRoutes = (contractsMock('ines').overrides ?? []).filter((o) => o.path.source.includes('contracts'));
    const policyRoutes = (governanceMock({ persona: p }).overrides ?? []).filter((o) => o.path.source.includes('policy-versions'));

    const tenants = (workbenchRows() as { tenant: { id: string; name: string; slug: string } }[]).map(({ tenant }) => ({ id: tenant.id, name: tenant.name, kind: 'BUSINESS', slug: tenant.slug, status: 'ACTIVE', status_reason_code: null, status_changed_at: '2026-01-01T00:00:00Z', is_active: true, created_at: '2026-01-01T00:00:00Z', activated_at: '2026-01-01T00:00:00Z', suspended_at: null }));

    const handlers: { method?: string; path: RegExp; reply: Handler }[] = [
      { path: /^\/auth\/platform\/session$/, reply: () => ok({ sub: me, consumer_type: 'platform', tenant_id: PLATFORM_TENANT_ID, scopes: scopesOf(p), iat: IAT, exp: IAT + 8 * 3600 }) },
      { path: /^\/platform\/me$/, reply: () => ok({ user_id: me, email: person.email, display_name: person.name, tenant_id: PLATFORM_TENANT_ID, tenant_name: 'Aramo Platform', role_keys: [...person.roles] }) },
      { path: /^\/platform\/tenants$/, reply: () => ok({ tenants }) },

      // ── change requests (A3 / A6-R) ──
      {
        path: /^\/platform\/commercial\/change-requests$/,
        reply: ({ query }) => {
          if (!can('platform:approval:read')) return forbid('platform:approval:read');
          const mine = query.get('eligible_for_me') === 'true';
          const rows = mine ? this.requests.filter((r) => this.verdict(r, p) === null) : this.requests;
          return ok({ requests: [...rows].reverse(), next_cursor: null });
        },
      },
      {
        path: /^\/platform\/commercial\/change-requests\/[^/]+\/conversion$/,
        reply: ({ path }) => {
          const r = this.find(rid(path));
          if (!r) return err(404, 'NOT_FOUND');
          return ok({ request: r, conversion: { direction: 'TO_GOVERNED', status: r.state === 'APPLYING' ? 'PENDING_PROVIDER' : r.state, pending_provider: r.state === 'APPLYING' } });
        },
      },
      {
        path: /^\/platform\/commercial\/change-requests\/[^/]+$/,
        reply: ({ path }) => {
          if (!can('platform:approval:read')) return forbid('platform:approval:read');
          const r = this.find(rid(path));
          return r ? ok(this.detail(r, p)) : err(404, 'NOT_FOUND');
        },
      },
      {
        method: 'POST',
        path: /^\/platform\/commercial\/change-requests$/,
        reply: ({ body }) => {
          const b = (body ?? {}) as { action_type?: string; tenant_id?: string | null; product_key?: string | null; payload?: Record<string, unknown>; reason?: string };
          const action = b.action_type ?? '';
          this.log.push(`${p} create ${action}`);
          const scope = REQUESTER_SCOPE[action];
          if (scope === undefined || !can(scope)) return forbid(scope ?? 'unknown');
          const r = this.create(p, { action_type: action, tenant_id: b.tenant_id ?? null, payload: b.payload ?? {}, reason: b.reason ?? '', product_key: b.product_key ?? 'sign' });
          return ok({ request: r, replayed: false }, 201);
        },
      },
      {
        method: 'POST',
        path: /^\/platform\/commercial\/change-requests\/[^/]+\/(submit|withdraw)$/,
        reply: ({ path }) => {
          const r = this.find(rid(path));
          if (!r) return err(404, 'NOT_FOUND');
          const act = path.endsWith('/submit') ? 'submit' : 'withdraw';
          this.log.push(`${p} ${act} ${r.id}`);
          if (r.requested_by !== me) return err(403, 'INSUFFICIENT_PERMISSIONS', { reason: 'not_requester' });
          if (act === 'submit') this.submit(p, r);
          else {
            Object.assign(r, { state: 'WITHDRAWN', withdrawn_at: this.tick() });
            this.record(p, 'COMMERCIAL_CHANGE_REQUEST_WITHDRAWN', r);
          }
          return ok({ request: r });
        },
      },
      {
        method: 'POST',
        path: /^\/platform\/commercial\/change-requests\/[^/]+\/approvals$/,
        reply: ({ path, body }) => {
          const r = this.find(rid(path));
          if (!r) return err(404, 'NOT_FOUND');
          const step = (body as { step_index?: number } | null)?.step_index ?? -1;
          this.log.push(`${p} approve ${r.id} step=${String(step)}`);
          const v = this.verdict(r, p);
          if (v !== null || step !== this.approvalsOf(r.id).length) {
            this.record(p, 'COMMERCIAL_APPROVAL_REFUSED', r);
            return err(409, 'COMMERCIAL_APPROVAL_REFUSED', { refusal: v ?? 'OUT_OF_ORDER' });
          }
          const a = this.approve(p, r, step);
          return ok({ request: r, approval: a, apply: null }, 201);
        },
      },
      {
        method: 'POST',
        path: /^\/platform\/commercial\/change-requests\/[^/]+\/reject$/,
        reply: ({ path, body }) => {
          const r = this.find(rid(path));
          if (!r) return err(404, 'NOT_FOUND');
          const reason = (body as { reason?: string } | null)?.reason ?? '';
          this.log.push(`${p} reject ${r.id}`);
          const v = this.verdict(r, p);
          if (v !== null) return err(409, 'COMMERCIAL_APPROVAL_REFUSED', { refusal: v });
          Object.assign(r, { state: 'REJECTED', rejected_at: this.tick(), rejected_by: me, rejection_reason: reason });
          this.record(p, 'COMMERCIAL_CHANGE_REQUEST_REJECTED', r);
          return ok({ request: r });
        },
      },
      {
        method: 'POST',
        path: /^\/platform\/commercial\/change-requests\/[^/]+\/(apply|convert)$/,
        reply: ({ path }) => {
          const r = this.find(rid(path));
          if (!r) return err(404, 'NOT_FOUND');
          const act = path.endsWith('/convert') ? 'convert' : 'apply';
          this.log.push(`${p} ${act} ${r.id}`);
          // TD-B2-3 / TD-A6-3: the requester only, an approved request only.
          if (!this.applyActionable(r, p)) {
            this.record(p, 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED', r);
            return r.requested_by !== me ? err(403, 'COMMERCIAL_APPLY_REFUSED', { reason: 'NOT_REQUESTER' }) : err(409, 'COMMERCIAL_APPLY_REFUSED', { reason: 'NOT_APPROVED' });
          }
          if (act === 'convert') {
            Object.assign(r, { state: 'APPLYING' });
            this.record(p, 'COMMERCIAL_CHANGE_REQUEST_APPLYING', r);
            return ok({ request: r, conversion: { direction: 'TO_GOVERNED', status: 'PENDING_PROVIDER', pending_provider: true } });
          }
          this.applyEffect(p, r);
          return ok({ request: r });
        },
      },

      // ── support extensions (A8 / B6) ──
      {
        path: /^\/platform\/commercial\/support-extensions$/,
        reply: ({ query }) => {
          const tid = query.get('tenant_id') ?? '';
          const sub = SX_SUBS[tid];
          if (!sub) return undefined; // the B3 fixture's other tenants
          return ok({ extensions: this.extensionRows(tid), subscriptions: [{ id: sub.id, product_key: 'sign', source: 'SELF_SERVICE', status: 'PAST_DUE', grace_until: sub.grace_until, current_period_end: sub.current_period_end }], policy: POLICY });
        },
      },
      {
        method: 'POST',
        path: /^\/platform\/commercial\/support-extensions$/,
        reply: ({ body }) => {
          const b = (body ?? {}) as { tenant_id?: string; requested_days?: number; reason?: string };
          this.log.push(`${p} extend ${String(b.requested_days)}`);
          if (!can('platform:subscription:support')) return forbid('platform:subscription:support');
          return ok({ ...this.extend(p, { tenant_id: b.tenant_id ?? '', requested_days: b.requested_days ?? 0, reason: b.reason ?? '' }), replayed: false }, 201);
        },
      },

      // ── catalog (B2): the fixture's plans, with the world's open requests and publishes ──
      {
        path: /^\/platform\/commercial\/catalog$/,
        reply: (ctx) => {
          const base = catalogBase(ctx) as { status?: number; body: { products: { plans: { versions: Record<string, unknown>[] }[] }[] } };
          for (const plan of base.body.products[0]!.plans) {
            for (const v of plan.versions) {
              const id = String(v['id']);
              if (this.published.has(id)) Object.assign(v, { status: 'PUBLISHED', published_at: '2026-10-24T14:30:00.000Z' });
              const open = this.requests.filter((r) => r.action_type.startsWith('PLAN_') && r.payload['plan_version_id'] === id && OPEN.includes(r.state));
              v['open_requests'] = open.map((r) => ({ id: r.id, action_type: r.action_type, state: r.state, expires_at: r.expires_at }));
            }
          }
          return ok(base.body);
        },
      },

      // ── Tenant › Commercial (B3): the fixture's facts, with the world's open request ──
      {
        path: /^\/platform\/commercial\/tenants\/[^/]+\/commercial$/,
        reply: (ctx) => {
          if (!can('platform:subscription:read')) return forbid('platform:subscription:read');
          const base = tenantCommercialBase(ctx) as { body: { tenant: { id: string }; products: { product_key: string; open_request: unknown }[] } } | undefined;
          if (base === undefined) return undefined;
          const tid = base.body.tenant.id;
          const open = [...this.requests].reverse().find((r) => r.tenant_id === tid && OPEN.includes(r.state));
          const signP = base.body.products.find((x) => x.product_key === 'sign');
          if (signP && open) signP.open_request = { id: open.id, action_type: open.action_type, kind: open.kind, state: open.state, requested_by: open.requested_by, created_at: open.created_at };
          return ok(base.body);
        },
      },

      // ── governance (B5): the operators roster names the people; the audit stream is the world's ──
      {
        path: /^\/platform\/commercial\/operators$/,
        reply: () =>
          can('platform:approval:read')
            ? ok({
                operators: (Object.keys(D4_PEOPLE) as D4Person[]).map((k) => ({ user_id: D4_PEOPLE[k].sub, email: D4_PEOPLE[k].email, display_name: D4_PEOPLE[k].name, role_keys: [...D4_PEOPLE[k].roles], commercial_role_keys: D4_PEOPLE[k].roles.filter((r) => r !== 'super_admin'), attested: k !== 'maya', is_last_owner: false, pending_role_requests: [] })),
                chains: [],
                all_fulfillable: true,
              })
            : forbid('platform:approval:read'),
      },
      {
        path: /^\/platform\/commercial\/audit-events$/,
        reply: ({ query }) => {
          if (!can('platform:commercial:audit:read')) return forbid('platform:commercial:audit:read');
          const cr = query.get('change_request_id');
          const rows = this.audit.filter((e) => cr === null || e.change_request_id === cr);
          return ok({ events: [...rows].reverse(), next_cursor: null });
        },
      },
    ];

    return {
      clock: D4_NOW,
      overrides: [...handlers, ...(subs.overrides ?? []), ...contractRoutes, ...policyRoutes],
    };
  }
}
