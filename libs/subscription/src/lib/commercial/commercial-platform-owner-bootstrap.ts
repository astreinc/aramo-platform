import { v7 as uuidv7 } from 'uuid';

import type { PrismaService } from '../prisma/prisma.service.js';

import { CommercialPolicyRepository } from './commercial-policy.repository.js';
import { D9_STATEMENT_VERSION } from './commercial-operator.repository.js';
import { PLATFORM_OWNER_ROLE_KEY, deterministicMembershipRoleId, effectivePlatformOwners, grantPlatformRole } from './commercial-role-change.js';

// CCP-A9 — the D7 platform-owner bootstrap command (T2-F1-H3 Amendment A1 A1-2; Inc-1
// Closure Amendment A1 A1-3(b)). It is the ONLY non-governed path that grants a platform
// role, and it is one-shot:
//
//   (1) Outside the protected seed files: nothing here is imported by seed.ts,
//       seed-platform-owner.ts or seed-astre.ts, and deploy/seed-prod.sh never invokes it.
//   (2) One target, one role: the target is resolved as the single user satisfying the
//       T2-F1-H3 :28 relationship (email purush@aramo.ai, membership in the Aramo Platform
//       sentinel tenant, holding super_admin). It grants exactly platform_owner on that
//       existing membership. It takes NO user, email, tenant or role argument; it creates no
//       user, membership, tenant, credential or Cognito object.
//   (3) One-time: it refuses once any active platform_owner exists who is not the target,
//       and once a bootstrap grant event exists. Target already platform_owner → success, no
//       write.
//   (4) Idempotent: a re-run writes nothing. The membership-role row has a deterministic id
//       and `ON CONFLICT DO NOTHING` (`update: {}` semantics, :31).
//   (5) Audited: exactly one CommercialAuditEvent, is_exception = true, kind BOOTSTRAP
//       (granted_source MIGRATION), with the target user id, the role, the executing host
//       context and the PO authorization reference. DB backstops: one BOOTSTRAP attestation
//       ever, one bootstrap event ever (subscription migration 20261025180100).
//   (6) It also writes the operator's D9 attestation (method BOOTSTRAP, self), closing
//       TD-A3-3 for the first operator.
//   (7) Production execution is a production write: separately PO-authorized (A1-2(7)).

/** T2-F1-H3 :28 — the bound operator. Fixed: never an argument (A1-2(2)). */
export const BOOTSTRAP_TARGET_EMAIL = 'purush@aramo.ai';
/** The Aramo Platform sentinel tenant (libs/auth PLATFORM_TENANT_SENTINEL_ID; pinned by the A9 spec). */
export const BOOTSTRAP_PLATFORM_TENANT_ID = '01900000-0000-7000-8000-000000000100';
export const PLATFORM_OWNER_BOOTSTRAP_EVENT = 'COMMERCIAL_PLATFORM_OWNER_BOOTSTRAPPED';

export type PlatformOwnerBootstrapRefusal =
  | 'TARGET_NOT_FOUND'
  | 'TARGET_AMBIGUOUS'
  | 'TARGET_INACTIVE'
  | 'ALREADY_BOOTSTRAPPED'
  | 'OTHER_PLATFORM_OWNER_EXISTS'
  | 'HUMAN_REF_IN_USE'
  | 'INVALID_ARGUMENT';

export class PlatformOwnerBootstrapRefusedError extends Error {
  constructor(
    readonly refusal: PlatformOwnerBootstrapRefusal,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(`platform-owner bootstrap refused (${refusal})`);
    this.name = 'PlatformOwnerBootstrapRefusedError';
  }
}

export interface PlatformOwnerBootstrapInput {
  /** The PO authorization reference for this execution (recorded, never interpreted). */
  po_authorization_ref: string;
  /** D9: SHA-256 hex of the operator's attested human reference (no PII). */
  human_ref_hash: string;
  /** The executing principal or host context (recorded). */
  executed_by: string;
  correlation_id: string;
  now?: Date;
}

export type PlatformOwnerBootstrapResult =
  | { outcome: 'GRANTED'; user_id: string; membership_role_id: string; attestation_id: string; audit_event_id: string }
  | { outcome: 'NOOP_ALREADY_GRANTED'; user_id: string };

const SHA256_HEX = /^[0-9a-f]{64}$/;

export async function runPlatformOwnerBootstrap(prisma: PrismaService, input: PlatformOwnerBootstrapInput): Promise<PlatformOwnerBootstrapResult> {
  if (typeof input.po_authorization_ref !== 'string' || input.po_authorization_ref.trim().length < 3 || input.po_authorization_ref.length > 500) {
    throw new PlatformOwnerBootstrapRefusedError('INVALID_ARGUMENT', { argument: 'po_authorization_ref' });
  }
  if (typeof input.human_ref_hash !== 'string' || !SHA256_HEX.test(input.human_ref_hash)) {
    throw new PlatformOwnerBootstrapRefusedError('INVALID_ARGUMENT', { argument: 'human_ref_hash' });
  }
  // A1-2(5): no ACTIVE commercial policy → the audit stream cannot record the event: fail closed.
  const policy = await new CommercialPolicyRepository(prisma).getActivePolicy();
  const now = input.now ?? new Date();
  const T = BOOTSTRAP_PLATFORM_TENANT_ID;

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('ccp:bootstrap:platform_owner', 0))`;
      const targets = await tx.$queryRawUnsafe<Array<{ user_id: string; user_active: boolean; membership_active: boolean }>>(
        `SELECT DISTINCT u.id::text AS user_id, u.is_active AS user_active, m.is_active AS membership_active
           FROM identity."User" u
           JOIN identity."UserTenantMembership" m ON m.user_id = u.id
           JOIN identity."UserTenantMembershipRole" mr ON mr.membership_id = m.id
           JOIN identity."Role" r ON r.id = mr.role_id
          WHERE u.email = $1 AND m.tenant_id = $2::uuid AND r.key = 'super_admin'`,
        BOOTSTRAP_TARGET_EMAIL,
        T,
      );
      if (targets.length === 0) throw new PlatformOwnerBootstrapRefusedError('TARGET_NOT_FOUND');
      if (targets.length > 1) throw new PlatformOwnerBootstrapRefusedError('TARGET_AMBIGUOUS', { holders: targets.length });
      const target = targets[0] as { user_id: string; user_active: boolean; membership_active: boolean };
      if (!target.user_active || !target.membership_active) throw new PlatformOwnerBootstrapRefusedError('TARGET_INACTIVE', { user_id: target.user_id });

      const owners = await effectivePlatformOwners(tx, T);
      if (owners.includes(target.user_id)) return { outcome: 'NOOP_ALREADY_GRANTED' as const, user_id: target.user_id };

      const prior = await tx.commercialAuditEvent.count({ where: { event_type: PLATFORM_OWNER_BOOTSTRAP_EVENT } });
      if (prior > 0) throw new PlatformOwnerBootstrapRefusedError('ALREADY_BOOTSTRAPPED', { prior_events: prior });
      const others = owners.filter((u) => u !== target.user_id);
      if (others.length > 0) throw new PlatformOwnerBootstrapRefusedError('OTHER_PLATFORM_OWNER_EXISTS', { holders: others.length });

      const membership = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM identity."UserTenantMembership" WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
        target.user_id,
        T,
      );
      const membership_id = (membership[0] as { id: string }).id;
      const { membership_role_id } = await grantPlatformRole(tx, T, {
        user_id: target.user_id,
        role_key: PLATFORM_OWNER_ROLE_KEY,
        id: deterministicMembershipRoleId(`ccp-a9:bootstrap:${membership_id}:${PLATFORM_OWNER_ROLE_KEY}`),
      });

      // D9 (method BOOTSTRAP, self). An active attestation of the target is reused.
      const active = await tx.commercialOperatorAttestation.findFirst({ where: { user_id: target.user_id, revoked_at: null }, select: { id: true } });
      let attestation_id = active?.id ?? null;
      if (attestation_id === null) {
        const used = await tx.commercialOperatorAttestation.findFirst({ where: { human_ref_hash: input.human_ref_hash, revoked_at: null }, select: { id: true } });
        if (used !== null) throw new PlatformOwnerBootstrapRefusedError('HUMAN_REF_IN_USE');
        const a = await tx.commercialOperatorAttestation.create({
          data: {
            id: uuidv7(),
            user_id: target.user_id,
            human_ref_hash: input.human_ref_hash,
            statement_version: D9_STATEMENT_VERSION,
            method: 'BOOTSTRAP',
            attested_by: target.user_id,
            attested_at: now,
          },
        });
        attestation_id = a.id;
      }

      const audit_event_id = uuidv7();
      await tx.commercialAuditEvent.create({
        data: {
          id: audit_event_id,
          actor_id: null,
          actor_type: 'system',
          actor_role_keys: [],
          event_type: PLATFORM_OWNER_BOOTSTRAP_EVENT,
          is_exception: true,
          tenant_id: null,
          subject: `platform_operator:${target.user_id}`,
          policy_version_id: policy.version_id,
          payload: {
            exception_kind: 'BOOTSTRAP',
            granted_source: 'MIGRATION',
            target_user_id: target.user_id,
            role_granted: PLATFORM_OWNER_ROLE_KEY,
            membership_id,
            membership_role_id,
            attestation_id,
            executed_by: input.executed_by,
            po_authorization_ref: input.po_authorization_ref,
            instrument: 'Aramo-T2-F1-H3-Production-Platform-Owner-Bootstrap-Directive-Amendment-A1-CCP-Confirmation-v1_0 A1-2',
          },
          correlation_id: input.correlation_id,
          created_at: now,
        },
      });
      return { outcome: 'GRANTED' as const, user_id: target.user_id, membership_role_id, attestation_id, audit_event_id };
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}

// ---- CLI argument contract (A1-2(2): no redirecting argument) ----------------------------

/** The only flags the command accepts. Anything else — a user, email, tenant or role — is refused. */
export const BOOTSTRAP_CLI_FLAGS = ['--po-authorization-ref', '--human-ref-hash'] as const;

export function parseBootstrapArgs(argv: readonly string[]): { po_authorization_ref: string; human_ref_hash: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!(BOOTSTRAP_CLI_FLAGS as readonly string[]).includes(flag)) {
      throw new PlatformOwnerBootstrapRefusedError('INVALID_ARGUMENT', { unknown_argument: flag, accepted: [...BOOTSTRAP_CLI_FLAGS] });
    }
    if (values.has(flag)) throw new PlatformOwnerBootstrapRefusedError('INVALID_ARGUMENT', { duplicate_argument: flag });
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      value = argv[i + 1];
      i += 1;
    }
    if (value === undefined || value.length === 0) throw new PlatformOwnerBootstrapRefusedError('INVALID_ARGUMENT', { missing_value: flag });
    values.set(flag, value);
  }
  const po = values.get('--po-authorization-ref');
  const human = values.get('--human-ref-hash');
  if (po === undefined) throw new PlatformOwnerBootstrapRefusedError('INVALID_ARGUMENT', { missing_argument: '--po-authorization-ref' });
  if (human === undefined) throw new PlatformOwnerBootstrapRefusedError('INVALID_ARGUMENT', { missing_argument: '--human-ref-hash' });
  return { po_authorization_ref: po, human_ref_hash: human };
}
