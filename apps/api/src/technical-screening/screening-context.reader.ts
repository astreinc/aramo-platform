import { Inject, Injectable } from '@nestjs/common';
import type { VisibilityContextShape } from '@aramo/common';
import { JobDomainRepository } from '@aramo/job-domain';
import {
  REQUISITION_CONTEXT_READ_PORT,
  type RequisitionContextReadPort,
} from '@aramo/talent-intelligence';
import { TalentEvidenceRepository } from '@aramo/talent-evidence';
import { TalentRecordRepository } from '@aramo/talent-record';
import type { ScreeningRequisitionContext, ScreeningTalentContext } from '@aramo/technical-screening';

// TIP-E2E INC-3 A1-3 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED §B.3) — the MINIMIZED
// prompt context for screening question generation, composed at the apps/api
// root (the screening lib imports none of these domains).
//   - Requisition: read through the INC-2 RequisitionContextReadPort under the
//     acting recruiter's visibility (absent / out of visibility → null). Golden
//     profile job description + experience only; constraints (rate, location,
//     work mode, authorization) and every commercial field are excluded.
//   - Talent: skills, work history and a bounded résumé excerpt from the
//     already-redacted résumé text. No name, contact field, pay or
//     protected-trait material. The screening AI service redacts again before
//     sending (TENANT-LLM-2 :71).
const RESUME_EXCERPT_MAX = 4000;
const LIST_MAX = 25;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

@Injectable()
export class ScreeningContextReader {
  constructor(
    @Inject(REQUISITION_CONTEXT_READ_PORT) private readonly requisitions: RequisitionContextReadPort,
    private readonly jobDomain: JobDomainRepository,
    private readonly evidence: TalentEvidenceRepository,
    private readonly talentRecords: TalentRecordRepository,
  ) {}

  // Null when the requisition is absent or outside the actor's visibility.
  async requisitionContext(input: {
    tenant_id: string;
    visibility: VisibilityContextShape;
    requisition_id: string;
  }): Promise<ScreeningRequisitionContext | null> {
    const ctx = await this.requisitions.resolveContext({
      tenant_id: input.tenant_id,
      actor: input.visibility,
      requisition_id: input.requisition_id,
    });
    if (ctx === null) return null;
    const required = ctx.skill_requirements
      .filter((r) => r.requirement_type !== 'preferred')
      .map((r) => r.raw_surface_form)
      .slice(0, LIST_MAX);
    const preferred = ctx.skill_requirements
      .filter((r) => r.requirement_type === 'preferred')
      .map((r) => r.raw_surface_form)
      .slice(0, LIST_MAX);
    let jd: string | null = null;
    let experience: string | null = null;
    if (ctx.golden_profile_id !== null) {
      const gp = await this.jobDomain.findGoldenProfileById(ctx.golden_profile_id);
      if (gp !== null && gp.tenant_id === input.tenant_id) {
        const skills = (gp.skills ?? {}) as Record<string, unknown>;
        jd = str(skills['jd_text']);
        const exp = (gp.experience ?? {}) as Record<string, unknown>;
        const years = typeof exp['total_years'] === 'number' ? `${exp['total_years']} years` : null;
        const domain = str(exp['domain']);
        experience = [years, domain].filter((x) => x !== null).join(', ') || null;
      }
    }
    return {
      title: ctx.title,
      required_skills: required,
      preferred_skills: preferred,
      job_description: jd === null ? null : jd.slice(0, RESUME_EXCERPT_MAX),
      experience_summary: experience,
    };
  }

  async talentContext(input: { tenant_id: string; talent_record_id: string }): Promise<ScreeningTalentContext> {
    const [skills, history, resume] = await Promise.all([
      this.evidence.findTalentSkillEvidenceByTalent({ tenant_id: input.tenant_id, talent_id: input.talent_record_id }),
      this.evidence.findWorkHistoryByTalent({ tenant_id: input.tenant_id, talent_id: input.talent_record_id }),
      this.talentRecords.findResumeRedactedText({ tenant_id: input.tenant_id, talent_record_id: input.talent_record_id }),
    ]);
    const uniqueSkills = [...new Set(skills.map((s) => s.surface_form.trim()).filter((s) => s.length > 0))].slice(0, LIST_MAX);
    return {
      headline: null,
      skills: uniqueSkills,
      work_history: history.slice(0, 10).map((h) => ({
        title: str(h.role_title),
        organization: str(h.employer_name),
        summary: h.description_text === null ? null : h.description_text.slice(0, 600),
      })),
      resume_excerpt: resume === null ? null : resume.slice(0, RESUME_EXCERPT_MAX),
    };
  }
}
