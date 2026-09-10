import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { normalizeEmail, normalizePhone } from '@aramo/common';
import {
  IngestionService,
  deriveSourceClass,
  type IngestionPayloadRequestDto,
  type IngestionSourceClass,
} from '@aramo/ingestion';
import { ObjectStorageService } from '@aramo/object-storage';
import { SourcedTalentRepository } from '@aramo/sourced-talent';

import {
  MANUAL_CAPTURE_SOURCE,
  MANUAL_CAPTURE_SOURCE_CHANNEL,
  MANUAL_CAPTURE_STORAGE_CHANNEL,
} from './manual-capture.constants.js';

// TM-L1-C1 — Manual recruiter capture backend substrate (INTERNAL orchestration
// seam; NOT wired to a route). A recruiter manually entering a person is still a
// SOURCE event: this service routes that structured input through the SAME
// governed provenance model as every other source — object-storage raw artifact
// -> ingestion arrival (RawPayloadReference) -> sourced_talent staging — leaving
// an identity-resolution-ready PRE-Talent subject. It mints ZERO TalentRecord
// rows and never promotes (Arrival != Talent; single-genuine-Talent staging rule).
//
// It mirrors the SRC-1 Indeed Apply webhook orchestration (object-storage ->
// ingestion.acceptPayload -> sourced-talent.recordArrival) over the same four
// already-imported libs — zero new nx edges. It does NOT expose a public route.
//
// Future sequencing (NOT this seam): TM-L1-E may repoint the recruiter Add-Talent
// UI onto this governed capture and retire/reroute the legacy
// POST /v1/talent-records direct-create — but capture stays PRE-Talent. It does
// NOT promote and MUST NOT bypass identity resolution. The canonical path is
// TM-L1-E UI capture -> TM-L1 staging -> TM-L2 identity resolution -> downstream
// governed lifecycle -> TM-L8 promotion -> TalentRecord reuse/create.

// The narrow set of structured recruiter-entered fields. Kept flat + string-only
// so the canonical JSON artifact serialises deterministically (content-addressed
// idempotency). Extensible as the capture form grows.
export interface ManualTalentCaptureFields {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  profile_url?: string;
  current_employer?: string;
  key_skills?: string;
}

export interface ManualTalentCaptureInput {
  // Tenant identity — from the authenticated context only, NEVER a request body.
  tenant_id: string;
  // The authenticated recruiter who performed the capture — the ACTOR. Recorded
  // in provenance, kept SEPARATE from source/channel classification.
  actor_id: string;
  requestId: string;
  fields: ManualTalentCaptureFields;
}

export interface ManualTalentCaptureResult {
  // sourced_talent staging subject id (the pre-Talent, resolution-ready subject).
  arrival_id: string;
  // ingestion RawPayloadReference id (the provenance-preserving arrival).
  ingestion_payload_id: string;
  // Server-selected source + server-derived attestation level (informational —
  // the persisted values are written server-side inside acceptPayload).
  source: typeof MANUAL_CAPTURE_SOURCE;
  source_class: IngestionSourceClass;
}

// Deterministic canonical JSON over the structured person fields ONLY — sorted
// keys, defined values only, no actor/tenant/timestamp. Identical recruiter data
// hashes to identical bytes => content-addressed dedup across replays.
function canonicaliseFields(fields: ManualTalentCaptureFields): Buffer {
  const entries = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && String(v).length > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical: Record<string, string> = {};
  for (const [k, v] of entries) canonical[k] = String(v);
  return Buffer.from(JSON.stringify(canonical), 'utf8');
}

function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function buildDeclaredName(fields: ManualTalentCaptureFields): string | null {
  const name = [fields.first_name, fields.last_name]
    .filter((p) => typeof p === 'string' && p.trim().length > 0)
    .join(' ')
    .trim();
  return name.length > 0 ? name : null;
}

@Injectable()
export class ManualTalentCaptureService {
  constructor(
    private readonly objectStorage: ObjectStorageService,
    private readonly ingestion: IngestionService,
    private readonly arrivals: SourcedTalentRepository,
  ) {}

  async capture(
    input: ManualTalentCaptureInput,
  ): Promise<ManualTalentCaptureResult> {
    // 1. Canonical raw JSON artifact of the structured input (a REAL artifact —
    //    the actual manual entry — never a faked resume/file), and its
    //    content-addressed dedup key.
    const canonical = canonicaliseFields(input.fields);
    const contentSha = sha256Hex(canonical);

    // 2. Persist the raw artifact through the existing ingestion object-storage
    //    mechanism. The server recomputes sha256 over the exact stored bytes; it
    //    equals contentSha (same bytes) and feeds acceptPayload's dedup.
    const { storage_ref, sha256 } = await this.objectStorage.putIngestionObject({
      tenant_id: input.tenant_id,
      channel: MANUAL_CAPTURE_STORAGE_CHANNEL,
      external_source_id: contentSha,
      body: canonical,
      content_type: 'application/json',
      requestId: input.requestId,
    });

    // 3. Governed arrival. source is SERVER-SET to talent_direct (the caller
    //    cannot invent it); source_class is SERVER-DERIVED inside acceptPayload
    //    (the request DTO does not carry it). captured_at is server-stamped.
    const capturedAt = new Date();
    const capturedAtIso = capturedAt.toISOString();
    const declaredName = buildDeclaredName(input.fields);
    const acceptRequest: IngestionPayloadRequestDto = {
      source: MANUAL_CAPTURE_SOURCE,
      storage_ref,
      sha256,
      content_type: 'application/json',
      captured_at: capturedAtIso,
      ...(declaredName !== null ? { declared_name: declaredName } : {}),
    } as IngestionPayloadRequestDto;
    const accepted = await this.ingestion.acceptPayload({
      tenant_id: input.tenant_id,
      request: acceptRequest,
    });

    // 4. Pre-Talent staging subject (channel dedup memory). Idempotent on
    //    (tenant, TALENT_DIRECT, contentSha). The ACTOR (recruiter) is recorded
    //    in provenance — SEPARATE from the source/channel classification.
    const arrival = await this.arrivals.recordArrival({
      tenant_id: input.tenant_id,
      source_channel: MANUAL_CAPTURE_SOURCE_CHANNEL,
      external_source_id: contentSha,
      ...(input.fields.email !== undefined && input.fields.email.length > 0
        ? { normalized_email: normalizeEmail(input.fields.email) }
        : {}),
      ...(input.fields.phone !== undefined && input.fields.phone.length > 0
        ? { normalized_phone: normalizePhone(input.fields.phone) }
        : {}),
      // No ratified legal basis exists for manual capture — counsel disposition
      // is pending (Lane 5). Represent that HONESTLY: the basis is unasserted
      // (null) with an explicit pending status. We do NOT fabricate a basis;
      // `recruiter_manual_entry` is the capture MECHANISM (provenance context
      // below), not a processing basis. This JSONB field is not consumed by
      // promotion today; promotion carries the arrival's source + server-derived
      // source_class verbatim.
      legal_basis: {
        basis: null,
        status: 'PENDING_COUNSEL',
      },
      provenance: {
        ingestion_payload_id: accepted.id,
        captured_at: capturedAtIso,
        // ACTOR attribution — the authenticated recruiter who captured. Kept
        // OUT of the source vocabulary (talent_direct is the channel).
        captured_by_actor_id: input.actor_id,
        // Capture MECHANISM/context — provenance only, NEVER a legal basis.
        capture_mechanism: 'recruiter_manual_entry',
        structured: { ...input.fields },
      },
      arrived_at: capturedAt,
    });

    return {
      arrival_id: arrival.id,
      ingestion_payload_id: accepted.id,
      source: MANUAL_CAPTURE_SOURCE,
      source_class: deriveSourceClass(MANUAL_CAPTURE_SOURCE),
    };
  }
}
