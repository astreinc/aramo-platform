// CreateTalentRecordRequestDto — POST /v1/talent-records payload.
// tenant_id derived from AuthContext.tenant_id (never the body).
import type {
  ResumeDraftCertification,
  ResumeDraftEducation,
  ResumeDraftSkill,
  ResumeDraftWorkHistory,
} from '@aramo/talent-extraction';

import type {
  AvailabilityStatus,
  EngagementType,
  WorkAuthorization,
} from './stated-fields.js';

export interface CreateTalentRecordRequestDto {
  // TalentRecord Admission Invariant: a TalentRecord is a genuine, ATS-operable
  // profile and MUST NOT be created without the minimum identity + contact
  // anchors — first_name, last_name, a primary email, and a primary (cell)
  // phone. These four are REQUIRED on EVERY creation path (manual, governed
  // promotion, import); incomplete person data stays in the pre-Talent
  // staging/identity substrate and never crosses this boundary. The repository
  // enforces the invariant structurally (assertAdmissible) so no caller can
  // bypass it via the DTO type alone.
  first_name: string;
  last_name: string;
  site_id?: string;
  email1: string;
  email2?: string;
  phone_home?: string;
  phone_cell: string;
  phone_work?: string;
  address?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string; // B2 — ISO-3166 alpha-2 (FE defaults 'US' on manual create)
  source?: string;
  key_skills?: string;
  current_employer?: string;
  current_pay?: string;
  desired_pay?: string;
  date_available?: string;
  can_relocate?: boolean;
  is_hot?: boolean;
  notes?: string;
  web_site?: string;
  best_time_to_call?: string;
  title?: string; // B1 — professional title (most-recent role)
  // Talent-stated categorical fields (stated-fields amendment §4). Validated
  // against the closed vocabulary by the repository guard (interface DTO — the
  // @IsIn intent honored via the module's manual-guard idiom).
  availability_status?: AvailabilityStatus;
  engagement_type?: EngagementType;
  work_authorization?: WorkAuthorization;
  owner_id?: string;
  // Reviewed work-history (LOCKED scope expansion). Persisted AFTER the record
  // is created as TalentWorkHistoryEntry (source='resume') — NOT a TalentRecord
  // scalar; the repository ignores it and the controller writes it post-create.
  // Declared, recruiter-edited; not verified. Each entry may carry source_refs
  // (HF1 §16/R8) — durable block-level provenance persisted with the row.
  work_history?: ResumeDraftWorkHistory[];
  // HF1 Gate-6 R2 — reviewed résumé skills as structured facts + source_refs.
  // Persisted post-create as declared TalentSkillEvidence WITH provenance (the
  // free-text key_skills scalar is retained separately). Repository ignores it.
  skills?: ResumeDraftSkill[];
  // HF2 R8/R18/R19 — reviewed résumé education + certifications (grounded,
  // recruiter-edited). Persisted post-create as declared TalentEducationEntry /
  // TalentCertificationEntry WITH provenance; the repository ignores them (the
  // controller writes them post-create, like work_history/skills).
  education?: ResumeDraftEducation[];
  certifications?: ResumeDraftCertification[];
  // HF1 Gate-6 R1 — the résumé document + corpus provenance, carried from the
  // draft. Present only on the résumé-first create path; when present the
  // controller creates the résumé TalentDocument AFTER the record and stamps
  // source_document_id + source_map_version + resume_text_hash onto the evidence.
  resume_document?: {
    storage_key: string;
    file_name: string;
    mime_type: string;
    size_bytes: number;
    source_map_version?: string;
    resume_text_hash?: string;
  };
}
