import { Injectable } from '@nestjs/common';
import {
  ResumeParserService,
  buildResumeSourceMap,
  type ParseStatus,
  type TalentRecordPrefill,
} from '@aramo/resume-parse';
import { TalentExtractionService } from '@aramo/talent-extraction';

import type { DraftFromResumeResponse } from '../dto/draft-from-resume.response.js';

import { ResumeSourceAuthorizer } from './resume-source-authorizer.js';
import type {
  AuthorizedExtractionContext,
  ResumeExtractionSource,
} from './resume-source.types.js';

// TALENT-INTEL-1 (TI-1B) — the SHARED governed-LLM résumé-extraction
// orchestrator. Extracted verbatim (behaviour-preserving) from the controller-
// private draftGovernedLlm so BOTH the CREATE draft path and the (future) EDIT
// re-extraction path run one identical pipeline:
//
//   authorize source  →  resolve storage_key  →  fetch text  →  source-map
//   →  local contact extraction (captured during model-input redaction)
//   →  ONE governed HF2 extraction  →  normalize  →  proposal/prefill
//
// Authorization (ResumeSourceAuthorizer) always precedes storage access; the
// pipeline below never sees a raw client key.
@Injectable()
export class ResumeExtractionOrchestrator {
  constructor(
    private readonly authorizer: ResumeSourceAuthorizer,
    private readonly resumeParser: ResumeParserService,
    private readonly talentExtraction: TalentExtractionService,
  ) {}

  async extractResume(
    source: ResumeExtractionSource,
    ctx: AuthorizedExtractionContext,
  ): Promise<DraftFromResumeResponse> {
    const RETRY_WARNING =
      'We couldn’t read this résumé. Please retry, or enter the details manually.';

    // ── Authorization BEFORE any object access (ruling 15). A foreign/malformed
    //    /unauthorized reference throws here and never reaches storage.
    const { storage_key } = await this.authorizer.authorize(source, ctx);
    const { tenant_id, requestId } = ctx;

    let text: string | null;
    try {
      text = await this.resumeParser.extractTextFromStorageKey({ storage_key, requestId });
    } catch {
      // Fetch/extract error — non-blocking; empty prefill + retry.
      return { mode: 'governed_llm', prefill: {}, parse_status: 'failed', warning: RETRY_WARNING };
    }
    if (text === null || text.trim() === '') {
      return { mode: 'governed_llm', prefill: {}, parse_status: 'failed', warning: RETRY_WARNING };
    }

    // HF1 §3/R1 — the canonical source-map (version + text hash + ordered blocks),
    // built by the bytes→text owner and handed by value to the grounding lib.
    const source_map = buildResumeSourceMap(text);

    let result;
    try {
      result = await this.talentExtraction.extractResumeDraft({ tenant_id, source_map });
    } catch {
      // Defensive: the structured path maps provider errors to a status and does
      // not throw, but an unexpected throw still degrades to a retry affordance.
      return {
        mode: 'governed_llm',
        prefill: {},
        parse_status: 'partial',
        extraction_status: 'provider_failure',
        warning:
          'Résumé extraction is temporarily unavailable. Please retry, or enter the details manually.',
      };
    }

    const { status, proposal, contact } = result;

    // Explicit technical-failure states (§13/R9): distinct, honest warnings —
    // never a masked empty draft. No prefill is offered on a technical failure.
    if (status === 'provider_truncated') {
      return {
        mode: 'governed_llm',
        prefill: {},
        parse_status: 'failed',
        extraction_status: status,
        warning:
          'This résumé was too long to read in a single pass. Please retry, or enter the details manually.',
      };
    }
    if (status === 'invalid_structured_output') {
      return {
        mode: 'governed_llm',
        prefill: {},
        parse_status: 'failed',
        extraction_status: status,
        warning: RETRY_WARNING,
      };
    }
    if (status === 'provider_failure') {
      return {
        mode: 'governed_llm',
        prefill: {},
        parse_status: 'partial',
        extraction_status: status,
        warning:
          'Résumé extraction is temporarily unavailable. Please retry, or enter the details manually.',
      };
    }

    // Everything the model IS allowed to see — name, address, city, state, ZIP,
    // country — comes from the GROUNDED LLM proposal.
    const prefill: TalentRecordPrefill = {};
    if (proposal.first_name !== undefined) prefill.first_name = proposal.first_name;
    if (proposal.last_name !== undefined) prefill.last_name = proposal.last_name;
    if (proposal.address !== undefined) prefill.address = proposal.address;
    if (proposal.city !== undefined) prefill.city = proposal.city;
    if (proposal.state !== undefined) prefill.state = proposal.state;
    if (proposal.zip !== undefined) prefill.zip = proposal.zip;
    if (proposal.country !== undefined) prefill.country = proposal.country;
    // HF2 R17 — email/phone were CAPTURED during model-input redaction (never
    // sent to the model; ADR-0015 Decision-6 / §17) and returned on the result —
    // no second scan. First email → email1, second → email2; phones → cell/
    // home/work in order.
    const emails = contact?.emails ?? [];
    const phones = contact?.phones ?? [];
    if (emails[0] !== undefined) prefill.email1 = emails[0];
    if (emails[1] !== undefined) prefill.email2 = emails[1];
    if (phones[0] !== undefined) prefill.phone_cell = phones[0];
    if (phones[1] !== undefined) prefill.phone_home = phones[1];
    if (phones[2] !== undefined) prefill.phone_work = phones[2];
    if (proposal.current_employer !== undefined) prefill.current_employer = proposal.current_employer;
    if (proposal.title !== undefined) prefill.title = proposal.title;
    // Clean skills → the free-text key_skills field (the recruiter-facing R5 §2
    // surface). The STRUCTURED skills + their source_refs are carried separately
    // (below) for durable provenance (R7).
    if (proposal.skills.length > 0) {
      prefill.key_skills = proposal.skills.map((s) => s.surface_form).join(', ');
    }

    const hasIdentity = prefill.first_name !== undefined || prefill.last_name !== undefined;
    const hasAny = Object.keys(prefill).length > 0 || proposal.work_history.length > 0;
    const parse_status: ParseStatus = hasIdentity ? 'parsed' : 'partial';
    return {
      mode: 'governed_llm',
      prefill,
      parse_status,
      extraction_status: status,
      // Reviewable work-history (declared 'from résumé', recruiter-editable),
      // each carrying its source_refs (§16/R8).
      ...(proposal.work_history.length > 0 ? { work_history: proposal.work_history } : {}),
      // R7 — structured skills + source_refs carried through the API (the FE form
      // uses the free-text key_skills; these preserve durable skill provenance).
      ...(proposal.skills.length > 0 ? { skills: proposal.skills } : {}),
      // HF2 R8/R18/R19 — grounded education + certifications carried to the review
      // card (declared 'from résumé'; persisted with provenance on create).
      ...(proposal.education.length > 0 ? { education: proposal.education } : {}),
      ...(proposal.certifications.length > 0 ? { certifications: proposal.certifications } : {}),
      // §16 — provenance anchors the FE carries back into the create request.
      source_map_version: proposal.source_map_version,
      resume_text_hash: proposal.resume_text_hash,
      ...(hasAny
        ? {}
        : { warning: 'No details could be read from this résumé. Please enter them manually.' }),
    };
  }
}
