import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError, type AramoLogger } from '@aramo/common';

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
//   - core_talent_id OMITTED (production path) → run the inline T2-1
//     verified-email resolver:
//       * payload.verified_email is non-null AND a verified email-type
//         TalentContactMethod exists with the same value → resolve to
//         that Talent (cross-tenant: Core Talent is tenant-agnostic;
//         the overlay is tenant-scoped per the T2-1 model);
//         resolution_method = verified_email_match.
//       * Else → CREATE-NEW Talent; resolution_method = new_identity.
//     T2-1 Decision 3 — DETERMINISTIC, exact, oldest-first; no fuzzy
//     auto-merge. An UNverified email does NOT resolve (held as evidence,
//     not an identity key).
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
// ResolutionMethod (DB) enum. T2-3: the service COMPUTES this on the
// production path (verified_email_match | new_identity); callers MAY
// supply it on the ASSOCIATE test path (defaults to 'caller_supplied').
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
  // T2-3: optional. When undefined → the inline resolver runs (the
  // production path). Test/internal affordances retained:
  //   - null → force CREATE-NEW (skip resolver)
  //   - <UUID> → force ASSOCIATE with this id (skip resolver)
  core_talent_id?: string | null;
  // Closed vocabulary on TalentTenantOverlay (Talent Record Spec §2.2,
  // 4 values): self_signup | recruiter_capture | referral | import.
  source_channel: string;
  // T2-3: optional. When undefined the service computes it (the
  // production path: verified_email_match | new_identity). When supplied
  // alongside a UUID core_talent_id, used as the recorded method.
  resolution_method?: ResolutionMethodValue;
  authContext: CanonicalizeAuthContext;
  requestId: string;
}

export interface CanonicalizeResult {
  talent_id: string;
  tenant_id: string;
  resolution_method: ResolutionMethodValue;
  // true when the payload was already canonicalized (the idempotency
  // short-circuit fired). When true: no new Talent / overlay /
  // evidence / outbox-event was written; the caller sees the prior
  // result. outbox_event_id is null in this case.
  already_canonicalized: boolean;
  // OutboxEvent id IF a new event was written (i.e.
  // already_canonicalized === false). Drained by T2-2b.
  outbox_event_id: string | null;
  // Number of TalentContactMethod rows written in this run (0 when
  // payload carried no verified_email + no profile_url, or when
  // already_canonicalized === true).
  contact_methods_created: number;
}

// Locked-row shape returned by the SELECT … FOR UPDATE. Mirrors the
// columns the canonicalize flow reads.
interface LockedPayloadRow {
  id: string;
  tenant_id: string;
  verified_email: string | null;
  profile_url: string | null;
  resolved_talent_id: string | null;
  resolution_method: ResolutionMethodValue | null;
}

// URL-host heuristic for TalentContactType classification of profile_url
// (Directive §2.4). Conservative: only linkedin / github get specific
// categorization; everything else is 'other'. R12-faithful — we do not
// fabricate 'portfolio' for arbitrary domains since the §2.2 contact-type
// closed enum (TalentContactType) ascribes specific semantics to
// 'portfolio' that we cannot reliably derive from URL host alone.
type ContactTypeForUrl = 'linkedin' | 'github' | 'other';
function classifyProfileUrl(url: string): ContactTypeForUrl {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return 'linkedin';
    if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
    return 'other';
  } catch {
    return 'other';
  }
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
      where: { resolved_talent_id: null },
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
      core_talent_id: input.core_talent_id,
      resolution_method: input.resolution_method,
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
            resolved_talent_id,
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

        // Step 2 — idempotency. If resolved_talent_id is already set, the
        // payload has been canonicalized in a prior run; no-op return.
        // The locked row + this check is the idempotency-anchor (T2-1
        // Decision 4): the resolved_talent_id write is the LAST mutation
        // inside the tx, so this read sees either NULL (first canonicalize)
        // or the committed non-NULL value (a prior canonicalize succeeded).
        if (payload.resolved_talent_id !== null) {
          this.logger.log({
            event: 'canonicalize_idempotent_noop',
            tenant_id: payload.tenant_id,
            payload_id: payload.id,
            talent_id: payload.resolved_talent_id,
            prior_resolution_method: payload.resolution_method,
          });
          // The prior canonicalize wrote resolution_method alongside
          // resolved_talent_id (the last-write tuple at Step 5). A non-
          // null resolved_talent_id ⇒ a non-null resolution_method.
          const priorMethod =
            payload.resolution_method ??
            input.resolution_method ??
            'caller_supplied';
          return {
            talent_id: payload.resolved_talent_id,
            tenant_id: payload.tenant_id,
            resolution_method: priorMethod,
            already_canonicalized: true,
            outbox_event_id: null,
            contact_methods_created: 0,
          } satisfies CanonicalizeResult;
        }

        // Step 3 — Talent decision (T2-3: RESOLVE | ASSOCIATE | CREATE-NEW).
        // The resolveOrCreate seam is INLINE here; lib-surface forbidden-
        // names tripwire (proof 5) stays literally green.
        let talentId: string;
        let resolvedMethod: ResolutionMethodValue;
        let needsCreate = false;

        if (input.core_talent_id === undefined) {
          // T2-3 PRODUCTION PATH: the inline T2-1 verified-email resolver.
          // payload.verified_email is already lowercased + trimmed at
          // ingestion (libs/ingestion ingestion.service.ts:74-77); we match
          // on the stored value directly.
          //
          // Cross-tenant: Core Talent is tenant-agnostic; the resolver
          // does NOT filter by tenant_id. One Jane, tenant-scoped overlay
          // (the T2-1 model). Deterministic — exact, oldest match wins.
          //
          // Unverified-doesn't-resolve: only verification_status='verified'
          // contact methods are identity keys; the rest are evidence.
          if (payload.verified_email !== null) {
            const existing = await tx.talentContactMethod.findFirst({
              where: {
                type: 'email',
                value: payload.verified_email,
                verification_status: 'verified',
              },
              orderBy: { created_at: 'asc' },
            });
            if (existing !== null) {
              talentId = existing.talent_id;
              resolvedMethod = 'verified_email_match';
            } else {
              needsCreate = true;
              resolvedMethod = 'new_identity';
              talentId = ''; // assigned in the create branch below
            }
          } else {
            // No verified email → no identity key → CREATE-NEW.
            needsCreate = true;
            resolvedMethod = 'new_identity';
            talentId = ''; // assigned in the create branch below
          }
        } else if (input.core_talent_id !== null) {
          // ASSOCIATE (test/internal): validate the supplied id exists in
          // `talent.Talent`. The follower model is bit-identical to the
          // source-of-truth (the drift-tripwire enforces); tenant-agnostic
          // because Core Talents are tenant-agnostic.
          const existing = await tx.talent.findUnique({
            where: { id: input.core_talent_id },
          });
          if (existing === null) {
            throw new AramoError(
              'NOT_FOUND',
              'Talent not found',
              404,
              {
                requestId: input.requestId,
                details: {
                  reason: 'core_talent_not_found',
                  core_talent_id: input.core_talent_id,
                },
              },
            );
          }
          talentId = existing.id;
          resolvedMethod = input.resolution_method ?? 'caller_supplied';
        } else {
          // CREATE-NEW forced (test/internal — explicit null).
          needsCreate = true;
          resolvedMethod = input.resolution_method ?? 'new_identity';
          talentId = ''; // assigned in the create branch below
        }

        if (needsCreate) {
          // The ONE authorized createTalent call site at T2-2a / T2-3.
          // Proof 6 (authorized-creation tripwire) asserts ATS ops still
          // create ZERO Talents and this is the ONLY new caller outside
          // libs/talent itself. The resolver miss + the forced CREATE-NEW
          // path FOLD HERE (single `.talent.create(` invocation in the
          // lib source — the proof 6 count assertion stays at exactly 1).
          talentId = uuidv7();
          await tx.talent.create({
            data: {
              id: talentId,
              lifecycle_status: 'active',
            },
          });
        }

        // Step 3b — overlay for (talent_id, tenant_id). Create if absent.
        // findUnique on the @@unique([talent_id, tenant_id]) compound key.
        const existingOverlay = await tx.talentTenantOverlay.findUnique({
          where: {
            talent_id_tenant_id: {
              talent_id: talentId,
              tenant_id: payload.tenant_id,
            },
          },
        });
        if (existingOverlay === null) {
          await tx.talentTenantOverlay.create({
            data: {
              id: uuidv7(),
              talent_id: talentId,
              tenant_id: payload.tenant_id,
              source_channel: input.source_channel,
              // Closed vocabulary (Talent Record Spec §2.2). New overlay
              // lands in 'active' — the canonicalize event is the
              // tenant's first relationship to the Talent identity.
              tenant_status: 'active',
            },
          });
        }

        // Step 4 — populate contact-method evidence (R12-faithful, what
        // the payload carries). Skill / work-history / rate / work-auth /
        // document / derived-snapshot are DEFERRED per F-canonicalization-
        // skills (the generic payload carries no real signal for them;
        // fabricating would violate R12 "1:1 to spec").
        const nowTs = new Date();
        let contactMethodsCreated = 0;
        if (payload.verified_email !== null) {
          await tx.talentContactMethod.create({
            data: {
              id: uuidv7(),
              talent_id: talentId,
              tenant_id: payload.tenant_id,
              type: 'email',
              value: payload.verified_email,
              is_primary: false,
              verification_status: 'verified',
              verified_at: nowTs,
              created_at: nowTs,
            },
          });
          contactMethodsCreated += 1;
        }
        if (payload.profile_url !== null) {
          const type = classifyProfileUrl(payload.profile_url);
          await tx.talentContactMethod.create({
            data: {
              id: uuidv7(),
              talent_id: talentId,
              tenant_id: payload.tenant_id,
              type,
              value: payload.profile_url,
              is_primary: false,
              verification_status: 'unverified',
              created_at: nowTs,
            },
          });
          contactMethodsCreated += 1;
        }

        // Step 5 — record the decision (T2-1 Decision 4) on the
        // RawPayloadReference row. The LAST write before the outbox
        // emission; the idempotency anchor (the next canonicalize call
        // on this payload short-circuits at step 2). resolvedMethod was
        // computed by the T2-3 Step-3 branch (verified_email_match |
        // new_identity | caller_supplied).
        await tx.rawPayloadReference.update({
          where: { id: payload.id },
          data: {
            resolved_talent_id: talentId,
            resolution_method: resolvedMethod,
          },
        });

        // Step 6 — write the outbox event IN THE SAME TRANSACTION (the
        // split seam per Directive §0: T2-2a writes, T2-2b drains).
        // The outbox invariant — the event commits atomically with the
        // state change; rollback leaves no orphan event row (atomicity
        // proof 4). Event payload carries identity + method + the source
        // payload id; downstream consumers (T2-2b drain → SNS at M7)
        // reconstruct the canonicalization decision from this envelope.
        const outboxEventId = uuidv7();
        await tx.outboxEvent.create({
          data: {
            id: outboxEventId,
            tenant_id: payload.tenant_id,
            event_type: 'talent.canonicalized',
            event_payload: {
              talent_id: talentId,
              tenant_id: payload.tenant_id,
              resolution_method: resolvedMethod,
              payload_id: payload.id,
            } as never,
          },
        });

        return {
          talent_id: talentId,
          tenant_id: payload.tenant_id,
          resolution_method: resolvedMethod,
          already_canonicalized: false,
          outbox_event_id: outboxEventId,
          contact_methods_created: contactMethodsCreated,
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
      talent_id: result.talent_id,
      resolution_method: result.resolution_method,
      already_canonicalized: result.already_canonicalized,
      outbox_event_id: result.outbox_event_id,
      contact_methods_created: result.contact_methods_created,
      latency_ms: Date.now() - startedAt,
    });

    return result;
  }
}
