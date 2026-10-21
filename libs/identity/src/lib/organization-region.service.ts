import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';
import {
  AUTHORITY_STATEMENT_VERSION,
  BILLING_REGION_US,
  authorityStatementSha256,
} from './util/us-organization.js';

// Aramo-Sign-Signup-Federated-Owner Amendment A1 (LOCKED) §2.4 / §2.5 — the
// tenant's billing-region lock (V1: US) and the signer's authority attestation.
// The attestation is evidence of what the signer SAID (refinement A); it is not
// verified signing authority and never a legal-document acceptance.
@Injectable()
export class OrganizationRegionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Hold the tenant's organization profile to the US (idempotent). */
  async lockUs(tenant_id: string): Promise<void> {
    await this.prisma.tenantBillingRegionPolicy.createMany({
      data: [{ tenant_id, region: BILLING_REGION_US }],
      skipDuplicates: true,
    });
  }

  /** The region the tenant's profile is held to, or null (unrestricted). */
  async regionOf(tenant_id: string): Promise<string | null> {
    const row = await this.prisma.tenantBillingRegionPolicy.findUnique({ where: { tenant_id } });
    return row?.region ?? null;
  }

  /** Record the signer's attestation once per signup request (idempotent for a retried signup). */
  async recordAttestation(args: {
    tenant_id: string;
    signup_request_id: string | null;
    signer_email: string;
    signer_name: string;
    signer_title: string;
    organization_legal_name: string;
    ip: string | null;
    attested_at: Date;
  }): Promise<void> {
    if (args.signup_request_id !== null) {
      const existing = await this.prisma.organizationAuthorityAttestation.findUnique({
        where: { signup_request_id: args.signup_request_id },
      });
      if (existing !== null) return;
    }
    await this.prisma.organizationAuthorityAttestation.create({
      data: {
        id: uuidv7(),
        tenant_id: args.tenant_id,
        signup_request_id: args.signup_request_id,
        signer_email: args.signer_email,
        signer_name: args.signer_name,
        signer_title: args.signer_title,
        organization_legal_name: args.organization_legal_name,
        statement_version: AUTHORITY_STATEMENT_VERSION,
        statement_sha256: authorityStatementSha256(),
        ip: args.ip,
        attested_at: args.attested_at,
      },
    });
  }

  async attestationsFor(tenant_id: string): Promise<{ signer_email: string; signer_name: string; signer_title: string; organization_legal_name: string; statement_version: string; attested_at: Date }[]> {
    return this.prisma.organizationAuthorityAttestation.findMany({
      where: { tenant_id },
      orderBy: { attested_at: 'asc' },
      select: { signer_email: true, signer_name: true, signer_title: true, organization_legal_name: true, statement_version: true, attested_at: true },
    });
  }
}
