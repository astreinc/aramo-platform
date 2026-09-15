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
const RESUME_DRAFT_PROMPT_VERSION = 'resume-draft/v2';
const RESUME_DRAFT_SCHEMA_NAME = 'resume-draft-extraction/v2';
// §11/R11 — max_tokens is an INERT OPERATIONAL SAFETY BOUNDARY, not the fix. The
// architecture (facts + refs, no copied prose) is what bounds the output; a
// truncation now surfaces as an EXPLICIT provider_truncated failure (§13), never
// a silent empty draft. Not tuned in this increment (R11).
const RESUME_DRAFT_MAX_TOKENS = 8192;

const DRAFT_SYSTEM_MESSAGE =
  'You structure a résumé into facts for a talent-intake form. The résumé is ' +
  'given as numbered source blocks, each line prefixed with a block id like ' +
  '"[B004]". Return ONLY facts EXPLICITLY present about the person the résumé is ' +
  'about: their name, location, current employer/title, skills, and work history. ' +
  'For every fact you return, set "source_refs" to the list of block ids whose ' +
  'text states that fact (e.g. ["B004"]). Do NOT copy or quote the block text — ' +
  'reference it by id only. Do NOT infer, enrich, or normalize; omit any field ' +
  'not clearly stated rather than guessing. Distinguish the résumé owner from ' +
  'other people named (references, managers, client contacts) and their location ' +
  'from employer/school locations. List each skill exactly as written, atomic and ' +
  'de-duplicated. Do NOT output email or phone. Do NOT output job descriptions, ' +
  'responsibilities, or résumé prose — structured facts only.';

// Native JSON-schema for constrained decoding (§12/R2). Compact: facts +
// source_refs; NO source_excerpt; NO work-history description (R3/R4).
const RESUME_DRAFT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    identity: {
      type: 'object',
      additionalProperties: false,
      properties: {
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        source_refs: { type: 'array', items: { type: 'string' } },
      },
      required: ['source_refs'],
    },
    location: {
      type: 'object',
      additionalProperties: false,
      properties: {
        address: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        zip: { type: 'string' },
        country: { type: 'string' },
        source_refs: { type: 'array', items: { type: 'string' } },
      },
      required: ['source_refs'],
    },
    professional: {
      type: 'object',
      additionalProperties: false,
      properties: {
        current_employer: { type: 'string' },
        title: { type: 'string' },
        source_refs: { type: 'array', items: { type: 'string' } },
      },
      required: ['source_refs'],
    },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          surface_form: { type: 'string' },
          source_refs: { type: 'array', items: { type: 'string' } },
        },
        required: ['surface_form', 'source_refs'],
      },
    },
    work_history: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          employer_name: { type: 'string' },
          role_title: { type: 'string' },
          start_date: { type: 'string' },
          end_date: { type: 'string' },
          employment_type: { type: 'string' },
          source_refs: { type: 'array', items: { type: 'string' } },
        },
        required: ['employer_name', 'role_title', 'source_refs'],
      },
    },
  },
  required: ['skills', 'work_history'],
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
      rejected_count: 0,
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
    let redactedSpanCountInput = 0;
    const userContent = source_map.blocks
      .map((b) => {
        const { redactedText, spanCount } = redactPii(b.text);
        redactedSpanCountInput += spanCount;
        return `[${b.block_id}] ${redactedText}`;
      })
      .join('\n');

    // ONE native structured-output call (R2/R6). No retry (R6) — a truncation or
    // off-schema result is surfaced as an explicit failure status.
    const outcome = await this.structuredGen.generateStructured({
      model: ARAMO_AI_DRAFT_MODEL,
      system: DRAFT_SYSTEM_MESSAGE,
      user_content: userContent,
      max_tokens: RESUME_DRAFT_MAX_TOKENS,
      json_schema: RESUME_DRAFT_SCHEMA,
      schema_name: RESUME_DRAFT_SCHEMA_NAME,
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

    const parsed = parseDraftStructured(outcome.parsed);
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

    // Work history — employer AND role must both ground against the entry's refs
    // (§5). Declared (source='resume'), NOT verified. Dates/employment_type only
    // when the model returned a string. NO description (R4). source_refs carried
    // through to the persistence seam (§16/R8).
    for (const wh of parsed.work_history) {
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
      proposal.work_history.push({
        employer_name: employer,
        role_title: role,
        ...(typeof wh.start_date === 'string' && wh.start_date.trim() !== ''
          ? { start_date: wh.start_date.trim() }
          : {}),
        ...(typeof wh.end_date === 'string' && wh.end_date.trim() !== ''
          ? { end_date: wh.end_date.trim() }
          : {}),
        ...(typeof wh.employment_type === 'string' && wh.employment_type.trim() !== ''
          ? { employment_type: wh.employment_type.trim() }
          : {}),
        source_refs: refs,
      });
    }

    proposal.rejected_count = rejected;

    const factCount = countFacts(proposal);
    // success = grounded facts AND nothing rejected; partial = something was
    // rejected OR nothing grounded (honest — never a masked failure, §13).
    const status: ResumeDraftStatus = factCount > 0 && rejected === 0 ? 'success' : 'partial';

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
      rejected_count: rejected,
      redacted_span_count_input: redactedSpanCountInput,
    });

    return { status, proposal };
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
  }): Promise<string[]> {
    const ids: string[] = [];
    const createdAt = new Date();
    for (const e of input.entries) {
      const employer = e.employer_name.trim();
      const role = e.role_title.trim();
      if (employer === '' || role === '') continue;
      const start = parseWorkHistoryDate(e.start_date);
      const end = parseWorkHistoryDate(e.end_date);
      const id = uuidv7();
      await this.evidence.createTalentWorkHistoryEntry({
        id,
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
        ...(typeof e.description === 'string' && e.description.trim() !== ''
          ? { description_text: e.description.trim() }
          : {}),
        created_at: createdAt,
      });
      ids.push(id);
    }
    return ids;
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

// A free-text résumé date ('2022', 'Dec 2021', 'present') → a calendar Date, or
// null when it does not parse (e.g. 'present' → ongoing, no end_date).
function parseWorkHistoryDate(value: string | undefined): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? null : d;
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
function parseDraftStructured(parsedUnknown: unknown): ResumeDraftCompletion {
  const out: ResumeDraftCompletion = { skills: [], work_history: [] };
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

function isWorkHistoryFactShape(v: unknown): v is ResumeDraftWorkHistoryFact {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['employer_name'] === 'string' &&
    typeof o['role_title'] === 'string' &&
    isStringArray(o['source_refs'])
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
  return n + proposal.skills.length + proposal.work_history.length;
}
