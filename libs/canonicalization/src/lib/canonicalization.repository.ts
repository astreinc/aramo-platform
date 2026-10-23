import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError, type AramoLogger } from '@aramo/common';
import { SourcedTalentRepository, type SourcedTalentRow } from '@aramo/sourced-talent';

import { Prisma } from '../../prisma/generated/client/client.js';

import { PrismaService } from './prisma/prisma.service.js';

// T2-2a / T2-3 — canonicalization orchestrator (the atomic resolve-or-create
// canonicalize service).
//
// Surface (closed, single method):
//   canonicalize({ payload_id, source_channel, authContext, requestId })
//     → CanonicalizeResult
//
// ATI-SEP-1 T10 WP2 (Addenda A2 F-1 / A3 — ATS keeps sourcing, rebuilt on
// sourced_talent): every ingestion arrival resolves to an ATS-local
// sourced_talent.SourcedTalent row, keyed by (tenant, channel, external id):
//   * an arrival a SRC-1 channel writer already landed (Indeed apply webhook,
//     manual capture — provenance.ingestion_payload_id = this payload) is REUSED;
//   * otherwise canonicalize records one idempotently: channel = the payload's
//     source (upper-cased), external id = the channel profile URL when present,
//     else the payload's content hash (a re-pull of the same profile / the same
//     bytes is the SAME arrival).
// The retired trust subject + identity-index cluster are no longer minted:
// RawPayloadReference.resolved_subject_id / resolved_cluster_id become INERT
// soft refs (ADD-not-rename); sourced_talent_id is the new anchor + poll gate.
// No fuzzy match, no cross-tenant key — the arrival stays inside the tenant wall.
//
// Atomicity (Directive §1 Ruling 1): the payload decision + outbox event commit
// in ONE Prisma $transaction at READ COMMITTED with a SELECT … FOR UPDATE lock on
// the RawPayloadReference row. The SourcedTalent write runs on the sourced-talent
// lib's OWN client (a separate connection, the precedent the retired resolver
// seams set): it is idempotent on the (tenant, channel, external id) @@unique, so
// a canonicalize rollback leaves at most a reusable arrival that the retry finds.
//
// R-boundary: identity + contact material ONLY. No tier / ordinal / match
// output (R10).

// Resolution method — closed enum mirroring the ingestion-schema
// ResolutionMethod (DB) enum. TR-2a-B2 (DDR-2 §6): canonicalize/recordSourcedArrival
// WRITES only {new_identity, confirmed_anchor_match}. `verified_email_match` +
// `caller_supplied` are read-widened HISTORICAL values the DB enum still carries
// (append-only truth of the retired rule); canonicalize never produces them.
export type ResolutionMethodValue =
  | 'new_identity'
  | 'confirmed_anchor_match'
  | 'verified_email_match'
  | 'caller_supplied';

// Caller-supplied auth context. Minimal shape: tenant_id is the only
// field T2-2a reads (for cross-tenant rejection — absorbed into
// CANONICALIZATION_PAYLOAD_NOT_FOUND so the surface does not enumerate
// other-tenant payload ids). The lib stays decoupled from @aramo/auth
// (Nest's AuthContext) at T2-2a; T2-3's ingestion-trigger maps the
// real AuthContext to this shape.
export interface CanonicalizeAuthContext {
  tenant_id: string;
}

export interface CanonicalizeInput {
  payload_id: string;
  // Provenance channel of the arrival (stored on the L2 contact evidence).
  source_channel: string;
  authContext: CanonicalizeAuthContext;
  requestId: string;
}

export interface CanonicalizeResult {
  // ATI-SEP-1 T10 WP2 — the ATS-local sourced_talent.SourcedTalent id this
  // arrival resolved to (the sourcing pool / promotion key).
  sourced_talent_id: string;
  tenant_id: string;
  resolution_method: ResolutionMethodValue;
  // true when the payload was already canonicalized (the idempotency
  // short-circuit fired). When true: no new subject / evidence / outbox-event
  // was written; the caller sees the prior result. outbox_event_id is null.
  already_canonicalized: boolean;
  // OutboxEvent id IF a new event was written (i.e.
  // already_canonicalized === false). Drained by T2-2b.
  outbox_event_id: string | null;
}

// Locked-row shape returned by the SELECT … FOR UPDATE. Mirrors the
// columns the canonicalize flow reads.
interface LockedPayloadRow {
  id: string;
  tenant_id: string;
  source: string;
  source_class: string;
  sha256: string;
  captured_at: Date;
  verified_email: string | null;
  profile_url: string | null;
  declared_name: string | null;
  sourced_talent_id: string | null;
  resolution_method: ResolutionMethodValue | null;
}

// T2-3 — unresolved-payload batch shape (the polling-outbox row). The
// trigger processor reads these rows and invokes canonicalize() per
// payload; the resolved_talent_id IS NULL filter means each row is
// off-queue once resolved (resolved_talent_id is set inside the
// canonicalize $transaction). The minimal projection is intentional —
// the consumer only needs (payload_id, tenant_id) to invoke
// canonicalize; verified_email + source decisions stay inside the
// canonicalize $transaction.
export interface UnresolvedPayloadRow {
  id: string;
  tenant_id: string;
  source: string;
}

@Injectable()
export class CanonicalizationRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('CanonicalizationRepositoryLogger')
    private readonly logger: AramoLogger,
    // ATI-SEP-1 T10 WP2 — the ATS-local sourcing store (scope:ats → scope:ats).
    // Runs on its OWN client; recordArrival is idempotent on the dedup key.
    private readonly sourced: SourcedTalentRepository,
  ) {}

  // T2-3 — polling-outbox read. Returns up to `limit` payloads not yet resolved
  // to a SourcedTalent (sourced_talent_id IS NULL), oldest first. A legacy row
  // canonicalized before WP2 (resolved_subject_id set, sourced_talent_id NULL) is
  // picked up ONCE and lands its arrival — the forward backfill of the pool.
  // `minAgeMs` holds a just-written payload back for a moment so the SRC-1
  // channel writer's own recordArrival (written right after acceptPayload) lands
  // first and is reused rather than duplicated.
  //
  // No transaction / no lock — the canonicalize $transaction itself SELECTs FOR
  // UPDATE the row, so two ticks racing on one payload serialize there and the
  // second short-circuits on the now non-null sourced_talent_id.
  async findUnresolvedPayloadBatch(args: {
    limit: number;
    minAgeMs?: number;
  }): Promise<UnresolvedPayloadRow[]> {
    const minAge = args.minAgeMs ?? 0;
    const rows = await this.prisma.rawPayloadReference.findMany({
      where: {
        sourced_talent_id: null,
        ...(minAge > 0 ? { created_at: { lte: new Date(Date.now() - minAge) } } : {}),
      },
      orderBy: { created_at: 'asc' },
      take: args.limit,
      select: {
        id: true,
        tenant_id: true,
        source: true,
      },
    });
    return rows;
  }

  async canonicalize(input: CanonicalizeInput): Promise<CanonicalizeResult> {
    const startedAt = Date.now();
    this.logger.log({
      event: 'canonicalize_started',
      tenant_id: input.authContext.tenant_id,
      payload_id: input.payload_id,
      source_channel: input.source_channel,
    });

    const result = await this.prisma.$transaction(
      async (tx) => {
        // Step 1 — read + lock the payload row (held for the rest of the tx).
        const lockedRows = await tx.$queryRaw<LockedPayloadRow[]>`
          SELECT
            id,
            tenant_id,
            source,
            source_class,
            sha256,
            captured_at,
            verified_email,
            profile_url,
            declared_name,
            sourced_talent_id,
            resolution_method
          FROM "ingestion"."RawPayloadReference"
          WHERE id = ${input.payload_id}::uuid
          FOR UPDATE
        `;

        const payload = lockedRows[0];

        // Cross-tenant absorbed into NOT_FOUND — no enumeration.
        if (payload === undefined || payload.tenant_id !== input.authContext.tenant_id) {
          throw new AramoError(
            'CANONICALIZATION_PAYLOAD_NOT_FOUND',
            'RawPayloadReference not found',
            404,
            {
              requestId: input.requestId,
              details: { payload_id: input.payload_id },
            },
          );
        }

        // Step 2 — idempotency: sourced_talent_id is the LAST write of a prior
        // successful canonicalize.
        if (payload.sourced_talent_id !== null) {
          this.logger.log({
            event: 'canonicalize_idempotent_noop',
            tenant_id: payload.tenant_id,
            payload_id: payload.id,
            sourced_talent_id: payload.sourced_talent_id,
          });
          return {
            sourced_talent_id: payload.sourced_talent_id,
            tenant_id: payload.tenant_id,
            resolution_method: payload.resolution_method ?? 'new_identity',
            already_canonicalized: true,
            outbox_event_id: null,
          } satisfies CanonicalizeResult;
        }

        // Step 3 — resolve the arrival to its SourcedTalent row.
        const { arrival, existed } = await this.resolveArrival(payload, input.source_channel);
        const resolvedMethod: ResolutionMethodValue = existed
          ? 'confirmed_anchor_match'
          : 'new_identity';

        // Step 4 — record the decision on the payload row (the idempotency
        // anchor). resolved_subject_id / resolved_cluster_id are NOT written.
        await tx.rawPayloadReference.update({
          where: { id: payload.id },
          data: {
            sourced_talent_id: arrival.id,
            resolution_method: resolvedMethod,
          },
        });

        // Step 5 — the outbox event IN THE SAME TRANSACTION.
        const outboxEventId = uuidv7();
        await tx.outboxEvent.create({
          data: {
            id: outboxEventId,
            tenant_id: payload.tenant_id,
            event_type: 'talent.canonicalized',
            event_payload: {
              sourced_talent_id: arrival.id,
              tenant_id: payload.tenant_id,
              resolution_method: resolvedMethod,
              payload_id: payload.id,
            } as never,
          },
        });

        return {
          sourced_talent_id: arrival.id,
          tenant_id: payload.tenant_id,
          resolution_method: resolvedMethod,
          already_canonicalized: false,
          outbox_event_id: outboxEventId,
        } satisfies CanonicalizeResult;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    );

    this.logger.log({
      event: 'canonicalize_completed',
      tenant_id: result.tenant_id,
      payload_id: input.payload_id,
      sourced_talent_id: result.sourced_talent_id,
      resolution_method: result.resolution_method,
      already_canonicalized: result.already_canonicalized,
      outbox_event_id: result.outbox_event_id,
      latency_ms: Date.now() - startedAt,
    });

    return result;
  }

  // The arrival this payload is: the channel writer's own row when it recorded
  // one for this payload, else an idempotent (tenant, channel, external id) row.
  private async resolveArrival(
    payload: LockedPayloadRow,
    provenanceChannel: string,
  ): Promise<{ arrival: SourcedTalentRow; existed: boolean }> {
    const linked = await this.sourced.findByIngestionPayloadId(payload.tenant_id, payload.id);
    if (linked !== null) return { arrival: linked, existed: true };

    const source_channel = payload.source.toUpperCase();
    const external_source_id = payload.profile_url ?? payload.sha256;
    const prior = await this.sourced.findArrival(payload.tenant_id, source_channel, external_source_id);
    if (prior !== null) return { arrival: prior, existed: true };

    const email = payload.verified_email?.trim().toLowerCase() ?? '';
    const arrival = await this.sourced.recordArrival({
      tenant_id: payload.tenant_id,
      source_channel,
      external_source_id,
      ...(email !== '' ? { normalized_email: email } : {}),
      provenance: {
        ingestion_payload_id: payload.id,
        captured_at: payload.captured_at.toISOString(),
        source: payload.source,
        source_class: payload.source_class,
        provenance_channel: provenanceChannel,
        recorded_by: 'canonicalization',
        applicant: {
          full_name: payload.declared_name,
          email: payload.verified_email,
          profile_url: payload.profile_url,
        },
      },
      // No ratified basis is asserted at canonicalize — promotion carries the
      // payload's source + server-derived source_class into the consent ledger.
      legal_basis: { basis: null, status: 'PENDING_COUNSEL' },
      arrived_at: payload.captured_at,
    });
    return { arrival, existed: false };
  }
}
