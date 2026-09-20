import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import {
  AiDraftService,
  ARAMO_AI_DRAFT_MODEL,
  redactPii,
  STRUCTURED_GENERATION_PROVIDER,
  type StructuredGenerationErrorCategory,
  type StructuredGenerationProvider,
} from '@aramo/ai-draft';
import {
  TalentEvidenceRepository,
  type CreateTalentWorkHistoryEntryInput,
  type CreateTalentSkillEvidenceInput,
  type CreateTalentEducationEntryInput,
  type CreateTalentCertificationEntryInput,
  type CreateTalentProjectExperienceInput,
  type CreateTalentResumeEditionInput,
  type SetTalentResumeDefaultInput,
  type TalentResumeEditionRow,
  type TalentResumeDefaultRow,
  type TalentResumeEditionWithDocumentRow,
  type UpsertResumeExtractionDraftInput,
  type ResumeExtractionDraftRow,
  type ResumeExtractionDraftSourceKindValue,
  type TalentWorkAuthorizationStatusValue,
} from '@aramo/talent-evidence';
import { TalentTrustService } from '@aramo/talent-trust';

import type {
  ExtractDeclaredEvidenceInput,
  ExtractDeclaredEvidenceResult,
  ExtractedCertification,
  ExtractedEducation,
  ExtractedSkill,
  ExtractedWorkHistory,
  ExtractionCompletion,
  ResumeDraftCompletion,
  ResumeDraftIdentity,
  ResumeDraftInput,
  ResumeDraftLocation,
  ResumeDraftProfessional,
  ResumeDraftProposal,
  ResumeDraftResult,
  ResumeDraftSkill,
  ResumeDraftSkillFact,
  ResumeDraftSkillUsage,
  ResumeDraftProject,
  ResumeDraftAssertion,
  ResumeDraftEducation,
  ResumeDraftCertification,
  ResumeProvenance,
  ResumeDraftStatus,
  ResumeDraftWorkHistory,
  ResumeDraftWorkHistoryFact,
  ResumeSourceMap,
  TalentWorkHistoryView,
} from './dto/extraction.dto.js';
import { deriveSkillId } from './skill-id.js';
import {
  mapCertificationToClaim,
  mapEducationToClaim,
  mapWorkAuthorizationToClaim,
  mapSkillToClaim,
  mapWorkHistoryToClaim,
  mapAssertionToClaim,
} from './ledger-mapper.js';
// HF2 R14/R27 — canonical strict date normalization + interval-union skill
// timeline. Duration derivation consumes ONLY normalized ResumeDate values
// (never a loose new Date(freeform)); unknown/ambiguous → null (contributes
// nothing), and the derived precision is carried so a year-only span is never
// presented as exact.
import {
  parseResumeDate,
  isOngoingDateToken,
  type ResumeDate,
} from './resume-date.js';
import {
  deriveSkillTimeline,
  type SkillUsageInterval,
} from './skill-usage-timeline.js';

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
// A résumé's full structured extraction (identity + location + professional +
// every skill + every work-history entry, each carrying a VERBATIM
// source_excerpt) routinely exceeds 2048 output tokens for a real 1–2 page
// résumé. At 2048 the completion truncated mid-JSON (stop_reason=max_tokens) →
// JSON.parse failed → an empty extraction surfaced as "no details could be
// read". 8192 gives ~4x headroom for the excerpt-heavy output.
const EXTRACTION_MAX_TOKENS = 8192;

const SYSTEM_MESSAGE =
  'You are a résumé-structuring assistant. Extract ONLY skills, work-history ' +
  'entries, education, and certifications that are EXPLICITLY present in the ' +
  'provided text. Do NOT infer, enrich, normalize, or add anything not literally ' +
  'stated. For every item, include a "source_excerpt" copied VERBATIM from the ' +
  'provided text that contains the claim. Respond with STRICT JSON only, no prose, ' +
  'no code fences.';

// ── Résumé-draft (pre-create) extraction — HF1 durable fact extraction ───────
// HF1 (Durable-Fact-Extraction-Directive v1.0). SINGLE-READ, FACT-ONLY,
// SOURCE-REFERENCED: the model reads a block-annotated résumé ONCE and returns
// the structured Add-Talent facts PLUS compact `source_refs` (block ids) — never
// copied prose, never a `source_excerpt`, never work-history `description` (R3/R4).
// Output is STRUCTURALLY BOUNDED (§11): it grows with the number of facts, not
// the length of the résumé.
//
// Prompt/schema VERSION identifier. v2 = the HF1 compact source-ref contract
// (v1 = the retired verbatim-excerpt contract). Bump on any change to
// DRAFT_SYSTEM_MESSAGE / RESUME_DRAFT_SCHEMA.
// HF2 Talent-Experience-Intelligence extraction. v3 = the nested experience
// contract (skill_usage/version/activity/basis + projects + assertions +
// education + certifications), bumped from the HF1 v2 flat-fact contract.
const RESUME_DRAFT_PROMPT_VERSION = 'resume-draft/v3';
const RESUME_DRAFT_SCHEMA_NAME = 'resume-draft-extraction/v3';
// HF2 P4 ruling (b) — the v3 draft path's SINGLE-CALL output ceiling. Raised
// 8192→16384 for THIS path ONLY (not a global bump): v3's richer Talent-
// Intelligence output legitimately reaches ~9K tokens on heavy enterprise
// résumés (measured), so 8192 would knowingly fail valid senior résumés. This
// is not the HF1 excerpt-bloat regime — output stays facts+refs. Truly extreme
// résumés still return provider_truncated (explicit, observable). One call only —
// no retry cascade, no second extraction (§26/R11). The examine path keeps
// EXTRACTION_MAX_TOKENS (8192) — unrelated ceilings are NOT raised.
const RESUME_DRAFT_V3_MAX_TOKENS = 16384;

// HF2 R12 — cardinality CEILINGS (safety, not product limits). Set high vs
// normal résumé density. Enforced in the CONSUMER (deterministic re-clamp via
// cap() + overflow flag) — NOT in the provider json_schema: Anthropic's native
// structured output rejects `maxItems` on arrays ("property 'maxItems' is not
// supported"), which 400s the whole call, so the ceilings live only in code.
// overflow is surfaced (status=partial + overflow flag), NEVER silently dropped
// — the WorkExperience source_refs still
// span all blocks, so complete evidence stays retrievable from the source-map.
const MAX_WORK_HISTORY = 20;
const MAX_SKILL_USAGE_PER_EXP = 30;
const MAX_PROJECTS_PER_EXP = 10;
const MAX_ASSERTIONS_PER_EXP = 30; // ≈20 activity + 10 accomplishment (unified list)
const MAX_EDUCATION = 10;
const MAX_CERTIFICATIONS = 20;
// HF2 R10 — recruiter-facing per-role summary hard cap.
const WORK_SUMMARY_MAX_CHARS = 600;

// HF2 R13 — the compact GOVERNED activity vocabulary (closed enum, verified
// vocab-guard-clean). Constrains skill_usage.activity + assertion.type so the
// model classifies rather than invents free prose.
const ACTIVITY_VOCAB = [
  'DEVELOP', 'DESIGN', 'ARCHITECT', 'IMPLEMENT', 'INTEGRATE', 'MIGRATE',
  'DEPLOY', 'ADMINISTER', 'TEST', 'AUTOMATE', 'SUPPORT', 'LEAD', 'ANALYZE',
  'BUILD', 'OTHER',
] as const;

const DRAFT_SYSTEM_MESSAGE =
  'You structure a résumé into governed evidence for a talent-intake form. The ' +
  'résumé is given as numbered source blocks, each line prefixed with a block id ' +
  'like "[B004]". Return ONLY facts EXPLICITLY present about the person the résumé ' +
  'is about. For EVERY fact and nested item set "source_refs" to the block ids ' +
  'whose text states it (e.g. ["B004"]). Do NOT copy or quote block text — ' +
  'reference by id only. Do NOT infer, enrich, normalize, expand one skill into ' +
  'related technologies, assign proficiency, or derive years/versions from dates, ' +
  'titles, or employers. Every schema property must be PRESENT, but for anything ' +
  'the résumé does not clearly state return an empty string "" (or an empty list ' +
  '[] for a list) — NEVER a guess. Empty means "not stated". Distinguish the résumé ' +
  'owner from other people named, and their location from employer/school ' +
  'locations. Do NOT output email or phone. Per work_history entry: (1) an ' +
  'optional "experience_summary" — ONE short factual sentence, at most 600 ' +
  'characters, of what the role was, drawn only from that entry’s blocks, never ' +
  'a copied responsibility list; (2) "skill_usage": each skill used IN THAT ROLE ' +
  'with its surface_form exactly as written, an optional "version" ONLY if the ' +
  'résumé states it, a compact "activity" from the allowed set, and ' +
  '"usage_period_basis" = EXPLICIT when the résumé states the skill’s own dates, ' +
  'WORK_EXPERIENCE_CONTEXT when only the role dates cover it, or UNKNOWN; (3) ' +
  '"projects": distinct initiatives — "project_name" only if the résumé names one ' +
  '(else omit it, never invent), plus optional context/domain; (4) "assertions": ' +
  'atomic activities/accomplishments, each a short "statement" with a "type" from ' +
  'the allowed set and a "metric" ONLY if a measurable outcome is explicitly ' +
  'stated (never invent a number). Also return top-level "education" and ' +
  '"certifications" that are explicitly stated. Structured facts + refs only — no ' +
  'copied résumé prose.';

// Transport enums include '' so a REQUIRED property can still say "not stated"
// without the model inventing a value — '' normalizes to absent (stripTransport-
// Empties) before grounding. (Native structured output requires every property
// present; Aramo keeps these fields SEMANTICALLY optional — the transport/domain
// split.)
const ACTIVITY_SCHEMA = { type: 'string', enum: [...ACTIVITY_VOCAB, ''] } as const;
const BASIS_SCHEMA = { type: 'string', enum: ['EXPLICIT', 'WORK_EXPERIENCE_CONTEXT', 'UNKNOWN', ''] } as const;
const REFS_SCHEMA = { type: 'array', items: { type: 'string' } } as const;

// Native JSON-schema for constrained decoding (§12/R2/R22). Compact facts +
// source_refs; NO source_excerpt. NO `maxItems`/array-size keywords — native
// structured output rejects them (400); cardinality ceilings (R12) are enforced
// in the consumer via cap(), not the schema.
// TRANSPORT schema (provider-facing). Native structured output requires EVERY
// property present (optional-parameter limit is 24; an all-optional schema over-
// runs it) and rejects `maxItems`. So: every property is in `required`, arrays
// carry no maxItems, and "not stated" is transported as '' (scalars) / [] (lists)
// — never omitted. stripTransportEmpties() converts those empties back to absent
// BEFORE grounding, so the SEMANTIC v3 contract (fields genuinely optional) is
// unchanged and provider-required presence never becomes domain-required data.
const RESUME_DRAFT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    identity: {
      type: 'object', additionalProperties: false,
      properties: { first_name: { type: 'string' }, last_name: { type: 'string' }, source_refs: REFS_SCHEMA },
      required: ['first_name', 'last_name', 'source_refs'],
    },
    location: {
      type: 'object', additionalProperties: false,
      properties: {
        address: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' },
        zip: { type: 'string' }, country: { type: 'string' }, source_refs: REFS_SCHEMA,
      },
      required: ['address', 'city', 'state', 'zip', 'country', 'source_refs'],
    },
    professional: {
      type: 'object', additionalProperties: false,
      properties: { current_employer: { type: 'string' }, title: { type: 'string' }, source_refs: REFS_SCHEMA },
      required: ['current_employer', 'title', 'source_refs'],
    },
    skills: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { surface_form: { type: 'string' }, source_refs: REFS_SCHEMA },
        required: ['surface_form', 'source_refs'],
      },
    },
    work_history: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          employer_name: { type: 'string' },
          role_title: { type: 'string' },
          start_date: { type: 'string' },
          end_date: { type: 'string' },
          employment_type: { type: 'string' },
          location: { type: 'string' },
          experience_summary: { type: 'string', maxLength: WORK_SUMMARY_MAX_CHARS },
          source_refs: REFS_SCHEMA,
          skill_usage: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                surface_form: { type: 'string' },
                version: { type: 'string' },
                activity: ACTIVITY_SCHEMA,
                usage_start: { type: 'string' },
                usage_end: { type: 'string' },
                usage_period_basis: BASIS_SCHEMA,
                source_refs: REFS_SCHEMA,
              },
              required: ['surface_form', 'version', 'activity', 'usage_start', 'usage_end', 'usage_period_basis', 'source_refs'],
            },
          },
          projects: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                project_name: { type: 'string' },
                context: { type: 'string' },
                domain: { type: 'string' },
                start_date: { type: 'string' },
                end_date: { type: 'string' },
                source_refs: REFS_SCHEMA,
              },
              required: ['project_name', 'context', 'domain', 'start_date', 'end_date', 'source_refs'],
            },
          },
          assertions: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                type: ACTIVITY_SCHEMA,
                statement: { type: 'string' },
                metric: { type: 'string' },
                source_refs: REFS_SCHEMA,
              },
              required: ['type', 'statement', 'metric', 'source_refs'],
            },
          },
        },
        required: [
          'employer_name', 'role_title', 'start_date', 'end_date', 'employment_type',
          'location', 'experience_summary', 'source_refs', 'skill_usage', 'projects', 'assertions',
        ],
      },
    },
    education: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          institution_name: { type: 'string' },
          degree_name: { type: 'string' },
          field_of_study: { type: 'string' },
          conferred_date: { type: 'string' },
          source_refs: REFS_SCHEMA,
        },
        required: ['institution_name', 'degree_name', 'field_of_study', 'conferred_date', 'source_refs'],
      },
    },
    certifications: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          certification_name: { type: 'string' },
          issuer_name: { type: 'string' },
          credential_ref: { type: 'string' },
          issued_date: { type: 'string' },
          expiry_date: { type: 'string' },
          version_or_level: { type: 'string' },
          source_refs: REFS_SCHEMA,
        },
        required: ['certification_name', 'issuer_name', 'credential_ref', 'issued_date', 'expiry_date', 'version_or_level', 'source_refs'],
      },
    },
  },
  required: ['identity', 'location', 'professional', 'skills', 'work_history', 'education', 'certifications'],
};

@Injectable()
export class TalentExtractionService {
  private readonly logger = new Logger(TalentExtractionService.name);

  constructor(
    private readonly aiDraft: AiDraftService,
    private readonly evidence: TalentEvidenceRepository,
    // TR-4 B2 — the NEW edge: the producer owns its ledger write (DDR §3).
    private readonly trust: TalentTrustService,
    // HF1 §12/R2 — the native JSON-schema structured-generation port (the B6P
    // surface on @aramo/ai-draft). The Add-Talent résumé draft path uses THIS
    // (not the free-text generateDraft); the examine path keeps generateDraft.
    @Inject(STRUCTURED_GENERATION_PROVIDER)
    private readonly structuredGen: StructuredGenerationProvider,
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
    // TALENT-INTEL-1 TI-1C — declared work-authorization → RIGHT_TO_WORK.
    work_authorization_written: number;
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
    let work_authorization_written = 0;
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

    // TALENT-INTEL-1 (TI-1C §step-5) — route declared work-authorization rows as
    // RIGHT_TO_WORK claims. Same idempotent posture: recordDeclaredClaimIfAbsent
    // writes only rows lacking a ledger counterpart (source_ref = the typed row),
    // at THIRD_PARTY_UNVERIFIED — a declared claim that cannot elevate ELIGIBILITY.
    const workAuthorizations = await this.evidence.listWorkAuthorizationForLedger({
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
    });
    for (const row of workAuthorizations) {
      const claim = mapWorkAuthorizationToClaim(row);
      const result = await this.trust.recordDeclaredClaimIfAbsent({
        subjectRef,
        assertion_type: claim.assertion_type,
        assertion_payload: claim.payload,
        source_ref: claim.source_ref,
        created_by: 'talent-extraction',
      });
      if (result.written) work_authorization_written += 1;
      else skipped += 1;
    }

    if (
      skills_written > 0 ||
      work_history_written > 0 ||
      education_written > 0 ||
      certification_written > 0 ||
      work_authorization_written > 0
    ) {
      this.logger.log({
        event: 'talent_claims_routed_to_ledger',
        tenant_id: input.tenant_id,
        talent_id: input.talent_id,
        skills_written,
        work_history_written,
        education_written,
        certification_written,
        work_authorization_written,
        skipped,
      });
    }
    return {
      skills_written,
      work_history_written,
      education_written,
      certification_written,
      work_authorization_written,
      skipped,
    };
  }

  // TALENT-INTEL-1 TI-1G §1 — the governed work-authorization evidence writer.
  // Activates the (previously dormant) RIGHT_TO_WORK evidence path from an EXPLICIT
  // recruiter statement: APPEND a TalentWorkAuthorization assertion (append-only —
  // a new row per assertion, never overwriting prior history) carrying only the
  // recruiter-stated coarse status, then route it into the trust ledger as a
  // declared RIGHT_TO_WORK claim (THIRD_PARTY_UNVERIFIED — cannot elevate the
  // ELIGIBILITY band; declaration ≠ verification). NO inference: the decomposed
  // richer fields (authorized_to_work_in / visa_type / requires_sponsorship) are
  // NOT derived from the status, location, or any résumé signal — they stay at
  // their empty/false defaults until a surface explicitly collects them (TI-1G
  // §2/§3). The caller (controller) enqueues Talent reconcile after this.
  async recordDeclaredWorkAuthorization(input: {
    talent_id: string;
    tenant_id: string;
    work_authorization_status: TalentWorkAuthorizationStatusValue;
    asserted_by: string;
  }): Promise<void> {
    await this.evidence.createTalentWorkAuthorization({
      id: uuidv7(),
      talent_id: input.talent_id,
      tenant_id: input.tenant_id,
      work_authorization_status: input.work_authorization_status,
      authorized_to_work_in: [],
      requires_sponsorship: false,
      updated_at: new Date(),
    });
    // Route the just-appended typed row into the RIGHT_TO_WORK trust ledger
    // (idempotent; source_ref = the typed row, so each assertion lands once).
    await this.routeDeclaredEvidenceToLedger({
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
    });
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
    // TALENT-INTEL-1 TI-1C — declared work-authorization → RIGHT_TO_WORK.
    work_authorization_written: number;
    skipped: number;
  }> {
    const talentIds = await this.evidence.listTalentIdsWithEvidenceByTenant(tenant_id);
    let skills_written = 0;
    let work_history_written = 0;
    let education_written = 0;
    let certification_written = 0;
    let work_authorization_written = 0;
    let skipped = 0;
    for (const talent_id of talentIds) {
      const r = await this.routeDeclaredEvidenceToLedger({ tenant_id, talent_id });
      skills_written += r.skills_written;
      work_history_written += r.work_history_written;
      education_written += r.education_written;
      certification_written += r.certification_written;
      work_authorization_written += r.work_authorization_written;
      skipped += r.skipped;
    }
    return {
      talents: talentIds.length,
      skills_written,
      work_history_written,
      education_written,
      certification_written,
      work_authorization_written,
      skipped,
    };
  }

  // TR-4 B2 (DDR §3.4) — the --all-tenants enumeration for the backfill CLI.
  async listTenantIdsWithEvidence(): Promise<string[]> {
    return this.evidence.listTenantIdsWithEvidence();
  }

  // Add-Talent governed-LLM DRAFT extraction (HF1 durable fact extraction).
  //
  // ONE governed model call (R6): a block-annotated, REDACTED (R10) rendering of
  // the Aramo-owned source-map → native JSON-schema structured output (R2) →
  // facts + source_refs. Grounding (R5) resolves each ref against the source-map
  // and validates the fact value locally — a ref to a nonexistent block, a ref
  // whose block text does not contain the value, or an unsupported fact is
  // REJECTED; valid facts survive the rejection of invalid ones (per-fact, §14).
  // PERSISTS NOTHING; writes no evidence/trust. Returns an EXPLICIT status (§13):
  // a technical failure (truncation / off-schema / provider error) NEVER
  // masquerades as a successful empty draft. NOTE: extractDeclaredEvidence (the
  // persisted Core evidence path) is intentionally NOT touched by this method.
  async extractResumeDraft(input: ResumeDraftInput): Promise<ResumeDraftResult> {
    const { source_map } = input;
    const emptyProposal = (): ResumeDraftProposal => ({
      skills: [],
      work_history: [],
      education: [],
      certifications: [],
      rejected_count: 0,
      overflow: false,
      source_map_version: source_map.version,
      resume_text_hash: source_map.text_hash,
    });

    // Nothing to structure → no model call; an honest 'partial' (NOT a failure,
    // NOT a success): there were no source blocks to extract from.
    if (source_map.blocks.length === 0) {
      return { status: 'partial', proposal: emptyProposal() };
    }

    // Render the block-annotated, REDACTED model input (§17/R10 — email / phone /
    // SSN / CC / routing never reach the model). Grounding below uses the RAW
    // block text (the Aramo-owned corpus); redaction only removes PII we never
    // extract, so no legitimate fact is lost.
    // Redact PII from the model input AND capture the masked email/phone values
    // in the SAME pass (no second scan): what we redact from the model is exactly
    // what we keep for the recruiter prefill. Email/phone are never sent to the
    // model; they flow to the prefill only, via the captured contact below.
    let redactedSpanCountInput = 0;
    const capturedEmails: string[] = [];
    const capturedPhones: string[] = [];
    const userContent = source_map.blocks
      .map((b) => {
        const { redactedText, spanCount, emails, phones } = redactPii(b.text);
        redactedSpanCountInput += spanCount;
        for (const e of emails) if (!capturedEmails.includes(e)) capturedEmails.push(e);
        for (const p of phones) if (!capturedPhones.includes(p)) capturedPhones.push(p);
        return `[${b.block_id}] ${redactedText}`;
      })
      .join('\n');

    // ONE native structured-output call (R2/R6). No retry (R6) — a truncation or
    // off-schema result is surfaced as an explicit failure status.
    const outcome = await this.structuredGen.generateStructured({
      model: ARAMO_AI_DRAFT_MODEL,
      system: DRAFT_SYSTEM_MESSAGE,
      user_content: userContent,
      max_tokens: RESUME_DRAFT_V3_MAX_TOKENS,
      json_schema: RESUME_DRAFT_SCHEMA,
      schema_name: RESUME_DRAFT_SCHEMA_NAME,
      // FORCED_TOOL transport (compatibility hotfix): the v3 schema is too large
      // for strict constrained-decoding grammar compilation, so this path uses a
      // single forced tool whose input_schema IS the v3 schema. Schema-GUIDED,
      // not grammar-CONSTRAINED — parseDraftStructured + stripTransportEmpties +
      // grounding remain the authoritative trust boundary. CI keeps STRICT.
      transport: 'FORCED_TOOL',
    });

    if (outcome.kind !== 'ok') {
      const status = mapOutcomeToFailure(outcome.category);
      this.logger.log({
        event: 'resume_draft.failed',
        tenant_id: input.tenant_id,
        prompt_version: RESUME_DRAFT_PROMPT_VERSION,
        schema_name: RESUME_DRAFT_SCHEMA_NAME,
        source_map_version: source_map.version,
        status,
        model_call_count: 1,
        input_chars: userContent.length,
        redacted_span_count_input: redactedSpanCountInput,
      });
      return { status, proposal: emptyProposal() };
    }

    // Transport → semantic normalization (compatibility hotfix): the provider
    // schema requires every property present, transporting "not stated" as ''/[]
    // (native structured output caps optional params at 24 + rejects maxItems).
    // Strip those transport empties back to absent BEFORE grounding so provider-
    // required presence never becomes domain-required data — the semantic v3
    // contract (genuinely-optional facts) is unchanged, and an '' field never
    // grounds, persists, or demands source evidence.
    const parsed = parseDraftStructured(stripTransportEmpties(outcome.parsed));
    // Block index for ref resolution (§5): id → RAW block text (grounding corpus).
    const blockIndex = new Map<string, string>(
      source_map.blocks.map((b) => [b.block_id, b.text] as const),
    );

    const proposal = emptyProposal();
    let rejected = 0;
    let sourceRefCount = 0;

    // Identity — each name part validated INDEPENDENTLY against the group's refs
    // (§9/§14 — a fabricated surname riding a real ref is dropped on its own).
    if (parsed.identity !== undefined) {
      const refs = parsed.identity.source_refs;
      const fn = (parsed.identity.first_name ?? '').trim();
      const ln = (parsed.identity.last_name ?? '').trim();
      if (fn !== '') {
        if (groundValue(fn, refs, blockIndex)) proposal.first_name = fn;
        else rejected += 1;
      }
      if (ln !== '') {
        if (groundValue(ln, refs, blockIndex)) proposal.last_name = ln;
        else rejected += 1;
      }
    }

    // Location — per-field grounding; distinguished from employer/school (§11).
    if (parsed.location !== undefined) {
      const refs = parsed.location.source_refs;
      const loc = parsed.location;
      const fields: Array<[keyof ResumeDraftLocation, string]> = [
        ['address', (loc.address ?? '').trim()],
        ['city', (loc.city ?? '').trim()],
        ['state', (loc.state ?? '').trim()],
        ['zip', (loc.zip ?? '').trim()],
        ['country', (loc.country ?? '').trim()],
      ];
      for (const [key, value] of fields) {
        if (value === '') continue;
        if (groundValue(value, refs, blockIndex)) {
          (proposal as unknown as Record<string, unknown>)[key as string] = value;
        } else {
          rejected += 1;
        }
      }
    }

    // Professional — current employer + most-recent title, per-field grounded.
    if (parsed.professional !== undefined) {
      const refs = parsed.professional.source_refs;
      const emp = (parsed.professional.current_employer ?? '').trim();
      const ttl = (parsed.professional.title ?? '').trim();
      if (emp !== '') {
        if (groundValue(emp, refs, blockIndex)) proposal.current_employer = emp;
        else rejected += 1;
      }
      if (ttl !== '') {
        if (groundValue(ttl, refs, blockIndex)) proposal.title = ttl;
        else rejected += 1;
      }
    }

    // Skills — grounded, atomic, de-duplicated (§12). The surface_form must be
    // supported by its cited blocks; a hallucinated skill is rejected. Structured
    // skills + their refs are CARRIED (R7 — not reduced to key_skills here).
    const seen = new Set<string>();
    for (const skill of parsed.skills) {
      const sf = skill.surface_form.trim();
      if (sf === '' || !groundValue(sf, skill.source_refs, blockIndex)) {
        rejected += 1;
        continue;
      }
      const key = sf.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const refs = dedupeRefs(skill.source_refs);
      sourceRefCount += refs.length;
      proposal.skills.push({ surface_form: sf, source_refs: refs });
    }

    // R12 — cardinality CEILINGS, enforced NON-SILENTLY: truncate overflow +
    // flag it (never drop quietly). The WorkExperience source_refs still span all
    // blocks, so complete evidence stays retrievable from the source-map.
    let overflow = false;
    const cap = <T,>(arr: readonly T[], max: number): T[] => {
      if (arr.length > max) overflow = true;
      return arr.slice(0, max);
    };

    // Work history — employer AND role must both ground against the entry's refs
    // (§5). Nested intelligence (summary/skill_usage/projects/assertions) is
    // grounded INDEPENDENTLY per item so one bad nested fact never destroys the
    // WorkExperience or its siblings (R-boundary). Declared, NOT verified.
    for (const wh of cap(parsed.work_history, MAX_WORK_HISTORY)) {
      const employer = wh.employer_name.trim();
      const role = wh.role_title.trim();
      if (
        employer === '' ||
        role === '' ||
        !groundValue(employer, wh.source_refs, blockIndex) ||
        !groundValue(role, wh.source_refs, blockIndex)
      ) {
        rejected += 1;
        continue;
      }
      const refs = dedupeRefs(wh.source_refs);
      sourceRefCount += refs.length;
      const location = (wh.location ?? '').trim();

      // skill_usage — surface_form + version are DIRECT_FACTs (substring-grounded
      // against the usage's OWN refs — the cross-role leakage guard: a skill only
      // attaches where its refs resolve + support it). `activity` is a
      // SOURCE_ASSOCIATED_INTERPRETATION (governed classification, carried, not
      // value-validated). usage dates: carried ONLY when the basis is EXPLICIT;
      // for WORK_EXPERIENCE_CONTEXT the model must not manufacture skill dates —
      // they are NULLED here and Aramo resolves the effective interval from the
      // parent WorkExperience at derivation time (P4 ruling; keeps stated evidence
      // separate from derived temporal intelligence).
      const skillUsage: ResumeDraftSkillUsage[] = [];
      for (const su of cap(wh.skill_usage ?? [], MAX_SKILL_USAGE_PER_EXP)) {
        const sf = su.surface_form.trim();
        if (sf === '' || !groundValue(sf, su.source_refs, blockIndex)) {
          rejected += 1;
          continue;
        }
        const suRefs = dedupeRefs(su.source_refs);
        sourceRefCount += suRefs.length;
        const version = (su.version ?? '').trim();
        const basis = (su.usage_period_basis ?? '').trim();
        const explicitDates = basis === 'EXPLICIT';
        skillUsage.push({
          surface_form: sf,
          ...(version !== '' && groundValue(version, su.source_refs, blockIndex)
            ? { version }
            : {}),
          ...(typeof su.activity === 'string' && su.activity.trim() !== ''
            ? { activity: su.activity.trim() }
            : {}),
          // Dates carried ONLY for EXPLICIT basis (stated skill dates); dropped
          // for WORK_EXPERIENCE_CONTEXT/UNKNOWN (resolved from the parent role).
          ...(explicitDates && typeof su.usage_start === 'string' && su.usage_start.trim() !== ''
            ? { usage_start: su.usage_start.trim() }
            : {}),
          ...(explicitDates && typeof su.usage_end === 'string' && su.usage_end.trim() !== ''
            ? { usage_end: su.usage_end.trim() }
            : {}),
          ...(basis !== '' ? { usage_period_basis: basis } : {}),
          source_refs: suRefs,
        });
      }

      // projects — refs must resolve; project_name (when present) is a DIRECT_FACT
      // (substring-grounded, never invented, R6); `context` is a
      // SOURCE_ASSOCIATED_INTERPRETATION (carried with valid refs, NOT validated).
      const projects: ResumeDraftProject[] = [];
      for (const pj of cap(wh.projects ?? [], MAX_PROJECTS_PER_EXP)) {
        if (!refsResolve(pj.source_refs, blockIndex)) {
          rejected += 1;
          continue;
        }
        const name = (pj.project_name ?? '').trim();
        // A named project must be supported; an unnamed initiative is allowed.
        if (name !== '' && !groundValue(name, pj.source_refs, blockIndex)) {
          rejected += 1;
          continue;
        }
        const pjRefs = dedupeRefs(pj.source_refs);
        sourceRefCount += pjRefs.length;
        projects.push({
          ...(name !== '' ? { project_name: name } : {}),
          ...(typeof pj.context === 'string' && pj.context.trim() !== ''
            ? { context: capWorkSummary(pj.context) }
            : {}),
          ...(typeof pj.domain === 'string' && pj.domain.trim() !== ''
            ? { domain: pj.domain.trim() }
            : {}),
          ...(typeof pj.start_date === 'string' && pj.start_date.trim() !== ''
            ? { start_date: pj.start_date.trim() }
            : {}),
          ...(typeof pj.end_date === 'string' && pj.end_date.trim() !== ''
            ? { end_date: pj.end_date.trim() }
            : {}),
          source_refs: pjRefs,
        });
      }

      // assertions — a SOURCE_ASSOCIATED_INTERPRETATION: refs must resolve, but
      // `type`(governed classification) + `statement`(paraphrase) are NOT value-
      // validated, so grounding_class is stamped explicitly. `metric` is a
      // DIRECT_FACT kept ONLY when it substring-grounds (never invented, R17).
      const assertions: ResumeDraftAssertion[] = [];
      for (const a of cap(wh.assertions ?? [], MAX_ASSERTIONS_PER_EXP)) {
        const statement = a.statement.trim();
        const type = a.type.trim();
        if (statement === '' || type === '' || !refsResolve(a.source_refs, blockIndex)) {
          rejected += 1;
          continue;
        }
        const aRefs = dedupeRefs(a.source_refs);
        sourceRefCount += aRefs.length;
        const metric = (a.metric ?? '').trim();
        assertions.push({
          type,
          statement: capWorkSummary(statement),
          ...(metric !== '' && groundValue(metric, a.source_refs, blockIndex)
            ? { metric }
            : {}),
          grounding_class: 'SOURCE_ASSOCIATED_INTERPRETATION',
          source_refs: aRefs,
        });
      }

      // experience_summary — rides the fact-grounded entry (refs valid by
      // construction); hard-capped to 600 (R10).
      const summary =
        typeof wh.experience_summary === 'string' ? capWorkSummary(wh.experience_summary) : '';

      proposal.work_history.push({
        employer_name: employer,
        role_title: role,
        ...(location !== '' && groundValue(location, wh.source_refs, blockIndex)
          ? { location }
          : {}),
        ...(typeof wh.start_date === 'string' && wh.start_date.trim() !== ''
          ? { start_date: wh.start_date.trim() }
          : {}),
        ...(typeof wh.end_date === 'string' && wh.end_date.trim() !== ''
          ? { end_date: wh.end_date.trim() }
          : {}),
        ...(typeof wh.employment_type === 'string' && wh.employment_type.trim() !== ''
          ? { employment_type: wh.employment_type.trim() }
          : {}),
        ...(summary !== '' ? { experience_summary: summary } : {}),
        source_refs: refs,
        ...(skillUsage.length > 0 ? { skill_usage: skillUsage } : {}),
        ...(projects.length > 0 ? { projects } : {}),
        ...(assertions.length > 0 ? { assertions } : {}),
      });
    }

    // Education — institution + degree must both ground (§5); source_refs carried.
    for (const ed of cap(parsed.education, MAX_EDUCATION)) {
      const inst = ed.institution_name.trim();
      const degree = ed.degree_name.trim();
      if (
        inst === '' ||
        degree === '' ||
        !groundValue(inst, ed.source_refs, blockIndex) ||
        !groundValue(degree, ed.source_refs, blockIndex)
      ) {
        rejected += 1;
        continue;
      }
      const edRefs = dedupeRefs(ed.source_refs);
      sourceRefCount += edRefs.length;
      proposal.education.push({
        institution_name: inst,
        degree_name: degree,
        ...(typeof ed.field_of_study === 'string' && ed.field_of_study.trim() !== ''
          ? { field_of_study: ed.field_of_study.trim() }
          : {}),
        ...(typeof ed.conferred_date === 'string' && ed.conferred_date.trim() !== ''
          ? { conferred_date: ed.conferred_date.trim() }
          : {}),
        source_refs: edRefs,
      });
    }

    // Certifications — certification_name must ground (§5); source_refs carried.
    for (const ct of cap(parsed.certifications, MAX_CERTIFICATIONS)) {
      const name = ct.certification_name.trim();
      if (name === '' || !groundValue(name, ct.source_refs, blockIndex)) {
        rejected += 1;
        continue;
      }
      const ctRefs = dedupeRefs(ct.source_refs);
      sourceRefCount += ctRefs.length;
      proposal.certifications.push({
        certification_name: name,
        ...(typeof ct.issuer_name === 'string' && ct.issuer_name.trim() !== ''
          ? { issuer_name: ct.issuer_name.trim() }
          : {}),
        ...(typeof ct.credential_ref === 'string' && ct.credential_ref.trim() !== ''
          ? { credential_ref: ct.credential_ref.trim() }
          : {}),
        ...(typeof ct.issued_date === 'string' && ct.issued_date.trim() !== ''
          ? { issued_date: ct.issued_date.trim() }
          : {}),
        ...(typeof ct.expiry_date === 'string' && ct.expiry_date.trim() !== ''
          ? { expiry_date: ct.expiry_date.trim() }
          : {}),
        ...(typeof ct.version_or_level === 'string' && ct.version_or_level.trim() !== ''
          ? { version_or_level: ct.version_or_level.trim() }
          : {}),
        source_refs: ctRefs,
      });
    }

    proposal.rejected_count = rejected;
    proposal.overflow = overflow;

    const factCount = countFacts(proposal);
    // success = grounded facts, nothing rejected, no overflow; else partial —
    // R12: overflow is a visible partial/incomplete condition, never silent.
    const status: ResumeDraftStatus =
      factCount > 0 && rejected === 0 && !overflow ? 'success' : 'partial';

    // PII-floor instrumentation (§17): counts + token/byte metrics only, never
    // content. `completion_bytes` is the structured payload size — the metric the
    // HF1 before/after table tracks (§25): it now grows with facts, not prose.
    this.logger.log({
      event: 'resume_draft.extracted',
      tenant_id: input.tenant_id,
      prompt_version: RESUME_DRAFT_PROMPT_VERSION,
      schema_name: RESUME_DRAFT_SCHEMA_NAME,
      source_map_version: source_map.version,
      status,
      model_call_count: 1,
      input_chars: userContent.length,
      input_tokens: outcome.transport.input_tokens,
      output_tokens: outcome.transport.output_tokens,
      completion_bytes: Buffer.byteLength(JSON.stringify(outcome.parsed), 'utf8'),
      fact_count: factCount,
      source_ref_count: sourceRefCount,
      skills_count: proposal.skills.length,
      work_history_count: proposal.work_history.length,
      skill_usage_count: proposal.work_history.reduce((n, w) => n + (w.skill_usage?.length ?? 0), 0),
      project_count: proposal.work_history.reduce((n, w) => n + (w.projects?.length ?? 0), 0),
      assertion_count: proposal.work_history.reduce((n, w) => n + (w.assertions?.length ?? 0), 0),
      education_count: proposal.education.length,
      certification_count: proposal.certifications.length,
      overflow: proposal.overflow,
      rejected_count: rejected,
      redacted_span_count_input: redactedSpanCountInput,
    });

    // `contact` carries the email/phone captured during redaction (never sent to
    // the model) — the controller merges them into the recruiter prefill.
    return { status, proposal, contact: { emails: capturedEmails, phones: capturedPhones } };
  }

  // Persist recruiter-REVIEWED work-history at Add-Talent create time (LOCKED
  // scope expansion). Writes each entry as a declared TalentWorkHistoryEntry
  // (source='resume') keyed to the freshly-created talent. These are DECLARED,
  // NOT verified (ADR-0015 v1.3 §4.3) — no trust/verification state is set.
  // Reuses this service's TalentEvidenceRepository (no new cross-lib edge from
  // talent-record). Rows missing the required employer/role are skipped. Free-
  // text dates persist only when they parse to a real calendar date ('present'
  // → no end_date = ongoing). Returns the created ids.
  async persistDeclaredWorkHistory(input: {
    talent_id: string;
    tenant_id: string;
    entries: readonly ResumeDraftWorkHistory[];
    // HF1 durable provenance (Gate-6 R8) — the résumé TalentDocument + the corpus
    // the entry's source_refs resolve against. All optional; when absent the rows
    // persist with NULL/empty provenance (unchanged pre-HF1 behavior).
    provenance?: ResumeProvenance;
  }): Promise<string[]> {
    const ids: string[] = [];
    const createdAt = new Date();
    for (const e of input.entries) {
      const employer = e.employer_name.trim();
      const role = e.role_title.trim();
      if (employer === '' || role === '') continue;
      const start = parseWorkHistoryDate(e.start_date);
      const end = parseWorkHistoryDate(e.end_date);
      const workExperienceId = uuidv7();
      const summary =
        typeof e.experience_summary === 'string' ? capWorkSummary(e.experience_summary) : '';
      await this.evidence.createTalentWorkHistoryEntry({
        id: workExperienceId,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        employer_name: employer,
        role_title: role,
        source: 'resume',
        ...(start !== null ? { start_date: start } : {}),
        ...(end !== null ? { end_date: end } : {}),
        ...(typeof e.employment_type === 'string' && e.employment_type.trim() !== ''
          ? { employment_type: e.employment_type.trim() }
          : {}),
        ...(typeof e.location === 'string' && e.location.trim() !== ''
          ? { location: e.location.trim() }
          : {}),
        ...(typeof e.description === 'string' && e.description.trim() !== ''
          ? { description_text: e.description.trim() }
          : {}),
        // HF2 R10 — the bounded recruiter-facing role summary (≤600). company_id
        // stays NULL: company RESOLUTION is out of scope (the null column is the
        // forward seam; THE WALL forbids importing company here, ADR-0029/I15).
        ...(summary !== '' ? { experience_summary: summary } : {}),
        // HF1 provenance — per-entry source_refs + the shared document/corpus anchors.
        ...provenanceFields(e.source_refs, input.provenance),
        created_at: createdAt,
      });
      ids.push(workExperienceId);

      // HF2 R3/R16 — the role's time-aware SkillUsage evidence (each row keyed to
      // this WorkExperience). Declared, NOT scored (source='declared'; no
      // confidence). usage_start/end persist ONLY when the résumé stated the
      // skill's OWN dates (EXPLICIT); WORK_EXPERIENCE_CONTEXT leaves them NULL
      // (never manufactured — P4 ruling), the derivation resolves the interval
      // from this role instead.
      await this.persistRoleSkillUsage({
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        work_experience_id: workExperienceId,
        skill_usage: e.skill_usage ?? [],
        provenance: input.provenance,
        createdAt,
      });

      // HF2 R6 — named/unnamed projects within the role.
      await this.persistRoleProjects({
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        work_experience_id: workExperienceId,
        projects: e.projects ?? [],
        provenance: input.provenance,
        createdAt,
      });

      // HF2 R1/R7 — activity/accomplishment assertions → EvidenceRecord ledger
      // (EXPERIENCE_CLAIM, deterministic, non-authoritative — P5).
      if (Array.isArray(e.assertions) && e.assertions.length > 0) {
        await this.persistExperienceAssertions({
          talent_id: input.talent_id,
          tenant_id: input.tenant_id,
          work_experience_id: workExperienceId,
          assertions: e.assertions,
        });
      }
    }

    // HF2 R14 — the derived skill-years snapshot (union, not sum), computed ONLY
    // on normalized dates (R27). Best-effort: a snapshot hiccup must not fail the
    // evidence writes above (the controller's create path is already soft-fail).
    await this.persistDerivedSkillSnapshot({
      talent_id: input.talent_id,
      tenant_id: input.tenant_id,
      entries: input.entries,
      createdAt,
    });

    return ids;
  }

  // HF2 R3/R16 — persist one role's SkillUsage rows. version + usage dates are
  // DIRECT_FACT (carried only when the model grounded them); activity_context is
  // the governed activity token (SOURCE_ASSOCIATED_INTERPRETATION). Deterministic.
  private async persistRoleSkillUsage(input: {
    talent_id: string;
    tenant_id: string;
    work_experience_id: string;
    skill_usage: readonly ResumeDraftSkillUsage[];
    provenance?: ResumeProvenance;
    createdAt: Date;
  }): Promise<void> {
    for (const su of input.skill_usage) {
      const surface = su.surface_form.trim();
      if (surface === '') continue;
      // usage_start/end stored ONLY at EXPLICIT basis AND when strictly parseable
      // (a year-only "2021" anchors to its month edge; ambiguous text → NULL,
      // never a fabricated day — R27). WORK_EXPERIENCE_CONTEXT keeps them NULL.
      const explicit = su.usage_period_basis === 'EXPLICIT';
      const usageStart = explicit ? resumeDateToDbDate(su.usage_start, 'start') : null;
      const usageEnd = explicit ? resumeDateToDbDate(su.usage_end, 'end') : null;
      await this.evidence.createTalentSkillEvidence({
        id: uuidv7(),
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        skill_id: deriveSkillId(surface),
        surface_form: surface,
        source: 'declared',
        work_experience_id: input.work_experience_id,
        ...(typeof su.version === 'string' && su.version.trim() !== ''
          ? { version: su.version.trim() }
          : {}),
        ...(usageStart !== null ? { usage_start: usageStart } : {}),
        ...(usageEnd !== null ? { usage_end: usageEnd } : {}),
        ...(typeof su.usage_period_basis === 'string' && su.usage_period_basis.trim() !== ''
          ? { usage_period_basis: su.usage_period_basis.trim() }
          : {}),
        ...(typeof su.activity === 'string' && su.activity.trim() !== ''
          ? { activity_context: su.activity.trim() }
          : {}),
        ...provenanceFields(su.source_refs, input.provenance),
        created_at: input.createdAt,
      });
    }
  }

  // HF2 R6 — persist one role's ProjectExperience rows. project_name (when named)
  // is DIRECT_FACT; context_summary/domain are SOURCE_ASSOCIATED_INTERPRETATION.
  private async persistRoleProjects(input: {
    talent_id: string;
    tenant_id: string;
    work_experience_id: string;
    projects: readonly ResumeDraftProject[];
    provenance?: ResumeProvenance;
    createdAt: Date;
  }): Promise<void> {
    for (const pj of input.projects) {
      const name = typeof pj.project_name === 'string' ? pj.project_name.trim() : '';
      const context = typeof pj.context === 'string' ? capWorkSummary(pj.context) : '';
      const domain = typeof pj.domain === 'string' ? pj.domain.trim() : '';
      // A project with neither a name nor any context is empty noise — skip it.
      if (name === '' && context === '' && domain === '') continue;
      const pStart = resumeDateToDbDate(pj.start_date, 'start');
      const pEnd = resumeDateToDbDate(pj.end_date, 'end');
      await this.evidence.createTalentProjectExperience({
        id: uuidv7(),
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        work_experience_id: input.work_experience_id,
        ...(name !== '' ? { project_name: name } : {}),
        ...(context !== '' ? { context_summary: context } : {}),
        ...(domain !== '' ? { domain } : {}),
        ...(pStart !== null ? { start_date: pStart } : {}),
        ...(pEnd !== null ? { end_date: pEnd } : {}),
        ...provenanceFields(pj.source_refs, input.provenance),
        created_at: input.createdAt,
      });
    }
  }

  // HF2 R14 — derive + persist the union-based skill-years snapshot. Declared,
  // NOT scored (skill_confidence_scores = {} — R3); estimated years are the
  // interval-UNION per skill (concurrent roles counted once), carrying the
  // COARSEST input precision so a year-only estimate is never presented as exact.
  private async persistDerivedSkillSnapshot(input: {
    talent_id: string;
    tenant_id: string;
    entries: readonly ResumeDraftWorkHistory[];
    createdAt: Date;
  }): Promise<void> {
    const derived = deriveResumeSkillYears(input.entries, dateToResumeDate(input.createdAt));
    // Nothing datable → no snapshot (avoid an all-null row).
    if (derived.overall_years === null && Object.keys(derived.by_skill).length === 0) return;
    await this.evidence.createTalentDerivedSnapshot({
      id: uuidv7(),
      talent_id: input.talent_id,
      tenant_id: input.tenant_id,
      // R3 — declared, not scored: no confidence is computed on this path.
      skill_confidence_scores: {},
      ...(derived.overall_years !== null
        ? { estimated_years_experience_overall: derived.overall_years }
        : {}),
      estimated_years_experience_by_skill: derived.by_skill,
      computed_at: input.createdAt,
    });
  }

  // HF1 Gate-6 R1 — create the résumé's TalentDocument AFTER confirmed Talent
  // creation (never at draft/proposal time — the review-before-create contract).
  // Deterministic; the returned id becomes source_document_id on the evidence
  // rows. Reuses this service's TalentEvidenceRepository (no new cross-lib edge).
  async createResumeDocument(input: {
    talent_id: string;
    tenant_id: string;
    uploaded_by_actor_id: string;
    storage_key: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
  }): Promise<string> {
    const id = uuidv7();
    await this.evidence.createTalentDocument({
      id,
      talent_id: input.talent_id,
      tenant_id: input.tenant_id,
      uploaded_by_actor_id: input.uploaded_by_actor_id,
      uploaded_at: new Date(),
      document_type: 'resume',
      filename: input.filename,
      file_storage_ref: input.storage_key,
      mime_type: input.mime_type,
      size_bytes: input.size_bytes,
      // The governed extraction ran off this document's text — 'parsed'.
      parse_status: 'parsed',
      consent_scope_at_upload: [],
      retention_policy: 'default',
      is_active: true,
    });
    return id;
  }

  // TALENT-INTEL-1 TI-1D-C — thin résumé-edition passthroughs (reuse this
  // service's TalentEvidenceRepository; no new cross-lib edge). The composition /
  // ingestion policy (idempotency, default-if-none) lives in the talent-record
  // ResumeEditionIngestionService; these only forward to the ledger repo.
  async createResumeEdition(
    input: CreateTalentResumeEditionInput,
  ): Promise<TalentResumeEditionRow> {
    return this.evidence.createTalentResumeEdition(input);
  }

  async findResumeEditionByDocument(
    talentDocumentId: string,
  ): Promise<TalentResumeEditionRow | null> {
    return this.evidence.findResumeEditionByDocumentId(talentDocumentId);
  }

  async findResumeEditionById(id: string): Promise<TalentResumeEditionRow | null> {
    return this.evidence.findTalentResumeEditionById(id);
  }

  async listResumeEditionsWithDocument(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<TalentResumeEditionWithDocumentRow[]> {
    return this.evidence.findResumeEditionsWithDocumentByTalent(args);
  }

  async setDefaultResumeEdition(
    input: SetTalentResumeDefaultInput,
  ): Promise<TalentResumeDefaultRow> {
    return this.evidence.setDefaultResumeEdition(input);
  }

  async getDefaultResumeEdition(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<TalentResumeDefaultRow | null> {
    return this.evidence.findDefaultResumeEdition(args);
  }

  // TALENT-INTEL-1 (TI-1F-A) — thin ResumeExtractionDraft passthroughs (reuse
  // this service's TalentEvidenceRepository; no new cross-lib edge). The draft is
  // the durable governed-extraction REVIEW artifact — NOT Talent evidence, NOT
  // authoritative until recruiter confirm (TI-1F-B).
  async upsertResumeExtractionDraft(
    input: Omit<UpsertResumeExtractionDraftInput, 'id'>,
  ): Promise<ResumeExtractionDraftRow> {
    // The id is only consumed on CREATE; on an idempotent conflict the existing
    // draft (with its original id) is returned unchanged.
    return this.evidence.upsertResumeExtractionDraft({ id: uuidv7(), ...input });
  }

  async findResumeExtractionDraftBySource(args: {
    tenant_id: string;
    source_kind: ResumeExtractionDraftSourceKindValue;
    source_ref: string;
  }): Promise<ResumeExtractionDraftRow | null> {
    return this.evidence.findResumeExtractionDraftBySource(args);
  }

  async findProcessingResumeExtractionDrafts(args: {
    limit: number;
  }): Promise<ResumeExtractionDraftRow[]> {
    return this.evidence.findProcessingResumeExtractionDrafts(args);
  }

  async markResumeExtractionDraftReadyForReview(input: {
    id: string;
    structured_payload: unknown;
    extractor_version?: string | null;
    source_map_version?: string | null;
    resume_text_hash?: string | null;
  }): Promise<void> {
    return this.evidence.markResumeExtractionDraftReadyForReview(input);
  }

  async markResumeExtractionDraftFailed(input: {
    id: string;
    last_error_code: string;
    last_error_at: Date;
  }): Promise<void> {
    return this.evidence.markResumeExtractionDraftFailed(input);
  }

  // TI-1F-B — review-context lookup for an EXISTING-Talent confirm.
  async findResumeExtractionDraftByEdition(args: {
    tenant_id: string;
    resume_edition_id: string;
  }): Promise<ResumeExtractionDraftRow | null> {
    return this.evidence.findResumeExtractionDraftByEdition(args);
  }

  // TI-1F-B — CREATE_DRAFT_UPLOAD close-out: link + ACCEPT the originating draft
  // on a confirmed create. Returns rows affected (0 = not reviewable → no-op).
  async markResumeExtractionDraftAccepted(input: {
    id: string;
    tenant_id: string;
    talent_id?: string | null;
    talent_document_id?: string | null;
    resume_edition_id?: string | null;
    reviewed_by: string;
    reviewed_at: Date;
  }): Promise<number> {
    return this.evidence.markResumeExtractionDraftAccepted(input);
  }

  // TI-1F-B — REJECT: no typed evidence, no reconciliation (§3). Returns rows
  // affected (0 = not reviewable → caller 409s).
  async markResumeExtractionDraftRejected(input: {
    id: string;
    tenant_id: string;
    reviewed_by: string;
    reviewed_at: Date;
  }): Promise<number> {
    return this.evidence.markResumeExtractionDraftRejected(input);
  }

  // TI-1F-B — the EXISTING-Talent CONFIRM promotion (directive §3, §4-E/F/G).
  // Reads the grounded facts the governed extractor already persisted onto the
  // draft in A (structured_payload — NO re-extraction, one shared extractor, §6),
  // shapes them into typed-evidence rows anchored on source_document_id (the
  // draft's talent_document_id — NEVER resume_edition_id, §4-F), and hands them to
  // the repository's ATOMIC promotion (persist ALL accepted facts + flip the draft
  // READY_FOR_REVIEW → ACCEPTED in one tx; §4-E). Prior evidence is PRESERVED —
  // these are additive creates, never a replace-set (§4-G). Trust projection,
  // the derived skill-years snapshot, and reconciliation run AFTER commit
  // (idempotent, §4-E) — the raw fact promotion is the only atomic unit here;
  // Talent/skill reconcile SIGNALS are TI-1F-C. Mirrors the create-path persister
  // shaping (persistDeclared*) via the shared row helpers.
  async promoteResumeExtractionDraft(input: {
    draft: ResumeExtractionDraftRow;
    actor_id: string;
    reviewed_at?: Date;
  }): Promise<{
    work_history_ids: string[];
    skill_evidence_ids: string[];
    project_ids: string[];
    education_ids: string[];
    certification_ids: string[];
  }> {
    const draft = input.draft;
    if (draft.talent_id == null || draft.talent_document_id == null) {
      // Evidence MUST anchor a Talent + a source document; an ATTACHMENT draft
      // always carries both (A's add-edition sets them). Defensive: the controller
      // pre-validates + maps this to a 422 — a missing anchor is a structural
      // fault, never a silent no-op.
      throw new Error('resume-extraction-draft-missing-promotion-anchor');
    }
    const talent_id = draft.talent_id;
    const tenant_id = draft.tenant_id;
    const reviewed_at = input.reviewed_at ?? new Date();
    const createdAt = reviewed_at;
    const payload = (draft.structured_payload ?? {}) as {
      work_history?: readonly ResumeDraftWorkHistory[];
      skills?: readonly ResumeDraftSkill[];
      education?: readonly ResumeDraftEducation[];
      certifications?: readonly ResumeDraftCertification[];
      source_map_version?: string | null;
      resume_text_hash?: string | null;
    };
    // §4-F — provenance is the source DOCUMENT, never the edition.
    const provenance: ResumeProvenance = {
      source_document_id: draft.talent_document_id,
      ...(typeof payload.source_map_version === 'string'
        ? { source_map_version: payload.source_map_version }
        : {}),
      ...(typeof payload.resume_text_hash === 'string'
        ? { resume_text_hash: payload.resume_text_hash }
        : {}),
    };

    const workHistory: CreateTalentWorkHistoryEntryInput[] = [];
    const skillEvidence: CreateTalentSkillEvidenceInput[] = [];
    const projects: CreateTalentProjectExperienceInput[] = [];
    const assertionTasks: { work_experience_id: string; assertions: readonly ResumeDraftAssertion[] }[] = [];

    for (const e of payload.work_history ?? []) {
      const employer = e.employer_name.trim();
      const role = e.role_title.trim();
      if (employer === '' || role === '') continue;
      const start = parseWorkHistoryDate(e.start_date);
      const end = parseWorkHistoryDate(e.end_date);
      const workExperienceId = uuidv7();
      const summary =
        typeof e.experience_summary === 'string' ? capWorkSummary(e.experience_summary) : '';
      workHistory.push({
        id: workExperienceId,
        talent_id,
        tenant_id,
        employer_name: employer,
        role_title: role,
        source: 'resume',
        ...(start !== null ? { start_date: start } : {}),
        ...(end !== null ? { end_date: end } : {}),
        ...(typeof e.employment_type === 'string' && e.employment_type.trim() !== ''
          ? { employment_type: e.employment_type.trim() }
          : {}),
        ...(typeof e.location === 'string' && e.location.trim() !== ''
          ? { location: e.location.trim() }
          : {}),
        ...(typeof e.description === 'string' && e.description.trim() !== ''
          ? { description_text: e.description.trim() }
          : {}),
        ...(summary !== '' ? { experience_summary: summary } : {}),
        ...provenanceFields(e.source_refs, provenance),
        created_at: createdAt,
      });

      for (const su of e.skill_usage ?? []) {
        const surface = su.surface_form.trim();
        if (surface === '') continue;
        const explicit = su.usage_period_basis === 'EXPLICIT';
        const usageStart = explicit ? resumeDateToDbDate(su.usage_start, 'start') : null;
        const usageEnd = explicit ? resumeDateToDbDate(su.usage_end, 'end') : null;
        skillEvidence.push({
          id: uuidv7(),
          talent_id,
          tenant_id,
          skill_id: deriveSkillId(surface),
          surface_form: surface,
          source: 'declared',
          work_experience_id: workExperienceId,
          ...(typeof su.version === 'string' && su.version.trim() !== ''
            ? { version: su.version.trim() }
            : {}),
          ...(usageStart !== null ? { usage_start: usageStart } : {}),
          ...(usageEnd !== null ? { usage_end: usageEnd } : {}),
          ...(typeof su.usage_period_basis === 'string' && su.usage_period_basis.trim() !== ''
            ? { usage_period_basis: su.usage_period_basis.trim() }
            : {}),
          ...(typeof su.activity === 'string' && su.activity.trim() !== ''
            ? { activity_context: su.activity.trim() }
            : {}),
          ...provenanceFields(su.source_refs, provenance),
          created_at: createdAt,
        });
      }

      for (const pj of e.projects ?? []) {
        const name = typeof pj.project_name === 'string' ? pj.project_name.trim() : '';
        const context = typeof pj.context === 'string' ? capWorkSummary(pj.context) : '';
        const domain = typeof pj.domain === 'string' ? pj.domain.trim() : '';
        if (name === '' && context === '' && domain === '') continue;
        const pStart = resumeDateToDbDate(pj.start_date, 'start');
        const pEnd = resumeDateToDbDate(pj.end_date, 'end');
        projects.push({
          id: uuidv7(),
          talent_id,
          tenant_id,
          work_experience_id: workExperienceId,
          ...(name !== '' ? { project_name: name } : {}),
          ...(context !== '' ? { context_summary: context } : {}),
          ...(domain !== '' ? { domain } : {}),
          ...(pStart !== null ? { start_date: pStart } : {}),
          ...(pEnd !== null ? { end_date: pEnd } : {}),
          ...provenanceFields(pj.source_refs, provenance),
          created_at: createdAt,
        });
      }

      if (Array.isArray(e.assertions) && e.assertions.length > 0) {
        assertionTasks.push({ work_experience_id: workExperienceId, assertions: e.assertions });
      }
    }

    // Declared top-level skills (dedup by lowercased surface, mirroring the create
    // path). These skill rows carry no work_experience_id.
    const seen = new Set<string>();
    for (const s of payload.skills ?? []) {
      const surface = s.surface_form.trim();
      if (surface === '') continue;
      const key = surface.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      skillEvidence.push({
        id: uuidv7(),
        talent_id,
        tenant_id,
        skill_id: deriveSkillId(surface),
        surface_form: surface,
        source: 'declared',
        ...provenanceFields(s.source_refs, provenance),
        created_at: createdAt,
      });
    }

    const education: CreateTalentEducationEntryInput[] = [];
    for (const ed of payload.education ?? []) {
      const institution = ed.institution_name.trim();
      const degree = ed.degree_name.trim();
      if (institution === '' || degree === '') continue;
      const conferred = resumeDateToDbDate(ed.conferred_date, 'end');
      education.push({
        id: uuidv7(),
        talent_id,
        tenant_id,
        institution_name: institution,
        degree_name: degree,
        source: 'resume',
        ...(typeof ed.field_of_study === 'string' && ed.field_of_study.trim() !== ''
          ? { field_of_study: ed.field_of_study.trim() }
          : {}),
        ...(conferred !== null ? { conferred_date: conferred } : {}),
        ...provenanceFields(ed.source_refs, provenance),
        created_at: createdAt,
      });
    }

    const certifications: CreateTalentCertificationEntryInput[] = [];
    for (const c of payload.certifications ?? []) {
      const name = c.certification_name.trim();
      if (name === '') continue;
      const issued = resumeDateToDbDate(c.issued_date, 'start');
      const expiry = resumeDateToDbDate(c.expiry_date, 'end');
      certifications.push({
        id: uuidv7(),
        talent_id,
        tenant_id,
        certification_name: name,
        source: 'resume',
        ...(typeof c.issuer_name === 'string' && c.issuer_name.trim() !== ''
          ? { issuer_name: c.issuer_name.trim() }
          : {}),
        ...(typeof c.credential_ref === 'string' && c.credential_ref.trim() !== ''
          ? { credential_ref: c.credential_ref.trim() }
          : {}),
        ...(issued !== null ? { issued_date: issued } : {}),
        ...(expiry !== null ? { expiry_date: expiry } : {}),
        ...provenanceFields(c.source_refs, provenance),
        created_at: createdAt,
      });
    }

    // §4-E — the ONLY atomic unit: persist ALL accepted typed facts + flip the
    // draft to ACCEPTED, all-or-none.
    const result = await this.evidence.promoteResumeExtractionDraftEvidence({
      draft_id: draft.id,
      tenant_id,
      reviewed_by: input.actor_id,
      reviewed_at,
      work_history: workHistory,
      skill_evidence: skillEvidence,
      projects,
      education,
      certifications,
    });

    // AFTER commit (idempotent projections, §4-E) — best-effort: a hiccup here
    // never un-promotes the committed evidence. The derived skill-years snapshot
    // and the experience-assertion trust claims are projections of the now-
    // committed facts. Talent/skill canonical RECONCILE signals are TI-1F-C.
    try {
      await this.persistDerivedSkillSnapshot({
        talent_id,
        tenant_id,
        entries: payload.work_history ?? [],
        createdAt,
      });
    } catch {
      // non-fatal projection
    }
    for (const task of assertionTasks) {
      try {
        await this.persistExperienceAssertions({
          talent_id,
          tenant_id,
          work_experience_id: task.work_experience_id,
          assertions: task.assertions,
        });
      } catch {
        // non-fatal trust projection
      }
    }

    return result;
  }

  // TI-1F-C — CREATE_DRAFT_UPLOAD confirm lookup (by draft id).
  async findResumeExtractionDraftById(args: {
    tenant_id: string;
    id: string;
  }): Promise<ResumeExtractionDraftRow | null> {
    return this.evidence.findResumeExtractionDraftById(args);
  }

  // TALENT-INTEL-1 TI-1F-C (strengthened-D, PHASE 1) — establish the accepted
  // résumé evidence lifecycle for a first-time create against a RESERVED talent_id,
  // in ONE atomic talent_evidence transaction, WITHOUT finalizing the draft. Shapes
  // the recruiter-reviewed create-body facts into typed-evidence rows anchored on a
  // freshly-minted résumé TalentDocument (§4-F), then hands document + companion
  // default edition + all evidence + the draft-LINK (talent_id/doc/edition, draft
  // stays READY_FOR_REVIEW) to the repository's atomic writer. No model call — the
  // governed extraction already ran in A; these are the reviewed facts. The derived
  // snapshot + assertion trust claims run POST-commit (idempotent projections). The
  // shaping mirrors promoteResumeExtractionDraft (the review path) + the create-
  // persister mapping; ACCEPTED is written later (phase 3) once the Talent exists.
  async establishCreateDraftEvidence(input: {
    tenant_id: string;
    talent_id: string;
    actor_id: string;
    draft_id: string;
    resume_document: {
      storage_key: string;
      file_name: string;
      mime_type: string;
      size_bytes: number;
      source_map_version?: string;
      resume_text_hash?: string;
    };
    work_history?: readonly ResumeDraftWorkHistory[];
    skills?: readonly ResumeDraftSkill[];
    education?: readonly ResumeDraftEducation[];
    certifications?: readonly ResumeDraftCertification[];
  }): Promise<{ document_id: string; edition_id: string }> {
    const { tenant_id, talent_id } = input;
    const createdAt = new Date();
    const documentId = uuidv7();
    // §4-F — provenance is the (about-to-be-created) source DOCUMENT.
    const provenance: ResumeProvenance = {
      source_document_id: documentId,
      ...(typeof input.resume_document.source_map_version === 'string'
        ? { source_map_version: input.resume_document.source_map_version }
        : {}),
      ...(typeof input.resume_document.resume_text_hash === 'string'
        ? { resume_text_hash: input.resume_document.resume_text_hash }
        : {}),
    };

    const workHistory: CreateTalentWorkHistoryEntryInput[] = [];
    const skillEvidence: CreateTalentSkillEvidenceInput[] = [];
    const projects: CreateTalentProjectExperienceInput[] = [];
    const assertionTasks: { work_experience_id: string; assertions: readonly ResumeDraftAssertion[] }[] = [];

    for (const e of input.work_history ?? []) {
      const employer = e.employer_name.trim();
      const role = e.role_title.trim();
      if (employer === '' || role === '') continue;
      const start = parseWorkHistoryDate(e.start_date);
      const end = parseWorkHistoryDate(e.end_date);
      const workExperienceId = uuidv7();
      const summary =
        typeof e.experience_summary === 'string' ? capWorkSummary(e.experience_summary) : '';
      workHistory.push({
        id: workExperienceId,
        talent_id,
        tenant_id,
        employer_name: employer,
        role_title: role,
        source: 'resume',
        ...(start !== null ? { start_date: start } : {}),
        ...(end !== null ? { end_date: end } : {}),
        ...(typeof e.employment_type === 'string' && e.employment_type.trim() !== ''
          ? { employment_type: e.employment_type.trim() }
          : {}),
        ...(typeof e.location === 'string' && e.location.trim() !== ''
          ? { location: e.location.trim() }
          : {}),
        ...(typeof e.description === 'string' && e.description.trim() !== ''
          ? { description_text: e.description.trim() }
          : {}),
        ...(summary !== '' ? { experience_summary: summary } : {}),
        ...provenanceFields(e.source_refs, provenance),
        created_at: createdAt,
      });
      for (const su of e.skill_usage ?? []) {
        const surface = su.surface_form.trim();
        if (surface === '') continue;
        const explicit = su.usage_period_basis === 'EXPLICIT';
        const usageStart = explicit ? resumeDateToDbDate(su.usage_start, 'start') : null;
        const usageEnd = explicit ? resumeDateToDbDate(su.usage_end, 'end') : null;
        skillEvidence.push({
          id: uuidv7(),
          talent_id,
          tenant_id,
          skill_id: deriveSkillId(surface),
          surface_form: surface,
          source: 'declared',
          work_experience_id: workExperienceId,
          ...(typeof su.version === 'string' && su.version.trim() !== ''
            ? { version: su.version.trim() }
            : {}),
          ...(usageStart !== null ? { usage_start: usageStart } : {}),
          ...(usageEnd !== null ? { usage_end: usageEnd } : {}),
          ...(typeof su.usage_period_basis === 'string' && su.usage_period_basis.trim() !== ''
            ? { usage_period_basis: su.usage_period_basis.trim() }
            : {}),
          ...(typeof su.activity === 'string' && su.activity.trim() !== ''
            ? { activity_context: su.activity.trim() }
            : {}),
          ...provenanceFields(su.source_refs, provenance),
          created_at: createdAt,
        });
      }
      for (const pj of e.projects ?? []) {
        const name = typeof pj.project_name === 'string' ? pj.project_name.trim() : '';
        const context = typeof pj.context === 'string' ? capWorkSummary(pj.context) : '';
        const domain = typeof pj.domain === 'string' ? pj.domain.trim() : '';
        if (name === '' && context === '' && domain === '') continue;
        const pStart = resumeDateToDbDate(pj.start_date, 'start');
        const pEnd = resumeDateToDbDate(pj.end_date, 'end');
        projects.push({
          id: uuidv7(),
          talent_id,
          tenant_id,
          work_experience_id: workExperienceId,
          ...(name !== '' ? { project_name: name } : {}),
          ...(context !== '' ? { context_summary: context } : {}),
          ...(domain !== '' ? { domain } : {}),
          ...(pStart !== null ? { start_date: pStart } : {}),
          ...(pEnd !== null ? { end_date: pEnd } : {}),
          ...provenanceFields(pj.source_refs, provenance),
          created_at: createdAt,
        });
      }
      if (Array.isArray(e.assertions) && e.assertions.length > 0) {
        assertionTasks.push({ work_experience_id: workExperienceId, assertions: e.assertions });
      }
    }

    const seen = new Set<string>();
    for (const s of input.skills ?? []) {
      const surface = s.surface_form.trim();
      if (surface === '') continue;
      const key = surface.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      skillEvidence.push({
        id: uuidv7(),
        talent_id,
        tenant_id,
        skill_id: deriveSkillId(surface),
        surface_form: surface,
        source: 'declared',
        ...provenanceFields(s.source_refs, provenance),
        created_at: createdAt,
      });
    }

    const education: CreateTalentEducationEntryInput[] = [];
    for (const ed of input.education ?? []) {
      const institution = ed.institution_name.trim();
      const degree = ed.degree_name.trim();
      if (institution === '' || degree === '') continue;
      const conferred = resumeDateToDbDate(ed.conferred_date, 'end');
      education.push({
        id: uuidv7(),
        talent_id,
        tenant_id,
        institution_name: institution,
        degree_name: degree,
        source: 'resume',
        ...(typeof ed.field_of_study === 'string' && ed.field_of_study.trim() !== ''
          ? { field_of_study: ed.field_of_study.trim() }
          : {}),
        ...(conferred !== null ? { conferred_date: conferred } : {}),
        ...provenanceFields(ed.source_refs, provenance),
        created_at: createdAt,
      });
    }

    const certifications: CreateTalentCertificationEntryInput[] = [];
    for (const c of input.certifications ?? []) {
      const name = c.certification_name.trim();
      if (name === '') continue;
      const issued = resumeDateToDbDate(c.issued_date, 'start');
      const expiry = resumeDateToDbDate(c.expiry_date, 'end');
      certifications.push({
        id: uuidv7(),
        talent_id,
        tenant_id,
        certification_name: name,
        source: 'resume',
        ...(typeof c.issuer_name === 'string' && c.issuer_name.trim() !== ''
          ? { issuer_name: c.issuer_name.trim() }
          : {}),
        ...(typeof c.credential_ref === 'string' && c.credential_ref.trim() !== ''
          ? { credential_ref: c.credential_ref.trim() }
          : {}),
        ...(issued !== null ? { issued_date: issued } : {}),
        ...(expiry !== null ? { expiry_date: expiry } : {}),
        ...provenanceFields(c.source_refs, provenance),
        created_at: createdAt,
      });
    }

    // PHASE 1 atomic write (talent_evidence, single schema): document + default
    // edition + evidence + draft-LINK (draft stays READY_FOR_REVIEW). All-or-none.
    const result = await this.evidence.establishCreateDraftEvidence({
      tenant_id,
      talent_id,
      created_by: input.actor_id,
      draft_id: input.draft_id,
      document: {
        id: documentId,
        uploaded_by_actor_id: input.actor_id,
        filename: input.resume_document.file_name,
        file_storage_ref: input.resume_document.storage_key,
        mime_type: input.resume_document.mime_type,
        size_bytes: input.resume_document.size_bytes,
        uploaded_at: createdAt,
      },
      edition: {
        id: uuidv7(),
        content_hash: input.resume_document.resume_text_hash ?? '',
        created_at: createdAt,
      },
      resume_default_id: uuidv7(),
      work_history: workHistory,
      skill_evidence: skillEvidence,
      projects,
      education,
      certifications,
    });

    // POST-commit projections (best-effort; keyed by talent_id + work_experience_id,
    // independent of the TalentRecord). Mirrors the review path.
    try {
      await this.persistDerivedSkillSnapshot({
        talent_id,
        tenant_id,
        entries: input.work_history ?? [],
        createdAt,
      });
    } catch {
      // non-fatal projection
    }
    for (const task of assertionTasks) {
      try {
        await this.persistExperienceAssertions({
          talent_id,
          tenant_id,
          work_experience_id: task.work_experience_id,
          assertions: task.assertions,
        });
      } catch {
        // non-fatal trust projection
      }
    }

    return result;
  }

  // HF1 Gate-6 R2 — persist recruiter-reviewed résumé SKILLS as declared
  // TalentSkillEvidence at create time, WITH durable source provenance. Closes
  // the recon discrepancy (skills previously collapsed to the key_skills scalar
  // only — that scalar is RETAINED separately by the caller). DECLARED, NOT
  // scored/verified: confidence_score stays NULL, no inference/enrichment.
  // Deterministic — no AI call (R3). De-duplicated by surface_form. Returns ids.
  async persistDeclaredSkills(input: {
    talent_id: string;
    tenant_id: string;
    skills: readonly ResumeDraftSkill[];
    provenance?: ResumeProvenance;
  }): Promise<string[]> {
    const ids: string[] = [];
    const createdAt = new Date();
    const seen = new Set<string>();
    for (const s of input.skills) {
      const surface = s.surface_form.trim();
      if (surface === '') continue;
      const key = surface.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const id = uuidv7();
      await this.evidence.createTalentSkillEvidence({
        id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        skill_id: deriveSkillId(surface),
        surface_form: surface,
        source: 'declared',
        ...provenanceFields(s.source_refs, input.provenance),
        created_at: createdAt,
      });
      ids.push(id);
    }
    return ids;
  }

  // HF2 R8/R18 — persist recruiter-reviewed résumé EDUCATION as declared
  // TalentEducationEntry WITH durable provenance. institution+degree required
  // (a row missing either is dropped, not guessed). Dates strict-parsed (R27) —
  // ambiguous → NULL, never fabricated. DECLARED, not verified. Returns ids.
  async persistDeclaredEducation(input: {
    talent_id: string;
    tenant_id: string;
    education: readonly ResumeDraftEducation[];
    provenance?: ResumeProvenance;
  }): Promise<string[]> {
    const ids: string[] = [];
    const createdAt = new Date();
    for (const ed of input.education) {
      const institution = ed.institution_name.trim();
      const degree = ed.degree_name.trim();
      if (institution === '' || degree === '') continue;
      const conferred = resumeDateToDbDate(ed.conferred_date, 'end');
      const id = uuidv7();
      await this.evidence.createTalentEducationEntry({
        id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        institution_name: institution,
        degree_name: degree,
        source: 'resume',
        ...(typeof ed.field_of_study === 'string' && ed.field_of_study.trim() !== ''
          ? { field_of_study: ed.field_of_study.trim() }
          : {}),
        ...(conferred !== null ? { conferred_date: conferred } : {}),
        ...provenanceFields(ed.source_refs, input.provenance),
        created_at: createdAt,
      });
      ids.push(id);
    }
    return ids;
  }

  // HF2 R8/R19 — persist recruiter-reviewed résumé CERTIFICATIONS as declared
  // TalentCertificationEntry WITH provenance. name required; issued/expiry
  // strict-parsed (R27). DECLARED, not verified. Returns ids.
  async persistDeclaredCertifications(input: {
    talent_id: string;
    tenant_id: string;
    certifications: readonly ResumeDraftCertification[];
    provenance?: ResumeProvenance;
  }): Promise<string[]> {
    const ids: string[] = [];
    const createdAt = new Date();
    for (const c of input.certifications) {
      const name = c.certification_name.trim();
      if (name === '') continue;
      const issued = resumeDateToDbDate(c.issued_date, 'start');
      const expiry = resumeDateToDbDate(c.expiry_date, 'end');
      const id = uuidv7();
      await this.evidence.createTalentCertificationEntry({
        id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        certification_name: name,
        source: 'resume',
        ...(typeof c.issuer_name === 'string' && c.issuer_name.trim() !== ''
          ? { issuer_name: c.issuer_name.trim() }
          : {}),
        ...(typeof c.credential_ref === 'string' && c.credential_ref.trim() !== ''
          ? { credential_ref: c.credential_ref.trim() }
          : {}),
        ...(issued !== null ? { issued_date: issued } : {}),
        ...(expiry !== null ? { expiry_date: expiry } : {}),
        ...provenanceFields(c.source_refs, input.provenance),
        created_at: createdAt,
      });
      ids.push(id);
    }
    return ids;
  }

  // HF2 R1/R7 — route a WorkExperience's résumé-derived ASSERTIONS (activities /
  // accomplishments) into the talent-trust EvidenceRecord ledger as EXPERIENCE_
  // CLAIM rows. Reuses the SAME governed write surface as the declared-claim
  // reconcile (recordDeclaredClaimIfAbsent: THIRD_PARTY_UNVERIFIED / DOCUMENT /
  // ai_derived; NON-authoritative — cannot elevate a trust band). DETERMINISTIC
  // — no AI call (R6/§26); the source_ref is a content id so a re-create is
  // idempotent. grounding_class rides the payload (SOURCE_ASSOCIATED_
  // INTERPRETATION) for later Vector/KG projection. Returns the count written.
  async persistExperienceAssertions(input: {
    talent_id: string;
    tenant_id: string;
    work_experience_id: string;
    assertions: readonly ResumeDraftAssertion[];
  }): Promise<number> {
    const subjectRef = {
      tenant_id: input.tenant_id,
      ref_type: 'ATS_TALENT_RECORD' as const,
      ref_id: input.talent_id,
      link_source: 'talent-extraction',
    };
    let written = 0;
    for (const a of input.assertions) {
      if (a.statement.trim() === '' || a.type.trim() === '') continue;
      const claim = mapAssertionToClaim(a, input.work_experience_id);
      const result = await this.trust.recordDeclaredClaimIfAbsent({
        subjectRef,
        assertion_type: claim.assertion_type,
        assertion_payload: claim.payload,
        source_ref: claim.source_ref,
        created_by: 'talent-extraction',
      });
      if (result.written) written += 1;
    }
    return written;
  }

  // Full-profile EDIT (LOCKED scope expansion) — REPLACE the talent's declared
  // ('resume'-sourced) work-history with the recruiter-reviewed set. Mirrors
  // persistDeclaredWorkHistory's mapping (employer/role required; free-text dates
  // parsed; 'present' → no end_date = ongoing), then hands the full set to the
  // repository's ATOMIC replace (delete the prior resume rows + recreate). An
  // empty/all-invalid set clears the declared work-history. These stay DECLARED,
  // NOT verified (ADR-0015 v1.3 §4.3). Returns the created ids.
  async replaceDeclaredWorkHistory(input: {
    talent_id: string;
    tenant_id: string;
    entries: readonly ResumeDraftWorkHistory[];
  }): Promise<string[]> {
    const createdAt = new Date();
    const rows: CreateTalentWorkHistoryEntryInput[] = [];
    for (const e of input.entries) {
      const employer = e.employer_name.trim();
      const role = e.role_title.trim();
      if (employer === '' || role === '') continue;
      const start = parseWorkHistoryDate(e.start_date);
      const end = parseWorkHistoryDate(e.end_date);
      rows.push({
        id: uuidv7(),
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        employer_name: employer,
        role_title: role,
        source: 'resume' as const,
        ...(start !== null ? { start_date: start } : {}),
        ...(end !== null ? { end_date: end } : {}),
        ...(typeof e.employment_type === 'string' && e.employment_type.trim() !== ''
          ? { employment_type: e.employment_type.trim() }
          : {}),
        ...(typeof e.description === 'string' && e.description.trim() !== ''
          ? { description_text: e.description.trim() }
          : {}),
        created_at: createdAt,
      });
    }
    return this.evidence.replaceWorkHistoryForTalent({
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      entries: rows,
    });
  }

  // Talent-detail read: the persisted work-history for a talent (LOCKED scope
  // expansion — "display what we created"). Declared rows; `verified:false`
  // (these are 'from résumé', not independently verified — ADR-0015 v1.3 §4.3).
  async listDeclaredWorkHistory(input: {
    talent_id: string;
    tenant_id: string;
  }): Promise<TalentWorkHistoryView[]> {
    const rows = await this.evidence.findWorkHistoryByTalent({
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
    });
    return rows.map((r) => ({
      id: r.id,
      employer_name: r.employer_name,
      role_title: r.role_title,
      start_date: r.start_date !== null ? r.start_date.toISOString().slice(0, 10) : null,
      end_date: r.end_date !== null ? r.end_date.toISOString().slice(0, 10) : null,
      employment_type: r.employment_type,
      description: r.description_text,
      source: r.source,
      // DECLARED, not verified — the recruiter reviewed it, but no independent
      // verification ran. The green VERIFIED badge is a later, separate signal.
      verified: false,
    }));
  }
}

// HF1 Gate-6 — build the durable-provenance write fields for one evidence row:
// per-item source_refs (de-duplicated, omitted when empty) + the shared
// document/corpus anchors (omitted when absent). Keeps NULL/empty provenance for
// the pre-HF1 path (no provenance passed).
function provenanceFields(
  refs: string[] | undefined,
  prov: ResumeProvenance | undefined,
): {
  source_refs?: string[];
  source_document_id?: string;
  source_map_version?: string;
  resume_text_hash?: string;
} {
  return {
    ...(Array.isArray(refs) && refs.length > 0 ? { source_refs: dedupeRefs(refs) } : {}),
    ...(prov?.source_document_id !== undefined
      ? { source_document_id: prov.source_document_id }
      : {}),
    ...(prov?.source_map_version !== undefined
      ? { source_map_version: prov.source_map_version }
      : {}),
    ...(prov?.resume_text_hash !== undefined ? { resume_text_hash: prov.resume_text_hash } : {}),
  };
}

// A free-text résumé date ('2022', 'Dec 2021', 'present') → a calendar Date for
// @db.Date STORAGE, or null when it is not confidence-safe. R27: NO loose
// `new Date(freeform)` — the strict parser recognizes a closed shape set and
// REFUSES everything else (→ null), so a stored value is never fabricated from
// ambiguous text. A coarse date anchors to its 'start' edge for storage (a
// year-only "2021" → 2021-01-01); the precision loss is intentional at the
// storage boundary and is NEVER what the duration math consumes — that path
// takes the precision-carrying ResumeDate directly (deriveResumeSkillYears).
function parseWorkHistoryDate(value: string | undefined): Date | null {
  return resumeDateToDbDate(value, 'start');
}

// Strict freeform → @db.Date. Ongoing tokens ('present') and unparseable text
// yield null (no end_date = ongoing). `edge` anchors a coarse date's boundary
// (YEAR start→Jan-1, end→Dec-1) WITHOUT ever inventing a day beyond the edge
// convention. UTC midnight keeps @db.Date free of timezone drift.
function resumeDateToDbDate(
  value: string | undefined,
  edge: 'start' | 'end',
): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const d = parseResumeDate(value);
  if (d === null) return null;
  const month = d.month ?? (edge === 'start' ? 1 : 12);
  const day = d.day ?? 1;
  return new Date(Date.UTC(d.year, month - 1, day));
}

// "Now" as an EXACT ResumeDate (a precisely-known instant — NOT a parsed
// freeform string, so it is R27-safe). Used as the asOf edge for ongoing spans.
function dateToResumeDate(d: Date): ResumeDate {
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    precision: 'EXACT',
  };
}

// HF2 R14 — the PURE derivation (no DB, unit-tested): résumé work-history →
// union-based skill-years. For each SkillUsage the interval is EXPLICIT (the
// résumé stated the skill's own dates) or inherited from the enclosing role
// (WORK_EXPERIENCE_CONTEXT / unknown basis); ongoing is an explicit 'present'
// token on either the usage end or the role end. Per skill_id the intervals are
// UNIONED (concurrent roles counted once — never summed), carrying the coarsest
// precision. `overall_years` is the union of ALL role spans (career length).
export interface DerivedSkillYear {
  skill_id: string;
  surface_form: string;
  supported_months: number;
  years: number;
  precision: string | null;
  current: boolean;
}
export interface DerivedResumeSkillYears {
  overall_years: number | null;
  by_skill: Record<string, DerivedSkillYear>;
}

function monthsToYears(months: number): number {
  return Math.round((months / 12) * 10) / 10;
}

export function deriveResumeSkillYears(
  entries: readonly ResumeDraftWorkHistory[],
  asOf: ResumeDate,
): DerivedResumeSkillYears {
  const roleIntervals: SkillUsageInterval[] = [];
  const bySkill = new Map<string, { surface_form: string; intervals: SkillUsageInterval[] }>();

  for (const e of entries) {
    if (e.employer_name.trim() === '' || e.role_title.trim() === '') continue;
    const roleStart = strictOrNull(e.start_date);
    const roleOngoing = isOngoingToken(e.end_date);
    const roleEnd = roleOngoing ? null : strictOrNull(e.end_date);
    const roleInterval: SkillUsageInterval = {
      start: roleStart,
      end: roleEnd,
      ongoing: roleOngoing,
    };
    if (roleStart !== null) roleIntervals.push(roleInterval);

    for (const su of e.skill_usage ?? []) {
      const surface = su.surface_form.trim();
      if (surface === '') continue;
      const explicit = su.usage_period_basis === 'EXPLICIT';
      const suStart = explicit ? strictOrNull(su.usage_start) : null;
      const interval: SkillUsageInterval =
        explicit && suStart !== null
          ? {
              start: suStart,
              end: isOngoingToken(su.usage_end) ? null : strictOrNull(su.usage_end),
              ongoing: isOngoingToken(su.usage_end),
            }
          : roleInterval; // WORK_EXPERIENCE_CONTEXT / unknown → inherit the role span
      const id = deriveSkillId(surface);
      const bucket = bySkill.get(id) ?? { surface_form: surface, intervals: [] };
      bucket.intervals.push(interval);
      bySkill.set(id, bucket);
    }
  }

  const by_skill: Record<string, DerivedSkillYear> = {};
  for (const [skill_id, bucket] of bySkill) {
    const t = deriveSkillTimeline(bucket.intervals, asOf);
    by_skill[skill_id] = {
      skill_id,
      surface_form: bucket.surface_form,
      supported_months: t.supported_months,
      years: monthsToYears(t.supported_months),
      precision: t.precision,
      current: t.current_usage,
    };
  }

  const overall = deriveSkillTimeline(roleIntervals, asOf);
  const overall_years =
    roleIntervals.length > 0 ? monthsToYears(overall.supported_months) : null;

  return { overall_years, by_skill };
}

function strictOrNull(value: string | undefined): ResumeDate | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return parseResumeDate(value);
}

function isOngoingToken(value: string | undefined): boolean {
  return typeof value === 'string' && isOngoingDateToken(value);
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

// ── résumé-draft helpers (HF1 durable fact extraction) ───────────────────────

// Map the provider-neutral outcome category → the explicit §13/R9 failure state.
function mapOutcomeToFailure(
  category: StructuredGenerationErrorCategory,
): ResumeDraftStatus {
  if (category === 'truncated') return 'provider_truncated';
  if (category === 'malformed_output' || category === 'empty_output') {
    return 'invalid_structured_output';
  }
  // rate_limited | server_error | timeout | network | transport | auth_config |
  // invalid_request → a provider/transport/config failure.
  return 'provider_failure';
}

function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === 'string';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

// Shape-guard the provider's parsed output into the compact completion. Native
// constrained decoding (§12) should already guarantee the schema; this is the
// defensive deterministic floor (never throws; off-shape groups are dropped).
// Compatibility-hotfix normalization (transport → semantic). The provider
// TRANSPORT schema requires every property present and transports "not stated"
// as '' (scalars). Convert those transport empties back to ABSENT (drop ''-valued
// keys) so the downstream semantic pipeline sees exactly the shape a genuinely-
// optional schema would produce — provider-required presence never becomes
// domain-required data. Arrays are preserved verbatim (an empty [] stays [] =
// "no items"; source_refs entries are untouched); nested objects recurse; every
// non-empty scalar is kept as-is. Pure; returns a fresh structure.
function stripTransportEmpties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTransportEmpties);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') {
        if (v !== '') out[k] = v; // '' → absent (the transport "not stated")
      } else {
        out[k] = stripTransportEmpties(v);
      }
    }
    return out;
  }
  return value;
}

function parseDraftStructured(parsedUnknown: unknown): ResumeDraftCompletion {
  const out: ResumeDraftCompletion = {
    skills: [],
    work_history: [],
    education: [],
    certifications: [],
  };
  if (typeof parsedUnknown !== 'object' || parsedUnknown === null) return out;
  const obj = parsedUnknown as Record<string, unknown>;
  if (isResumeDraftIdentityShape(obj['identity'])) out.identity = obj['identity'];
  if (isResumeDraftLocationShape(obj['location'])) out.location = obj['location'];
  if (isResumeDraftProfessionalShape(obj['professional'])) out.professional = obj['professional'];
  out.skills = Array.isArray(obj['skills'])
    ? (obj['skills'] as unknown[]).filter(isSkillFactShape)
    : [];
  out.work_history = Array.isArray(obj['work_history'])
    ? (obj['work_history'] as unknown[]).filter(isWorkHistoryFactShape)
    : [];
  out.education = Array.isArray(obj['education'])
    ? (obj['education'] as unknown[]).filter(isEducationFactShape)
    : [];
  out.certifications = Array.isArray(obj['certifications'])
    ? (obj['certifications'] as unknown[]).filter(isCertificationFactShape)
    : [];
  return out;
}

function isResumeDraftIdentityShape(v: unknown): v is ResumeDraftIdentity {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    isStringArray(o['source_refs']) &&
    isOptionalString(o['first_name']) &&
    isOptionalString(o['last_name'])
  );
}

function isResumeDraftLocationShape(v: unknown): v is ResumeDraftLocation {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    isStringArray(o['source_refs']) &&
    isOptionalString(o['address']) &&
    isOptionalString(o['city']) &&
    isOptionalString(o['state']) &&
    isOptionalString(o['zip']) &&
    isOptionalString(o['country'])
  );
}

function isResumeDraftProfessionalShape(v: unknown): v is ResumeDraftProfessional {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    isStringArray(o['source_refs']) &&
    isOptionalString(o['current_employer']) &&
    isOptionalString(o['title'])
  );
}

function isSkillFactShape(v: unknown): v is ResumeDraftSkillFact {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['surface_form'] === 'string' && isStringArray(o['source_refs']);
}

// Nested-array items are shape-checked defensively when present; a malformed
// nested item is filtered out (never crashes the whole extraction).
function isNestedArray(v: unknown, guard: (x: unknown) => boolean): boolean {
  return v === undefined || (Array.isArray(v) && v.every(guard));
}

function isWorkHistoryFactShape(v: unknown): v is ResumeDraftWorkHistoryFact {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['employer_name'] === 'string' &&
    typeof o['role_title'] === 'string' &&
    isOptionalString(o['experience_summary']) &&
    isOptionalString(o['location']) &&
    isStringArray(o['source_refs']) &&
    isNestedArray(o['skill_usage'], isSkillUsageFactShape) &&
    isNestedArray(o['projects'], isProjectFactShape) &&
    isNestedArray(o['assertions'], isAssertionFactShape)
  );
}

function isSkillUsageFactShape(v: unknown): v is ResumeDraftSkillUsage {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['surface_form'] === 'string' &&
    isStringArray(o['source_refs']) &&
    isOptionalString(o['version']) &&
    isOptionalString(o['activity']) &&
    isOptionalString(o['usage_start']) &&
    isOptionalString(o['usage_end']) &&
    isOptionalString(o['usage_period_basis'])
  );
}

function isProjectFactShape(v: unknown): v is ResumeDraftProject {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    isStringArray(o['source_refs']) &&
    isOptionalString(o['project_name']) &&
    isOptionalString(o['context']) &&
    isOptionalString(o['domain']) &&
    isOptionalString(o['start_date']) &&
    isOptionalString(o['end_date'])
  );
}

function isAssertionFactShape(v: unknown): v is ResumeDraftAssertion {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['type'] === 'string' &&
    typeof o['statement'] === 'string' &&
    isStringArray(o['source_refs']) &&
    isOptionalString(o['metric'])
  );
}

function isEducationFactShape(v: unknown): v is ResumeDraftEducation {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['institution_name'] === 'string' &&
    typeof o['degree_name'] === 'string' &&
    isStringArray(o['source_refs']) &&
    isOptionalString(o['field_of_study']) &&
    isOptionalString(o['conferred_date'])
  );
}

function isCertificationFactShape(v: unknown): v is ResumeDraftCertification {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['certification_name'] === 'string' &&
    isStringArray(o['source_refs']) &&
    isOptionalString(o['issuer_name']) &&
    isOptionalString(o['credential_ref']) &&
    isOptionalString(o['issued_date']) &&
    isOptionalString(o['expiry_date']) &&
    isOptionalString(o['version_or_level'])
  );
}

// HF1 §5/R5 — GROUND a value against the source-map. A fact is supported ONLY
// when: it cites at least one ref; EVERY cited ref resolves to a real block in
// THIS map (a nonexistent ref, or a ref minted against a different résumé, fails
// here); AND the value text occurs within the union of those blocks' RAW text.
// The model's reference alone is never proof.
function groundValue(
  value: string,
  refs: unknown,
  blockIndex: Map<string, string>,
): boolean {
  const v = value.trim();
  if (v === '') return false;
  if (!isStringArray(refs) || refs.length === 0) return false;
  const texts: string[] = [];
  for (const id of refs) {
    const blockText = blockIndex.get(id);
    if (blockText === undefined) return false; // nonexistent / cross-résumé ref
    texts.push(normalizeForMatch(blockText));
  }
  return texts.join(' ').includes(normalizeForMatch(v));
}

// HF2 R5 — REF-VALIDITY only (for paraphrase facts like project context /
// assertion statements that cannot be verbatim-substring-grounded): at least one
// ref, and EVERY ref resolves to a real block in THIS map (rejects nonexistent /
// cross-résumé refs). The identifying value (skill surface_form, project name,
// employer/role, institution/degree, cert name) is additionally substring-ground
// via groundValue; a paraphrase rides its already-ref-valid parent.
function refsResolve(refs: unknown, blockIndex: Map<string, string>): boolean {
  if (!isStringArray(refs) || refs.length === 0) return false;
  return refs.every((id) => blockIndex.get(id) !== undefined);
}

// HF2 R10 — clamp a recruiter-facing summary/context to ONE line, ≤600 chars
// (defensive re-clamp behind the provider maxLength). Keeps output bounded (§11).
function capWorkSummary(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > WORK_SUMMARY_MAX_CHARS
    ? oneLine.slice(0, WORK_SUMMARY_MAX_CHARS).trim()
    : oneLine;
}

// Unique refs, original order preserved.
function dedupeRefs(refs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of refs) {
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

// Count grounded facts for instrumentation (§25): populated scalar fields +
// grounded skills + grounded work-history entries.
function countFacts(proposal: ResumeDraftProposal): number {
  const scalarKeys: Array<keyof ResumeDraftProposal> = [
    'first_name',
    'last_name',
    'address',
    'city',
    'state',
    'zip',
    'country',
    'current_employer',
    'title',
  ];
  let n = 0;
  for (const k of scalarKeys) {
    if (typeof proposal[k] === 'string' && (proposal[k] as string) !== '') n += 1;
  }
  return (
    n +
    proposal.skills.length +
    proposal.work_history.length +
    proposal.education.length +
    proposal.certifications.length
  );
}
