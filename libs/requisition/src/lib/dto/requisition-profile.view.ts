import type {
  GoldenProfileConstraints,
  GoldenProfileExperience,
  GoldenProfileProvenance,
  GoldenProfileSkill,
} from '@aramo/job-domain';

// PR-A2 P3 — the GoldenProfile READ view (GET /v1/requisitions/:id/profile).
//
// The substrate-confirm finding: jd_text + the structured GoldenProfile are
// PERSISTED, but nested inside the GoldenProfile.skills Json blob (recon C),
// with no first-class read endpoint (A1 deferred it). This DTO is that
// first-class read shape — the cockpit's profile workbench reads it instead
// of reaching into the raw blob. RESHAPE-ON-READ only: NO schema migration
// (R3). goldenProfileContentFromStorage() does the un-nesting; this view
// adds the requisition-side metadata (requisition_id / golden_profile_id /
// has_profile) the workbench needs.
//
// The PROFILE-LESS shape (has_profile === false): golden_profile_id null,
// jd_text '', empty skill/industry lists, generated_by null. A requisition
// with no confirmed profile yet returns this — NOT a 404/500 (gate §4 P3).
export interface RequisitionProfileView {
  requisition_id: string;
  golden_profile_id: string | null;
  has_profile: boolean;

  // The un-nested GoldenProfile content (from the skills Json blob).
  jd_text: string;
  role_family: string | null;
  seniority_level: string | null;
  // null ONLY in the profile-less shape; otherwise the stored provenance.
  generated_by: GoldenProfileProvenance | null;
  required_skills: GoldenProfileSkill[];
  preferred_skills: Array<{ name: string }>;
  critical_skills: GoldenProfileSkill[];
  experience: GoldenProfileExperience;
  constraints: GoldenProfileConstraints;
}

// The canonical profile-less response — a requisition that has never had a
// profile confirmed. Built explicitly (NOT via goldenProfileContentFromStorage,
// which would default generated_by to 'manual') so has_profile === false is
// honestly distinguishable from a hand-entered manual profile.
export function emptyRequisitionProfileView(
  requisition_id: string,
): RequisitionProfileView {
  return {
    requisition_id,
    golden_profile_id: null,
    has_profile: false,
    jd_text: '',
    role_family: null,
    seniority_level: null,
    generated_by: null,
    required_skills: [],
    preferred_skills: [],
    critical_skills: [],
    experience: { industries: [] },
    constraints: {},
  };
}
