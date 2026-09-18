import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';
import type { SkillActor } from './skill.repository.js';
import type {
  RelationshipDirectionality,
  SkillRelationshipSource,
  SkillRelationshipType,
} from './relationship-vocab.js';

// SkillRelationshipRepository — governed canonical-to-canonical edges
// (SKILL-TAX-1C). Every mutation writes its SkillAuditEvent (subject_id =
// source_skill_id). Removal is a SOFT status flip, never a delete.

export interface SkillRelationshipRow {
  id: string;
  source_skill_id: string;
  target_skill_id: string;
  relationship_type: SkillRelationshipType;
  directionality: RelationshipDirectionality;
  status: 'active' | 'inactive';
  source: SkillRelationshipSource;
  source_ref: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
}

export interface AddRelationshipPersistInput {
  source_skill_id: string;
  target_skill_id: string;
  relationship_type: SkillRelationshipType;
  directionality: RelationshipDirectionality;
  source: SkillRelationshipSource;
  source_ref?: string | null;
  actor?: SkillActor;
}

function resolveActor(actor?: SkillActor): { actorId: string | null; actorType: string } {
  return { actorId: actor?.id ?? null, actorType: actor?.type ?? 'system' };
}

// SKILL-TAX-1F-B2 — the narrow transaction-client surface addRelationshipWithin needs.
// A Prisma interactive-transaction client satisfies it structurally, so
// SkillGovernanceService can run addRelationshipWithin INSIDE the proposal-accept
// transaction. Relationships emit NO correction task (a taxonomy edge never alters
// canonical identity, per the 1F-B2 correction-task matrix) — only the edge + audit.
export type SkillRelationshipTxClient = Pick<
  PrismaService,
  'skillRelationship' | 'skillAuditEvent'
>;

@Injectable()
export class SkillRelationshipRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Public entry — its own transaction. Delegates to the composable primitive.
  async addRelationship(input: AddRelationshipPersistInput): Promise<SkillRelationshipRow> {
    return this.prisma.$transaction((tx) => this.addRelationshipWithin(tx, input));
  }

  // SKILL-TAX-1F-B2 — the composable canonical write: edge row + RELATIONSHIP_ADDED
  // audit, on the CALLER'S transaction client. Same canonical governance logic whether
  // invoked by addRelationship or by proposal acceptance — no duplicate writer. Emits
  // NO SkillCorrectionTask: relationships are taxonomy intelligence and never change
  // canonical identity of stored evidence (1F-B2 matrix).
  async addRelationshipWithin(
    tx: SkillRelationshipTxClient,
    input: AddRelationshipPersistInput,
  ): Promise<SkillRelationshipRow> {
    const id = uuidv7();
    const { actorId, actorType } = resolveActor(input.actor);
    const rel = await tx.skillRelationship.create({
      data: {
        id,
        source_skill_id: input.source_skill_id,
        target_skill_id: input.target_skill_id,
        relationship_type: input.relationship_type,
        directionality: input.directionality,
        status: 'active',
        source: input.source,
        source_ref: input.source_ref ?? null,
        created_by: actorId,
        updated_by: actorId,
      },
    });
    await tx.skillAuditEvent.create({
      data: {
        id: uuidv7(),
        tenant_id: null,
        actor_id: actorId,
        actor_type: actorType,
        event_type: 'RELATIONSHIP_ADDED',
        subject_id: input.source_skill_id,
        event_payload: {
          relationship_id: id,
          target_skill_id: input.target_skill_id,
          relationship_type: input.relationship_type,
          directionality: input.directionality,
          source: input.source,
        },
      },
    });
    return rel as SkillRelationshipRow;
  }

  async removeRelationship(id: string, actor?: SkillActor): Promise<SkillRelationshipRow> {
    const { actorId, actorType } = resolveActor(actor);
    return this.prisma.$transaction(async (tx) => {
      const rel = (await tx.skillRelationship.update({
        where: { id },
        data: { status: 'inactive', updated_by: actorId },
      })) as SkillRelationshipRow;
      await tx.skillAuditEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: null,
          actor_id: actorId,
          actor_type: actorType,
          event_type: 'RELATIONSHIP_REMOVED',
          subject_id: rel.source_skill_id,
          event_payload: {
            relationship_id: id,
            target_skill_id: rel.target_skill_id,
            relationship_type: rel.relationship_type,
          },
        },
      });
      return rel;
    });
  }

  // All active edges touching a skill, in either orientation.
  async listForSkill(skillId: string): Promise<SkillRelationshipRow[]> {
    const rows = await this.prisma.skillRelationship.findMany({
      where: {
        status: 'active',
        OR: [{ source_skill_id: skillId }, { target_skill_id: skillId }],
      },
      orderBy: { created_at: 'asc' },
    });
    return rows as SkillRelationshipRow[];
  }
}
