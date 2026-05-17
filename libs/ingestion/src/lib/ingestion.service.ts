import { Injectable } from '@nestjs/common';
import { SourceConsentService } from '@aramo/consent';

import type { IndeedSearchResultsRequestDto } from './dto/indeed-search-results-request.dto.js';
import type { IndeedSearchResultsResponseDto } from './dto/indeed-search-results-response.dto.js';
import type { IngestionPayloadRequestDto } from './dto/ingestion-payload-request.dto.js';
import type {
  DedupOutcomeDto,
  IngestionPayloadResponseDto,
  IngestionStatus,
} from './dto/ingestion-payload-response.dto.js';
import {
  IngestionRepository,
  type RawPayloadRow,
} from './ingestion.repository.js';

// IngestionService — accept a generic ingestion payload, store the raw
// payload reference, run deduplication, return the ingestion result.
//
// PR-12 is PASSIVE INTAKE (Charter R2 mitigation per directive §7):
// the service stores what is submitted; it does not crawl, search,
// or autonomously discover. No external-source calls.
//
// Deduplication is detection-and-flag only (directive §4.4 + §5): the
// service detects whether a matching prior payload exists and reports
// the outcome; it does not merge, resolve, or canonicalize duplicates.
//
// Dedup order (first match wins): sha256 (content-addressed) →
// verified_email → profile_url. A sha256 match is the strongest signal
// (same payload bytes); verified_email + profile_url surface semantic
// duplicates with different bytes. The (tenant_id, sha256) DB-level
// unique constraint guarantees a sha256 collision is rejected before
// insert; the service intercepts the lookup first to return a
// "duplicate" response cleanly instead of surfacing a constraint
// violation.

export interface AcceptPayloadInput {
  tenant_id: string;
  request: IngestionPayloadRequestDto;
}

export interface AcceptIndeedSearchResultsInput {
  tenant_id: string;
  requestId: string;
  request: IndeedSearchResultsRequestDto;
}

@Injectable()
export class IngestionService {
  constructor(
    private readonly ingestionRepo: IngestionRepository,
    private readonly sourceConsentService: SourceConsentService,
  ) {}

  async acceptPayload(
    input: AcceptPayloadInput,
  ): Promise<IngestionPayloadResponseDto> {
    const { tenant_id, request } = input;

    // Dedup: sha256 first (content-addressed, strongest signal).
    const sha256Match = await this.ingestionRepo.findBySha256({
      tenant_id,
      sha256: request.sha256,
    });
    if (sha256Match !== null) {
      return this.toResponse(sha256Match, 'duplicate', {
        match_signal: 'sha256',
        existing_payload_id: sha256Match.id,
      });
    }

    // Normalize the dedup-supporting fields. Email lowercased + trimmed;
    // profile_url trimmed only (case can be significant in URL paths).
    const normalizedEmail =
      request.verified_email !== undefined
        ? request.verified_email.trim().toLowerCase()
        : null;
    const normalizedProfileUrl =
      request.profile_url !== undefined ? request.profile_url.trim() : null;

    // Dedup: verified_email match within tenant.
    if (normalizedEmail !== null && normalizedEmail.length > 0) {
      const emailMatch = await this.ingestionRepo.findByVerifiedEmail({
        tenant_id,
        verified_email: normalizedEmail,
      });
      if (emailMatch !== null) {
        return this.toResponse(emailMatch, 'duplicate', {
          match_signal: 'verified_email',
          existing_payload_id: emailMatch.id,
        });
      }
    }

    // Dedup: profile_url match within tenant.
    if (normalizedProfileUrl !== null && normalizedProfileUrl.length > 0) {
      const urlMatch = await this.ingestionRepo.findByProfileUrl({
        tenant_id,
        profile_url: normalizedProfileUrl,
      });
      if (urlMatch !== null) {
        return this.toResponse(urlMatch, 'duplicate', {
          match_signal: 'profile_url',
          existing_payload_id: urlMatch.id,
        });
      }
    }

    // No prior match — store the raw payload reference.
    const row = await this.ingestionRepo.createPayload({
      tenant_id,
      source: request.source,
      storage_ref: request.storage_ref,
      sha256: request.sha256,
      content_type: request.content_type,
      captured_at: new Date(request.captured_at),
      verified_email: normalizedEmail,
      profile_url: normalizedProfileUrl,
    });
    return this.toResponse(row, 'accepted', {
      match_signal: null,
      existing_payload_id: null,
    });
  }

  async getPayload(args: { id: string }): Promise<IngestionPayloadResponseDto | null> {
    const row = await this.ingestionRepo.findById(args);
    if (row === null) {
      return null;
    }
    return this.toResponse(row, 'accepted', {
      match_signal: null,
      existing_payload_id: null,
    });
  }

  // POST /v1/ingestion/indeed/search-results — Phase 4 Group 3
  // Step 1 (PR-13 directive §4.1).
  //
  // PASSIVE INTAKE (Charter R2 mitigation): the recruiter (or
  // tenant-approved governed automation) ran the Indeed search
  // externally; this method receives the shortlist record they
  // pushed to it. NO Indeed API call is made from here. If a
  // future refactor adds an outbound Indeed call, that crosses
  // the R2 line — the source-engine refusal stops here.
  //
  // NO CONTACT DATA EXTRACTED: per Phase 4 Step 1, the search-
  // results stage stores shortlist references only. The Indeed
  // request body carries no verified_email / profile_url and the
  // method writes neither to RawPayloadReference.
  //
  // SOURCE-CONSENT REGISTRATION (Charter R5 honest-visibility):
  // on each ingest, this method calls SourceConsentService to
  // register the per-scope initial consent state per the Group 2
  // v2.3a table. For Indeed this is PARTIAL consent — contacting
  // is LIMITED to the Indeed channel only (via
  // metadata.permitted_channels = ['indeed']). NEVER all-yes.
  // Assigning consent the source did not grant would be widening
  // by aggregation; the SourceConsentService mapping is the
  // load-bearing R5 rule.
  //
  // Dedup: sha256 content-addressed only — the search-results
  // stage stores no email/URL so the verified_email / profile_url
  // dedup paths don't apply here.
  async acceptIndeedSearchResults(
    input: AcceptIndeedSearchResultsInput,
  ): Promise<IndeedSearchResultsResponseDto> {
    const { tenant_id, requestId, request } = input;

    // sha256-only dedup for Indeed (no email / no URL in the
    // wire body).
    const sha256Match = await this.ingestionRepo.findBySha256({
      tenant_id,
      sha256: request.sha256,
    });
    if (sha256Match !== null) {
      // A prior identical Indeed payload exists in this tenant.
      // Do NOT re-register source-consent (the original ingest
      // already registered it). Return the existing record's
      // metadata so the caller knows it was a duplicate.
      return this.toIndeedResponse(sha256Match, {
        match_signal: 'sha256',
        existing_payload_id: sha256Match.id,
      });
    }

    // No prior match — store the raw payload reference with
    // source='indeed' (server-set; the endpoint path implies it).
    const row = await this.ingestionRepo.createPayload({
      tenant_id,
      source: 'indeed',
      storage_ref: request.storage_ref,
      sha256: request.sha256,
      content_type: request.content_type,
      captured_at: new Date(request.captured_at),
      // Indeed search-results stage extracts no contact data —
      // both verified_email and profile_url are explicitly null.
      verified_email: null,
      profile_url: null,
      skill_surface_forms: request.skill_surface_forms ?? null,
    });

    // Register the per-scope initial consent state per Group 2
    // v2.3a (PR-13 directive §4.3). The mapping rule lives in
    // libs/consent; this call hands off the source/talent/tenant
    // context.
    await this.sourceConsentService.registerSourceDerivedConsent({
      tenant_id,
      talent_id: request.talent_id,
      source: 'indeed',
      occurred_at: request.captured_at,
      requestId,
    });

    return this.toIndeedResponse(row, {
      match_signal: null,
      existing_payload_id: null,
    });
  }

  private toIndeedResponse(
    row: RawPayloadRow,
    dedup: DedupOutcomeDto,
  ): IndeedSearchResultsResponseDto {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      // Server-asserted: the Indeed endpoint always writes
      // source='indeed' and reports status='shortlisted_not_unlocked'.
      source: 'indeed',
      status: 'shortlisted_not_unlocked',
      dedup,
      created_at: row.created_at.toISOString(),
    };
  }

  private toResponse(
    row: RawPayloadRow,
    status: IngestionStatus,
    dedup: DedupOutcomeDto,
  ): IngestionPayloadResponseDto {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      source: row.source,
      status,
      dedup,
      created_at: row.created_at.toISOString(),
    };
  }
}
