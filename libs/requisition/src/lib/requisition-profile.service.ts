import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { AramoError, type VisibilityContextShape } from '@aramo/common';
import { AiDraftService } from '@aramo/ai-draft';
import {
  JobDomainRepository,
  goldenProfileContentFromStorage,
  goldenProfileContentToStorage,
  type GoldenProfileContent,
} from '@aramo/job-domain';

import type {
  ConfirmProfileResponseDto,
  DraftProfileResponseDto,
} from './dto/profile-generation.dto.js';
import {
  emptyRequisitionProfileView,
  type RequisitionProfileView,
} from './dto/requisition-profile.view.js';
import type { RequisitionView } from './dto/requisition.view.js';
import {
  buildProfilePrompt,
  extractRoleContent,
  parseProfileCompletion,
} from './profile-prompt.js';
import { RequisitionRepository } from './requisition.repository.js';

// Job-Module LB-3 — JD + GoldenProfile generation service. The 2nd
// declared libs/ai-draft consumer (ADR-0015 v1.2). Mirrors the engagement
// draft → send governance: draft is non-committal; confirm persists the
// recruiter-reviewed final via the seam mint (LB-2).
//
// G1 human-in-the-loop: the draft touches NOTHING canonical; only confirm
// mints/updates the Job + GoldenProfile and stamps golden_profile_id.
// G3: NO consent gate (no external recipient). G4: the prompt is built
// from the role-content allowlist (profile-prompt.ts) — commercial/notes
// never reach the LLM. G5: PII-redaction (D6) + no-raw-logging (D7) are
// handled inside AiDraftService. G6: matching stays deterministic — this
// service only GENERATES the GoldenProfile; it does not match.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_MAX_TOKENS = 1024;

@Injectable()
export class RequisitionProfileService {
  constructor(
    private readonly aiDraftService: AiDraftService,
    private readonly requisitionRepository: RequisitionRepository,
    private readonly jobDomainRepository: JobDomainRepository,
  ) {}

  // GET /v1/requisitions/:id/profile — PR-A2 P3 the first-class profile
  // read (A1 deferred it). Visibility-scoped (same 404 contract as GET-by-id:
  // a req invisible to the actor → 404, NEVER the profile of a req they
  // cannot see). RESHAPE-ON-READ: un-nests jd_text + the structured profile
  // from the GoldenProfile.skills Json blob via goldenProfileContentFromStorage
  // — NO schema change (R3). A requisition with no confirmed profile yet
  // returns the profile-less shape (has_profile === false), NOT a 404/500.
  async readProfile(args: {
    tenant_id: string;
    requisition_id: string;
    visibility: VisibilityContextShape;
    requestId: string;
  }): Promise<RequisitionProfileView> {
    const view = await this.requisitionRepository.findByIdForActor({
      tenant_id: args.tenant_id,
      id: args.requisition_id,
      visibility: args.visibility,
    });
    if (view === null) {
      throw new AramoError('NOT_FOUND', 'Requisition not found (or not visible to actor)', 404, {
        requestId: args.requestId,
        details: { id: args.requisition_id },
      });
    }

    // No profile confirmed yet → the profile-less shape (not an error).
    if (view.golden_profile_id === null) {
      return emptyRequisitionProfileView(args.requisition_id);
    }

    const row = await this.jobDomainRepository.findGoldenProfileById(
      view.golden_profile_id,
    );
    if (row === null) {
      // Defensive: the seam points at a row that has vanished. Surface the
      // profile-less shape (still honest: has_profile false) rather than 500.
      return emptyRequisitionProfileView(args.requisition_id);
    }

    const content = goldenProfileContentFromStorage({
      skills: row.skills,
      experience: row.experience,
      constraints: row.constraints,
    });
    return {
      requisition_id: args.requisition_id,
      golden_profile_id: view.golden_profile_id,
      has_profile: true,
      jd_text: content.jd_text,
      role_family: content.role_family ?? null,
      seniority_level: content.seniority_level ?? null,
      generated_by: content.generated_by,
      required_skills: content.required_skills,
      preferred_skills: content.preferred_skills,
      critical_skills: content.critical_skills,
      experience: content.experience,
      constraints: content.constraints,
    };
  }

  // POST /v1/requisitions/:id/profile/draft — runs the LLM, persists the
  // ai-draft audit events (in libs/ai-draft), returns the draft. NO
  // mutation of the canonical Requisition / GoldenProfile (G1).
  async draftProfile(args: {
    tenant_id: string;
    requisition_id: string;
    brief: string;
    max_tokens?: number;
    visibility: VisibilityContextShape;
    requestId: string;
  }): Promise<DraftProfileResponseDto> {
    if (args.brief.trim().length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'brief must be non-empty', 400, {
        requestId: args.requestId,
        details: { field: 'brief' },
      });
    }
    // Visibility-scoped read — 404 if the requisition is not visible to the
    // actor (mirrors the GET-by-id contract; no LLM tokens spent on an
    // invisible req).
    const view = await this.requisitionRepository.findByIdForActor({
      tenant_id: args.tenant_id,
      id: args.requisition_id,
      visibility: args.visibility,
    });
    if (view === null) {
      throw new AramoError('NOT_FOUND', 'Requisition not found (or not visible to actor)', 404, {
        requestId: args.requestId,
        details: { id: args.requisition_id },
      });
    }

    // G4 — build the prompt from the role-content ALLOWLIST ONLY.
    const role = extractRoleContent(view);
    const { prompt, system_message } = buildProfilePrompt({ brief: args.brief, role });

    const result = await this.aiDraftService.generateDraft({
      tenant_id: args.tenant_id,
      prompt,
      max_tokens: args.max_tokens ?? DEFAULT_MAX_TOKENS,
      system_message,
      requestId: args.requestId,
    });

    const parsed = parseProfileCompletion(result.completion, args.brief);
    return {
      draft_event_id: result.audit_record_id,
      jd_text: parsed.jd_text,
      golden_profile_draft: parsed.golden_profile,
      ai_draft_audit_record_id: result.audit_record_id,
    };
  }

  // POST /v1/requisitions/:id/profile/confirm — persists the recruiter-
  // reviewed final JD + GoldenProfile (LB-2 mint), idempotent.
  async confirmProfile(args: {
    tenant_id: string;
    requisition_id: string;
    draft_event_id?: string;
    jd_text: string;
    golden_profile: GoldenProfileContent;
    visibility: VisibilityContextShape;
    requestId: string;
  }): Promise<ConfirmProfileResponseDto> {
    const view = await this.requisitionRepository.findByIdForActor({
      tenant_id: args.tenant_id,
      id: args.requisition_id,
      visibility: args.visibility,
    });
    if (view === null) {
      throw new AramoError('NOT_FOUND', 'Requisition not found (or not visible to actor)', 404, {
        requestId: args.requestId,
        details: { id: args.requisition_id },
      });
    }

    // The recruiter-reviewed final is authoritative; jd_text on the body
    // overrides whatever sits in the golden_profile envelope.
    const content: GoldenProfileContent = {
      ...args.golden_profile,
      jd_text: args.jd_text,
    };

    // Cross-event-ref (G1, mirrors the engagement send → draft-event
    // reference): an AI-generated profile MUST reference its draft event.
    // The manual-entry
    // path (generated_by === 'manual') is exempt — AI is never required.
    if (content.generated_by === 'ai_draft') {
      if (args.draft_event_id === undefined || !UUID_RE.test(args.draft_event_id)) {
        throw new AramoError(
          'VALIDATION_ERROR',
          'draft_event_id is required to confirm an AI-generated profile',
          422,
          { requestId: args.requestId, details: { reason: 'draft_ref_required', field: 'draft_event_id' } },
        );
      }
    }

    const storage = goldenProfileContentToStorage(content);

    // Idempotent re-generation: if the requisition already links a profile,
    // UPDATE it in place (no duplicate mint).
    if (view.golden_profile_id !== null) {
      const updated = await this.jobDomainRepository.updateGoldenProfile({
        id: view.golden_profile_id,
        tenant_id: args.tenant_id,
        skills: storage.skills,
        experience: storage.experience,
        constraints: storage.constraints,
        critical_skills: storage.critical_skills,
      });
      if (updated !== null) {
        // Already stamped; the link is unchanged.
        return view;
      }
      // The linked row vanished (defensive) — fall through to re-mint.
    }

    // Mint: create Job + GoldenProfile, then stamp the seam.
    const jobId = randomUUID();
    await this.jobDomainRepository.createJob({ id: jobId, tenant_id: args.tenant_id });
    const goldenProfileId = randomUUID();
    await this.jobDomainRepository.createGoldenProfile({
      id: goldenProfileId,
      tenant_id: args.tenant_id,
      job_id: jobId,
      skills: storage.skills,
      experience: storage.experience,
      constraints: storage.constraints,
      critical_skills: storage.critical_skills,
    });

    const stamped: RequisitionView = await this.requisitionRepository.stampGoldenProfileId({
      tenant_id: args.tenant_id,
      id: args.requisition_id,
      golden_profile_id: goldenProfileId,
      requestId: args.requestId,
    });
    return stamped;
  }
}
