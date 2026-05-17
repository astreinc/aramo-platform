import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { hashCanonicalizedBody } from '@aramo/common';

import { ConsentRepository } from './consent.repository.js';
import type { ConsentScopeValue } from './dto/consent-grant-request.dto.js';
import type { ConsentSourceType } from './dto/source-consent-source.js';

// SourceConsentService — registers the per-scope initial consent
// state for a talent that arrives via an ingestion source, per the
// Group 2 v2.3a "Consent state mapping" table. The mapping RULE
// lives here (PR-13 directive §4.3 + Lead Option-1 ruling): the
// consent module owns consent semantics; the ingestion module
// announces "a payload arrived from source X" and this service
// decides what that means for consent state.
//
// CRITICAL — Charter R5 (no widening via aggregation): an Indeed-
// sourced ingest produces PARTIAL consent — profile_storage /
// resume_processing / matching granted; contacting LIMITED to the
// Indeed channel ONLY (NOT all-yes general contacting consent).
// The partial Indeed state is the load-bearing honest-visibility
// behavior of PR-13. The contacting grant carries
// `metadata.permitted_channels: ['indeed']` so the runtime
// consent-check resolver returns denied for any non-Indeed channel
// (`reason_code: 'channel_not_consented'`).
//
// The consent module's append-only ledger convention applies: this
// service writes one append-only TalentConsentEvent per granted
// scope, exactly as ConsentService.grant does. The events flow
// through ConsentRepository.recordConsentEvent (the shared write
// seam — outbox / audit / staleness logic uniformly applied).

export interface RegisterSourceDerivedConsentInput {
  tenant_id: string;
  talent_id: string;
  source: ConsentSourceType;
  // ISO-8601 timestamp the source-derived consent should record as
  // its occurred_at. Caller provides; typically the ingestion
  // captured_at value or "now".
  occurred_at: string;
  // Caller's request id, threaded through for audit + outbox.
  requestId: string;
}

// What a single per-scope event registration looks like before
// the repository write seam packages it as a TalentConsentEvent.
interface SourceScopeGrant {
  scope: ConsentScopeValue;
  // Optional per-grant metadata (e.g., the contacting grant for
  // Indeed carries `permitted_channels: ['indeed']`).
  metadata?: Record<string, unknown>;
}

// Group 2 v2.3a "Consent state mapping" — locked at Group 2
// Consolidated Baseline v2.0 §2.3a. Each row enumerates which
// scopes are GRANTED at ingest from that source, with optional
// per-grant metadata. Cells with "no" / "N/A" produce no event —
// no grant means denied at resolver time (the resolver's empty
// scope handling).
const SOURCE_SCOPE_GRANTS: Record<ConsentSourceType, SourceScopeGrant[]> = {
  // Group 2 v2.3a: profile_storage=yes (per terms), resume=yes,
  // matching=yes, contacting=limited (Indeed channel). The
  // permitted_channels metadata is the R5 honest-visibility
  // tripwire — a contacting check with channel=email is denied.
  indeed: [
    { scope: 'profile_storage', metadata: { source_terms: 'indeed' } },
    { scope: 'resume_processing', metadata: { source_terms: 'indeed' } },
    { scope: 'matching', metadata: { source_terms: 'indeed' } },
    {
      scope: 'contacting',
      metadata: { permitted_channels: ['indeed'] },
    },
  ],
  // Group 2 v2.3a: profile_storage=yes (public), resume=N/A,
  // matching=yes, contacting=no. No resume_processing grant
  // (N/A); no contacting grant (explicit "no" → denied at
  // resolver time via empty-scope handling).
  github: [
    { scope: 'profile_storage', metadata: { source_terms: 'github_public' } },
    { scope: 'matching', metadata: { source_terms: 'github_public' } },
  ],
  // Group 2 v2.3a: profile_storage=yes (legitimate interest),
  // resume=yes, matching=yes, contacting=limited until refreshed.
  // The 12-month staleness window (R6) handles the "until
  // refreshed" semantic; no per-channel restriction is encoded.
  astre_import: [
    {
      scope: 'profile_storage',
      metadata: { lawful_basis: 'legitimate_interest' },
    },
    { scope: 'resume_processing' },
    { scope: 'matching' },
    { scope: 'contacting' },
  ],
  // Group 2 v2.3a: all four scopes = explicit. The Talent
  // provided data directly with explicit consent for every scope.
  talent_direct: [
    { scope: 'profile_storage' },
    { scope: 'resume_processing' },
    { scope: 'matching' },
    { scope: 'contacting' },
  ],
};

@Injectable()
export class SourceConsentService {
  constructor(private readonly consentRepo: ConsentRepository) {}

  async registerSourceDerivedConsent(
    input: RegisterSourceDerivedConsentInput,
  ): Promise<void> {
    const grants = SOURCE_SCOPE_GRANTS[input.source];
    // talent_direct is captured at self-signup; the other three
    // sources are server-side imports.
    const captured_method =
      input.source === 'talent_direct' ? 'self_signup' : 'import';

    for (const grant of grants) {
      const requestHash = hashCanonicalizedBody({
        tenant_id: input.tenant_id,
        talent_id: input.talent_id,
        source: input.source,
        scope: grant.scope,
      });
      const idempotencyKey = uuidv7();
      const metadata: Record<string, unknown> = {
        source_consent_origin: input.source,
        ...(grant.metadata ?? {}),
      };
      await this.consentRepo.recordConsentEvent({
        action: 'granted',
        tenant_id: input.tenant_id,
        talent_id: input.talent_id,
        scope: grant.scope,
        captured_method,
        // Source-derived consent has no human actor — the import
        // attribution is in metadata.source_consent_origin.
        captured_by_actor_id: null,
        consent_version: 'source-derived-v1',
        occurred_at: input.occurred_at,
        metadata,
        idempotencyKey,
        requestHash,
        requestId: input.requestId,
      });
    }
  }
}
