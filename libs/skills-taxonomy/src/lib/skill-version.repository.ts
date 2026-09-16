import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';
import type { SkillActor } from './skill.repository.js';

// SkillVersionRepository — governed versions of a canonical Skill
// (SKILL-TAX-1B). (skill_id, normalized_version) is unique. Every mutation
// writes its SkillAuditEvent (subject_id = skill_id). A version is NEVER
// inferred from anything (§7) — it is only what the caller states.

export interface SkillVersionRow {
  id: string;
  skill_id: string;
  version: string;
  normalized_version: string;
  version_family: string | null;
  status: 'active' | 'inactive';
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
}

export interface AddVersionPersistInput {
  skill_id: string;
  version: string;
  normalized_version: string;
  version_family?: string | null;
  actor?: SkillActor;
}

export interface UpdateVersionPersistInput {
  version_family?: string | null;
  status?: 'active' | 'inactive';
  actor?: SkillActor;
}

function resolveActor(actor?: SkillActor): { actorId: string | null; actorType: string } {
  return { actorId: actor?.id ?? null, actorType: actor?.type ?? 'system' };
}

@Injectable()
export class SkillVersionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async addVersion(input: AddVersionPersistInput): Promise<SkillVersionRow> {
    const id = uuidv7();
    const { actorId, actorType } = resolveActor(input.actor);
    const [version] = await this.prisma.$transaction([
      this.prisma.skillVersion.create({
        data: {
          id,
          skill_id: input.skill_id,
          version: input.version,
          normalized_version: input.normalized_version,
          version_family: input.version_family ?? null,
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
          event_type: 'VERSION_ADDED',
          subject_id: input.skill_id,
          event_payload: {
            version_id: id,
            version: input.version,
            normalized_version: input.normalized_version,
            version_family: input.version_family ?? null,
          },
        },
      }),
    ]);
    return version as SkillVersionRow;
  }

  async updateVersion(id: string, input: UpdateVersionPersistInput): Promise<SkillVersionRow> {
    const { actorId, actorType } = resolveActor(input.actor);
    const data: Record<string, string | null> = { updated_by: actorId };
    if (input.version_family !== undefined) data['version_family'] = input.version_family;
    if (input.status !== undefined) data['status'] = input.status;

    return this.prisma.$transaction(async (tx) => {
      const version = (await tx.skillVersion.update({ where: { id }, data })) as SkillVersionRow;
      await tx.skillAuditEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: null,
          actor_id: actorId,
          actor_type: actorType,
          event_type: 'VERSION_UPDATED',
          subject_id: version.skill_id,
          event_payload: { version_id: id, changed: data },
        },
      });
      return version;
    });
  }

  async findForSkill(
    skillId: string,
    normalizedVersion: string,
  ): Promise<SkillVersionRow | null> {
    const row = await this.prisma.skillVersion.findUnique({
      where: {
        skill_id_normalized_version: {
          skill_id: skillId,
          normalized_version: normalizedVersion,
        },
      },
    });
    return (row as SkillVersionRow | null) ?? null;
  }

  async listForSkill(skillId: string): Promise<SkillVersionRow[]> {
    const rows = await this.prisma.skillVersion.findMany({
      where: { skill_id: skillId },
      orderBy: { version: 'asc' },
    });
    return rows as SkillVersionRow[];
  }
}
