import { Injectable, Logger } from '@nestjs/common';
import type { ResumeDraftAssertion } from '@aramo/talent-extraction';
import { TalentEvidenceRepository } from '@aramo/talent-evidence';
import { TalentTrustService } from '@aramo/talent-trust';

import {
  mapAssertionToClaim,
  mapCertificationToClaim,
  mapEducationToClaim,
  mapSkillToClaim,
  mapWorkAuthorizationToClaim,
  mapWorkHistoryToClaim,
} from './ledger-mapper.js';

// TEMPORARY — ATI-SEP-1 §5; deleted at T10 when Talent Intelligence service
// ingestion replaces it. Never call from an ATS create/edit request path.
//
// ATI-SEP-1 A1 — LegacyTrustProjectionService. The typed-row → trust-ledger
// projection that previously lived inside libs/talent-extraction (TR-4 B2 / TR-7
// B1 / TI-1C / HF2), relocated VERBATIM to the apps/api composition root so the
// ATS-owned libs (talent-extraction, talent-evidence — scope:ats) carry NO
// @aramo/talent-trust edge. It reads the ATS typed store through the
// talent-evidence *ForLedger read methods and writes through the SAME governed
// surface as before (recordDeclaredClaimIfAbsent: THIRD_PARTY_UNVERIFIED —
// declared, cannot elevate a band). Behaviour, provenance keys (source_ref) and
// the created_by / link_source labels are UNCHANGED, so the reconcile stays
// idempotent against every ledger row written before the move.
//
// Callers (never an ATS request path): the examine endpoint's Step-4b reconcile,
// the claims-ledger backfill CLI, and (ATI-SEP-1 A3) the LEGACY talent-event
// handler, which runs post-commit off the ATS talent outbox. The Add-Talent
// create / promote / edit path makes ZERO calls here (ATI-SEP-1 §5).
@Injectable()
export class LegacyTrustProjectionService {
  private readonly logger = new Logger(LegacyTrustProjectionService.name);

  constructor(
    private readonly evidence: TalentEvidenceRepository,
    private readonly trust: TalentTrustService,
  ) {}

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

  // ATI-SEP-1 A3 — route EVERY persisted work-history entry's experience
  // assertions (TalentWorkHistoryEntry.assertions, written at Save since A2) for
  // one talent. Post-commit only (the LEGACY talent-event handler); idempotent
  // through the content-keyed source_ref. Returns the count written.
  async routePersistedExperienceAssertionsToLedger(input: {
    tenant_id: string;
    talent_id: string;
  }): Promise<number> {
    const rows = await this.evidence.listWorkHistoryForLedger(input);
    let written = 0;
    for (const row of rows) {
      if (!Array.isArray(row.assertions) || row.assertions.length === 0) continue;
      written += await this.routeExperienceAssertionsToLedger({
        tenant_id: input.tenant_id,
        talent_id: input.talent_id,
        work_experience_id: row.id,
        assertions: row.assertions as ResumeDraftAssertion[],
      });
    }
    return written;
  }

  // HF2 R1/R7 — route a WorkExperience's resume-derived ASSERTIONS (activities /
  // accomplishments) into the talent-trust EvidenceRecord ledger as EXPERIENCE_
  // CLAIM rows. Reuses the SAME governed write surface as the declared-claim
  // reconcile (recordDeclaredClaimIfAbsent: THIRD_PARTY_UNVERIFIED / DOCUMENT /
  // ai_derived; NON-authoritative — cannot elevate a trust band). DETERMINISTIC
  // — no AI call (R6/§26); the source_ref is a content id so a re-create is
  // idempotent. grounding_class rides the payload (SOURCE_ASSOCIATED_
  // INTERPRETATION) for later Vector/KG projection. Returns the count written.
  // ATI-SEP-1 A1 — formerly persistExperienceAssertions, invoked post-commit by the
  // talent-extraction create/promote persisters; those ATS paths no longer call it
  // (where a review draft exists, its structured_payload retains the assertions).
  async routeExperienceAssertionsToLedger(input: {
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
}
