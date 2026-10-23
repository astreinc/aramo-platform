import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';

// ATI-SEP-1 A3 (ADR-0036 §3; Addendum A2 E-1) — the ATS talent outbox. Events
// carry past-tense BUSINESS-FACT names; the version rides the envelope
// (event_version), never the name. Every row is written in the SAME
// talent_record transaction as the fact it records (create / update), or in the
// erasure pass's transaction (talent.erased), so a row exists iff the fact
// committed. Payloads are ids + changed field NAMES only: no PII, no document
// reference, no storage key.
export const TALENT_EVENT_CREATED = 'talent.created';
export const TALENT_EVENT_PROFILE_UPDATED = 'talent.profile_updated';
export const TALENT_EVENT_ERASED = 'talent.erased';
export const TALENT_EVENT_VERSION = 'v1';
export const TALENT_EVENT_SOURCE = 'ats-talent-record';
export const TALENT_EVENT_SUBJECT_TYPE = 'talent_record';

export type TalentEventType =
  | typeof TALENT_EVENT_CREATED
  | typeof TALENT_EVENT_PROFILE_UPDATED
  | typeof TALENT_EVENT_ERASED;

export interface TalentEventPayload {
  talent_record_id: string;
  // talent.profile_updated — the NAMES of the changed fields / evidence areas.
  changed_fields?: string[];
  // talent.created via an intake Save — the originating draft id.
  intake_draft_id?: string;
}

export interface TalentEventInput {
  tenant_id: string;
  event_type: TalentEventType;
  talent_record_id: string;
  changed_fields?: readonly string[];
  intake_draft_id?: string;
  correlation_id?: string | null;
  causation_id?: string | null;
}

// The Prisma create payload for one outbox row (envelope columns always set).
export function buildTalentEventRow(input: TalentEventInput): {
  id: string;
  tenant_id: string;
  event_type: string;
  event_payload: TalentEventPayload;
  event_version: string;
  source: string;
  subject_type: string;
  subject_id: string;
  correlation_id: string | null;
  causation_id: string | null;
} {
  const payload: TalentEventPayload = {
    talent_record_id: input.talent_record_id,
    ...(input.changed_fields !== undefined
      ? { changed_fields: [...new Set(input.changed_fields)].sort() }
      : {}),
    ...(input.intake_draft_id !== undefined ? { intake_draft_id: input.intake_draft_id } : {}),
  };
  return {
    id: uuidv7(),
    tenant_id: input.tenant_id,
    event_type: input.event_type,
    event_payload: payload,
    event_version: TALENT_EVENT_VERSION,
    source: TALENT_EVENT_SOURCE,
    subject_type: TALENT_EVENT_SUBJECT_TYPE,
    subject_id: input.talent_record_id,
    correlation_id: input.correlation_id ?? null,
    causation_id: input.causation_id ?? null,
  };
}

// The minimal transaction surface the writers need (a Prisma interactive-tx
// client or the PrismaService itself).
export interface TalentEventOutboxWriter {
  talentEventOutbox: {
    create(args: { data: ReturnType<typeof buildTalentEventRow> }): Promise<unknown>;
  };
}

export async function writeTalentEvent(
  tx: TalentEventOutboxWriter,
  input: TalentEventInput,
): Promise<void> {
  await tx.talentEventOutbox.create({ data: buildTalentEventRow(input) });
}

// A claimed outbox row in the canonical envelope shape (structurally the
// @aramo/events LeasedOutboxRow — no lib edge needed for the adapter).
export interface TalentEventOutboxClaimRow {
  id: string;
  tenant_id: string;
  event_type: string;
  event_payload: unknown;
  created_at: Date;
  event_version: string | null;
  source: string | null;
  subject_type: string | null;
  subject_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  publish_attempts: number;
}

// Retry backoff for a failed dispatch: the lease is held for
// min(BASE * 2^(attempts-1), MAX) seconds, so a failing handler is retried at
// 5s, 10s, 20s … capped at 15 minutes, until the attempt budget quarantines it.
const RETRY_BACKOFF_BASE_SECONDS = 5;
const RETRY_BACKOFF_MAX_SECONDS = 900;

// The lease-safe outbox store (ADR-0033 Decision 1), structurally satisfying
// @aramo/events LeaseSafeOutboxRepository. All time decisions use DB now().
@Injectable()
export class TalentEventOutboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Standalone append for a fact committed OUTSIDE a talent_record transaction
  // (an ATS evidence edit in talent_evidence) — written right after that commit.
  async append(input: TalentEventInput): Promise<void> {
    await writeTalentEvent(this.prisma as unknown as TalentEventOutboxWriter, input);
  }

  async claimOutboxBatch(input: {
    limit: number;
    lease_seconds: number;
    max_attempts: number;
  }): Promise<TalentEventOutboxClaimRow[]> {
    return this.prisma.$queryRaw<TalentEventOutboxClaimRow[]>`
      UPDATE "talent_record"."TalentEventOutbox" AS o
      SET "claimed_at" = now(),
          "lease_expires_at" = now() + make_interval(secs => ${input.lease_seconds}::double precision),
          "publish_attempts" = o."publish_attempts" + 1
      FROM (
        SELECT "id"
        FROM "talent_record"."TalentEventOutbox"
        WHERE "published_at" IS NULL
          AND "quarantined_at" IS NULL
          AND "publish_attempts" < ${input.max_attempts}
          AND ("lease_expires_at" IS NULL OR "lease_expires_at" < now())
        ORDER BY "created_at" ASC
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
      ) AS c
      WHERE o."id" = c."id"
      RETURNING o."id", o."tenant_id", o."event_type", o."event_payload",
                o."created_at", o."event_version", o."source", o."subject_type",
                o."subject_id"::text AS "subject_id", o."correlation_id", o."causation_id",
                o."publish_attempts"
    `;
  }

  async markOutboxPublished(input: { event_ids: readonly string[] }): Promise<number> {
    if (input.event_ids.length === 0) return 0;
    const updated = await this.prisma.talentEventOutbox.updateMany({
      where: { id: { in: [...input.event_ids] }, published_at: null },
      data: { published_at: new Date() },
    });
    return updated.count;
  }

  // A failed dispatch keeps the lease for the backoff window (NOT released for
  // an immediate re-claim): the claim scan skips a row whose lease is live.
  async releaseOutboxLease(input: {
    event_ids: readonly string[];
    last_error: string;
  }): Promise<number> {
    if (input.event_ids.length === 0) return 0;
    return this.prisma.$executeRaw`
      UPDATE "talent_record"."TalentEventOutbox"
      SET "claimed_at" = NULL,
          "lease_expires_at" = now() + make_interval(secs => LEAST(
            ${RETRY_BACKOFF_BASE_SECONDS}::double precision * power(2, GREATEST("publish_attempts" - 1, 0)),
            ${RETRY_BACKOFF_MAX_SECONDS}::double precision)),
          "last_publish_error" = ${input.last_error}
      WHERE "id" = ANY(${[...input.event_ids]}::uuid[])
        AND "published_at" IS NULL
        AND "quarantined_at" IS NULL
    `;
  }

  async quarantineOutbox(input: {
    event_ids: readonly string[];
    reason: string;
  }): Promise<number> {
    if (input.event_ids.length === 0) return 0;
    const updated = await this.prisma.talentEventOutbox.updateMany({
      where: { id: { in: [...input.event_ids] }, published_at: null },
      data: { quarantined_at: new Date(), quarantine_reason: input.reason },
    });
    return updated.count;
  }
}
