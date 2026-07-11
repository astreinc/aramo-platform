import { Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AiDraftService } from '@aramo/ai-draft';
import { TalentEvidenceRepository } from '@aramo/talent-evidence';
import { TalentTrustService } from '@aramo/talent-trust';

import type {
  ExtractDeclaredEvidenceInput,
  ExtractDeclaredEvidenceResult,
  ExtractedCertification,
  ExtractedEducation,
  ExtractedSkill,
  ExtractedWorkHistory,
  ExtractionCompletion,
} from './dto/extraction.dto.js';
import { deriveSkillId } from './skill-id.js';
import {
  mapCertificationToClaim,
  mapEducationToClaim,
  mapSkillToClaim,
  mapWorkHistoryToClaim,
} from './ledger-mapper.js';

// Gate-1 G1-A — TalentExtractionService.
//
// Reads the talent's DECLARED source text (résumé body + recruiter key_skills,
// supplied by the caller), asks the LLM (via the governed @aramo/ai-draft
// consumer surface — ADR-0015 v1.3, 3rd declared consumer) to STRUCTURE what is
// explicitly present, then persists the result as `declared` evidence rows
// (A2-materialize). It NEVER infers or enriches: every extracted item must
// carry a verbatim source_excerpt found in the source text, else it is dropped
// (the constrained-to-source guardrail).
//
// Scoring stays deterministic + LLM-free (matching/examination); this lib only
// PRODUCES declared evidence. The parse/validate/persist path below is fully
// deterministic and unit-tested against a mocked generateDraft completion.
const EXTRACTION_MAX_TOKENS = 2048;

const SYSTEM_MESSAGE =
  'You are a résumé-structuring assistant. Extract ONLY skills, work-history ' +
  'entries, education, and certifications that are EXPLICITLY present in the ' +
  'provided text. Do NOT infer, enrich, normalize, or add anything not literally ' +
  'stated. For every item, include a "source_excerpt" copied VERBATIM from the ' +
  'provided text that contains the claim. Respond with STRICT JSON only, no prose, ' +
  'no code fences.';

@Injectable()
export class TalentExtractionService {
  private readonly logger = new Logger(TalentExtractionService.name);

  constructor(
    private readonly aiDraft: AiDraftService,
    private readonly evidence: TalentEvidenceRepository,
    // TR-4 B2 — the NEW edge: the producer owns its ledger write (DDR §3).
    private readonly trust: TalentTrustService,
  ) {}

  async extractDeclaredEvidence(
    input: ExtractDeclaredEvidenceInput,
  ): Promise<ExtractDeclaredEvidenceResult> {
    const sourceText = buildSourceText(input);
    // Nothing declared to extract from → no-op (no LLM call).
    if (sourceText.trim() === '') {
      return {
        skill_evidence_ids: [],
        work_history_ids: [],
        education_ids: [],
        certification_ids: [],
        rejected_count: 0,
      };
    }

    const draft = await this.aiDraft.generateDraft({
      tenant_id: input.tenant_id,
      prompt: buildPrompt(sourceText),
      max_tokens: EXTRACTION_MAX_TOKENS,
      system_message: SYSTEM_MESSAGE,
    });

    const parsed = parseCompletion(draft.completion);
    // A source corpus (whitespace-normalized) to validate excerpts against.
    const corpus = normalizeForMatch(sourceText);

    const skill_evidence_ids: string[] = [];
    const work_history_ids: string[] = [];
    const education_ids: string[] = [];
    const certification_ids: string[] = [];
    let rejected_count = 0;
    const createdAt = new Date();

    for (const skill of parsed.skills) {
      if (!isSourced(skill.surface_form, skill.source_excerpt, corpus)) {
        rejected_count += 1;
        continue;
      }
      const id = uuidv7();
      await this.evidence.createTalentSkillEvidence({
        id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        skill_id: deriveSkillId(skill.surface_form),
        surface_form: skill.surface_form.trim(),
        source: 'declared',
        evidence_text: skill.source_excerpt.trim(),
        // Only pass through claims the LLM copied from the source; confidence_score
        // stays NULL for declared rows (R3 — declared ≠ scored).
        ...(typeof skill.proficiency_claim === 'string' && skill.proficiency_claim.trim() !== ''
          ? { proficiency_claim: skill.proficiency_claim.trim() }
          : {}),
        ...(typeof skill.years_claimed === 'number' && Number.isFinite(skill.years_claimed)
          ? { years_claimed: skill.years_claimed }
          : {}),
        created_at: createdAt,
      });
      skill_evidence_ids.push(id);
    }

    for (const wh of parsed.work_history) {
      const employer = wh.employer_name.trim();
      const role = wh.role_title.trim();
      if (employer === '' || role === '' || !isExcerptInSource(wh.source_excerpt, corpus)) {
        rejected_count += 1;
        continue;
      }
      const id = uuidv7();
      await this.evidence.createTalentWorkHistoryEntry({
        id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        employer_name: employer,
        role_title: role,
        // TalentWorkHistorySource has no 'declared' member; work history is
        // extracted from the résumé body, so 'resume' is the honest source
        // value (skills use 'declared'; the work-history source enum is a
        // distinct closed vocabulary that includes 'resume').
        source: 'resume',
        ...(typeof wh.start_date === 'string' && wh.start_date.trim() !== ''
          ? { start_date: new Date(wh.start_date) }
          : {}),
        ...(typeof wh.end_date === 'string' && wh.end_date.trim() !== ''
          ? { end_date: new Date(wh.end_date) }
          : {}),
        ...(typeof wh.employment_type === 'string' && wh.employment_type.trim() !== ''
          ? { employment_type: wh.employment_type.trim() }
          : {}),
        ...(typeof wh.description === 'string' && wh.description.trim() !== ''
          ? { description_text: wh.description.trim() }
          : {}),
        created_at: createdAt,
      });
      work_history_ids.push(id);
    }

    for (const edu of parsed.education) {
      const institution = edu.institution_name.trim();
      const degree = edu.degree_name.trim();
      if (institution === '' || degree === '' || !isExcerptInSource(edu.source_excerpt, corpus)) {
        rejected_count += 1;
        continue;
      }
      const id = uuidv7();
      await this.evidence.createTalentEducationEntry({
        id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        institution_name: institution,
        degree_name: degree,
        // Education is extracted from the résumé body → 'resume' is the honest source.
        source: 'resume',
        evidence_text: edu.source_excerpt.trim(),
        ...(typeof edu.field_of_study === 'string' && edu.field_of_study.trim() !== ''
          ? { field_of_study: edu.field_of_study.trim() }
          : {}),
        ...(typeof edu.conferred_date === 'string' && edu.conferred_date.trim() !== ''
          ? { conferred_date: new Date(edu.conferred_date) }
          : {}),
        created_at: createdAt,
      });
      education_ids.push(id);
    }

    for (const cert of parsed.certifications) {
      const name = cert.certification_name.trim();
      if (name === '' || !isExcerptInSource(cert.source_excerpt, corpus)) {
        rejected_count += 1;
        continue;
      }
      const id = uuidv7();
      await this.evidence.createTalentCertificationEntry({
        id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        certification_name: name,
        source: 'resume',
        evidence_text: cert.source_excerpt.trim(),
        ...(typeof cert.issuer_name === 'string' && cert.issuer_name.trim() !== ''
          ? { issuer_name: cert.issuer_name.trim() }
          : {}),
        ...(typeof cert.credential_ref === 'string' && cert.credential_ref.trim() !== ''
          ? { credential_ref: cert.credential_ref.trim() }
          : {}),
        ...(typeof cert.issued_date === 'string' && cert.issued_date.trim() !== ''
          ? { issued_date: new Date(cert.issued_date) }
          : {}),
        ...(typeof cert.expiry_date === 'string' && cert.expiry_date.trim() !== ''
          ? { expiry_date: new Date(cert.expiry_date) }
          : {}),
        created_at: createdAt,
      });
      certification_ids.push(id);
    }

    this.logger.log({
      event: 'talent_declared_evidence_extracted',
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      skills_persisted: skill_evidence_ids.length,
      work_history_persisted: work_history_ids.length,
      education_persisted: education_ids.length,
      certifications_persisted: certification_ids.length,
      rejected_count,
    });

    return {
      skill_evidence_ids,
      work_history_ids,
      education_ids,
      certification_ids,
      rejected_count,
    };
  }

  // TR-4 B2 (DDR §3.1-§3.3) — route this talent's typed EMPLOYMENT/SKILL rows into
  // the trust ledger as canonical CLAIMS evidence. A RECONCILE, by design: it reads
  // the typed store and writes only the rows lacking a ledger counterpart (the
  // §3.2 source_ref existence check), so it is IDEMPOTENT and SELF-HEALING —
  // re-running (re-examine or backfill) writes nothing already written, and a
  // prior partial failure completes exactly once on the next run.
  //
  // MARKER-SEMANTICS NOTE (§2.2 finding): talent-extraction has NO poll and NO
  // boolean marker — extractDeclaredEvidence is invoked synchronously by the
  // examine HTTP endpoint, gated by an exists-check (skill-count === 0) that guards
  // only the expensive LLM extraction. This reconcile is therefore called
  // UNCONDITIONALLY by examine (outside that guard), so a ledger failure on run N
  // is retried on run N+1. source_ref = the STABLE typed-row id (never re-minted on
  // a re-examine, since extraction is skipped), so the existence check is sound.
  //
  // LOUD FAIL (§3.3): a ledger-write failure PROPAGATES (the examine request errors)
  // — never swallowed, never a silent half-commit. The typed rows persist; their
  // ledger counterparts land on the next successful run.
  async routeDeclaredEvidenceToLedger(input: {
    tenant_id: string;
    talent_id: string;
  }): Promise<{
    skills_written: number;
    work_history_written: number;
    education_written: number;
    certification_written: number;
    skipped: number;
  }> {
    // talent_id IS the ATS TalentRecord.id (ATS-as-heart) — the subject resolves
    // via the ATS_TALENT_RECORD ref.
    const subjectRef = {
      tenant_id: input.tenant_id,
      ref_type: 'ATS_TALENT_RECORD' as const,
      ref_id: input.talent_id,
      link_source: 'talent-extraction',
    };

    let skills_written = 0;
    let work_history_written = 0;
    let education_written = 0;
    let certification_written = 0;
    let skipped = 0;

    const skills = await this.evidence.listSkillEvidenceForLedger({
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
    });
    for (const row of skills) {
      const claim = mapSkillToClaim(row);
      const result = await this.trust.recordDeclaredClaimIfAbsent({
        subjectRef,
        assertion_type: claim.assertion_type,
        assertion_payload: claim.payload,
        source_ref: claim.source_ref,
        created_by: 'talent-extraction',
      });
      if (result.written) skills_written += 1;
      else skipped += 1;
    }

    const work = await this.evidence.listWorkHistoryForLedger({
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
    });
    for (const row of work) {
      const claim = mapWorkHistoryToClaim(row);
      const result = await this.trust.recordDeclaredClaimIfAbsent({
        subjectRef,
        assertion_type: claim.assertion_type,
        assertion_payload: claim.payload,
        source_ref: claim.source_ref,
        created_by: 'talent-extraction',
      });
      if (result.written) work_history_written += 1;
      else skipped += 1;
    }

    const education = await this.evidence.listEducationForLedger({
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
    });
    for (const row of education) {
      const claim = mapEducationToClaim(row);
      const result = await this.trust.recordDeclaredClaimIfAbsent({
        subjectRef,
        assertion_type: claim.assertion_type,
        assertion_payload: claim.payload,
        source_ref: claim.source_ref,
        created_by: 'talent-extraction',
      });
      if (result.written) education_written += 1;
      else skipped += 1;
    }

    const certifications = await this.evidence.listCertificationForLedger({
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
    });
    for (const row of certifications) {
      const claim = mapCertificationToClaim(row);
      const result = await this.trust.recordDeclaredClaimIfAbsent({
        subjectRef,
        assertion_type: claim.assertion_type,
        assertion_payload: claim.payload,
        source_ref: claim.source_ref,
        created_by: 'talent-extraction',
      });
      if (result.written) certification_written += 1;
      else skipped += 1;
    }

    if (
      skills_written > 0 ||
      work_history_written > 0 ||
      education_written > 0 ||
      certification_written > 0
    ) {
      this.logger.log({
        event: 'talent_claims_routed_to_ledger',
        tenant_id: input.tenant_id,
        talent_id: input.talent_id,
        skills_written,
        work_history_written,
        education_written,
        certification_written,
        skipped,
      });
    }
    return {
      skills_written,
      work_history_written,
      education_written,
      certification_written,
      skipped,
    };
  }

  // TR-4 B2 (DDR §3.4) — the one-time backfill: reconcile every talent in a tenant
  // that owns typed evidence. Same idempotent per-talent path as the live route, so
  // a second run reports zero. Recompute rides each subject's writes as always.
  async backfillLedgerForTenant(tenant_id: string): Promise<{
    talents: number;
    skills_written: number;
    work_history_written: number;
    education_written: number;
    certification_written: number;
    skipped: number;
  }> {
    const talentIds = await this.evidence.listTalentIdsWithEvidenceByTenant(tenant_id);
    let skills_written = 0;
    let work_history_written = 0;
    let education_written = 0;
    let certification_written = 0;
    let skipped = 0;
    for (const talent_id of talentIds) {
      const r = await this.routeDeclaredEvidenceToLedger({ tenant_id, talent_id });
      skills_written += r.skills_written;
      work_history_written += r.work_history_written;
      education_written += r.education_written;
      certification_written += r.certification_written;
      skipped += r.skipped;
    }
    return {
      talents: talentIds.length,
      skills_written,
      work_history_written,
      education_written,
      certification_written,
      skipped,
    };
  }

  // TR-4 B2 (DDR §3.4) — the --all-tenants enumeration for the backfill CLI.
  async listTenantIdsWithEvidence(): Promise<string[]> {
    return this.evidence.listTenantIdsWithEvidence();
  }
}

// ── deterministic helpers (the tested core) ──────────────────────────────────

function buildSourceText(input: ExtractDeclaredEvidenceInput): string {
  return [input.resume_text ?? '', input.key_skills ?? '']
    .filter((s) => s.trim() !== '')
    .join('\n');
}

function buildPrompt(sourceText: string): string {
  return (
    'Extract skills, work history, education, and certifications from the ' +
    'following talent-declared text. Return STRICT JSON of shape ' +
    '{"skills":[{"surface_form":string,"source_excerpt":string,' +
    '"proficiency_claim"?:string,"years_claimed"?:number}],' +
    '"work_history":[{"employer_name":string,"role_title":string,' +
    '"source_excerpt":string,"start_date"?:string,"end_date"?:string,' +
    '"employment_type"?:string,"description"?:string}],' +
    '"education":[{"institution_name":string,"degree_name":string,' +
    '"source_excerpt":string,"field_of_study"?:string,"conferred_date"?:string}],' +
    '"certifications":[{"certification_name":string,"source_excerpt":string,' +
    '"issuer_name"?:string,"credential_ref"?:string,"issued_date"?:string,' +
    '"expiry_date"?:string}]}. ' +
    'Every source_excerpt MUST be copied verbatim from the text below.\n\n' +
    '---\n' +
    sourceText +
    '\n---'
  );
}

// Strip optional ```json fences and parse; a malformed completion yields an
// empty result (deterministic — never throws on bad model output).
export function parseCompletion(completion: string): ExtractionCompletion {
  const empty: ExtractionCompletion = {
    skills: [],
    work_history: [],
    education: [],
    certifications: [],
  };
  const stripped = completion
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch {
    return empty;
  }
  if (typeof raw !== 'object' || raw === null) return empty;
  const obj = raw as Record<string, unknown>;
  const skills = Array.isArray(obj['skills'])
    ? (obj['skills'] as unknown[]).filter(isSkillShape)
    : [];
  const work_history = Array.isArray(obj['work_history'])
    ? (obj['work_history'] as unknown[]).filter(isWorkHistoryShape)
    : [];
  const education = Array.isArray(obj['education'])
    ? (obj['education'] as unknown[]).filter(isEducationShape)
    : [];
  const certifications = Array.isArray(obj['certifications'])
    ? (obj['certifications'] as unknown[]).filter(isCertificationShape)
    : [];
  return { skills, work_history, education, certifications };
}

function isSkillShape(v: unknown): v is ExtractedSkill {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['surface_form'] === 'string' && typeof o['source_excerpt'] === 'string';
}

function isWorkHistoryShape(v: unknown): v is ExtractedWorkHistory {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['employer_name'] === 'string' &&
    typeof o['role_title'] === 'string' &&
    typeof o['source_excerpt'] === 'string'
  );
}

function isEducationShape(v: unknown): v is ExtractedEducation {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['institution_name'] === 'string' &&
    typeof o['degree_name'] === 'string' &&
    typeof o['source_excerpt'] === 'string'
  );
}

function isCertificationShape(v: unknown): v is ExtractedCertification {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['certification_name'] === 'string' && typeof o['source_excerpt'] === 'string';
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Constrained-to-source: the excerpt must be non-empty AND present (whitespace-
// normalized) in the source corpus.
function isExcerptInSource(excerpt: string, corpus: string): boolean {
  if (excerpt.trim() === '') return false;
  return corpus.includes(normalizeForMatch(excerpt));
}

// A skill is sourced when it has a non-empty surface_form AND a valid excerpt.
function isSourced(surfaceForm: string, excerpt: string, corpus: string): boolean {
  if (surfaceForm.trim() === '') return false;
  return isExcerptInSource(excerpt, corpus);
}
