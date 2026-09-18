import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';

// SkillRepository — low-level persistence for the canonical Skill registry
// (SKILL-TAX-1A). Owns the Prisma client, app-side uuidv7 identity generation,
// and the append-only SkillAuditEvent write. Every mutation writes its audit
// row in the SAME transaction as the skill mutation (atomic: no skill change
// without its audit event, and none if the mutation rolls back).
//
// Cross-schema rule (Architecture §7.3): all *_id columns are plain UUIDs with
// no FK. Platform-global: no tenant_id on Skill; audit rows carry tenant_id =
// NULL for platform-global mutations.
//
// This repository does NOT normalize input or translate DB errors — that is the
// SkillRegistryService's job. It receives already-normalized values.

export type SkillStatus = 'active' | 'inactive';

// 1A emits only the first three; the full closed set is authorized by the
// SKILL-TAX-1 ruling and enforced by the DB CHECK for later phases.
export type SkillAuditEventType =
  | 'SKILL_CREATED'
  | 'SKILL_UPDATED'
  | 'SKILL_DEACTIVATED'
  | 'SKILL_MERGED'
  | 'ALIAS_ADDED'
  | 'ALIAS_REMOVED'
  | 'VERSION_ADDED'
  | 'VERSION_UPDATED'
  | 'RELATIONSHIP_ADDED'
  | 'RELATIONSHIP_REMOVED'
  | 'CANONICALIZATION_OVERRIDDEN';

export interface SkillRow {
  id: string;
  canonical_name: string;
  normalized_name: string;
  description: string | null;
  status: SkillStatus;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
  // SKILL-TAX-1F — set on the LOSER of a soft merge (winner id); NULL otherwise.
  merged_into_skill_id: string | null;
}

export interface SkillActor {
  id?: string | null;
  type?: string;
}

export interface CreateSkillPersistInput {
  canonical_name: string;
  normalized_name: string;
  description: string | null;
  actor?: SkillActor;
}

export interface UpdateSkillPersistInput {
  canonical_name?: string;
  normalized_name?: string;
  description?: string | null;
  actor?: SkillActor;
}

function resolveActor(actor?: SkillActor): { actorId: string | null; actorType: string } {
  return { actorId: actor?.id ?? null, actorType: actor?.type ?? 'system' };
}

@Injectable()
export class SkillRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createSkill(input: CreateSkillPersistInput): Promise<SkillRow> {
    const id = uuidv7();
    const { actorId, actorType } = resolveActor(input.actor);
    const [skill] = await this.prisma.$transaction([
      this.prisma.skill.create({
        data: {
          id,
          canonical_name: input.canonical_name,
          normalized_name: input.normalized_name,
          description: input.description,
          status: 'active',
          created_by: actorId,
          updated_by: actorId,
        },
      }),
      this.prisma.skillAuditEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: null,
          actor_id: actorId,
          actor_type: actorType,
          event_type: 'SKILL_CREATED' satisfies SkillAuditEventType,
          subject_id: id,
          event_payload: {
            canonical_name: input.canonical_name,
            normalized_name: input.normalized_name,
            description: input.description,
            status: 'active',
          },
        },
      }),
    ]);
    return skill as SkillRow;
  }

  async updateSkill(id: string, input: UpdateSkillPersistInput): Promise<SkillRow> {
    const { actorId, actorType } = resolveActor(input.actor);
    // JSON-safe change set: every value is string | null (audit-serialisable).
    const data: Record<string, string | null> = { updated_by: actorId };
    if (input.canonical_name !== undefined) data['canonical_name'] = input.canonical_name;
    if (input.normalized_name !== undefined) data['normalized_name'] = input.normalized_name;
    if (input.description !== undefined) data['description'] = input.description;

    const [skill] = await this.prisma.$transaction([
      this.prisma.skill.update({ where: { id }, data }),
      this.prisma.skillAuditEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: null,
          actor_id: actorId,
          actor_type: actorType,
          event_type: 'SKILL_UPDATED' satisfies SkillAuditEventType,
          subject_id: id,
          event_payload: { changed: data },
        },
      }),
    ]);
    return skill as SkillRow;
  }

  async deactivateSkill(id: string, actor?: SkillActor): Promise<SkillRow> {
    return this.transitionStatus(id, 'inactive', 'SKILL_DEACTIVATED', actor);
  }

  // Reactivation is modeled as an UPDATE in 1A (Ruling #2): it emits
  // SKILL_UPDATED, not a distinct event type.
  async reactivateSkill(id: string, actor?: SkillActor): Promise<SkillRow> {
    return this.transitionStatus(id, 'active', 'SKILL_UPDATED', actor);
  }

  private async transitionStatus(
    id: string,
    status: SkillStatus,
    eventType: SkillAuditEventType,
    actor?: SkillActor,
  ): Promise<SkillRow> {
    const { actorId, actorType } = resolveActor(actor);
    const [skill] = await this.prisma.$transaction([
      this.prisma.skill.update({ where: { id }, data: { status, updated_by: actorId } }),
      this.prisma.skillAuditEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: null,
          actor_id: actorId,
          actor_type: actorType,
          event_type: eventType,
          subject_id: id,
          event_payload: { status },
        },
      }),
    ]);
    return skill as SkillRow;
  }

  // SKILL-TAX-1F — SOFT merge. The loser keeps its id (permanently addressable),
  // goes status='inactive', and points at the winner via merged_into_skill_id. The
  // loser is NEVER hard-deleted and source evidence is NEVER re-keyed here (targeted
  // canonical_skill_id repointing is a separate, domain-owned correction step run by
  // the correction processor). Emits SKILL_MERGED against the loser. Caller
  // guarantees loser != winner and both exist (SkillRegistryService validates).
  //
  // SKILL-TAX-1F-B1 — the SkillCorrectionTask(PENDING) is created in the SAME
  // transaction as the mutation + audit (Gate-6 ruling): a committed merge always
  // leaves a durable record of the downstream repoint/reconcile it owes, with no
  // window where canonical truth changes but no recovery work exists.
  async mergeSkill(loserId: string, winnerId: string, actor?: SkillActor): Promise<SkillRow> {
    const { actorId, actorType } = resolveActor(actor);
    const [loser] = await this.prisma.$transaction([
      this.prisma.skill.update({
        where: { id: loserId },
        data: { status: 'inactive', merged_into_skill_id: winnerId, updated_by: actorId },
      }),
      this.prisma.skillAuditEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: null,
          actor_id: actorId,
          actor_type: actorType,
          event_type: 'SKILL_MERGED' satisfies SkillAuditEventType,
          subject_id: loserId,
          event_payload: { merged_into_skill_id: winnerId, status: 'inactive' },
        },
      }),
      this.prisma.skillCorrectionTask.create({
        data: {
          id: uuidv7(),
          correction_type: 'SKILL_MERGE',
          from_canonical_skill_id: loserId,
          to_canonical_skill_id: winnerId,
          surface_form: null,
          status: 'PENDING',
        },
      }),
    ]);
    return loser as SkillRow;
  }

  // SKILL-TAX-1F — record an explicit human canonicalization correction/override
  // against a subject Skill (Ruling 6). Append-only audit ONLY; the actual mapping
  // change (add alias, merge, etc.) is performed by its own governed method — this
  // records WHY/who for the governance ledger. payload must be JSON-safe.
  async recordCanonicalizationOverride(input: {
    subjectId: string;
    actor?: SkillActor;
    payload: Record<string, string | null>;
  }): Promise<void> {
    const { actorId, actorType } = resolveActor(input.actor);
    await this.prisma.skillAuditEvent.create({
      data: {
        id: uuidv7(),
        tenant_id: null,
        actor_id: actorId,
        actor_type: actorType,
        event_type: 'CANONICALIZATION_OVERRIDDEN' satisfies SkillAuditEventType,
        subject_id: input.subjectId,
        event_payload: input.payload,
      },
    });
  }

  async findById(id: string): Promise<SkillRow | null> {
    const row = await this.prisma.skill.findUnique({ where: { id } });
    return (row as SkillRow | null) ?? null;
  }

  async findByNormalizedName(normalizedName: string): Promise<SkillRow | null> {
    const row = await this.prisma.skill.findUnique({
      where: { normalized_name: normalizedName },
    });
    return (row as SkillRow | null) ?? null;
  }

  async listSkills(opts?: { includeInactive?: boolean }): Promise<SkillRow[]> {
    const where = opts?.includeInactive ? {} : { status: 'active' };
    const rows = await this.prisma.skill.findMany({
      where,
      orderBy: { canonical_name: 'asc' },
    });
    return rows as SkillRow[];
  }

  async countAuditEvents(subjectId: string): Promise<number> {
    return this.prisma.skillAuditEvent.count({ where: { subject_id: subjectId } });
  }

  async listAuditEvents(
    subjectId: string,
  ): Promise<Array<{ event_type: string; actor_id: string | null; actor_type: string; event_payload: unknown }>> {
    const rows = await this.prisma.skillAuditEvent.findMany({
      where: { subject_id: subjectId },
      orderBy: { created_at: 'asc' },
    });
    return rows.map((r) => ({
      event_type: r.event_type,
      actor_id: r.actor_id,
      actor_type: r.actor_type,
      event_payload: r.event_payload,
    }));
  }
}
