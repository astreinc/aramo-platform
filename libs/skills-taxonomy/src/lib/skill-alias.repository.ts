import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';
import type { SkillActor } from './skill.repository.js';

// SkillAliasRepository — governed alias -> canonical Skill mappings
// (SKILL-TAX-1B). Every mutation writes its SkillAuditEvent (subject_id =
// skill_id, so a skill's whole master-data trail — including alias changes — is
// queryable by the skill). Alias removal is a SOFT status flip (never a delete),
// so historical references stay traceable (§29).

export type SkillAliasType =
  | 'ABBREVIATION'
  | 'COMMON_NAME'
  | 'LEGACY_NAME'
  | 'VENDOR_VARIANT'
  | 'SPELLING_VARIANT';

export interface SkillAliasRow {
  id: string;
  skill_id: string;
  alias: string;
  normalized_alias: string;
  alias_type: SkillAliasType;
  status: 'active' | 'inactive';
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
}

export interface AddAliasPersistInput {
  skill_id: string;
  alias: string;
  normalized_alias: string;
  alias_type: SkillAliasType;
  actor?: SkillActor;
}

function resolveActor(actor?: SkillActor): { actorId: string | null; actorType: string } {
  return { actorId: actor?.id ?? null, actorType: actor?.type ?? 'system' };
}

// SKILL-TAX-1F-B2 — the narrow transaction-client surface the composable write
// primitives need. A Prisma interactive-transaction client satisfies it structurally,
// so SkillGovernanceService can run addAliasWithin INSIDE the proposal-accept
// transaction. Deliberately scoped to the skills_taxonomy models this repo already
// owns — it does NOT widen cross-domain access.
export type SkillAliasTxClient = Pick<
  PrismaService,
  'skillAlias' | 'skillAuditEvent' | 'skillCorrectionTask'
>;

@Injectable()
export class SkillAliasRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Public entry — its own transaction. Delegates to the composable primitive.
  async addAlias(input: AddAliasPersistInput): Promise<SkillAliasRow> {
    return this.prisma.$transaction((tx) => this.addAliasWithin(tx, input));
  }

  // SKILL-TAX-1F-B2 — the composable canonical write: alias row + ALIAS_ADDED audit +
  // ALIAS_CORRECTION durable task, on the CALLER'S transaction client. Same canonical
  // governance logic whether invoked by addAlias or by proposal acceptance — no
  // duplicate writer, and the correction task stays atomic with the write.
  async addAliasWithin(tx: SkillAliasTxClient, input: AddAliasPersistInput): Promise<SkillAliasRow> {
    const id = uuidv7();
    const { actorId, actorType } = resolveActor(input.actor);
    const alias = await tx.skillAlias.create({
      data: {
        id,
        skill_id: input.skill_id,
        alias: input.alias,
        normalized_alias: input.normalized_alias,
        alias_type: input.alias_type,
        status: 'active',
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
        event_type: 'ALIAS_ADDED',
        subject_id: input.skill_id,
        event_payload: {
          alias_id: id,
          alias: input.alias,
          normalized_alias: input.normalized_alias,
          alias_type: input.alias_type,
        },
      },
    });
    await tx.skillCorrectionTask.create({
      data: {
        id: uuidv7(),
        correction_type: 'ALIAS_CORRECTION',
        from_canonical_skill_id: null,
        to_canonical_skill_id: null,
        surface_form: input.alias,
        status: 'PENDING',
      },
    });
    return alias as SkillAliasRow;
  }

  async removeAlias(id: string, actor?: SkillActor): Promise<SkillAliasRow> {
    const { actorId, actorType } = resolveActor(actor);
    return this.prisma.$transaction(async (tx) => {
      const alias = (await tx.skillAlias.update({
        where: { id },
        data: { status: 'inactive', updated_by: actorId },
      })) as SkillAliasRow;
      await tx.skillAuditEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: null,
          actor_id: actorId,
          actor_type: actorType,
          event_type: 'ALIAS_REMOVED',
          subject_id: alias.skill_id,
          event_payload: { alias_id: id, normalized_alias: alias.normalized_alias },
        },
      });
      // SKILL-TAX-1F-B2 — removing an alias can un-resolve evidence that resolved via
      // it, so emit an ALIAS_CORRECTION for the alias surface (atomic; B1 fans it out).
      await tx.skillCorrectionTask.create({
        data: {
          id: uuidv7(),
          correction_type: 'ALIAS_CORRECTION',
          from_canonical_skill_id: null,
          to_canonical_skill_id: null,
          surface_form: alias.alias,
          status: 'PENDING',
        },
      });
      return alias;
    });
  }

  async findByNormalizedAlias(normalizedAlias: string): Promise<SkillAliasRow | null> {
    const row = await this.prisma.skillAlias.findUnique({
      where: { normalized_alias: normalizedAlias },
    });
    return (row as SkillAliasRow | null) ?? null;
  }

  async listForSkill(
    skillId: string,
    opts?: { includeInactive?: boolean },
  ): Promise<SkillAliasRow[]> {
    const rows = await this.prisma.skillAlias.findMany({
      where: opts?.includeInactive ? { skill_id: skillId } : { skill_id: skillId, status: 'active' },
      orderBy: { alias: 'asc' },
    });
    return rows as SkillAliasRow[];
  }
}
