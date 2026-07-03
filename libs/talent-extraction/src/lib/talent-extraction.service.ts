import { Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AiDraftService } from '@aramo/ai-draft';
import { TalentEvidenceRepository } from '@aramo/talent-evidence';

import type {
  ExtractDeclaredEvidenceInput,
  ExtractDeclaredEvidenceResult,
  ExtractedSkill,
  ExtractedWorkHistory,
  ExtractionCompletion,
} from './dto/extraction.dto.js';
import { deriveSkillId } from './skill-id.js';

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
  'You are a résumé-structuring assistant. Extract ONLY skills and work-history ' +
  'entries that are EXPLICITLY present in the provided text. Do NOT infer, ' +
  'enrich, normalize, or add anything not literally stated. For every item, ' +
  'include a "source_excerpt" copied VERBATIM from the provided text that ' +
  'contains the claim. Respond with STRICT JSON only, no prose, no code fences.';

@Injectable()
export class TalentExtractionService {
  private readonly logger = new Logger(TalentExtractionService.name);

  constructor(
    private readonly aiDraft: AiDraftService,
    private readonly evidence: TalentEvidenceRepository,
  ) {}

  async extractDeclaredEvidence(
    input: ExtractDeclaredEvidenceInput,
  ): Promise<ExtractDeclaredEvidenceResult> {
    const sourceText = buildSourceText(input);
    // Nothing declared to extract from → no-op (no LLM call).
    if (sourceText.trim() === '') {
      return { skill_evidence_ids: [], work_history_ids: [], rejected_count: 0 };
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

    this.logger.log({
      event: 'talent_declared_evidence_extracted',
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      skills_persisted: skill_evidence_ids.length,
      work_history_persisted: work_history_ids.length,
      rejected_count,
    });

    return { skill_evidence_ids, work_history_ids, rejected_count };
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
    'Extract skills and work history from the following talent-declared text. ' +
    'Return STRICT JSON of shape ' +
    '{"skills":[{"surface_form":string,"source_excerpt":string,' +
    '"proficiency_claim"?:string,"years_claimed"?:number}],' +
    '"work_history":[{"employer_name":string,"role_title":string,' +
    '"source_excerpt":string,"start_date"?:string,"end_date"?:string,' +
    '"employment_type"?:string,"description"?:string}]}. ' +
    'Every source_excerpt MUST be copied verbatim from the text below.\n\n' +
    '---\n' +
    sourceText +
    '\n---'
  );
}

// Strip optional ```json fences and parse; a malformed completion yields an
// empty result (deterministic — never throws on bad model output).
export function parseCompletion(completion: string): ExtractionCompletion {
  const empty: ExtractionCompletion = { skills: [], work_history: [] };
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
  return { skills, work_history };
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
