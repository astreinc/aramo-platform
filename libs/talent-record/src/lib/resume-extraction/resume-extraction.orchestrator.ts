import { Injectable } from '@nestjs/common';
import {
  ResumeParserService,
  buildResumeSourceMap,
  type ParseStatus,
  type TalentRecordPrefill,
} from '@aramo/resume-parse';
import {
  TalentExtractionService,
  type ResumeDraftProposal,
  type ResumeDraftRejectedWorkHistory,
} from '@aramo/talent-extraction';

import type { DraftFromResumeResponse } from '../dto/draft-from-resume.response.js';

import { ResumeSourceAuthorizer } from './resume-source-authorizer.js';
import type {
  AuthorizedExtractionContext,
  ResumeExtractionSource,
} from './resume-source.types.js';

// TALENT-INTEL-1 (TI-1B) — the SHARED governed-LLM resume-extraction
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
      'We couldn’t read this resume. Please retry, or enter the details manually.';

    // ── Authorization BEFORE any object access (ruling 15). A foreign/malformed
    //    /unauthorized reference throws here and never reaches storage.
    const { storage_key } = await this.authorizer.authorize(source, ctx);
    const { tenant_id, requestId } = ctx;

    let text: string | null;
    try {
      text = await this.resumeParser.extractTextFromStorageKey({ storage_key, requestId });
    } catch {
      // Fetch/extract error — non-blocking; empty prefill + retry.
      return { prefill: {}, parse_status: 'failed', warning: RETRY_WARNING };
    }
    if (text === null || text.trim() === '') {
      return { prefill: {}, parse_status: 'failed', warning: RETRY_WARNING };
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
        prefill: {},
        parse_status: 'partial',
        extraction_status: 'provider_failure',
        warning:
          'Resume extraction is temporarily unavailable. Please retry, or enter the details manually.',
      };
    }

    const { status, proposal, contact } = result;

    // Explicit technical-failure states (§13/R9): distinct, honest warnings —
    // never a masked empty draft. No prefill is offered on a technical failure.
    if (status === 'provider_truncated') {
      return {
        prefill: {},
        parse_status: 'failed',
        extraction_status: status,
        warning:
          'This resume was too long to read in a single pass. Please retry, or enter the details manually.',
      };
    }
    if (status === 'invalid_structured_output') {
      return {
        prefill: {},
        parse_status: 'failed',
        extraction_status: status,
        warning: RETRY_WARNING,
      };
    }
    if (status === 'provider_failure') {
      return {
        prefill: {},
        parse_status: 'partial',
        extraction_status: status,
        warning:
          'Resume extraction is temporarily unavailable. Please retry, or enter the details manually.',
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
    // key_skills (ATS-QA-1 row A2) — the de-duplicated DISPLAY union of the
    // explicitly listed skills and the per-role skill_usage surface forms. It
    // carries no years, proficiency or employment evidence. The STRUCTURED
    // listed skills + their source_refs are carried separately (below) for
    // durable provenance (R7); evidenced usage stays on each work-history entry.
    const keySkills = composeKeySkills(proposal);
    if (keySkills !== '') {
      prefill.key_skills = keySkills;
    }

    const hasIdentity = prefill.first_name !== undefined || prefill.last_name !== undefined;
    const hasAny = Object.keys(prefill).length > 0 || proposal.work_history.length > 0;
    const rejectedWarning = rejectedWorkHistoryWarning(proposal.rejected_work_history ?? []);
    const parse_status: ParseStatus = hasIdentity ? 'parsed' : 'partial';
    return {
      prefill,
      parse_status,
      extraction_status: status,
      // Reviewable work-history (declared 'from resume', recruiter-editable),
      // each carrying its source_refs (§16/R8).
      ...(proposal.work_history.length > 0 ? { work_history: proposal.work_history } : {}),
      // R7 — structured skills + source_refs carried through the API (the FE form
      // uses the free-text key_skills; these preserve durable skill provenance).
      ...(proposal.skills.length > 0 ? { skills: proposal.skills } : {}),
      // HF2 R8/R18/R19 — grounded education + certifications carried to the review
      // card (declared 'from resume'; persisted with provenance on create).
      ...(proposal.education.length > 0 ? { education: proposal.education } : {}),
      ...(proposal.certifications.length > 0 ? { certifications: proposal.certifications } : {}),
      // §16 — provenance anchors the FE carries back into the create request.
      source_map_version: proposal.source_map_version,
      resume_text_hash: proposal.resume_text_hash,
      ...(hasAny
        ? rejectedWarning !== null
          ? { warning: rejectedWarning }
          : {}
        : { warning: 'No details could be read from this resume. Please enter them manually.' }),
    };
  }
}

// A2 — listed skills first (in résumé order), then evidenced skill_usage surface
// forms in role order; de-duplicated case- and whitespace-insensitively (the
// first written form wins). Display text only.
export function composeKeySkills(
  proposal: Pick<ResumeDraftProposal, 'skills' | 'work_history'>,
): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string): void => {
    const surface = raw.replace(/\s+/g, ' ').trim();
    if (surface === '') return;
    const key = surface.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(surface);
  };
  for (const s of proposal.skills) add(s.surface_form);
  for (const wh of proposal.work_history) {
    for (const su of wh.skill_usage ?? []) add(su.surface_form);
  }
  return out.join(', ');
}

// I-3 — recruiter-safe draft warning for work-history entries that could not be
// matched to the résumé text. Names an employer only when that employer itself
// was found in the résumé (never surfaces ungrounded text).
export function rejectedWorkHistoryWarning(
  rejected: readonly ResumeDraftRejectedWorkHistory[],
): string | null {
  if (rejected.length === 0) return null;
  const employers = [
    ...new Set(
      rejected
        .map((r) => r.employer_name?.trim() ?? '')
        .filter((e) => e !== ''),
    ),
  ];
  const count = rejected.length;
  const head =
    count === 1
      ? '1 work history entry couldn’t be matched to the resume text and was left out'
      : `${count} work history entries couldn’t be matched to the resume text and were left out`;
  const named = employers.length > 0 ? ` (${employers.join(', ')})` : '';
  return `${head}${named}. Check the resume and add ${count === 1 ? 'it' : 'them'} below if needed.`;
}
