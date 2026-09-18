import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// SKILL-TAX-1F-B1 — the Talent-side canonical CORRECTION repository. A dedicated,
// narrow WRITE surface (NOT folded into TalentCanonicalCoverageRepository, which
// stays read-only) owning exactly two operations the correction processor needs:
//   1. repoint canonical_skill_id (loser → winner) on a skill MERGE — idempotent
//      (re-running finds no loser rows). NEVER touches raw surface_form / legacy
//      skill_id; only the additive canonical pointer moves.
//   2. discover the affected Talents for a targeted re-reconcile fan-out (by the
//      merged canonical ids OR the corrected surface_form) — targeted, never a
//      global sweep.

export interface AffectedTalent {
  tenant_id: string;
  talent_id: string;
}

@Injectable()
export class TalentCanonicalCorrectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  // MERGE repoint: every evidence row still pointing at the loser canonical id is
  // moved to the winner. Idempotent — a re-drain of the same correction updates 0
  // rows. Canonical ids are platform-global (the loser id is globally unique), so
  // this is correctly cross-tenant and needs no tenant filter. Returns the count.
  async repointCanonicalSkillId(fromCanonicalId: string, toCanonicalId: string): Promise<number> {
    const { count } = await this.prisma.talentSkillEvidence.updateMany({
      where: { canonical_skill_id: fromCanonicalId },
      data: { canonical_skill_id: toCanonicalId },
    });
    return count;
  }

  // Targeted fan-out discovery: the distinct Talents whose evidence references the
  // affected canonical id(s) OR the corrected surface_form. Both RESOLVED and
  // UNRESOLVED rows are eligible (the correction may flip either). Bounded by the
  // caller's limit; never scans the whole table unfiltered.
  async findAffectedTalents(args: {
    canonicalSkillIds?: readonly string[];
    surfaceForms?: readonly string[];
    limit: number;
  }): Promise<AffectedTalent[]> {
    const or: Array<Record<string, unknown>> = [];
    if (args.canonicalSkillIds && args.canonicalSkillIds.length > 0) {
      or.push({ canonical_skill_id: { in: [...args.canonicalSkillIds] } });
    }
    if (args.surfaceForms && args.surfaceForms.length > 0) {
      or.push({ surface_form: { in: [...args.surfaceForms] } });
    }
    if (or.length === 0) return [];
    return this.prisma.talentSkillEvidence.findMany({
      where: { OR: or },
      select: { tenant_id: true, talent_id: true },
      distinct: ['tenant_id', 'talent_id'],
      orderBy: [{ tenant_id: 'asc' }, { talent_id: 'asc' }],
      take: args.limit,
    });
  }
}
