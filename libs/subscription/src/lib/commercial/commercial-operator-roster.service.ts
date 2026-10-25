import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

import { checkChainSatisfiable, type RosterEntry } from './commercial-approval-eligibility.js';
import { COMMERCIAL_ACTIONS, COMMERCIAL_ROLE_CHANGE_ROLE_KEYS, resolveRequiredChain, type CommercialActionType, type CommercialChainRule } from './commercial-change-request.js';
import { CommercialOperatorRepository, type LiveOperator } from './commercial-operator.repository.js';
import type { CommercialPolicyContent } from './commercial-policy.js';
import { CommercialPolicyRepository } from './commercial-policy.repository.js';
import { PLATFORM_OWNER_ROLE_KEY, effectivePlatformOwners } from './commercial-role-change.js';

// CCP-B5 (handoff §5.8 Platform admins › commercial roles, §3.2 bootstrap gate, §3.3 last
// owner; pre-execution C-6) — READ-ONLY: the live platform roster with the commercial roles,
// and whether each approval chain can be fulfilled by independent people right now.
//
// Fulfillable (handoff §3.2; A9 per-chain rule, never a user count): some human MAKER holds
// the chain's requester authority, and the chain's steps can be matched to DISTINCT attested
// humans other than that maker (the A3 bipartite gate, checkChainSatisfiable). The chain
// steps and the requester authority are the REAL ones (resolveRequiredChain and
// COMMERCIAL_ACTIONS against the ACTIVE policy), so the panel says exactly what the approve
// gate (409 CCP_NOT_BOOTSTRAPPED) would say. A governance maker (role-based requester) must
// also be attested, as at create (TD-A3-5).
//
// Nothing here grants or changes a role: role changes are ROLE_GRANT / ROLE_REVOKE change
// requests only (A9; PBD §5.3 B5 "no direct role grant").

export type CommercialChainKey = 'ABOVE_THRESHOLD' | 'BELOW_THRESHOLD' | 'CATALOG_PUBLISH' | 'ROLE_CHANGE' | 'POLICY_CHANGE';

/** The handoff §3 chains, each represented by a real action whose chain it is. */
export const COMMERCIAL_CHAIN_PANEL: ReadonlyArray<{ key: CommercialChainKey; actions: readonly CommercialActionType[]; sample: (p: CommercialPolicyContent) => Record<string, unknown> }> = [
  { key: 'ABOVE_THRESHOLD', actions: ['CREDIT', 'DISCOUNT'], sample: (p) => ({ amount_minor: p.credit_escalation_threshold_minor, currency: p.currency }) },
  { key: 'BELOW_THRESHOLD', actions: ['SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT', 'ENTITLEMENT_REVOKE', 'CONVERSION', 'SUPPORT_EXTENSION'], sample: () => ({}) },
  { key: 'CATALOG_PUBLISH', actions: ['PLAN_VERSION_PUBLISH', 'PLAN_RETIRE'], sample: () => ({}) },
  { key: 'ROLE_CHANGE', actions: ['ROLE_GRANT', 'ROLE_REVOKE'], sample: () => ({ subject_user_id: '00000000-0000-7000-8000-000000000000', role_key: 'read_only_auditor' }) },
  { key: 'POLICY_CHANGE', actions: ['POLICY_ACTIVATE'], sample: () => ({ policy_version_id: '00000000-0000-7000-8000-000000000000' }) },
];

export interface ChainFulfillability {
  key: CommercialChainKey;
  rule: CommercialChainRule;
  /** The roles that can make a request on this chain. */
  maker_roles: string[];
  /** The step roles, in order. */
  step_roles: string[];
  fulfillable: boolean;
  /** Why not: no eligible maker, or steps no distinct eligible human can take. */
  missing: 'maker' | 'steps' | null;
  unfillable_steps: number[];
}

export interface RosterOperatorView {
  user_id: string;
  email: string | null;
  display_name: string | null;
  role_keys: string[];
  commercial_role_keys: string[];
  attested: boolean;
  is_last_owner: boolean;
  pending_role_requests: Array<{ id: string; action_type: string; role_key: string; state: string }>;
}

export interface CommercialRosterView {
  operators: RosterOperatorView[];
  chains: ChainFulfillability[];
  all_fulfillable: boolean;
}

const COMMERCIAL_ROLES = new Set<string>(COMMERCIAL_ROLE_CHANGE_ROLE_KEYS);

/** True when `op` may request `action`: its requester scope, or (governance) its live role plus a D9 attestation. */
function canMake(op: RosterEntry, action: CommercialActionType): boolean {
  const def = COMMERCIAL_ACTIONS[action];
  if (def.requester_role !== null) return op.attested && op.role_keys.includes(def.requester_role);
  return def.requester_scope !== null && op.scopes.includes(def.requester_scope);
}

/** Pure: fulfillability of every panel chain over a live roster. */
export function chainFulfillability(roster: readonly RosterEntry[], policy: CommercialPolicyContent): ChainFulfillability[] {
  return COMMERCIAL_CHAIN_PANEL.map(({ key, actions, sample }) => {
    const action = actions[0] as CommercialActionType;
    const chain = resolveRequiredChain(action, sample(policy), policy);
    const makers = roster.filter((r) => actions.some((a) => canMake(r, a)));
    let best: number[] = chain.steps.map((s) => s.step_index);
    let ok = false;
    for (const m of makers) {
      const r = checkChainSatisfiable(chain.steps, roster, new Set([m.user_id]));
      if (r.satisfiable) {
        ok = true;
        best = [];
        break;
      }
      if (r.unfillable_steps.length < best.length) best = r.unfillable_steps;
    }
    return {
      key,
      rule: chain.rule,
      maker_roles: definedMakers(actions),
      step_roles: chain.steps.map((s) => s.role_key),
      fulfillable: ok,
      missing: ok ? null : makers.length === 0 ? 'maker' : 'steps',
      unfillable_steps: ok ? [] : best,
    };
  });
}

/** The CCP roles that hold an action's requester authority (A1 §4.1 + TD-A3-5), in catalog order. */
const MAKER_SCOPE_ROLES: Readonly<Record<string, readonly string[]>> = {
  'platform:billing:request': ['commercial_ops'],
  'platform:subscription:request': ['commercial_ops'],
  'platform:entitlement:request': ['commercial_ops'],
  'platform:subscription:support': ['support_admin'],
  'platform:catalog:draft': ['catalog_manager'],
};
function definedMakers(actions: readonly CommercialActionType[]): string[] {
  const out: string[] = [];
  for (const a of actions) {
    const d = COMMERCIAL_ACTIONS[a];
    const roles = d.requester_role !== null ? [d.requester_role] : (MAKER_SCOPE_ROLES[d.requester_scope ?? ''] ?? []);
    for (const r of roles) if (!out.includes(r)) out.push(r);
  }
  return out;
}

@Injectable()
export class CommercialOperatorRosterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operators: CommercialOperatorRepository,
    private readonly policies: CommercialPolicyRepository,
  ) {}

  async read(platform_tenant_id: string): Promise<CommercialRosterView> {
    const policy = await this.policies.getActivePolicy();
    const roster: LiveOperator[] = await this.operators.readRoster(this.prisma, platform_tenant_id);
    const ids = roster.map((r) => r.user_id);
    const users =
      ids.length === 0
        ? []
        : await this.prisma.$queryRawUnsafe<Array<{ id: string; email: string; display_name: string | null }>>(
            `SELECT id::text AS id, email, display_name FROM identity."User" WHERE id = ANY($1::uuid[])`,
            ids,
          );
    const byId = new Map(users.map((u) => [u.id, u]));
    const owners = await effectivePlatformOwners(this.prisma, platform_tenant_id);
    const pending = await this.prisma.commercialChangeRequest.findMany({
      where: { action_type: { in: ['ROLE_GRANT', 'ROLE_REVOKE'] }, state: { in: ['DRAFT', 'PENDING_APPROVAL'] } },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: { id: true, action_type: true, state: true, payload: true },
    });
    const operators = roster.map((r) => {
      const u = byId.get(r.user_id);
      return {
        user_id: r.user_id,
        email: u?.email ?? null,
        display_name: u?.display_name ?? null,
        role_keys: [...r.role_keys],
        commercial_role_keys: r.role_keys.filter((k) => COMMERCIAL_ROLES.has(k)),
        attested: r.attested,
        is_last_owner: owners.length === 1 && owners[0] === r.user_id && r.role_keys.includes(PLATFORM_OWNER_ROLE_KEY),
        pending_role_requests: pending
          .filter((p) => (p.payload as Record<string, unknown> | null)?.['subject_user_id'] === r.user_id)
          .map((p) => ({ id: p.id, action_type: p.action_type, role_key: String((p.payload as Record<string, unknown>)['role_key'] ?? ''), state: p.state })),
      };
    });
    const chains = chainFulfillability(roster, policy.content);
    return { operators, chains, all_fulfillable: chains.every((c) => c.fulfillable) };
  }
}
