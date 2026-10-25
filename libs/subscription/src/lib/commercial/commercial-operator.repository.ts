import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';

import { CommercialAuditRepository } from './commercial-audit.repository.js';
import type { RosterEntry } from './commercial-approval-eligibility.js';
import { CommercialPolicyRepository } from './commercial-policy.repository.js';

// CCP-A3 — the LIVE platform-operator roster and the D9 attestation store.
//
// Roster (NC-4): roles and scopes are read inside the caller's subscription transaction
// with ONE raw cross-schema read of the identity RBAC tables — the same membership filter
// as the platform token's server-side resolution (libs/identity role.repository.ts
// findScopeKeysForUserInTenantAndSite: active membership, tenant-wide, active role) plus
// an active User. `FOR SHARE OF m, mr` holds the read membership and role-assignment rows
// until the transaction ends, so a concurrent revoke either committed first (and is seen)
// or waits for this approval to commit. No nx edge: SQL only, no @aramo/identity import
// (TD-A3-4). Only `platform:*` scopes count (the platform consumer filter).
//
// Attestation (D9; Charter §5.1 "required for every holder of a commercial role"): a
// user counts as a human for approval only with an ACTIVE CommercialOperatorAttestation.
// Rows are written by the governed paths that create commercial-role holders — the CCP-A9
// bootstrap command (method BOOTSTRAP, self), the A9 role-change grant apply and the A9
// platform-admin invite carrying a CCP role (method PLATFORM_OWNER, attested by a distinct
// platform_owner). TD-A3-3 is closed by those CCP-A9 paths.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
type Client = PrismaService | Tx;

export interface CommercialOperatorAttestationRow {
  id: string;
  user_id: string;
  human_ref_hash: string;
  statement_version: string;
  method: string;
  attested_by: string;
  attested_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}

/** A roster entry plus the id of the active attestation backing it. */
export interface LiveOperator extends RosterEntry {
  attestation_id: string | null;
}

const ROSTER_SQL = `
SELECT m.user_id::text AS user_id, r.key AS role_key, s.key AS scope_key
  FROM identity."UserTenantMembership" m
  JOIN identity."User" u ON u.id = m.user_id AND u.is_active
  JOIN identity."UserTenantMembershipRole" mr ON mr.membership_id = m.id
  JOIN identity."Role" r ON r.id = mr.role_id AND r.is_active
  LEFT JOIN identity."RoleScope" rs ON rs.role_id = r.id
  LEFT JOIN identity."Scope" s ON s.id = rs.scope_id
 WHERE m.tenant_id = $1::uuid AND m.is_active AND m.site_id IS NULL`;

export const D9_STATEMENT_VERSION = 'D9-v1';

@Injectable()
export class CommercialOperatorRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommercialAuditRepository,
    private readonly policies: CommercialPolicyRepository,
  ) {}

  /**
   * The live roster of the platform tenant (optionally only `user_ids`). Inside a
   * transaction pass `lock: true` to hold the read RBAC rows (FOR SHARE).
   */
  async readRoster(client: Client, platform_tenant_id: string, opts: { user_ids?: readonly string[]; lock?: boolean } = {}): Promise<LiveOperator[]> {
    const params: unknown[] = [platform_tenant_id];
    let sql = ROSTER_SQL;
    if (opts.user_ids !== undefined) {
      if (opts.user_ids.length === 0) return [];
      params.push([...opts.user_ids]);
      sql += ` AND m.user_id = ANY($2::uuid[])`;
    }
    if (opts.lock === true) sql += ` FOR SHARE OF m, mr`;
    const rows = await client.$queryRawUnsafe<Array<{ user_id: string; role_key: string; scope_key: string | null }>>(sql, ...params);
    const byUser = new Map<string, { roles: Set<string>; scopes: Set<string> }>();
    for (const row of rows) {
      const e = byUser.get(row.user_id) ?? { roles: new Set<string>(), scopes: new Set<string>() };
      e.roles.add(row.role_key);
      if (row.scope_key !== null && row.scope_key.startsWith('platform:')) e.scopes.add(row.scope_key);
      byUser.set(row.user_id, e);
    }
    const users = [...byUser.keys()];
    const attestations =
      users.length === 0
        ? []
        : await client.commercialOperatorAttestation.findMany({ where: { user_id: { in: users }, revoked_at: null }, select: { id: true, user_id: true } });
    const att = new Map(attestations.map((a) => [a.user_id, a.id]));
    return users.sort().map((user_id) => {
      const e = byUser.get(user_id) as { roles: Set<string>; scopes: Set<string> };
      return {
        user_id,
        attested: att.has(user_id),
        attestation_id: att.get(user_id) ?? null,
        role_keys: [...e.roles].sort(),
        scopes: [...e.scopes].sort(),
      };
    });
  }

  /** The live facts for one user (an empty entry when they hold no active platform role). */
  async readOperator(client: Client, platform_tenant_id: string, user_id: string, lock = false): Promise<LiveOperator> {
    const [entry] = await this.readRoster(client, platform_tenant_id, { user_ids: [user_id], lock });
    if (entry !== undefined) return entry;
    const a = await client.commercialOperatorAttestation.findFirst({ where: { user_id, revoked_at: null }, select: { id: true } });
    return { user_id, attested: a !== null, attestation_id: a?.id ?? null, role_keys: [], scopes: [] };
  }

  /** CCP-A9: the live facts for one user, read outside any caller transaction. */
  async readOperatorNow(platform_tenant_id: string, user_id: string): Promise<LiveOperator> {
    return this.readOperator(this.prisma, platform_tenant_id, user_id);
  }

  /** CCP-A9: true when `human_ref_hash` is already actively attested for some account (D9). */
  async isHumanRefActive(human_ref_hash: string): Promise<boolean> {
    return (await this.prisma.commercialOperatorAttestation.findFirst({ where: { human_ref_hash, revoked_at: null }, select: { id: true } })) !== null;
  }

  /**
   * Records an active D9 attestation and its audit event in one transaction. Called by the
   * CCP-A9 governed paths; not exposed over HTTP in A3. The partial unique indexes refuse a
   * second active attestation for the same account or the same human.
   */
  async recordAttestation(input: {
    user_id: string;
    human_ref_hash: string;
    method: 'BOOTSTRAP' | 'PLATFORM_OWNER';
    attested_by: string;
    attested_at: Date;
    correlation_id: string;
  }): Promise<CommercialOperatorAttestationRow> {
    const policy = await this.policies.getActivePolicy();
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.commercialOperatorAttestation.create({
        data: {
          id: uuidv7(),
          user_id: input.user_id,
          human_ref_hash: input.human_ref_hash,
          statement_version: D9_STATEMENT_VERSION,
          method: input.method,
          attested_by: input.attested_by,
          attested_at: input.attested_at,
        },
      });
      await this.audit.append(
        {
          actor: { id: input.attested_by, type: 'user', role_keys: [] },
          event_type: 'COMMERCIAL_OPERATOR_ATTESTATION_RECORDED',
          subject: `commercial_operator_attestation:${row.id}`,
          policy_version_id: policy.version_id,
          payload: { user_id: input.user_id, method: input.method, statement_version: D9_STATEMENT_VERSION },
          correlation_id: input.correlation_id,
        },
        tx,
      );
      return row as CommercialOperatorAttestationRow;
    });
  }

  /** Revokes the active attestation of `user_id` (once; the row stays as history). */
  async revokeAttestation(input: { user_id: string; revoked_by: string; reason: string; at: Date; correlation_id: string }): Promise<void> {
    const policy = await this.policies.getActivePolicy();
    await this.prisma.$transaction(async (tx) => {
      const active = await tx.commercialOperatorAttestation.findFirst({ where: { user_id: input.user_id, revoked_at: null } });
      if (active === null) return;
      await tx.commercialOperatorAttestation.update({
        where: { id: active.id },
        data: { revoked_at: input.at, revoked_by: input.revoked_by, revoke_reason: input.reason },
      });
      await this.audit.append(
        {
          actor: { id: input.revoked_by, type: 'user', role_keys: [] },
          event_type: 'COMMERCIAL_OPERATOR_ATTESTATION_REVOKED',
          subject: `commercial_operator_attestation:${active.id}`,
          policy_version_id: policy.version_id,
          payload: { user_id: input.user_id, reason: input.reason },
          correlation_id: input.correlation_id,
        },
        tx,
      );
    });
  }
}
