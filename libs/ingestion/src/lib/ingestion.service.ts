import { Injectable } from '@nestjs/common';

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

@Injectable()
export class IngestionService {
  constructor(private readonly ingestionRepo: IngestionRepository) {}

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
