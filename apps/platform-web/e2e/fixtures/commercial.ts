// CCP-B1 — the deterministic Commercial dataset for the visual, a11y, keyboard
// and 900px suites. A port of the CCP prototype's mock change requests
// (doc/design-reference/ccp/CCP-UI-v1_0/ccp-data.js CR0, without the retired
// pilot policy v0 and its requests: handoff "Don't build") into the REAL A3 DTO
// shapes (apps/platform-web/src/commercial/commercial-api.ts), at the prototype's
// frozen clock (NOW = 2026-10-24 14:00 UTC). Where the prototype uses an action
// the A3 engine does not have, the nearest real action stands in (PLAN_CHANGE →
// SUBSCRIPTION_CHANGE, RECON → CONVERSION; GRANT on Portal → ENTITLEMENT_GRANT on
// Sign: the registry holds `sign` only, PBD §7.1). TEST-ONLY: src/ never imports it.

import type { MockOptions, Reply } from './mock-api';
import { PERSONAS, type CcpPersona } from './session';

export const CCP_NOW = '2026-10-24T14:00:00Z';
const H = 3_600_000;
const ago = (h: number): string => new Date(Date.parse(CCP_NOW) - h * H).toISOString();
const plus = (iso: string, h: number): string => new Date(Date.parse(iso) + h * H).toISOString();

const POLICY_V1 = '019a0000-0000-7000-8000-0000000cc201';
export const PEOPLE = {
  daniel: PERSONAS.ccpOwner.sub,
  priya: PERSONAS.ccpFinance.sub,
  tomas: PERSONAS.ccpOps.sub,
  lena: PERSONAS.ccpCatalog.sub,
  kwame: PERSONAS.ccpSupport.sub,
  ines: PERSONAS.ccpAuditor.sub,
  arjun: 'cc000000-0000-7000-8000-00000000a12a',
} as const;

/** The prototype's tenants (ccp-data.js T0), as the existing tenant list returns them. */
export const CCP_TENANTS = [
  ['cc7e0000-0000-7000-8000-0000000000a1', 'Halcyon Health', 'halcyon'],
  ['cc7e0000-0000-7000-8000-0000000000a2', 'Atlas Freight', 'atlas-freight'],
  ['cc7e0000-0000-7000-8000-0000000000a3', 'Meridian Partners', 'meridian'],
  ['cc7e0000-0000-7000-8000-0000000000a4', 'Northwind Logistics', 'northwind'],
  ['cc7e0000-0000-7000-8000-0000000000a5', 'Fernhill Studio', 'fernhill'],
  ['cc7e0000-0000-7000-8000-0000000000a6', 'Oakridge Dental', 'oakridge'],
] as const;
const T = (slug: string): string => CCP_TENANTS.find((t) => t[2] === slug)![0];

const FIN = { step_index: 0, role_key: 'finance_admin', scope_keys: ['platform:billing:approve'] };
const OWN = { step_index: 1, role_key: 'platform_owner', scope_keys: ['platform:billing:approve'] };
const CHAIN = {
  BELOW: { rule: 'FINANCE_ONLY', basis: {}, steps: [FIN] },
  ABOVE: { rule: 'FINANCE_THEN_OWNER', basis: {}, steps: [FIN, OWN] },
  CATALOG: { rule: 'FINANCE_THEN_OWNER', basis: {}, steps: [FIN, { ...OWN, scope_keys: ['platform:catalog:approve', 'platform:catalog:publish'] }] },
  PRIV: { rule: 'DISTINCT_PLATFORM_OWNER', basis: {}, steps: [{ step_index: 0, role_key: 'platform_owner', scope_keys: ['platform:subscription:approve'] }] },
} as const;

interface Seed {
  id: string;
  /** The prototype id this row ports (comments only). */
  cr: string;
  action_type: string;
  tenant: string | null;
  payload: Record<string, unknown>;
  chain: keyof typeof CHAIN;
  by: string;
  createdAgo: number;
  state: string;
  /** Signed steps: [approver, hours ago]. */
  signed?: [string, number][];
  reason: string;
}

const id = (n: number): string => `0c3a${String(n).padStart(4, '0')}-0000-7000-8000-0000000c${String(n).padStart(4, '0')}`;

// CCP-UI-V12 (AM-3…AM-7; v1.2 §17.1 D-1, D-4) — the v1.2 prototype's three requests (ccp-data.js
// c53 / c54 / c55): a failed policy activation (requested by Priya), an approved grant to apply
// (requested by Tomás) and an apply-expired grant. CR-1054 / CR-1055 snapshot a policy version that
// declares a 72 h apply window (the prototype's pilot v0, renumbered: numbering starts at v1, Q12).
const POLICY_TTL = '019a0000-0000-7000-8000-0000000cc2f0';
const POLICY_V2_DRAFT = '019a0000-0000-7000-8000-0000000cc202';
export const V12_CR = {
  c1053: 'cc12ad53-0000-7000-8000-00000000c053',
  c1054: 'cc12ad54-0000-7000-8000-00000000c054',
  c1055: 'cc12ad55-0000-7000-8000-00000000c055',
} as const;

export const CR = {
  c1041: id(1041),
  c1042: id(1042),
  c1043: id(1043),
  c1044: id(1044),
  c1045: id(1045),
  c1049: id(1049),
  c1051: id(1051),
  c1052: id(1052),
  c1053: id(1053),
} as const;

/** A pending policy activation (bootstrap state only: its chain is the design banner's fourth). */
const POLICY_SEED: Seed = { id: CR.c1053, cr: 'CR-1053', action_type: 'POLICY_ACTIVATE', tenant: null, payload: { policy_version_id: '019a0000-0000-7000-8000-0000000cc202' }, chain: 'ABOVE', by: PEOPLE.arjun, createdAgo: 6, state: 'PENDING_APPROVAL', signed: [[PEOPLE.priya, 5]], reason: 'Tighten the credit threshold after the Q3 review.' };

interface V12Seed extends Seed {
  readonly approvedAgo: number;
  readonly policy: string;
}
const V12_SEEDS: V12Seed[] = [
  { id: V12_CR.c1053, cr: 'CR-1053', action_type: 'POLICY_ACTIVATE', tenant: null, payload: { policy_version_id: POLICY_V2_DRAFT }, chain: 'ABOVE', by: PEOPLE.priya, createdAgo: 26, state: 'APPLY_FAILED', signed: [[PEOPLE.arjun, 22], [PEOPLE.daniel, 16]], reason: 'Q3 review: tighten credits, shorten the approval window and set an apply window.\n\nEvidence: Finance review FR-2026-Q3', approvedAgo: 16, policy: POLICY_V1 },
  { id: V12_CR.c1054, cr: 'CR-1054', action_type: 'ENTITLEMENT_GRANT', tenant: 'atlas-freight', payload: {}, chain: 'BELOW', by: PEOPLE.tomas, createdAgo: 70, state: 'APPROVED', signed: [[PEOPLE.priya, 64]], reason: 'Trial of Intelligence for the regional hiring teams.\n\nEvidence: Email from Atlas, 15 Oct', approvedAgo: 64, policy: POLICY_TTL },
  { id: V12_CR.c1055, cr: 'CR-1055', action_type: 'ENTITLEMENT_GRANT', tenant: 'oakridge', payload: {}, chain: 'BELOW', by: PEOPLE.tomas, createdAgo: 110, state: 'APPLY_EXPIRED', signed: [[PEOPLE.priya, 104]], reason: 'Portal for the new practice.\n\nEvidence: Support ticket SUP-88102', approvedAgo: 104, policy: POLICY_TTL },
];

/** The policy versions behind the v1.2 requests (GET /platform/commercial/policy-versions). */
function v12Policies(meId: string) {
  const content = { format_version: 1, currency: 'USD', discount_escalation_threshold_bps: 2000, credit_escalation_threshold_minor: 50000, support_extension_max_days: 14, support_extension_frequency_window_days: 90, support_extension_cumulative_max_days: 30, support_extension_cumulative_window_days: 365, approval_expiry_hours: 72, past_due_grace_days: 7 };
  const v = (id: string, n: number, status: string, extra: Record<string, unknown> = {}, open: unknown = null) => ({ id, version_number: n, status, content: { ...content, ...extra }, content_checksum: 'c'.repeat(64), note: null, created_by: null, created_at: '2026-10-20T10:00:00Z', activated_by: null, activated_at: null, retired_at: null, open_request: open, latest_request: null });
  const mine = meId === PEOPLE.priya;
  return {
    versions: [
      v(POLICY_V2_DRAFT, 3, 'DRAFT', { credit_escalation_threshold_minor: 30000, approval_expiry_hours: 48, apply_expiry_hours: 72 }, { id: V12_CR.c1053, state: 'APPLY_FAILED', apply_actionable: mine, withdraw_actionable: mine }),
      v(POLICY_V1, 2, 'ACTIVE'),
      v(POLICY_TTL, 1, 'RETIRED', { apply_expiry_hours: 72 }),
    ],
    active_version_id: POLICY_V1,
    open_request: { id: V12_CR.c1053, state: 'APPLY_FAILED', policy_version_id: POLICY_V2_DRAFT },
    caller: { can_author: false, can_request_activation: false },
  };
}

const SEEDS: Seed[] = [
  { id: CR.c1041, cr: 'CR-1041', action_type: 'SUBSCRIPTION_CHANGE', tenant: 'atlas-freight', payload: { plan: 'scale', discount_bps: 2500 }, chain: 'ABOVE', by: PEOPLE.tomas, createdAgo: 31, state: 'PENDING_APPROVAL', signed: [[PEOPLE.priya, 20]], reason: 'Atlas is adding two regional hiring teams. The 25% discount was agreed on the renewal call.' },
  { id: CR.c1042, cr: 'CR-1042', action_type: 'CREDIT', tenant: 'northwind', payload: { amount_minor: 35000, currency: 'USD' }, chain: 'BELOW', by: PEOPLE.tomas, createdAgo: 5, state: 'PENDING_APPROVAL', reason: 'Envelopes failed to send during the 18 Oct incident.' },
  { id: CR.c1043, cr: 'CR-1043', action_type: 'DISCOUNT', tenant: 'halcyon', payload: { discount_bps: 3000 }, chain: 'ABOVE', by: PEOPLE.tomas, createdAgo: 26, state: 'PENDING_APPROVAL', signed: [[PEOPLE.arjun, 22]], reason: 'Renewal for a further 24 months.' },
  { id: CR.c1044, cr: 'CR-1044', action_type: 'PLAN_VERSION_PUBLISH', tenant: null, payload: { plan_version_id: '0c3a0000-0000-7000-8000-0000000a1a03' }, chain: 'CATALOG', by: PEOPLE.lena, createdAgo: 3, state: 'PENDING_APPROVAL', reason: 'Annual price review. Existing Team tenants stay on their pinned version.' },
  { id: CR.c1045, cr: 'CR-1045', action_type: 'ROLE_GRANT', tenant: null, payload: { subject_user_id: PEOPLE.ines, role_key: 'finance_admin' }, chain: 'PRIV', by: PEOPLE.daniel, createdAgo: 8, state: 'PENDING_APPROVAL', reason: 'Cover for Finance during the Q4 close.' },
  { id: CR.c1049, cr: 'CR-1049', action_type: 'ENTITLEMENT_GRANT', tenant: 'northwind', payload: {}, chain: 'BELOW', by: PEOPLE.tomas, createdAgo: 1, state: 'DRAFT', reason: 'Pilot of the self-service portal.' },
  { id: CR.c1051, cr: 'CR-1051', action_type: 'CONVERSION', tenant: 'meridian', payload: {}, chain: 'BELOW', by: PEOPLE.tomas, createdAgo: 26, state: 'APPLYING', signed: [[PEOPLE.priya, 24]], reason: 'Meridian stays on its contract. The checkout was started by a new team member.' },
  { id: CR.c1052, cr: 'CR-1052', action_type: 'SUPPORT_EXTENSION', tenant: 'oakridge', payload: { requested_days: 14 }, chain: 'BELOW', by: PEOPLE.kwame, createdAgo: 4, state: 'PENDING_APPROVAL', reason: 'The practice moved offices and paperwork was delayed.' },
];

export interface CcpRequest {
  id: string;
  action_type: string;
  kind: string;
  state: string;
  tenant_id: string | null;
  product_key: string | null;
  payload: Record<string, unknown>;
  payload_checksum: string;
  required_chain: { rule: string; basis: Record<string, unknown>; steps: { step_index: number; role_key: string; scope_keys: string[] }[] };
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

function toRequest(s: Seed): CcpRequest {
  const created = ago(s.createdAgo);
  const submitted = s.state === 'DRAFT' ? null : created;
  const tenant = s.tenant === null ? null : T(s.tenant);
  return {
    id: s.id,
    action_type: s.action_type,
    kind: 'NORMAL',
    state: s.state,
    tenant_id: tenant,
    product_key: s.tenant === null && s.action_type !== 'PLAN_VERSION_PUBLISH' ? null : 'sign',
    payload: s.payload,
    payload_checksum: 'a'.repeat(64),
    required_chain: JSON.parse(JSON.stringify(CHAIN[s.chain])) as CcpRequest['required_chain'],
    policy_version_id: POLICY_V1,
    policy_checksum: 'b'.repeat(64),
    requested_by: s.by,
    reason: s.reason,
    created_at: created,
    submitted_at: submitted,
    expires_at: submitted === null ? null : plus(submitted, 72),
    approved_at: s.state === 'APPLYING' ? ago((s.signed ?? [])[0]?.[1] ?? 0) : null,
    rejected_at: null,
    rejected_by: null,
    rejection_reason: null,
    withdrawn_at: null,
    expired_at: null,
    applied_at: null,
  };
}

/** Each persona's live verdict per pending request (what the A3 engine answers), by prototype `elig`. */
const VERDICT: Readonly<Record<string, Readonly<Partial<Record<CcpPersona, string | null>>>>> = {
  [CR.c1041]: { ccpFinance: 'USER_ALREADY_APPROVED', ccpOwner: null, ccpOps: 'SELF_APPROVAL', ccpCatalog: 'STEP_SCOPE_MISSING', ccpSupport: 'STEP_SCOPE_MISSING', ccpAuditor: 'STEP_SCOPE_MISSING' },
  [CR.c1042]: { ccpFinance: null, ccpOwner: 'STEP_SCOPE_MISSING', ccpOps: 'SELF_APPROVAL', ccpCatalog: 'STEP_SCOPE_MISSING', ccpSupport: 'STEP_SCOPE_MISSING', ccpAuditor: 'STEP_SCOPE_MISSING' },
  [CR.c1043]: { ccpFinance: 'STEP_SCOPE_MISSING', ccpOwner: null, ccpOps: 'SELF_APPROVAL', ccpCatalog: 'STEP_SCOPE_MISSING', ccpSupport: 'STEP_SCOPE_MISSING', ccpAuditor: 'STEP_SCOPE_MISSING' },
  [CR.c1044]: { ccpFinance: null, ccpOwner: 'OUT_OF_ORDER', ccpOps: 'STEP_SCOPE_MISSING', ccpCatalog: 'SELF_APPROVAL', ccpSupport: 'STEP_SCOPE_MISSING', ccpAuditor: 'STEP_SCOPE_MISSING' },
  [CR.c1045]: { ccpFinance: 'STEP_SCOPE_MISSING', ccpOwner: 'SELF_APPROVAL', ccpOps: 'STEP_SCOPE_MISSING', ccpCatalog: 'STEP_SCOPE_MISSING', ccpSupport: 'STEP_SCOPE_MISSING', ccpAuditor: 'STEP_SCOPE_MISSING' },
  [CR.c1053]: { ccpFinance: 'USER_ALREADY_APPROVED', ccpOwner: null, ccpOps: 'STEP_SCOPE_MISSING', ccpCatalog: 'STEP_SCOPE_MISSING', ccpSupport: 'STEP_SCOPE_MISSING', ccpAuditor: 'STEP_SCOPE_MISSING' },
  [CR.c1052]: { ccpFinance: null, ccpOwner: 'STEP_SCOPE_MISSING', ccpOps: 'STEP_SCOPE_MISSING', ccpCatalog: 'STEP_SCOPE_MISSING', ccpSupport: 'SELF_APPROVAL', ccpAuditor: 'STEP_SCOPE_MISSING' },
};

const ok = (body: unknown, status = 200): Reply => ({ status, body });
const err = (status: number, code: string, details: Record<string, unknown>): Reply => ({ status, body: { error: { code, message: 'refused', request_id: 'req-e2e', details } } });

export interface CcpWorldOptions {
  persona: CcpPersona;
  /** No change requests at all (the prototype's demoState "empty"). */
  empty?: boolean;
  /** Never answer the list (the prototype's demoState "loading"). */
  loading?: boolean;
  /** Pending requests whose chain the A3 gate reports unfulfillable (the prototype's bootstrap "notBootstrapped"). */
  unfulfillable?: readonly string[];
  /** Add a pending policy activation (the bootstrap state's fourth chain). */
  policyRequest?: boolean;
  /** The next approve of these ids answers this 409 (the backend refuses although the verdict said OK). */
  refuseApprove?: Readonly<Record<string, { code: string; details: Record<string, unknown> }>>;
  /**
   * CCP-C4 — these requests are fully signed, applied by their requester and pending at the provider
   * (APPLYING; a Stripe-side credit / discount / refund — the prototype's "Sent to Stripe").
   */
  applying?: readonly string[];
  /** CCP-UI-V12: add the v1.2 requests (CR-1053 / 1054 / 1055), their policy versions and the thresholds. */
  v12?: boolean;
}

/** A stateful Commercial API: approve / reject / submit / withdraw change what the next read returns. */
export class CcpWorld {
  readonly log: string[] = [];
  private readonly requests: CcpRequest[];
  private readonly approvals = new Map<string, Approval[]>();
  private readonly verdicts = new Map<string, string | null>();
  private clock = 0;

  constructor(private readonly o: CcpWorldOptions) {
    const seeds = o.policyRequest ? [...SEEDS.slice(0, 5), POLICY_SEED, ...SEEDS.slice(5)] : SEEDS;
    // CCP-R3 (CCP-A1 Amendment A1, FA-5): the server omits a CREDIT's amount for a caller without
    // platform:billing:read AND platform:billing:amount:read; the mock does the same per persona.
    const scopes = PERSONAS[o.persona].scopes as readonly string[];
    const amountAccess = scopes.includes('platform:billing:read') && scopes.includes('platform:billing:amount:read');
    const withhold = (p: Record<string, unknown>): Record<string, unknown> => {
      if (amountAccess || !('amount_minor' in p)) return p;
      const { amount_minor: _omitted, ...rest } = p;
      return { ...rest, amount_withheld: 'FINANCE_SCOPE_REQUIRED' };
    };
    this.requests = o.empty ? [] : seeds.map(toRequest).map((r) => ({ ...r, payload: withhold(r.payload) }));
    if (o.v12 === true && !o.empty) {
      for (const s of V12_SEEDS) this.requests.push({ ...toRequest(s), policy_version_id: s.policy, approved_at: ago(s.approvedAgo), expires_at: plus(ago(s.createdAgo), 72) });
    }
    const allSeeds: Seed[] = o.v12 === true ? [...seeds, ...V12_SEEDS] : seeds;
    for (const r of this.requests) if ((o.applying ?? []).includes(r.id)) Object.assign(r, { state: 'APPLYING', approved_at: ago(1) });
    for (const s of allSeeds) {
      const signed: ReadonlyArray<readonly [string, number]> = (o.applying ?? []).includes(s.id) && (s.signed ?? []).length === 0 ? [[PEOPLE.priya, 1]] : (s.signed ?? []);
      this.approvals.set(
        s.id,
        signed.map(([who, h], i) => ({
          id: `0c3aa${String(i)}00-0000-7000-8000-00000000${s.id.slice(-4)}`,
          step_index: i,
          approver_user_id: who,
          step_role_key: CHAIN[s.chain].steps[i]!.role_key,
          step_scope_keys: [...CHAIN[s.chain].steps[i]!.scope_keys],
          approver_role_keys: [CHAIN[s.chain].steps[i]!.role_key],
          comment: null,
          created_at: ago(h),
        })),
      );
      const v = VERDICT[s.id]?.[o.persona];
      if (v !== undefined) this.verdicts.set(s.id, v);
    }
  }

  private get me(): string {
    return PERSONAS[this.o.persona].sub;
  }

  private tick(): string {
    this.clock += 1;
    return new Date(Date.parse(CCP_NOW) + this.clock * 60_000).toISOString();
  }

  private detail(r: CcpRequest) {
    const approvals = this.approvals.get(r.id) ?? [];
    const pending = r.state === 'PENDING_APPROVAL';
    const verdict = this.verdicts.get(r.id);
    return {
      request: r,
      approvals,
      is_expired: false,
      chain_satisfiable: pending ? !(this.o.unfulfillable ?? []).includes(r.id) : null,
      // A6-R / TD-B2-3: only the requester, while approved or failed.
      apply_actionable: (r.state === 'APPROVED' || r.state === 'APPLY_FAILED') && r.requested_by === this.me,
      steps: r.required_chain.steps.map((s) => {
        const a = approvals.find((x) => x.step_index === s.step_index);
        const status = a ? 'APPROVED' : s.step_index === approvals.length ? 'NEXT' : 'WAITING';
        const caller = a ? null : pending && verdict !== undefined ? (verdict === null ? { eligible: true, refusal: null } : { eligible: false, refusal: verdict }) : { eligible: false, refusal: 'NOT_PENDING' };
        return { step_index: s.step_index, role_key: s.role_key, scope_keys: s.scope_keys, status, approval_id: a?.id ?? null, caller };
      }),
    };
  }

  private find(path: string): CcpRequest | undefined {
    const rid = decodeURIComponent(path.split('/')[4] ?? '');
    return this.requests.find((r) => r.id === rid);
  }

  mock(extra: MockOptions = {}): MockOptions & { clock: string } {
    return {
      ...extra,
      clock: CCP_NOW,
      persona: this.o.persona,
      overrides: [
        ...(extra.overrides ?? []),
        ...(this.o.v12 === true
          ? [
              { path: /^\/platform\/commercial\/policy-versions$/, reply: () => ok(v12Policies(this.me)) },
              { path: /^\/platform\/commercial\/metrics\/approvals$/, reply: () => ok({ as_of: CCP_NOW, change_requests_by_state: {}, pending_approval_nearing_expiry: 0, pending_approval_past_expiry: 0, open_alerts_by_type: {}, thresholds: { pending_provider_stuck_minutes: 1440, approval_expiry_lead_minutes: 720 } }) },
            ]
          : []),
        {
          path: /^\/platform\/tenants$/,
          reply: () =>
            ok({
              tenants: CCP_TENANTS.map(([tid, name, slug]) => ({ id: tid, name, kind: 'BUSINESS', slug, status: 'ACTIVE', status_reason_code: null, status_changed_at: '2026-01-01T00:00:00Z', is_active: true, created_at: '2026-01-01T00:00:00Z', activated_at: '2026-01-01T00:00:00Z', suspended_at: null })),
            }),
        },
        {
          path: /^\/platform\/commercial\/change-requests$/,
          reply: ({ query }) => {
            if (this.o.loading) return 'hang';
            const mine = query.get('eligible_for_me') === 'true';
            const rows = mine ? this.requests.filter((r) => r.state === 'PENDING_APPROVAL' && this.verdicts.get(r.id) === null) : this.requests;
            return ok({ requests: rows, next_cursor: null });
          },
        },
        {
          path: /^\/platform\/commercial\/change-requests\/[^/]+$/,
          reply: ({ path }) => {
            const r = this.find(path);
            return r ? ok(this.detail(r)) : err(404, 'NOT_FOUND', {});
          },
        },
        {
          method: 'POST',
          path: /^\/platform\/commercial\/change-requests\/[^/]+\/approvals$/,
          reply: ({ path, body }) => {
            const r = this.find(path);
            if (!r) return err(404, 'NOT_FOUND', {});
            const step = (body as { step_index?: number } | null)?.step_index ?? -1;
            this.log.push(`approve ${r.id} step=${String(step)}`);
            const forced = this.o.refuseApprove?.[r.id];
            if (forced) return err(409, forced.code, forced.details);
            const v = this.verdicts.get(r.id);
            if (r.state !== 'PENDING_APPROVAL') return err(409, 'COMMERCIAL_APPROVAL_REFUSED', { refusal: 'NOT_PENDING' });
            if (v !== null) return err(409, 'COMMERCIAL_APPROVAL_REFUSED', { refusal: v ?? 'STEP_SCOPE_MISSING' });
            const list = this.approvals.get(r.id) ?? [];
            const s = r.required_chain.steps[step];
            if (!s || step !== list.length) return err(409, 'COMMERCIAL_APPROVAL_REFUSED', { refusal: 'OUT_OF_ORDER' });
            const at = this.tick();
            const a: Approval = { id: `0c3aaf00-0000-7000-8000-0000000${String(list.length)}${r.id.slice(-4)}`, step_index: step, approver_user_id: this.me, step_role_key: s.role_key, step_scope_keys: s.scope_keys, approver_role_keys: [...PERSONAS[this.o.persona].roles], comment: null, created_at: at };
            list.push(a);
            this.approvals.set(r.id, list);
            if (list.length === r.required_chain.steps.length) Object.assign(r, { state: 'APPROVED', approved_at: at });
            this.verdicts.set(r.id, 'USER_ALREADY_APPROVED');
            return ok({ request: r, approval: a, apply: null }, 201);
          },
        },
        {
          method: 'POST',
          path: /^\/platform\/commercial\/change-requests\/[^/]+\/reject$/,
          reply: ({ path, body }) => {
            const r = this.find(path);
            if (!r) return err(404, 'NOT_FOUND', {});
            const reason = (body as { reason?: string } | null)?.reason ?? '';
            this.log.push(`reject ${r.id} reason=${reason}`);
            const v = this.verdicts.get(r.id);
            if (r.state !== 'PENDING_APPROVAL' || v !== null) return err(409, 'COMMERCIAL_APPROVAL_REFUSED', { refusal: r.state !== 'PENDING_APPROVAL' ? 'NOT_PENDING' : (v ?? 'STEP_SCOPE_MISSING') });
            Object.assign(r, { state: 'REJECTED', rejected_at: this.tick(), rejected_by: this.me, rejection_reason: reason });
            return ok({ request: r });
          },
        },
        {
          method: 'POST',
          path: /^\/platform\/commercial\/change-requests\/[^/]+\/(submit|withdraw)$/,
          reply: ({ path }) => {
            const r = this.find(path);
            if (!r) return err(404, 'NOT_FOUND', {});
            const act = path.endsWith('/submit') ? 'submit' : 'withdraw';
            this.log.push(`${act} ${r.id}`);
            if (r.requested_by !== this.me) return err(403, 'INSUFFICIENT_PERMISSIONS', { reason: 'not_requester' });
            const at = this.tick();
            if (act === 'submit') Object.assign(r, { state: 'PENDING_APPROVAL', submitted_at: at, expires_at: plus(at, 72) });
            else Object.assign(r, { state: 'WITHDRAWN', withdrawn_at: at });
            return ok({ request: r });
          },
        },
      ],
    };
  }
}

/** A one-shot (stateless per test) mock for the visual states. */
export function ccpMock(o: CcpWorldOptions): () => MockOptions & { clock: string } {
  return () => new CcpWorld(o).mock();
}
