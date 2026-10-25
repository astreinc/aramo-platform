import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';

import {
  type CommercialPolicy,
  type CommercialPolicyContent,
  commercialPolicyChecksum,
  parseActiveCommercialPolicy,
  parseCommercialPolicyContent,
} from './commercial-policy.js';

// CCP-A2 — the store for subscription."CommercialPolicyVersion", cloned from
// MatchingPolicyRepository (libs/skills-taxonomy, scope:cip — the pattern is reused, never
// imported).
//
// A2 surface: read the ACTIVE policy through the fail-closed parser, list versions, and
// append a DRAFT under a transaction-scoped advisory lock (race-free version numbering,
// with its policy audit row in the same transaction). There is deliberately NO activation
// method: v1 is ACTIVE by migration seed, and activating any later version is a CCP-A3
// change request (Charter §7; Recon Report §1 C1).

export type CommercialPolicyStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';

export interface CommercialPolicyVersionRow {
  id: string;
  version_number: number;
  status: CommercialPolicyStatus;
  content: unknown;
  content_checksum: string;
  note: string | null;
  created_by: string | null;
  created_at: Date;
  activated_by: string | null;
  activated_at: Date | null;
  retired_at: Date | null;
}

export interface CommercialPolicyActor {
  id: string | null;
  type: 'user' | 'system';
}

// One lock key for every policy write (hashtext of a fixed name).
const POLICY_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('subscription.commercial_policy'))`;

@Injectable()
export class CommercialPolicyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getActiveRow(): Promise<CommercialPolicyVersionRow | null> {
    const row = await this.prisma.commercialPolicyVersion.findFirst({ where: { status: 'ACTIVE' } });
    return row as CommercialPolicyVersionRow | null;
  }

  /**
   * The ACTIVE policy, parsed strictly. Throws CommercialPolicyUnavailableError when no
   * version is ACTIVE, the content is malformed, or the checksum does not match: no
   * commercial decision proceeds on a missing or broken policy (fail closed).
   */
  async getActivePolicy(): Promise<CommercialPolicy> {
    return parseActiveCommercialPolicy(await this.getActiveRow());
  }

  // Newest first.
  async listVersions(): Promise<CommercialPolicyVersionRow[]> {
    const rows = await this.prisma.commercialPolicyVersion.findMany({ orderBy: { version_number: 'desc' } });
    return rows as CommercialPolicyVersionRow[];
  }

  /**
   * Appends a DRAFT with the next version number (taken under the advisory lock). The
   * content must pass the strict parser; the checksum is computed here. Never changes
   * the ACTIVE version. Not exposed over HTTP in A2.
   */
  async createDraftVersion(input: {
    content: CommercialPolicyContent;
    note?: string | null;
    actor?: CommercialPolicyActor;
  }): Promise<CommercialPolicyVersionRow> {
    const content = parseCommercialPolicyContent(input.content);
    const checksum = commercialPolicyChecksum(content);
    const actorId = input.actor?.id ?? null;
    const actorType = input.actor?.type ?? 'system';
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(POLICY_LOCK_SQL);
      const latest = await tx.commercialPolicyVersion.aggregate({ _max: { version_number: true } });
      const versionNumber = (latest._max.version_number ?? 0) + 1;
      const id = uuidv7();
      const row = await tx.commercialPolicyVersion.create({
        data: {
          id,
          version_number: versionNumber,
          status: 'DRAFT',
          content: content as object,
          content_checksum: checksum,
          note: input.note ?? null,
          created_by: actorId,
        },
      });
      await tx.commercialPolicyAuditEvent.create({
        data: {
          id: uuidv7(),
          actor_id: actorId,
          actor_type: actorType,
          event_type: 'COMMERCIAL_POLICY_VERSION_CREATED',
          subject_id: id,
          event_payload: { version_number: versionNumber, content_checksum: checksum, content: content as object, note: input.note ?? null },
        },
      });
      return row as CommercialPolicyVersionRow;
    });
  }
}
