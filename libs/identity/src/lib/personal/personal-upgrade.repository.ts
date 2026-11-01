import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { bumpPrincipalVersion } from '../authorization-version.ops.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AUTHORITY_STATEMENT_VERSION, BILLING_REGION_US, authorityStatementSha256 } from '../util/us-organization.js';

import { writePersonalAudit } from './personal-risk.service.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §5 "Related work" — the
// Personal → Business upgrade (recon: doc/backlog/sign-personal-to-business-upgrade-recon.md).
//
// The upgrade is IN PLACE: the same identity.Tenant row changes kind PERSONAL → BUSINESS,
// so every envelope, evidence row, ledger hash chain, custody object key
// (tenants/<tenant>/…) and retention setting keyed by the tenant id stays exactly as it
// is. This class performs the identity half in ONE transaction:
//   - compare-and-set the kind (only a PERSONAL row changes; a lost race changes nothing),
//     with the organization name and profile columns (Sign Signup A1 §2.2);
//   - the US billing-region lock and the signer's authority attestation (A1 §2.4 / §2.5);
//   - the Business owner roles (tenant_admin added beside tenant_owner — ROLES-1 PR-2 §6);
//   - the owner's authorization version bump (the roles changed);
//   - the audit event identity.tenant.upgraded_to_business.
// The orchestration (eligibility, terms, subscription) lives in apps/sign-service.

export const PERSONAL_UPGRADE_AUDIT_SOURCE = 'sign.personal_upgrade';
export const BUSINESS_OWNER_ROLE_KEYS = ['tenant_owner', 'tenant_admin'] as const;

export interface PersonalUpgradeInput {
  tenant_id: string;
  owner_user_id: string;
  membership_id: string;
  organization_name: string;
  // PROFILE_FIELDS keys only (the caller passes the validated US organization details).
  profile: Readonly<Record<string, string | null>>;
  attestation: {
    signer_email: string;
    signer_name: string;
    signer_title: string;
    organization_legal_name: string;
    ip: string | null;
  };
  // Role ids for BUSINESS_OWNER_ROLE_KEYS (resolved by the caller).
  owner_role_ids: readonly string[];
  // Evidence carried on the audit row.
  terms_ref: string;
  ended_subscription: { id: string; plan_key: string | null; source: string } | null;
  request_id: string;
  now: Date;
}

export type PersonalUpgradeOutcome =
  | { upgraded: true; previous_name: string; roles_added: number }
  // The row was not PERSONAL when the transaction ran (a concurrent upgrade won).
  | { upgraded: false };

@Injectable()
export class PersonalUpgradeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upgradeToBusiness(input: PersonalUpgradeInput): Promise<PersonalUpgradeOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.tenant.findUnique({ where: { id: input.tenant_id }, select: { name: true, kind: true } });
      if (before === null || before.kind !== 'PERSONAL') return { upgraded: false } as const;
      // Compare-and-set: only a row still PERSONAL changes.
      const flipped = await tx.tenant.updateMany({
        where: { id: input.tenant_id, kind: 'PERSONAL' },
        data: { kind: 'BUSINESS', name: input.organization_name, ...input.profile },
      });
      if (flipped.count !== 1) return { upgraded: false } as const;

      await tx.tenantBillingRegionPolicy.createMany({ data: [{ tenant_id: input.tenant_id, region: BILLING_REGION_US }], skipDuplicates: true });
      await tx.organizationAuthorityAttestation.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          signup_request_id: null,
          signer_email: input.attestation.signer_email,
          signer_name: input.attestation.signer_name,
          signer_title: input.attestation.signer_title,
          organization_legal_name: input.attestation.organization_legal_name,
          statement_version: AUTHORITY_STATEMENT_VERSION,
          statement_sha256: authorityStatementSha256(),
          ip: input.attestation.ip,
          attested_at: input.now,
        },
      });

      const have = await tx.userTenantMembershipRole.findMany({ where: { membership_id: input.membership_id }, select: { role_id: true } });
      const held = new Set(have.map((r) => r.role_id));
      const add = input.owner_role_ids.filter((id) => !held.has(id));
      if (add.length > 0) {
        await tx.userTenantMembershipRole.createMany({ data: add.map((role_id) => ({ id: uuidv7(), membership_id: input.membership_id, role_id })) });
        await bumpPrincipalVersion(tx, { tenant_id: input.tenant_id, principal_id: input.owner_user_id });
      }

      await writePersonalAudit(tx, {
        event_type: 'identity.tenant.upgraded_to_business',
        tenant_id: input.tenant_id,
        subject_id: input.tenant_id,
        actor_id: input.owner_user_id,
        payload: {
          source: PERSONAL_UPGRADE_AUDIT_SOURCE,
          from_kind: 'PERSONAL',
          to_kind: 'BUSINESS',
          previous_name: before.name,
          organization_name: input.organization_name,
          region: BILLING_REGION_US,
          roles: [...BUSINESS_OWNER_ROLE_KEYS],
          roles_added: add.length,
          terms_ref: input.terms_ref,
          ended_subscription_id: input.ended_subscription?.id ?? null,
          ended_subscription_plan_key: input.ended_subscription?.plan_key ?? null,
          ended_subscription_source: input.ended_subscription?.source ?? null,
          request_id: input.request_id,
        },
      });
      return { upgraded: true, previous_name: before.name, roles_added: add.length } as const;
    });
  }
}
