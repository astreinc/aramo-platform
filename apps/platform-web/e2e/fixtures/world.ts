// PLATFORM-UX-1 H-1 — a STATEFUL fixture world for the journey tests: the
// mutations a journey makes (suspend, provision, restrict, accept …) change what
// the following reads return, as the real API would. One World per test.

import type { MockOptions, Reply } from './mock-api';
import { matchingPolicy, personalReview, proposal, proposals } from './rest';
import { OPERATOR_ID, SEED, tenantAudit, tenantDetail, tenantDomain, tenantSummaries, type AuditEvent } from './tenants';

const ok = (body: unknown, status = 200): Reply => ({ status, body });
const at = (n: number) => new Date(Date.parse('2026-10-24T15:00:00Z') + n * 60_000).toISOString();

const LIFECYCLE: Record<string, { to: string; event: string }> = {
  suspend: { to: 'SUSPENDED', event: 'tenant.suspended' },
  reactivate: { to: 'ACTIVE', event: 'tenant.reactivated' },
  'start-offboarding': { to: 'OFFBOARDING', event: 'tenant.offboarding_started' },
  close: { to: 'CLOSED', event: 'tenant.closed' },
};

export class World {
  readonly status: Record<string, string> = {};
  readonly events: Record<string, AuditEvent[]> = {};
  readonly created: { id: string; name: string; kind: string; slug: string }[] = [];
  readonly domain: Record<string, ReturnType<typeof tenantDomain>> = {};
  readonly personal: Record<string, string> = {};
  readonly personalUntil: Record<string, string | null> = {};
  readonly proposalStatus: Record<string, string> = {};
  readonly log: string[] = [];
  private clock = 0;
  /** Set to make the next accept of this proposal answer 409 (accepted elsewhere). */
  staleProposal: string | null = null;

  private tick(): string {
    this.clock += 1;
    return at(this.clock);
  }

  private statusOf(id: string): string {
    return this.status[id] ?? SEED.find((t) => t.id === id)?.status ?? 'PROVISIONED';
  }

  mock(extra: MockOptions = {}): MockOptions {
    const w = this;
    const tenantId = (path: string) => decodeURIComponent(path.split('/')[3]!);
    return {
      ...extra,
      overrides: [
        ...(extra.overrides ?? []),
        // ---- tenants
        {
          path: /^\/platform\/tenants$/,
          reply: () =>
            ok({
              tenants: [
                ...tenantSummaries().map((t) => ({ ...t, status: w.statusOf(t.id), is_active: w.statusOf(t.id) === 'ACTIVE' })),
                ...w.created.map((c) => ({ id: c.id, name: c.name, kind: c.kind, slug: c.slug, status: 'PROVISIONED', status_reason_code: null, status_changed_at: at(1), is_active: false, created_at: at(1), activated_at: null, suspended_at: null })),
              ],
            }),
        },
        {
          path: /^\/platform\/tenants\/[^/]+$/,
          reply: ({ path }) => {
            const id = tenantId(path);
            const c = w.created.find((x) => x.id === id);
            if (c) return ok({ tenant: { id: c.id, name: c.name, kind: c.kind, is_active: false, created_at: at(1), updated_at: at(1), identity_provider: null, status: 'PROVISIONED', slug: c.slug } });
            const d = tenantDetail(id);
            return d ? ok({ tenant: { ...d.tenant, status: w.statusOf(id), is_active: w.statusOf(id) === 'ACTIVE' } }) : undefined;
          },
        },
        {
          path: /^\/platform\/tenants\/[^/]+\/audit$/,
          reply: ({ path }) => {
            const id = tenantId(path);
            const base = w.created.some((x) => x.id === id) ? [] : tenantAudit(id).events;
            return ok({ events: [...(w.events[id] ?? []).slice().reverse(), ...base] });
          },
        },
        {
          method: 'POST',
          path: /^\/platform\/tenants\/[^/]+\/(suspend|reactivate|start-offboarding|close)$/,
          reply: ({ path, body }) => {
            const id = tenantId(path);
            const action = path.split('/')[4]!;
            const L = LIFECYCLE[action]!;
            const from = w.statusOf(id);
            w.status[id] = L.to;
            const b = (body ?? {}) as { reasonCode?: string; reasonText?: string };
            (w.events[id] ??= []).push({ event_type: L.event, created_at: w.tick(), actor_type: 'user', actor_id: OPERATOR_ID, event_payload: { before: { status: from }, after: { status: L.to }, reason: { code: b.reasonCode ?? null, text: b.reasonText ?? null } } });
            w.log.push(`${action} ${id}`);
            return ok({ tenant_id: id, from, to: L.to, status: L.to, changed: true });
          },
        },
        {
          method: 'POST',
          path: /^\/platform\/tenants\/[^/]+\/resend-owner-invite$/,
          reply: ({ path }) => {
            const id = tenantId(path);
            (w.events[id] ??= []).push({ event_type: 'tenant.owner_invite.sent', created_at: w.tick(), actor_type: 'user', actor_id: OPERATOR_ID, event_payload: {} });
            w.log.push(`resend ${id}`);
            return ok({ tenant_id: id, owner_user_id: 'usr_owner', owner_email: 'owner@example.com', resent: true });
          },
        },
        {
          method: 'POST',
          path: /^\/platform\/tenants$/,
          reply: ({ body }) => {
            const b = body as { name: string; owner_email: string; kind?: string; slug?: string; capabilities?: string[]; invite_owner?: boolean };
            const id = 'tn_01JB7JUNIPR';
            const slug = b.slug ?? b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            w.created.push({ id, name: b.name, kind: b.kind ?? 'BUSINESS', slug });
            w.log.push(`provision ${b.name} caps=${(b.capabilities ?? []).join(',')}`);
            return ok({ tenant_id: id, tenant_name: b.name, tenant_kind: b.kind ?? 'BUSINESS', owner_user_id: 'usr_new', owner_email: b.owner_email, membership_id: 'mem_new', capabilities: b.capabilities ?? [], invitation_sent: b.invite_owner !== false }, 201);
          },
        },
        // ---- domain
        { path: /^\/platform\/tenants\/[^/]+\/domain$/, reply: ({ path }) => ok(w.domain[tenantId(path)] ?? tenantDomain(tenantId(path))) },
        {
          method: 'POST',
          path: /^\/platform\/tenants\/[^/]+\/domain\/promote$/,
          reply: ({ path }) => {
            const id = tenantId(path);
            const d = structuredClone(w.domain[id] ?? tenantDomain(id));
            if (d.domain_claim) Object.assign(d.domain_claim, { claim: 'AUTHORITATIVE', expires_at: null, reason: 'operator_evidence' });
            w.domain[id] = d;
            w.log.push(`promote ${id}`);
            return ok(d);
          },
        },
        {
          method: 'POST',
          path: /^\/platform\/tenants\/[^/]+\/domain\/exception$/,
          reply: ({ path, body }) => {
            const id = tenantId(path);
            const d = structuredClone(w.domain[id] ?? tenantDomain(id));
            const b = body as { justification: string; evidence_ref: string };
            if (d.domain_claim) d.domain_claim.exception = true;
            d.exceptions.unshift({ id: 'dx_new', domain: d.domain_claim?.domain ?? '', justification: b.justification, evidence_ref: b.evidence_ref, granted_by_user_id: OPERATOR_ID, granted_at: w.tick(), revoked_by_user_id: null, revoked_at: null });
            w.domain[id] = d;
            w.log.push(`grant ${id}`);
            return ok(d);
          },
        },
        {
          method: 'DELETE',
          path: /^\/platform\/tenants\/[^/]+\/domain\/exception$/,
          reply: ({ path }) => {
            const id = tenantId(path);
            const d = structuredClone(w.domain[id] ?? tenantDomain(id));
            if (d.domain_claim) d.domain_claim.exception = false;
            for (const x of d.exceptions) if (x.revoked_at === null) Object.assign(x, { revoked_at: w.tick(), revoked_by_user_id: OPERATOR_ID });
            w.domain[id] = d;
            w.log.push(`revoke ${id}`);
            return ok(d);
          },
        },
        // ---- Sign Personal
        {
          path: /^\/platform\/personal-review$/,
          reply: () => {
            const r = personalReview();
            return ok({ ...r, items: r.items.map((i) => ({ ...i, state: w.personal[i.tenant_id] ?? i.state, restricted_until: i.tenant_id in w.personalUntil ? w.personalUntil[i.tenant_id] : i.restricted_until })) });
          },
        },
        {
          method: 'POST',
          path: /^\/platform\/tenants\/[^/]+\/personal\/[a-z-]+$/,
          reply: ({ path, body }) => {
            const id = tenantId(path);
            const action = path.split('/')[5]!;
            const to = action === 'restrict' ? 'restricted' : action === 'close' ? 'closed' : 'clear';
            w.personal[id] = to;
            w.personalUntil[id] = action === 'restrict' ? ((body as { until?: string }).until ?? null) : null;
            w.log.push(`${action} ${id} until=${String((body as { until?: string }).until ?? '')}`);
            return ok({ tenant_id: id, state: to, restricted_until: w.personalUntil[id] });
          },
        },
        // ---- skills
        {
          method: 'POST',
          path: /^\/platform\/skills\/[^/]+\/aliases$/,
          reply: ({ path, body }) => {
            const b = body as { alias: string; alias_type: string };
            w.log.push(`alias ${b.alias} -> ${tenantId(path)} (${b.alias_type})`);
            return ok({ id: 'al_new', skill_id: tenantId(path), alias: b.alias, normalized_alias: b.alias.toLowerCase(), alias_type: b.alias_type, status: 'active' }, 201);
          },
        },
        { path: /^\/platform\/skill-proposals$/, reply: ({ query }) => ok(proposals(query.get('status'), w.proposalStatus)) },
        { path: /^\/platform\/skill-proposals\/[^/]+$/, reply: ({ path }) => ok(proposal(tenantId(path), w.proposalStatus)) },
        {
          method: 'POST',
          path: /^\/platform\/skill-proposals\/[^/]+\/accept$/,
          reply: ({ path }) => {
            const id = tenantId(path);
            w.proposalStatus[id] = 'ACCEPTED';
            if (w.staleProposal === id) {
              w.log.push(`accept-409 ${id}`);
              return ok({ error: { code: 'SKILL_PROPOSAL_NOT_PENDING', message: 'Proposal is not pending' } }, 409);
            }
            w.log.push(`accept ${id}`);
            return ok(proposal(id, w.proposalStatus));
          },
        },
        // ---- matching
        ...matchingOverrides(w),
      ],
    };
  }
}

function matchingOverrides(w: World): NonNullable<MockOptions['overrides']> {
  let state = matchingPolicy() as ReturnType<typeof matchingPolicy>;
  return [
    { path: /^\/platform\/matching-policy$/, reply: () => ({ body: state }) },
    {
      method: 'POST',
      path: /^\/platform\/matching-policy\/versions$/,
      reply: ({ body }) => {
        const b = body as { evidence_thresholds: unknown; note?: string | null };
        const v = { ...state.versions[0]!, id: 'mpv_4', version_number: 4, status: 'DRAFT', evidence_thresholds: b.evidence_thresholds as never, note: b.note ?? null, activated_at: null, activated_by: null, retired_at: null };
        state = { ...state, versions: [v as never, ...state.versions] };
        w.log.push('matching draft v4');
        return { status: 201, body: v };
      },
    },
    {
      method: 'POST',
      path: /^\/platform\/matching-policy\/versions\/[^/]+\/activate$/,
      reply: ({ path }) => {
        const id = decodeURIComponent(path.split('/')[4]!);
        const versions = state.versions.map((v) => (v.id === id ? { ...v, status: 'ACTIVE' } : v.status === 'ACTIVE' ? { ...v, status: 'RETIRED' } : v));
        state = { active: (versions.find((v) => v.id === id) ?? null) as never, versions: versions as never };
        w.log.push(`matching activate ${id}`);
        return { body: versions.find((v) => v.id === id) };
      },
    },
  ];
}
