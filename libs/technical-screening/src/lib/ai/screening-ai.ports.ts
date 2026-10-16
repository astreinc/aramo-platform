// TIP-E2E INC-3 A1-3 — ports the composition root (apps/api) binds for the
// screening AI service. The lib never reads Consent, Requisition or Talent data
// directly (INC-3 :52 as amended: cross-domain composition stays in apps/api).

export const SCREENING_AI_CONSENT = Symbol('SCREENING_AI_CONSENT');

// The existing `ai_processing` consent operation, evaluated against the
// canonical Consent authority. Fail closed: anything but an explicit allow is false.
export interface ScreeningAiConsentPort {
  isAiProcessingAllowed(tenantId: string, talentRecordId: string): Promise<boolean>;
}

// Minimized requisition context for question tailoring (G-2). Read under the
// acting recruiter's requisition visibility. No compensation, no rate, no client
// commercial data.
export interface ScreeningRequisitionContext {
  title: string | null;
  required_skills: string[];
  preferred_skills: string[];
  job_description: string | null;
  experience_summary: string | null;
}

// Minimized talent profile (G-1). No name, no contact fields, no pay, no
// protected-trait material.
export interface ScreeningTalentContext {
  headline: string | null;
  skills: string[];
  work_history: Array<{ title: string | null; organization: string | null; summary: string | null }>;
  resume_excerpt: string | null;
}
