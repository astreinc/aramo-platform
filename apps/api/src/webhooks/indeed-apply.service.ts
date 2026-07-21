import { Injectable } from '@nestjs/common';
import { normalizeEmail, normalizePhone } from '@aramo/common';
import { TenantService, extractTenantSlugFromHost } from '@aramo/identity';
import {
  IngestionService,
  type IngestionPayloadRequestDto,
} from '@aramo/ingestion';
import { ObjectStorageService } from '@aramo/object-storage';
import { SourcedTalentRepository } from '@aramo/sourced-talent';

import {
  INDEED_APPLY_WEBHOOK_SECRET_ENV,
  INDEED_SOURCE_CHANNEL,
  INDEED_STORAGE_CHANNEL,
} from './indeed-apply.constants.js';
import {
  INDEED_SIGNATURE_HEADER,
  verifyIndeedSignature,
} from './indeed-signature.js';

// SRC-1 PR-2 — Indeed Apply webhook processing service (composition root,
// apps/api, R13.5). Orchestrates R4's strict order over three already-imported
// modules (object-storage, ingestion, sourced-talent) + tenant resolution
// (identity). Zero new nx edges (R13.5): every edge apps/api → these libs
// pre-exists.
//
// Anti-oracle order (R5): the secret gate (503) and signature check (401) run
// BEFORE tenant resolution, so an unknown-slug 404 is reachable only by an
// authentically-signed Indeed request — no unauthenticated tenant-enumeration
// oracle. Every non-200 outcome is a bare status with no body detail.

const APP_ROOT_DOMAIN = process.env['APP_ROOT_DOMAIN'] ?? 'aramo.ai';

export type IndeedApplyOutcome =
  | { status: 503 } // secret unset — endpoint dark
  | { status: 401 } // missing/invalid signature
  | { status: 404 } // unknown/inactive tenant slug
  | { status: 400 } // malformed payload (not JSON / no apply_id)
  | { status: 200; arrival_id: string; ingestion_payload_id: string };

interface ParsedApplyPayload {
  apply_id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
}

export interface ProcessIndeedApplyInput {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  host: string | undefined;
  requestId: string;
}

@Injectable()
export class IndeedApplyWebhookService {
  constructor(
    private readonly objectStorage: ObjectStorageService,
    private readonly ingestion: IngestionService,
    private readonly tenants: TenantService,
    private readonly arrivals: SourcedTalentRepository,
  ) {}

  async process(input: ProcessIndeedApplyInput): Promise<IndeedApplyOutcome> {
    // R5 — unset secret refuses ALL traffic (dark by construction).
    const secret = process.env[INDEED_APPLY_WEBHOOK_SECRET_ENV];
    if (secret === undefined || secret.length === 0) {
      return { status: 503 };
    }

    // R5 — authenticity FIRST (before any tenant probe). Fail-closed 401.
    if (!verifyIndeedSignature(input.rawBody, input.signatureHeader, secret)) {
      return { status: 401 };
    }

    // R6 / RECON-3a — tenant from the Host slug (reused primitives). Unknown or
    // inactive slug → 404, no detail. Caddy forwards the original host; prefer the
    // forwarded header, fall back to Host.
    const slug =
      input.host === undefined
        ? null
        : extractTenantSlugFromHost(input.host, APP_ROOT_DOMAIN);
    const tenant =
      slug === null ? null : await this.tenants.findActiveBySlug(slug);
    if (tenant === null) {
      return { status: 404 };
    }

    // RECON-2 — the stable dedup id is `id` (apply_id). No id → malformed.
    const parsed = this.parseApplyPayload(input.rawBody);
    if (parsed === null) {
      return { status: 400 };
    }

    const receivedAt = new Date();
    const receivedAtIso = receivedAt.toISOString();

    // R4 step 2 — persist the RAW signed bytes verbatim; sha256 server-computed.
    const { storage_ref, sha256 } = await this.objectStorage.putIngestionObject({
      tenant_id: tenant.id,
      channel: INDEED_STORAGE_CHANNEL,
      external_source_id: parsed.apply_id,
      body: input.rawBody,
      content_type: 'application/json',
      requestId: input.requestId,
    });

    // R4 step 3 — front door, in-process (source 'indeed'). verified_email is NOT
    // set (an applicant email is unverified); declared_name carried where the DTO
    // accepts it; source_class server-derives to THIRD_PARTY_UNVERIFIED.
    const acceptRequest: IngestionPayloadRequestDto = {
      source: 'indeed',
      storage_ref,
      sha256,
      content_type: 'application/json',
      captured_at: receivedAtIso,
      ...(parsed.full_name !== null ? { declared_name: parsed.full_name } : {}),
    } as IngestionPayloadRequestDto;
    const accepted = await this.ingestion.acceptPayload({
      tenant_id: tenant.id,
      request: acceptRequest,
    });

    // R4 step 4 — channel dedup memory. external_source_id = apply_id (RECON-2);
    // normalized contact via @aramo/common (R8) — NOT the @aramo/identity twin.
    // Idempotent: a redelivery of the same apply_id returns the ORIGINAL row.
    const arrival = await this.arrivals.recordArrival({
      tenant_id: tenant.id,
      source_channel: INDEED_SOURCE_CHANNEL,
      external_source_id: parsed.apply_id,
      ...(parsed.email !== null
        ? { normalized_email: normalizeEmail(parsed.email) }
        : {}),
      ...(parsed.phone !== null
        ? { normalized_phone: normalizePhone(parsed.phone) }
        : {}),
      // Placeholder basis per §2 PR-2 — counsel-gated (A4). The jurisdiction note
      // key is documented as pending until counsel returns the per-jurisdiction
      // basis text.
      legal_basis: {
        basis: 'first_party_application',
        jurisdiction_note: 'PENDING_COUNSEL_A4',
      },
      provenance: {
        ingestion_payload_id: accepted.id,
        received_at: receivedAtIso,
        // The signature HEADER NAME, never the value.
        signature_header: INDEED_SIGNATURE_HEADER,
        // Raw applicant identifiers as received (the schema keeps raw contact in
        // provenance; normalized_* carry the fingerprint-ready forms).
        applicant: {
          apply_id: parsed.apply_id,
          full_name: parsed.full_name,
          email: parsed.email,
          phone: parsed.phone,
        },
      },
      arrived_at: receivedAt,
    });

    return {
      status: 200,
      arrival_id: arrival.id,
      ingestion_payload_id: accepted.id,
    };
  }

  private parseApplyPayload(rawBody: Buffer): ParsedApplyPayload | null {
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    if (typeof json !== 'object' || json === null) {
      return null;
    }
    const obj = json as Record<string, unknown>;
    const id = obj['id'];
    if (typeof id !== 'string' || id.length === 0) {
      return null;
    }
    const applicant =
      typeof obj['applicant'] === 'object' && obj['applicant'] !== null
        ? (obj['applicant'] as Record<string, unknown>)
        : {};
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim().length > 0 ? v : null;
    return {
      apply_id: id,
      full_name: str(applicant['fullName']),
      email: str(applicant['email']),
      phone: str(applicant['phoneNumber']),
    };
  }
}
