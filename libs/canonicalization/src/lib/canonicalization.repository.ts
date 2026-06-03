import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError, type AramoLogger } from '@aramo/common';

import { Prisma } from '../../prisma/generated/client/client.js';

import { PrismaService } from './prisma/prisma.service.js';

// T2-2a — canonicalization orchestrator (the atomic create-or-associate
// canonicalize service). Lead-authored per
// Aramo-T2-2a-Canonicalization-Orchestration-Directive-v1_0-LOCKED.md.
//
// Surface (closed, single method):
//   canonicalize({ payload_id, core_talent_id, source_channel,
//                  resolution_method, authContext })
//     → CanonicalizeResult
//
// Semantics (caller-supplied id; ASSOCIATE-NOT-RESOLVE pattern, A5b-2
// applied to Core):
//   - core_talent_id provided → validate it exists; create overlay if
//     absent for (talent_id, tenant_id); populate evidence; record.
//   - core_talent_id null     → create a NEW Talent (the ONE authorized
//     createTalent call site at T2-2a; the authorized-creation
//     tripwire — proof 6 — asserts ATS ops still create ZERO Talents
//     and canonicalization is the only new caller); create overlay;
//     populate evidence; record.
//
//   NO inspection of verified_email to DECIDE the Talent. T2-2a records
//   WHAT the caller told it (resolution_method); it does NOT compute the
//   decision. The no-resolution tripwire (proof 5) is structural: a
//   source-scan of libs/canonicalization/src/lib/ for
//   findByVerifiedEmail/resolveIdentity/resolveTalent returns ZERO hits.
//   T2-3 wires the verified-email resolver.
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
// ResolutionMethod (DB) enum. Caller chooses one of the three values per
// the T2-2a ASSOCIATE-NOT-RESOLVE contract. T2-3 may extend the closed
// list (e.g. sha256_payload_dup).
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
  // null → CREATE-NEW (the ONE authorized createTalent path); non-null →
  // ASSOCIATE-with-existing (validated via tx.talent.findUnique).
  core_talent_id: string | null;
  // Closed vocabulary on TalentTenantOverlay (Talent Record Spec §2.2,
  // 4 values): self_signup | recruiter_capture | referral | import.
  source_channel: string;
  resolution_method: ResolutionMethodValue;
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

@Injectable()
export class CanonicalizationRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('CanonicalizationRepositoryLogger')
    private readonly logger: AramoLogger,
  ) {}

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
          return {
            talent_id: payload.resolved_talent_id,
            tenant_id: payload.tenant_id,
            resolution_method:
              payload.resolution_method ?? input.resolution_method,
            already_canonicalized: true,
            outbox_event_id: null,
            contact_methods_created: 0,
          } satisfies CanonicalizeResult;
        }

        // Step 3 — Talent decision (ASSOCIATE-NOT-RESOLVE).
        let talentId: string;
        if (input.core_talent_id !== null) {
          // ASSOCIATE: validate the supplied id exists in `talent.Talent`.
          // The follower model `Talent` is bit-identical to the source-of-
          // truth (the drift-tripwire CI test enforces); the lookup is
          // tenant-agnostic because Core Talents are tenant-agnostic.
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
        } else {
          // CREATE-NEW: the ONE authorized createTalent call site at T2-2a.
          // The authorized-creation tripwire (proof 6) asserts ATS ops
          // still create ZERO Talents and that this is the ONLY new caller
          // outside libs/talent itself.
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
        // on this payload short-circuits at step 2).
        await tx.rawPayloadReference.update({
          where: { id: payload.id },
          data: {
            resolved_talent_id: talentId,
            resolution_method: input.resolution_method,
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
              resolution_method: input.resolution_method,
              payload_id: payload.id,
            } as never,
          },
        });

        return {
          talent_id: talentId,
          tenant_id: payload.tenant_id,
          resolution_method: input.resolution_method,
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
