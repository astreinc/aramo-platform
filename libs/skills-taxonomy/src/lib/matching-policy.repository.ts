import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';
import type { SkillActor } from './skill.repository.js';

// ATI-SEP-1 Addendum A2 ruling A-c (P1) — MatchingPolicyRepository, the store for the
// platform-owned matching calibration (skills_taxonomy."MatchingPolicyVersion").
//
// Versioned + append-only: createVersion appends a DRAFT with the next version number;
// activateVersion retires the current ACTIVE version and activates the target in ONE
// transaction (exactly one ACTIVE — partial unique index). Every change writes its
// MatchingPolicyAuditEvent in the same transaction. Both writes serialize on a
// transaction-scoped advisory lock so version numbering and the one-ACTIVE swap are
// race-free. A version's content is immutable at the DB (trigger).
//
// The evidence_thresholds document is OPAQUE here (a JSON object): its shape belongs to
// libs/matching (parseEvidenceThresholds), which the apps/api boundary applies before a
// write and after a read. This lib never imports libs/matching.

export type MatchingPolicyStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';

export interface MatchingPolicyVersionRow {
  id: string;
  version_number: number;
  status: MatchingPolicyStatus;
  evidence_thresholds: unknown;
  note: string | null;
  created_by: string | null;
  created_at: Date;
  activated_by: string | null;
  activated_at: Date | null;
  retired_at: Date | null;
}

export interface CreateMatchingPolicyVersionInput {
  evidence_thresholds: Record<string, unknown>;
  note?: string | null;
  actor?: SkillActor;
}

export class MatchingPolicyVersionNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Matching policy version not found: ${id}`);
    this.name = 'MatchingPolicyVersionNotFoundError';
  }
}

// One lock key for every policy write (hashtext of a fixed name).
const POLICY_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('skills_taxonomy.matching_policy'))`;

function resolveActor(actor?: SkillActor): { actorId: string | null; actorType: string } {
  return { actorId: actor?.id ?? null, actorType: actor?.type ?? 'system' };
}

@Injectable()
export class MatchingPolicyRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Newest first (version_number desc).
  async listVersions(): Promise<MatchingPolicyVersionRow[]> {
    const rows = await this.prisma.matchingPolicyVersion.findMany({
      orderBy: { version_number: 'desc' },
    });
    return rows as MatchingPolicyVersionRow[];
  }

  async getActive(): Promise<MatchingPolicyVersionRow | null> {
    const row = await this.prisma.matchingPolicyVersion.findFirst({ where: { status: 'ACTIVE' } });
    return row as MatchingPolicyVersionRow | null;
  }

  async getById(id: string): Promise<MatchingPolicyVersionRow | null> {
    const row = await this.prisma.matchingPolicyVersion.findUnique({ where: { id } });
    return row as MatchingPolicyVersionRow | null;
  }

  // Appends a DRAFT version (next version_number). Never changes the ACTIVE version.
  async createVersion(input: CreateMatchingPolicyVersionInput): Promise<MatchingPolicyVersionRow> {
    const { actorId, actorType } = resolveActor(input.actor);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(POLICY_LOCK_SQL);
      const latest = await tx.matchingPolicyVersion.aggregate({ _max: { version_number: true } });
      const versionNumber = (latest._max.version_number ?? 0) + 1;
      const id = uuidv7();
      const row = await tx.matchingPolicyVersion.create({
        data: {
          id,
          version_number: versionNumber,
          status: 'DRAFT',
          evidence_thresholds: input.evidence_thresholds as object,
          note: input.note ?? null,
          created_by: actorId,
        },
      });
      await tx.matchingPolicyAuditEvent.create({
        data: {
          id: uuidv7(),
          actor_id: actorId,
          actor_type: actorType,
          event_type: 'MATCHING_POLICY_VERSION_CREATED',
          subject_id: id,
          event_payload: {
            version_number: versionNumber,
            evidence_thresholds: input.evidence_thresholds as object,
            note: input.note ?? null,
          },
        },
      });
      return row as MatchingPolicyVersionRow;
    });
  }

  // Makes the target the ONE ACTIVE version: the current ACTIVE version (if any) is
  // RETIRED first, then the target (DRAFT or RETIRED — re-activating a RETIRED version
  // is the rollback path) becomes ACTIVE. Activating the version that is already ACTIVE
  // is a no-op (no write, no audit) and returns it unchanged.
  async activateVersion(
    id: string,
    actor?: SkillActor,
  ): Promise<{ row: MatchingPolicyVersionRow; changed: boolean }> {
    const { actorId, actorType } = resolveActor(actor);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(POLICY_LOCK_SQL);
      const target = await tx.matchingPolicyVersion.findUnique({ where: { id } });
      if (target === null) throw new MatchingPolicyVersionNotFoundError(id);
      if (target.status === 'ACTIVE') {
        return { row: target as MatchingPolicyVersionRow, changed: false };
      }
      const now = new Date();
      const previous = await tx.matchingPolicyVersion.findFirst({ where: { status: 'ACTIVE' } });
      if (previous !== null) {
        await tx.matchingPolicyVersion.update({
          where: { id: previous.id },
          data: { status: 'RETIRED', retired_at: now },
        });
      }
      const row = await tx.matchingPolicyVersion.update({
        where: { id },
        data: { status: 'ACTIVE', activated_by: actorId, activated_at: now, retired_at: null },
      });
      await tx.matchingPolicyAuditEvent.create({
        data: {
          id: uuidv7(),
          actor_id: actorId,
          actor_type: actorType,
          event_type: 'MATCHING_POLICY_VERSION_ACTIVATED',
          subject_id: id,
          event_payload: {
            version_number: target.version_number,
            previous_active_version_id: previous?.id ?? null,
            previous_active_version_number: previous?.version_number ?? null,
          },
        },
      });
      return { row: row as MatchingPolicyVersionRow, changed: true };
    });
  }
}
