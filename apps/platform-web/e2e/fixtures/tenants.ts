// PLATFORM-UX-1 H-1 — deterministic tenant fixtures. A faithful port of the
// prototype's SEED / hist() / DOMAINS / SIGN (doc/design-reference/platform-admin/
// platform/Platform Admin.dc.html, logic class) into the REAL API DTO shapes
// (apps/platform-web/src/platform-api.ts). TEST-ONLY: never imported by src/.

export const NOW_ISO = '2026-10-24T15:00:00Z';
export const OPERATOR_ID = 'op_7f3a91c2e48b';
export const OWNER_ID = 'usr_4c19e0a7b2d1';

interface SeedTenant {
  id: string;
  name: string;
  slug: string;
  kind: 'BUSINESS' | 'PERSONAL';
  status: string;
  created: string;
  invite: 'Invited' | 'Not yet invited';
  caps: string[];
  provider: string | null;
  activated?: string;
  suspended?: string;
  offboarded?: string;
  closed?: string;
  rejected?: string;
  reasonCode?: string;
}

type Opt = Partial<Omit<SeedTenant, 'id' | 'name' | 'slug' | 'kind' | 'status' | 'created'>>;
const row = (
  id: string,
  name: string,
  slug: string,
  kind: 'BUSINESS' | 'PERSONAL',
  status: string,
  created: string,
  o: Opt,
): SeedTenant => ({ id, name, slug, kind, status, created, invite: 'Invited', caps: ['core', 'ats', 'portal'], provider: null, ...o });

export const SEED: SeedTenant[] = [
  row('tn_01J8Q2NWX4', 'Northwind Logistics', 'northwind', 'BUSINESS', 'ACTIVE', '2026-03-02', { activated: '2026-03-04', provider: 'microsoft', caps: ['core', 'ats', 'portal', 'sign'] }),
  row('tn_01JA7HVC2K', 'Halvorsen Clinics', 'halvorsen', 'BUSINESS', 'PROVISIONED', '2026-10-02', {}),
  row('tn_01JAB3BLQ9', 'Brightline Studio', 'brightline', 'BUSINESS', 'PROVISIONED', '2026-10-15', { invite: 'Not yet invited' }),
  row('tn_01J9MRDF7T', 'Meridian Freight', 'meridian', 'BUSINESS', 'SUSPENDED', '2026-05-19', { activated: '2026-05-21', suspended: '2026-10-11', reasonCode: 'payment_overdue', provider: 'google', caps: ['core', 'ats', 'portal', 'sign'] }),
  row('tn_01J6KTP3MZ', 'Kestrel Talent Partners', 'kestrel', 'BUSINESS', 'ACTIVE', '2026-01-12', { activated: '2026-01-13', provider: 'google', caps: ['core', 'ats', 'portal', 'intelligence'], rejected: '2026-08-14' }),
  row('tn_01JA2OMR8D', 'Odile Marchand', 'odile-marchand', 'PERSONAL', 'ACTIVE', '2026-10-19', { activated: '2026-10-19', caps: ['core', 'sign'] }),
  row('tn_01J4FWR6EN', 'Fenwick & Rowe', 'fenwick-rowe', 'BUSINESS', 'OFFBOARDING', '2025-11-03', { activated: '2025-11-05', offboarded: '2026-10-01', reasonCode: 'contract_ended', provider: 'microsoft' }),
  row('tn_01J2CLR0BT', 'Calder Robotics', 'calder', 'BUSINESS', 'CLOSED', '2025-06-20', { activated: '2025-06-22', offboarded: '2026-07-01', closed: '2026-09-30', reasonCode: 'offboarding_complete' }),
  row('tn_01JAP0CH5S', 'Pilar Ochoa', 'pilar-ochoa', 'PERSONAL', 'PROVISIONED', '2026-10-20', { caps: ['core', 'sign'] }),
  row('tn_01J7TDW9HA', 'Tidewater Health', 'tidewater', 'BUSINESS', 'ACTIVE', '2026-02-08', { activated: '2026-02-10', provider: 'microsoft', caps: ['core', 'ats', 'portal', 'sign'] }),
  row('tn_01J9ASG4RE', 'Ashgrove Schools', 'ashgrove', 'BUSINESS', 'PROVISIONED', '2026-09-28', {}),
];

export interface AuditEvent {
  event_type: string;
  created_at: string;
  actor_type: string;
  actor_id: string | null;
  event_payload: Record<string, unknown>;
}

// The prototype's event names → the backend's (tenant-labels.ts TENANT_EVENT_LABEL).
// The prototype actor types → the backend's user | system.
function ev(
  type: string,
  from: string | null,
  to: string | null,
  code: string | null,
  actor: 'user' | 'system',
  actorId: string | null,
  at: string,
  text?: string,
): AuditEvent {
  const payload: Record<string, unknown> = {};
  if (from && to) {
    payload['before'] = { status: from };
    payload['after'] = { status: to };
  }
  if (code) payload['reason'] = text ? { code, text } : { code };
  return { event_type: type, created_at: at, actor_type: actor, actor_id: actorId, event_payload: payload };
}

/** Oldest first — the prototype's hist(). */
export function hist(t: SeedTenant): AuditEvent[] {
  const e: AuditEvent[] = [];
  e.push(ev('tenant.provisioned', null, 'PROVISIONED', 'new_contract', 'user', OPERATOR_ID, `${t.created}T10:12:00Z`));
  // The prototype's provisioned event carries a to-status but no from-status: no
  // from → to pills, the dot takes the Provisioned tone; the reason is kept.
  e[0]!.event_payload = { after: { status: 'PROVISIONED' }, reason: { code: 'new_contract' } };
  if (t.invite !== 'Not yet invited') e.push(ev('tenant.owner_invite.sent', null, null, null, 'user', OPERATOR_ID, `${t.created}T10:13:00Z`));
  if (t.activated) {
    e.push(ev('tenant.owner_invite.accepted', null, null, null, 'user', OWNER_ID, `${t.activated}T08:40:00Z`));
    e.push(ev('tenant.activated', 'PROVISIONED', 'ACTIVE', 'owner_first_session', 'system', null, `${t.activated}T08:40:02Z`));
  }
  if (t.rejected)
    e.push(ev('tenant.lifecycle_transition_rejected', 'ACTIVE', 'CLOSED', 'illegal_transition', 'user', OPERATOR_ID, `${t.rejected}T11:02:00Z`, 'Close is only allowed from Provisioned or Offboarding.'));
  if (t.suspended)
    e.push(ev('tenant.suspended', 'ACTIVE', 'SUSPENDED', t.reasonCode ?? null, 'user', OPERATOR_ID, `${t.suspended}T13:20:00Z`, 'Invoice for September unpaid after 30 days; finance confirmed.'));
  if (t.offboarded) e.push(ev('tenant.offboarding_started', 'ACTIVE', 'OFFBOARDING', 'contract_ended', 'user', OPERATOR_ID, `${t.offboarded}T09:30:00Z`));
  if (t.closed) e.push(ev('tenant.closed', 'OFFBOARDING', 'CLOSED', 'offboarding_complete', 'user', OPERATOR_ID, `${t.closed}T16:00:00Z`));
  return e;
}

const lastAt = (t: SeedTenant): string => {
  const h = hist(t);
  return h[h.length - 1]!.created_at;
};

export function tenantSummaries() {
  return SEED.map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    slug: t.slug,
    status: t.status,
    status_reason_code: t.reasonCode ?? null,
    status_changed_at: lastAt(t),
    is_active: t.status === 'ACTIVE',
    created_at: `${t.created}T10:12:00Z`,
    activated_at: t.activated ? `${t.activated}T08:40:02Z` : null,
    suspended_at: t.suspended ? `${t.suspended}T13:20:00Z` : null,
  }));
}

export function tenantDetail(id: string) {
  const t = SEED.find((x) => x.id === id);
  if (!t) return null;
  return {
    tenant: {
      id: t.id,
      name: t.name,
      kind: t.kind,
      is_active: t.status === 'ACTIVE',
      created_at: `${t.created}T10:12:00Z`,
      updated_at: lastAt(t),
      identity_provider: t.provider,
      status: t.status,
      slug: t.slug,
    },
  };
}

export function tenantAudit(id: string) {
  const t = SEED.find((x) => x.id === id);
  return { events: t ? hist(t).slice().reverse() : [] };
}

export function dashboard() {
  const order = ['PROVISIONED', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'CLOSED'];
  const all = SEED.flatMap((t) => hist(t).map((e) => ({ e, t })));
  all.sort((a, b) => (a.e.created_at < b.e.created_at ? 1 : -1));
  return {
    status_counts: order.map((s) => ({ status: s, count: SEED.filter((t) => t.status === s).length })),
    onboarding: SEED.filter((t) => t.status === 'PROVISIONED')
      .sort((a, b) => (a.created < b.created ? -1 : 1))
      .map((t) => ({ tenant_id: t.id, name: t.name, slug: t.slug, created_at: `${t.created}T09:00:00Z`, invited: t.invite === 'Invited' })),
    recent_activity: all.slice(0, 15).map(({ e, t }) => {
      const r = e.event_payload['reason'] as { code?: string } | undefined;
      return {
        event_type: e.event_type,
        tenant_id: t.id,
        tenant_name: t.name,
        actor_type: e.actor_type,
        actor_id: e.actor_id,
        reason_code: r?.code ?? null,
        created_at: e.created_at,
      };
    }),
  };
}

// ---- Domain (prototype DOMAINS) → TenantDomain --------------------------------
const DOMAIN_REASON: Record<string, string> = {
  'Owner email domain at provisioning': 'provisioned',
  'Provisional claim expired without promotion': 'reservation_expired',
};

const DOMAINS: Record<string, { domain: string; state: string; reason: string; since: string; expires?: string; exception: boolean; exceptions: { domain: string; just: string; ev: string; by: string; at: string; rby: string | null; rat: string | null }[] }> = {
  tn_01J8Q2NWX4: { domain: 'northwind.com', state: 'AUTHORITATIVE', reason: 'Promoted with DNS TXT evidence', since: '2026-03-10', exception: false, exceptions: [] },
  tn_01JA7HVC2K: { domain: 'halvorsenclinics.no', state: 'PROVISIONAL', reason: 'Owner email domain at provisioning', since: '2026-10-02', expires: '2026-11-01', exception: false, exceptions: [] },
  tn_01J6KTP3MZ: {
    domain: 'kestreltalent.com',
    state: 'AUTHORITATIVE',
    reason: 'Promoted with signed group agreement',
    since: '2026-01-20',
    exception: true,
    exceptions: [{ domain: 'kestreltalent.com', just: 'Shared with sister company Kestrel Search under a group services agreement.', ev: 'CASE-2291', by: OPERATOR_ID, at: '2026-06-03', rby: null, rat: null }],
  },
  tn_01J9MRDF7T: { domain: 'meridianfreight.com', state: 'PROVISIONAL', reason: 'Owner email domain at provisioning', since: '2026-09-30', expires: '2026-10-30', exception: false, exceptions: [] },
  tn_01J7TDW9HA: { domain: 'tidewaterhealth.org', state: 'LAPSED', reason: 'Provisional claim expired without promotion', since: '2026-02-10', exception: false, exceptions: [] },
  tn_01J2CLR0BT: {
    domain: 'calderrobotics.io',
    state: 'RELEASED',
    reason: 'Released at close',
    since: '2026-09-30',
    exception: false,
    exceptions: [{ domain: 'calderrobotics.io', just: 'Contractor staff shared the domain during a joint venture.', ev: 'CASE-1840', by: OPERATOR_ID, at: '2025-08-11', rby: OPERATOR_ID, rat: '2026-09-30' }],
  },
};

export interface DomainFixture {
  tenant_id: string;
  domain_claim: { domain: string; claim: string; expires_at: string | null; reason: string | null; exception: boolean } | null;
  exceptions: { id: string; domain: string; justification: string; evidence_ref: string; granted_by_user_id: string; granted_at: string; revoked_by_user_id: string | null; revoked_at: string | null }[];
}

export function tenantDomain(id: string): DomainFixture {
  const d = DOMAINS[id];
  if (!d) return { tenant_id: id, domain_claim: null, exceptions: [] };
  return {
    tenant_id: id,
    domain_claim: {
      domain: d.domain,
      claim: d.state,
      expires_at: d.expires ? `${d.expires}T09:00:00Z` : null,
      reason: DOMAIN_REASON[d.reason] ?? d.reason,
      exception: d.exception,
    },
    exceptions: d.exceptions.map((x, i) => ({
      id: `dx_${i + 1}`,
      domain: x.domain,
      justification: x.just,
      evidence_ref: x.ev,
      granted_by_user_id: x.by,
      granted_at: `${x.at}T09:00:00Z`,
      revoked_by_user_id: x.rby,
      revoked_at: x.rat ? `${x.rat}T09:00:00Z` : null,
    })),
  };
}

// ---- Aramo Sign (prototype SIGN) → PlatformTenantSign --------------------------
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const SIGN: Record<string, { plan: string; key: string; sub: string; sending: boolean; source: string; started: string; periodEnd: string; grace: string | null; commitEnd: string | null; elig: string; used: number; allow: number; storageUsed: number; storageLimit: number; online: boolean; events: [string, string, string, string][] }> = {
  tn_01J8Q2NWX4: { plan: 'Sign Business', key: 'sign_business', sub: 'ACTIVE', sending: true, source: 'MANUAL', started: '2026-03-04', periodEnd: '2026-11-04', grace: null, commitEnd: '2027-03-03', elig: 'OK', used: 412, allow: 1000, storageUsed: 2.4 * GB, storageLimit: 25 * GB, online: true, events: [['invoice.paid', '2026-10-04T06:01:00Z', 'APPLIED', 'Period renewed to 4 Nov 2026'], ['invoice.paid', '2026-10-04T06:03:00Z', 'IGNORED', 'Duplicate delivery of the same event'], ['subscription.updated', '2026-09-02T12:44:00Z', 'STALE', 'Older than the current subscription state']] },
  tn_01J9MRDF7T: { plan: 'Sign Team', key: 'sign_team', sub: 'PAST_DUE', sending: false, source: 'SELF_SERVICE', started: '2026-05-21', periodEnd: '2026-10-21', grace: '2026-10-31', commitEnd: null, elig: 'LAPSED', used: 88, allow: 250, storageUsed: 0.3 * GB, storageLimit: 10 * GB, online: true, events: [['invoice.payment_failed', '2026-10-21T04:10:00Z', 'APPLIED', 'Card declined; grace period started']] },
  tn_01JA2OMR8D: { plan: 'Sign Personal', key: 'sign_personal', sub: 'ACTIVE', sending: true, source: 'FREE', started: '2026-10-19', periodEnd: '2026-11-19', grace: null, commitEnd: null, elig: 'OK', used: 3, allow: 5, storageUsed: 4 * MB, storageLimit: 100 * MB, online: false, events: [] },
  tn_01J7TDW9HA: { plan: 'Sign Business', key: 'sign_business', sub: 'TRIALING', sending: true, source: 'DEVELOPMENT', started: '2026-10-10', periodEnd: '2026-11-09', grace: null, commitEnd: null, elig: 'OK', used: 21, allow: 100, storageUsed: 0.1 * GB, storageLimit: 25 * GB, online: true, events: [] },
};

export function tenantSign(id: string) {
  const t = SEED.find((x) => x.id === id);
  const s = SIGN[id];
  const base = { tenant_id: id, tenant_kind: t?.kind ?? 'BUSINESS', capabilities: t?.caps ?? [], sign_entitled: (t?.caps ?? []).includes('sign') };
  if (!s) return { ...base, subscription: null, allowance: { subscribed: false }, storage: null, billing_available: true, billing_events: [] };
  return {
    ...base,
    subscription: {
      plan_key: s.key,
      plan_name: s.plan,
      source: s.source,
      status: s.sub,
      sending: s.sending,
      started_at: `${s.started}T09:00:00Z`,
      ended_at: null,
      current_period_end: `${s.periodEnd}T09:00:00Z`,
      cancel_at_period_end: false,
      grace_until: s.grace ? `${s.grace}T09:00:00Z` : null,
      billing_managed: s.online,
      commitment_end: s.commitEnd ? `${s.commitEnd}T09:00:00Z` : null,
      cancel_requested_within_commitment: false,
      eligibility_state: s.elig,
    },
    allowance: { subscribed: true, limit: s.allow, used: s.used, remaining: s.allow - s.used, period_start: `${s.started}T09:00:00Z`, period_end: `${s.periodEnd}T09:00:00Z` },
    storage: { capacity_key: 'storage', limit: s.storageLimit, unlimited: false, used: s.storageUsed },
    billing_available: s.online,
    billing_events: s.events.map(([type, at, outcome, detail]) => ({ event_type: type, outcome, detail, event_created_at: at, received_at: at })),
  };
}
