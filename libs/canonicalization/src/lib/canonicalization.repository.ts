import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import {
  AramoError,
  type AramoLogger,
  computeEmailFingerprint,
  loadIdentityPepper,
} from '@aramo/common';
import { IdentityIndexRepository } from '@aramo/identity-index';
import { TalentTrustService } from '@aramo/talent-trust';

import { Prisma } from '../../prisma/generated/client/client.js';

import { PrismaService } from './prisma/prisma.service.js';

// T2-2a / T2-3 — canonicalization orchestrator (the atomic resolve-or-
// associate-or-create canonicalize service). Lead-authored per
// Aramo-T2-2a-Canonicalization-Orchestration-Directive-v1_0-LOCKED.md
// + Aramo-T2-3-Resolution-Trigger-Gate5-Prompt-v1_0.
//
// Surface (closed, single method):
//   canonicalize({ payload_id, core_talent_id?, source_channel,
//                  resolution_method?, authContext })
//     → CanonicalizeResult
//
// Semantics (T2-3 RESOLVE + retained T2-2a test affordances):
//   - core_talent_id OMITTED (production path) → run the inline resolver.
//     Step 4b (ADR-0016) splits resolution into two anchors:
//       * PER-TENANT CORE HUSK (resolved_talent_id): a WITHIN-TENANT verified-
//         email match (the findFirst is tenant-filtered). Hit → reuse that
//         tenant's husk; miss → CREATE-NEW husk. resolution_method =
//         verified_email_match | new_identity. The husk no longer crosses
//         tenants (Core is now per-tenant, en route to retirement).
//       * CROSS-TENANT CLUSTER (resolved_cluster_id): a salted one-way
//         fingerprint of the verified email, computed tenant-side, resolves a
//         PII-free identity_index.PersonCluster (I14 — no raw email crosses the
//         tenant wall). One human across tenants shares ONE cluster.
//     DETERMINISTIC, exact, oldest-first within the tenant; no fuzzy
//     auto-merge. An UNverified email does NOT resolve (held as evidence,
//     not an identity key) and yields no fingerprint.
//   - core_talent_id = <UUID> (test/internal) → ASSOCIATE: validate the
//     supplied id; create overlay if absent; populate evidence; record.
//     resolution_method defaults to 'caller_supplied'.
//   - core_talent_id = null (test/internal) → force CREATE-NEW (skip
//     resolver). resolution_method defaults to 'new_identity'.
//
// Boundary re-frame (T2-3 vs T2-2a): the resolver is now IN Core
// canonicalization (the A5b-2 deferral vindicated; T2-1 ruled this is
// where it belongs). The ATS adapter STILL has no resolver — the ATS
// no-resolution tripwire (apps/api/src/tests/ats-batch4b-talent-link.
// integration.spec.ts) holds: libs/talent + libs/identity carry no
// findTalentByEmail / resolveIdentity / matchIdentity. The resolver
// lives INLINE in the canonicalize $transaction (no named public
// method): the lib-level forbidden-name tripwire (proof 5) stays
// literally green; the boundary is structural, not nominal.
//
// Atomicity (Directive §1 Ruling 1 — NON-NEGOTIABLE): all writes happen
// in ONE Prisma $transaction at READ COMMITTED with a SELECT … FOR UPDATE
// lock on the RawPayloadReference row. A partial canonicalization is a
// corrupt identity — saga is forbidden; a mid-tx failure rolls back
// EVERYTHING (Talent / overlay / evidence / outbox event /
// resolved_talent_id). Proof 4 (atomicity) is load-bearing.
//
// R-boundary: identity + contact-method evidence ONLY. No tier / score /
// rank / match (R10). The populated evidence models map 1:1 to spec
// (R12). TalentSkillEvidence + the other 5 non-contact evidence creates
// are DEFERRED (F-canonicalization-skills) — the generic payload carries
// no real skill_id / work-history / rate / work-auth / document /
// derived-snapshot signal; populating with synthetic values would
// VIOLATE R12.

// Resolution method — closed enum mirroring the ingestion-schema
// ResolutionMethod (DB) enum. Fix-Slice-2: canonicalize computes it from the
// L2 verified-email SubjectAnchor resolution — verified_email_match (hit) |
// new_identity (miss). `caller_supplied` is a retired husk-era value the DB
// enum still carries (no data migration this slice); canonicalize never
// produces it.
export type ResolutionMethodValue =
  | 'new_identity'
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
  // Fix-Slice-2 — the within-tenant L2 ResolutionSubject id this arrival
  // resolved to (was the Core husk talent_id). The husk is retired; canonicalize
  // resolves the arrival's subject via the verified-email SubjectAnchor.
  subject_id: string;
  tenant_id: string;
  resolution_method: ResolutionMethodValue;
  // true when the payload was already canonicalized (the idempotency
  // short-circuit fired). When true: no new subject / evidence / outbox-event
  // was written; the caller sees the prior result. outbox_event_id is null.
  already_canonicalized: boolean;
  // OutboxEvent id IF a new event was written (i.e.
  // already_canonicalized === false). Drained by T2-2b.
  outbox_event_id: string | null;
  // Number of L2 contact EvidenceRecords written this run (email + profile_url;
  // 0 when the payload carried neither, or already_canonicalized === true).
  contact_evidence_written: number;
}

// Locked-row shape returned by the SELECT … FOR UPDATE. Mirrors the
// columns the canonicalize flow reads.
interface LockedPayloadRow {
  id: string;
  tenant_id: string;
  verified_email: string | null;
  profile_url: string | null;
  // Fix-Slice-2 — the L2 subject idempotency anchor (was resolved_talent_id).
  resolved_subject_id: string | null;
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
    // Step 4b — the PII-free cross-tenant resolution index. Cluster
    // resolution happens via its OWN client (identity_index schema is not in
    // canonicalization's multi-schema follower client); an orphan cluster on
    // a canonicalize rollback is harmless and reused on retry (idempotent via
    // the fingerprint @@unique).
    private readonly identityIndex: IdentityIndexRepository,
    // Fix-Slice-2 — the within-tenant L2 resolution seam (TR-2a). Canonicalize
    // (scope:ats) → talent-trust (scope:cip) is ats→cip, lint-green (mirrors the
    // identityIndex edge). Runs on talent-trust's OWN client (a separate
    // connection, like identityIndex) — its writes are orphan-safe on a
    // canonicalize rollback and re-resolve idempotently on retry.
    private readonly talentTrust: TalentTrustService,
  ) {}

  // T2-3 — polling-outbox read. Returns up to `limit` unresolved payloads
  // (resolved_talent_id IS NULL), oldest first (created_at asc). The
  // CanonicalizationTriggerProcessor calls this on each tick and invokes
  // canonicalize() per row.
  //
  // No transaction / no lock — the canonicalize $transaction itself
  // SELECTs FOR UPDATE the RawPayloadReference row, so two ticks racing
  // on the same payload serialize on that lock; the second sees
  // resolved_talent_id non-null (from the first) and the idempotency
  // short-circuit fires (a no-op). The query result may be stale by the
  // time canonicalize runs — that's fine, the lock + short-circuit are
  // the load-bearing correctness invariants.
  async findUnresolvedPayloadBatch(args: {
    limit: number;
  }): Promise<UnresolvedPayloadRow[]> {
    const rows = await this.prisma.rawPayloadReference.findMany({
      where: { resolved_subject_id: null },
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

    // Atomic interactive transaction at READ COMMITTED (Directive §1
    // Ruling 4). The first statement is SELECT … FOR UPDATE on the
    // RawPayloadReference row — the concurrent-canonicalize race
    // protection without SERIALIZABLE's cost.
    const result = await this.prisma.$transaction(
      async (tx) => {
        // Step 1 — read + lock the payload row. $queryRaw runs on the
        // same connection as the surrounding interactive tx, so the
        // FOR UPDATE row-lock is held for the rest of the transaction.
        const lockedRows = await tx.$queryRaw<LockedPayloadRow[]>`
          SELECT
            id,
            tenant_id,
            verified_email,
            profile_url,
            resolved_subject_id,
            resolution_method
          FROM "ingestion"."RawPayloadReference"
          WHERE id = ${input.payload_id}::uuid
          FOR UPDATE
        `;

        const payload = lockedRows[0];

        // Cross-tenant absorbed into NOT_FOUND — no enumeration. A
        // caller from a different tenant cannot distinguish
        // 'payload exists in another tenant' from 'no such payload'.
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

        // Step 2 — idempotency. If resolved_subject_id is already set, the
        // payload has been canonicalized in a prior run; no-op return.
        // The locked row + this check is the idempotency-anchor: the
        // resolved_subject_id write is the LAST mutation inside the tx, so this
        // read sees either NULL (first canonicalize) or the committed non-NULL
        // value (a prior canonicalize succeeded).
        if (payload.resolved_subject_id !== null) {
          this.logger.log({
            event: 'canonicalize_idempotent_noop',
            tenant_id: payload.tenant_id,
            payload_id: payload.id,
            subject_id: payload.resolved_subject_id,
            prior_resolution_method: payload.resolution_method,
          });
          // The prior canonicalize wrote resolution_method alongside
          // resolved_subject_id (the last-write tuple at Step 5). A non-null
          // resolved_subject_id ⇒ a non-null resolution_method.
          const priorMethod = payload.resolution_method ?? 'new_identity';
          return {
            subject_id: payload.resolved_subject_id,
            tenant_id: payload.tenant_id,
            resolution_method: priorMethod,
            already_canonicalized: true,
            outbox_event_id: null,
            contact_evidence_written: 0,
          } satisfies CanonicalizeResult;
        }

        // Step 3a (4b) — CROSS-TENANT IDENTITY → PERSON_CLUSTER (PII-free).
        // UNTOUCHED by Fix-Slice-2 (§5 leave-untouched, R1). The same-human key
        // across tenants is a salted one-way fingerprint of the verified email,
        // computed TENANT-SIDE; only the opaque fingerprint crosses into
        // identity_index (I14 — no raw email leaves the tenant wall).
        // resolve-or-create is race-safe via the fingerprint @@unique. No
        // verified email ⇒ no cross-tenant key ⇒ resolvedClusterId stays NULL.
        // Runs on identityIndex's OWN client (cross-connection, orphan-safe).
        let resolvedClusterId: string | null = null;
        if (payload.verified_email !== null) {
          const pepper = loadIdentityPepper();
          const fingerprint = computeEmailFingerprint(
            payload.verified_email,
            pepper,
          );
          const cluster =
            await this.identityIndex.findOrCreateClusterByFingerprint(
              fingerprint,
              'email',
            );
          resolvedClusterId = cluster.id;
        }

        // Step 3 (Fix-Slice-2 §4.2/§4.3) — WITHIN-TENANT IDENTITY → L2
        // ResolutionSubject. The husk mint (`tx.talent.create`) + overlay +
        // husk-keyed TalentContactMethod writes are RETIRED. The arrival's
        // subject is resolved through the built TR-2a-1 verified-email
        // SubjectAnchor (hit → verified_email_match; miss → new subject +
        // record anchor → new_identity), and its per-arrival contact evidence
        // attaches on L2 — re-homing the husk's function, same semantic, new
        // substrate. Runs on talent-trust's OWN client (cross-connection,
        // orphan-safe on rollback; the subject re-resolves idempotently on
        // retry via the email anchor / SOURCED_TALENT @@unique).
        const arrival = await this.talentTrust.recordSourcedArrival({
          tenant_id: payload.tenant_id,
          payload_id: payload.id,
          verified_email: payload.verified_email,
          profile_url: payload.profile_url,
          source_channel: input.source_channel,
          created_by: 'canonicalization',
        });
        const subjectId = arrival.subject_id;
        const resolvedMethod: ResolutionMethodValue = arrival.resolution_method;

        // Step 5 — record the decision on the RawPayloadReference row. The LAST
        // write before the outbox emission; the idempotency anchor (the next
        // canonicalize on this payload short-circuits at Step 2 on a non-null
        // resolved_subject_id). resolved_talent_id is intentionally left NULL
        // (the husk is retired; the column drops in the final slice).
        await tx.rawPayloadReference.update({
          where: { id: payload.id },
          data: {
            resolved_subject_id: subjectId,
            resolved_cluster_id: resolvedClusterId,
            resolution_method: resolvedMethod,
          },
        });

        // Step 6 — write the outbox event IN THE SAME TRANSACTION (T2-2a
        // writes, T2-2b drains). The event commits atomically with the state
        // change; rollback leaves no orphan event row (atomicity proof 4). The
        // payload now carries the L2 subject id (was the husk talent_id).
        const outboxEventId = uuidv7();
        await tx.outboxEvent.create({
          data: {
            id: outboxEventId,
            tenant_id: payload.tenant_id,
            event_type: 'talent.canonicalized',
            event_payload: {
              subject_id: subjectId,
              tenant_id: payload.tenant_id,
              resolution_method: resolvedMethod,
              payload_id: payload.id,
            } as never,
          },
        });

        return {
          subject_id: subjectId,
          tenant_id: payload.tenant_id,
          resolution_method: resolvedMethod,
          already_canonicalized: false,
          outbox_event_id: outboxEventId,
          contact_evidence_written: arrival.contact_evidence_written,
        } satisfies CanonicalizeResult;
      },
      {
        // Directive §1 Ruling 4 — READ COMMITTED + SELECT FOR UPDATE on
        // the payload row. Sufficient to prevent the concurrent-
        // canonicalize race (two callers racing for the same payload
        // serialize on the row lock); cheaper than SERIALIZABLE for the
        // surrounding writes which do not need range-lock semantics.
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    );

    this.logger.log({
      event: 'canonicalize_completed',
      tenant_id: result.tenant_id,
      payload_id: input.payload_id,
      subject_id: result.subject_id,
      resolution_method: result.resolution_method,
      already_canonicalized: result.already_canonicalized,
      outbox_event_id: result.outbox_event_id,
      contact_evidence_written: result.contact_evidence_written,
      latency_ms: Date.now() - startedAt,
    });

    return result;
  }
}
