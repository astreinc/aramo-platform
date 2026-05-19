import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// Repository for the Talent-evidence entities (M3 PR-5).
//
// Surface scope (closed, per the PR-1 / PR-4 entity-foundation precedent):
//   - createTalentSkillEvidence / findTalentSkillEvidenceById
//   - createTalentWorkHistoryEntry / findTalentWorkHistoryEntryById
//   - createTalentContactMethod / findTalentContactMethodById
//   - createTalentRateExpectation / findTalentRateExpectationById
//   - createTalentWorkAuthorization / findTalentWorkAuthorizationById
//   - createTalentDocument / findTalentDocumentById
//   - createTalentDerivedSnapshot / findTalentDerivedSnapshotById
//
// Read-and-create only. No update / delete / list / filter methods are
// exposed — those are speculative until a consumer (PR-6 reasoning +
// evidence linkage) arrives with a concrete read pattern.
//
// Cross-schema rule (Architecture v2.1 §7.3): every `*_id` field on every
// entity is a plain UUID column with no foreign key. The repository
// accepts the UUIDs verbatim and persists them without referential
// validation; the application layer is responsible for the referenced
// values being correct.
//
// Json columns (on TalentDerivedSnapshot) carry shape per Group 2 §2.2.
// The repository accepts any JSON-serialisable value (`unknown`) and
// forwards it to Prisma opaquely — the same opaque-Json pattern PR-1's
// ExaminationRepository uses for its analytical fields.

type JsonInput = unknown;

// ---- Enum value types (mirror Prisma's generated enums) ---------------

export type TalentSkillEvidenceSourceValue = 'declared' | 'ingested' | 'derived';

export type TalentWorkHistorySourceValue = 'resume' | 'linkedin' | 'manual' | 'import';

export type TalentContactTypeValue =
  | 'email'
  | 'phone'
  | 'linkedin'
  | 'github'
  | 'portfolio'
  | 'other';

export type TalentContactVerificationStatusValue =
  | 'unverified'
  | 'verified'
  | 'failed'
  | 'stale';

// The TS literal type uses the spec values "W2" | "1099" | "C2C" | "FTE".
// The Prisma client identifier for "1099" is CONTRACT_1099 (the schema's
// @map("1099") maps it to the DB literal "1099"); the repository accepts
// the spec literal and translates internally.
export type TalentEmploymentTypeValue = 'W2' | '1099' | 'C2C' | 'FTE';

export type TalentRatePeriodValue = 'HOURLY' | 'ANNUAL';

export type TalentRateSourceValue = 'talent_declared' | 'recruiter_entered';

export type TalentWorkAuthorizationStatusValue =
  | 'US_CITIZEN'
  | 'PERMANENT_RESIDENT'
  | 'VISA_HOLDER'
  | 'REQUIRES_SPONSORSHIP'
  | 'OTHER'
  | 'NOT_DISCLOSED';

export type TalentDocumentTypeValue =
  | 'resume'
  | 'cover_letter'
  | 'certification'
  | 'work_sample'
  | 'reference_letter'
  | 'other';

export type TalentDocumentParseStatusValue =
  | 'pending'
  | 'parsed'
  | 'failed'
  | 'no_parse_attempted';

export type TalentDocumentRetentionPolicyValue =
  | 'default'
  | 'extended'
  | 'delete_after_X_days';

// ---- TalentSkillEvidence (Group 2 §2.2 #16) ----------------------------

export interface CreateTalentSkillEvidenceInput {
  id: string;
  talent_id: string;
  tenant_id: string;
  skill_id: string;
  source_record_id?: string;
  surface_form: string;
  source: TalentSkillEvidenceSourceValue;
  evidence_text?: string;
  proficiency_claim?: string;
  years_claimed?: number;
  confidence_score?: number;
  created_at: Date;
}

export interface TalentSkillEvidenceRow {
  id: string;
  talent_id: string;
  tenant_id: string;
  skill_id: string;
  source_record_id: string | null;
  surface_form: string;
  source: TalentSkillEvidenceSourceValue;
  evidence_text: string | null;
  proficiency_claim: string | null;
  years_claimed: number | null;
  confidence_score: number | null;
  created_at: Date;
}

// ---- TalentWorkHistoryEntry (Group 2 §2.2 #10) -------------------------

export interface CreateTalentWorkHistoryEntryInput {
  id: string;
  talent_id: string;
  tenant_id: string;
  employer_name: string;
  role_title: string;
  start_date?: Date;
  end_date?: Date;
  location?: string;
  employment_type?: string;
  description_text?: string;
  source: TalentWorkHistorySourceValue;
  source_document_id?: string;
  is_authoritative?: boolean;
  created_at: Date;
}

export interface TalentWorkHistoryEntryRow {
  id: string;
  talent_id: string;
  tenant_id: string;
  employer_name: string;
  role_title: string;
  start_date: Date | null;
  end_date: Date | null;
  location: string | null;
  employment_type: string | null;
  description_text: string | null;
  source: TalentWorkHistorySourceValue;
  source_document_id: string | null;
  is_authoritative: boolean | null;
  created_at: Date;
}

// ---- TalentContactMethod (Group 2 §2.2 #4) -----------------------------

export interface CreateTalentContactMethodInput {
  id: string;
  talent_id: string;
  tenant_id: string;
  type: TalentContactTypeValue;
  value: string;
  is_primary: boolean;
  verification_status: TalentContactVerificationStatusValue;
  verified_at?: Date;
  created_at: Date;
}

export interface TalentContactMethodRow {
  id: string;
  talent_id: string;
  tenant_id: string;
  type: TalentContactTypeValue;
  value: string;
  is_primary: boolean;
  verification_status: TalentContactVerificationStatusValue;
  verified_at: Date | null;
  created_at: Date;
}

// ---- TalentRateExpectation (Group 2 §2.2 #7) ---------------------------

export interface CreateTalentRateExpectationInput {
  id: string;
  talent_id: string;
  tenant_id: string;
  employment_type: TalentEmploymentTypeValue;
  min_rate: number;
  target_rate?: number;
  currency: string;
  period: TalentRatePeriodValue;
  source: TalentRateSourceValue;
  updated_at: Date;
}

export interface TalentRateExpectationRow {
  id: string;
  talent_id: string;
  tenant_id: string;
  employment_type: TalentEmploymentTypeValue;
  min_rate: number;
  target_rate: number | null;
  currency: string;
  period: TalentRatePeriodValue;
  source: TalentRateSourceValue;
  updated_at: Date;
}

// ---- TalentWorkAuthorization (Group 2 §2.2 #6 — Declared (Sensitive)) --

export interface CreateTalentWorkAuthorizationInput {
  id: string;
  talent_id: string;
  tenant_id: string;
  work_authorization_status: TalentWorkAuthorizationStatusValue;
  authorized_to_work_in: readonly string[];
  visa_type?: string;
  requires_sponsorship: boolean;
  updated_at: Date;
}

export interface TalentWorkAuthorizationRow {
  id: string;
  talent_id: string;
  tenant_id: string;
  work_authorization_status: TalentWorkAuthorizationStatusValue;
  authorized_to_work_in: string[];
  visa_type: string | null;
  requires_sponsorship: boolean;
  updated_at: Date;
}

// ---- TalentDocument (Group 2 §2.2 #8) ----------------------------------

export interface CreateTalentDocumentInput {
  id: string;
  talent_id: string;
  tenant_id: string;
  uploaded_by_actor_id: string;
  uploaded_at: Date;
  document_type: TalentDocumentTypeValue;
  filename: string;
  file_storage_ref: string;
  mime_type: string;
  size_bytes: number;
  parse_status: TalentDocumentParseStatusValue;
  consent_scope_at_upload: readonly string[];
  retention_policy: TalentDocumentRetentionPolicyValue;
  is_active: boolean;
}

export interface TalentDocumentRow {
  id: string;
  talent_id: string;
  tenant_id: string;
  uploaded_by_actor_id: string;
  uploaded_at: Date;
  document_type: TalentDocumentTypeValue;
  filename: string;
  file_storage_ref: string;
  mime_type: string;
  size_bytes: number;
  parse_status: TalentDocumentParseStatusValue;
  consent_scope_at_upload: string[];
  retention_policy: TalentDocumentRetentionPolicyValue;
  is_active: boolean;
}

// ---- TalentDerivedSnapshot (Group 2 §2.2 #17) --------------------------

export interface CreateTalentDerivedSnapshotInput {
  id: string;
  talent_id: string;
  tenant_id: string;
  skill_confidence_scores: JsonInput;
  estimated_years_experience_overall?: number;
  estimated_years_experience_by_skill?: JsonInput;
  skill_domains?: JsonInput;
  career_trajectory_pattern?: string;
  intent_signal?: JsonInput;
  freshness_score?: JsonInput;
  reachability_score?: JsonInput;
  availability_confidence?: number;
  trust_level?: string;
  data_completeness_score?: number;
  threshold_status?: JsonInput;
  current_consent_state?: JsonInput;
  computed_at: Date;
}

export interface TalentDerivedSnapshotRow {
  id: string;
  talent_id: string;
  tenant_id: string;
  skill_confidence_scores: unknown;
  estimated_years_experience_overall: number | null;
  estimated_years_experience_by_skill: unknown;
  skill_domains: unknown;
  career_trajectory_pattern: string | null;
  intent_signal: unknown;
  freshness_score: unknown;
  reachability_score: unknown;
  availability_confidence: number | null;
  trust_level: string | null;
  data_completeness_score: number | null;
  threshold_status: unknown;
  current_consent_state: unknown;
  computed_at: Date;
}

// Maps the spec literal value to the Prisma enum identifier. Spec literal
// "1099" requires translation because Prisma identifier rules forbid leading
// digits; the schema's @map("1099") makes the DB column store "1099".
const EMPLOYMENT_TYPE_TO_PRISMA: Record<TalentEmploymentTypeValue, 'W2' | 'CONTRACT_1099' | 'C2C' | 'FTE'> = {
  W2: 'W2',
  '1099': 'CONTRACT_1099',
  C2C: 'C2C',
  FTE: 'FTE',
};

const EMPLOYMENT_TYPE_FROM_PRISMA: Record<'W2' | 'CONTRACT_1099' | 'C2C' | 'FTE', TalentEmploymentTypeValue> = {
  W2: 'W2',
  CONTRACT_1099: '1099',
  C2C: 'C2C',
  FTE: 'FTE',
};

@Injectable()
export class TalentEvidenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- TalentSkillEvidence -------------------------------------------

  async createTalentSkillEvidence(
    input: CreateTalentSkillEvidenceInput,
  ): Promise<TalentSkillEvidenceRow> {
    const created = await this.prisma.talentSkillEvidence.create({
      data: {
        id: input.id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        skill_id: input.skill_id,
        source_record_id: input.source_record_id,
        surface_form: input.surface_form,
        source: input.source,
        evidence_text: input.evidence_text,
        proficiency_claim: input.proficiency_claim,
        years_claimed: input.years_claimed,
        confidence_score: input.confidence_score,
        created_at: input.created_at,
      },
    });
    return created as TalentSkillEvidenceRow;
  }

  async findTalentSkillEvidenceById(id: string): Promise<TalentSkillEvidenceRow | null> {
    const row = await this.prisma.talentSkillEvidence.findUnique({ where: { id } });
    return (row as TalentSkillEvidenceRow | null) ?? null;
  }

  // ---- TalentWorkHistoryEntry ----------------------------------------

  async createTalentWorkHistoryEntry(
    input: CreateTalentWorkHistoryEntryInput,
  ): Promise<TalentWorkHistoryEntryRow> {
    const created = await this.prisma.talentWorkHistoryEntry.create({
      data: {
        id: input.id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        employer_name: input.employer_name,
        role_title: input.role_title,
        start_date: input.start_date,
        end_date: input.end_date,
        location: input.location,
        employment_type: input.employment_type,
        description_text: input.description_text,
        source: input.source,
        source_document_id: input.source_document_id,
        is_authoritative: input.is_authoritative,
        created_at: input.created_at,
      },
    });
    return created as TalentWorkHistoryEntryRow;
  }

  async findTalentWorkHistoryEntryById(id: string): Promise<TalentWorkHistoryEntryRow | null> {
    const row = await this.prisma.talentWorkHistoryEntry.findUnique({ where: { id } });
    return (row as TalentWorkHistoryEntryRow | null) ?? null;
  }

  // ---- TalentContactMethod -------------------------------------------

  async createTalentContactMethod(
    input: CreateTalentContactMethodInput,
  ): Promise<TalentContactMethodRow> {
    const created = await this.prisma.talentContactMethod.create({
      data: {
        id: input.id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        type: input.type,
        value: input.value,
        is_primary: input.is_primary,
        verification_status: input.verification_status,
        verified_at: input.verified_at,
        created_at: input.created_at,
      },
    });
    return created as TalentContactMethodRow;
  }

  async findTalentContactMethodById(id: string): Promise<TalentContactMethodRow | null> {
    const row = await this.prisma.talentContactMethod.findUnique({ where: { id } });
    return (row as TalentContactMethodRow | null) ?? null;
  }

  // ---- TalentRateExpectation -----------------------------------------

  async createTalentRateExpectation(
    input: CreateTalentRateExpectationInput,
  ): Promise<TalentRateExpectationRow> {
    const created = await this.prisma.talentRateExpectation.create({
      data: {
        id: input.id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        employment_type: EMPLOYMENT_TYPE_TO_PRISMA[input.employment_type],
        min_rate: input.min_rate,
        target_rate: input.target_rate,
        currency: input.currency,
        period: input.period,
        source: input.source,
        updated_at: input.updated_at,
      },
    });
    return {
      ...(created as Omit<TalentRateExpectationRow, 'employment_type'>),
      employment_type:
        EMPLOYMENT_TYPE_FROM_PRISMA[
          (created as { employment_type: 'W2' | 'CONTRACT_1099' | 'C2C' | 'FTE' }).employment_type
        ],
    };
  }

  async findTalentRateExpectationById(id: string): Promise<TalentRateExpectationRow | null> {
    const row = await this.prisma.talentRateExpectation.findUnique({ where: { id } });
    if (row === null) return null;
    return {
      ...(row as Omit<TalentRateExpectationRow, 'employment_type'>),
      employment_type:
        EMPLOYMENT_TYPE_FROM_PRISMA[
          (row as { employment_type: 'W2' | 'CONTRACT_1099' | 'C2C' | 'FTE' }).employment_type
        ],
    };
  }

  // ---- TalentWorkAuthorization ---------------------------------------
  // Per directive §2 Ruling 4 / §9 F16: entity ships with its §2.2 column
  // shape; the Architecture §14.4 sensitive-field PII-handling treatment
  // (encryption, access logging, elevated-permission access) is deferred
  // to follow-up F16, pending the §14.3 sensitive-field implementation
  // artifact. The repository surface here is column-only — no F16 mechanics.

  async createTalentWorkAuthorization(
    input: CreateTalentWorkAuthorizationInput,
  ): Promise<TalentWorkAuthorizationRow> {
    const created = await this.prisma.talentWorkAuthorization.create({
      data: {
        id: input.id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        work_authorization_status: input.work_authorization_status,
        authorized_to_work_in: [...input.authorized_to_work_in],
        visa_type: input.visa_type,
        requires_sponsorship: input.requires_sponsorship,
        updated_at: input.updated_at,
      },
    });
    return created as TalentWorkAuthorizationRow;
  }

  async findTalentWorkAuthorizationById(
    id: string,
  ): Promise<TalentWorkAuthorizationRow | null> {
    const row = await this.prisma.talentWorkAuthorization.findUnique({ where: { id } });
    return (row as TalentWorkAuthorizationRow | null) ?? null;
  }

  // ---- TalentDocument ------------------------------------------------

  async createTalentDocument(
    input: CreateTalentDocumentInput,
  ): Promise<TalentDocumentRow> {
    const created = await this.prisma.talentDocument.create({
      data: {
        id: input.id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        uploaded_by_actor_id: input.uploaded_by_actor_id,
        uploaded_at: input.uploaded_at,
        document_type: input.document_type,
        filename: input.filename,
        file_storage_ref: input.file_storage_ref,
        mime_type: input.mime_type,
        size_bytes: input.size_bytes,
        parse_status: input.parse_status,
        consent_scope_at_upload: [...input.consent_scope_at_upload],
        retention_policy: input.retention_policy,
        is_active: input.is_active,
      },
    });
    return created as TalentDocumentRow;
  }

  async findTalentDocumentById(id: string): Promise<TalentDocumentRow | null> {
    const row = await this.prisma.talentDocument.findUnique({ where: { id } });
    return (row as TalentDocumentRow | null) ?? null;
  }

  // ---- TalentDerivedSnapshot -----------------------------------------

  async createTalentDerivedSnapshot(
    input: CreateTalentDerivedSnapshotInput,
  ): Promise<TalentDerivedSnapshotRow> {
    const created = await this.prisma.talentDerivedSnapshot.create({
      data: {
        id: input.id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        skill_confidence_scores: input.skill_confidence_scores as never,
        estimated_years_experience_overall: input.estimated_years_experience_overall,
        estimated_years_experience_by_skill: input.estimated_years_experience_by_skill as never,
        skill_domains: input.skill_domains as never,
        career_trajectory_pattern: input.career_trajectory_pattern,
        intent_signal: input.intent_signal as never,
        freshness_score: input.freshness_score as never,
        reachability_score: input.reachability_score as never,
        availability_confidence: input.availability_confidence,
        trust_level: input.trust_level,
        data_completeness_score: input.data_completeness_score,
        threshold_status: input.threshold_status as never,
        current_consent_state: input.current_consent_state as never,
        computed_at: input.computed_at,
      },
    });
    return created as TalentDerivedSnapshotRow;
  }

  async findTalentDerivedSnapshotById(
    id: string,
  ): Promise<TalentDerivedSnapshotRow | null> {
    const row = await this.prisma.talentDerivedSnapshot.findUnique({ where: { id } });
    return (row as TalentDerivedSnapshotRow | null) ?? null;
  }
}
