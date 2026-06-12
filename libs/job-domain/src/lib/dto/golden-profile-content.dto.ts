// Job-Module (Part 2 / R4) — the typed GoldenProfile content shape.
//
// The directive types the GoldenProfile to the shapes the deterministic
// matching engine's MatchingAnalysisInput ALREADY expects (recon B8), so
// the future matching-CONSUMPTION PR is a clean wiring job, not a redesign:
//   - critical_skills[].name  ↔ MatchingAnalysisInput.CriticalSkillExamination.name
//     (evidence_count / has_ingested_evidence are MATCH-TIME-evaluated
//      against a talent, NOT stored on the requirement-side GoldenProfile)
//   - constraints {location, work_mode, rate, work_authorization}
//     ↔ MatchingAnalysisInput.ConstraintChecksEvaluated keys (byte-for-byte)
//   - role_family ↔ MatchingAnalysisInput.role_family (ROLE_FAMILIES)
//
// STORAGE NOTE (Amendment v1.1 — exactly ONE additive migration): the
// job_domain schema is intentionally NOT changed by this PR (zero
// job-domain DDL — which also makes the no-touch-matching-spine HALT
// airtight). The typed content is persisted OVER the GoldenProfile's
// EXISTING columns via goldenProfileContentToStorage():
//   - skills (Json)        ← { role_family, seniority_level, jd_text,
//                              generated_by, required_skills,
//                              preferred_skills, critical_skills }
//   - experience (Json)    ← content.experience
//   - constraints (Json)   ← content.constraints
//   - critical_skills ([]) ← content.critical_skills[].name (the enumerable
//                              anchor-3 name set the engine iterates)
// Reading back: goldenProfileContentFromStorage() reconstitutes the shape.

export interface GoldenProfileSkill {
  name: string;
  min_years?: number;
}

export interface GoldenProfileExperience {
  total_years?: number;
  domain?: string;
  industries: string[];
}

export interface GoldenProfileConstraints {
  location?: string;
  work_mode?: string;
  rate?: string;
  work_authorization?: string;
}

export type GoldenProfileProvenance = 'manual' | 'ai_draft';

export interface GoldenProfileContent {
  role_family?: string;
  seniority_level?: string;
  jd_text: string;
  generated_by: GoldenProfileProvenance;
  required_skills: GoldenProfileSkill[];
  preferred_skills: Array<{ name: string }>;
  critical_skills: GoldenProfileSkill[];
  experience: GoldenProfileExperience;
  constraints: GoldenProfileConstraints;
}

// The storage projection consumed by JobDomainRepository.create/
// updateGoldenProfile (skills/experience/constraints Json + critical_skills
// name array). No DDL — uses the existing columns.
export interface GoldenProfileStorage {
  skills: unknown;
  experience: unknown;
  constraints: unknown;
  critical_skills: string[];
}

export function goldenProfileContentToStorage(
  content: GoldenProfileContent,
): GoldenProfileStorage {
  return {
    skills: {
      role_family: content.role_family ?? null,
      seniority_level: content.seniority_level ?? null,
      jd_text: content.jd_text,
      generated_by: content.generated_by,
      required_skills: content.required_skills,
      preferred_skills: content.preferred_skills,
      critical_skills: content.critical_skills,
    },
    experience: content.experience,
    constraints: content.constraints,
    critical_skills: content.critical_skills.map((s) => s.name),
  };
}

// Reconstitute a GoldenProfileContent from the stored columns (for the
// future consumption PR + the confirm round-trip). Tolerant of partial
// blobs (returns sensible empties) so a malformed legacy row never throws.
export function goldenProfileContentFromStorage(args: {
  skills: unknown;
  experience: unknown;
  constraints: unknown;
}): GoldenProfileContent {
  const s = (args.skills ?? {}) as Record<string, unknown>;
  const exp = (args.experience ?? {}) as Record<string, unknown>;
  const con = (args.constraints ?? {}) as Record<string, unknown>;
  return {
    role_family: (s['role_family'] as string | undefined) ?? undefined,
    seniority_level: (s['seniority_level'] as string | undefined) ?? undefined,
    jd_text: (s['jd_text'] as string | undefined) ?? '',
    generated_by: (s['generated_by'] as GoldenProfileProvenance | undefined) ?? 'manual',
    required_skills: (s['required_skills'] as GoldenProfileSkill[] | undefined) ?? [],
    preferred_skills: (s['preferred_skills'] as Array<{ name: string }> | undefined) ?? [],
    critical_skills: (s['critical_skills'] as GoldenProfileSkill[] | undefined) ?? [],
    experience: {
      total_years: exp['total_years'] as number | undefined,
      domain: exp['domain'] as string | undefined,
      industries: (exp['industries'] as string[] | undefined) ?? [],
    },
    constraints: {
      location: con['location'] as string | undefined,
      work_mode: con['work_mode'] as string | undefined,
      rate: con['rate'] as string | undefined,
      work_authorization: con['work_authorization'] as string | undefined,
    },
  };
}
