import { Injectable } from '@nestjs/common';
import {
  AramoError,
  type ConsentScopeStatus,
  type ContactChannel,
} from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import {
  OPERATION_SCOPE_MAP,
  type ConsentCheckOperation,
} from './dto/consent-check-operation.js';
import type { ConsentDecisionDto } from './dto/consent-decision.dto.js';
import {
  CONSENT_SCOPES,
  type ConsentCapturedMethodValue,
  type ConsentScopeValue,
} from './dto/consent-grant-request.dto.js';
import type { ConsentGrantResponseDto } from './dto/consent-grant-response.dto.js';
import type { ConsentRevokeResponseDto } from './dto/consent-revoke-response.dto.js';
import type { ConsentHistoryEventDto } from './dto/consent-history-event.dto.js';
import type { ConsentHistoryResponseDto } from './dto/consent-history-response.dto.js';
import type { TalentConsentScopeStateDto } from './dto/talent-consent-scope-state.dto.js';
import type { TalentConsentStateResponseDto } from './dto/talent-consent-state-response.dto.js';
import { PrismaService } from './prisma/prisma.service.js';
import {
  encodeCursor,
  type HistoryCursorPayload,
} from './util/history-cursor.js';

export type ConsentActionValue = 'granted' | 'revoked';

export interface RecordConsentEventInput {
  tenant_id: string;
  talent_id: string;
  action: ConsentActionValue;
  scope: ConsentScopeValue;
  captured_method: ConsentCapturedMethodValue;
  captured_by_actor_id: string | null;
  consent_version: string;
  // grant-only field; revoke ignores
  consent_text_snapshot?: string;
  consent_document_id?: string;
  occurred_at: string;
  // grant-only field; revoke ignores
  expires_at?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey: string;
  requestHash: string;
  requestId: string;
}

// Conditional return type: the public API discriminates the response
// shape from the input action, so service callers don't need to cast.
// A future DTO field change that breaks the contract surfaces as a
// type error at the call site, not as a runtime drift.
export type ConsentEventResponseShape<T extends ConsentActionValue> =
  T extends 'granted'
    ? ConsentGrantResponseDto
    : T extends 'revoked'
      ? ConsentRevokeResponseDto
      : never;

export interface ResolveConsentStateInput {
  tenant_id: string;
  talent_id: string;
  operation: ConsentCheckOperation;
  channel?: ContactChannel;
  // Optional per Phase 1 §6 line 497. Same key + same body → cached
  // ConsentDecision returned without re-running the resolver. Same key
  // + different body → 409.
  idempotencyKey?: string;
  requestHash: string;
  requestId: string;
}

export interface ResolveAllScopesInput {
  tenant_id: string;
  talent_id: string;
  requestId: string;
}

// PR-6 §4 + §5: history read input. `scope` is optional single-valued
// filter (multi-valued explicitly out of scope per §12). `limit` is the
// resolved page size (controller already clamped/validated per §5).
// `cursor` is the decoded payload (controller already decoded + handled
// 400 mapping per §3).
export interface ResolveHistoryInput {
  tenant_id: string;
  talent_id: string;
  scope?: ConsentScopeValue;
  limit: number;
  cursor?: HistoryCursorPayload;
  requestId: string;
}

// Decision E (PR-4): scope dependency chain. Locked from Group 2 §2.7
// "Scope Dependencies (Explicit Hierarchy)" (lines 2352-2361):
//   contacting requires matching requires profile_storage
//   cross_tenant_visibility requires all lower scopes
//   resume_processing is independent
// The chain for a given scope is the ordered list of *prerequisite* scopes
// (the requested scope itself is checked separately by Decision D after
// dependency validation).
const SCOPE_DEPENDENCY_CHAIN: Record<ConsentScopeValue, readonly ConsentScopeValue[]> = {
  profile_storage: [],
  resume_processing: [],
  matching: ['profile_storage'],
  contacting: ['profile_storage', 'matching'],
  cross_tenant_visibility: ['profile_storage', 'matching', 'contacting'],
};

// Decision F (PR-4): 12-month staleness window for the contacting scope.
// Computed in calendar months from the latest grant's occurred_at.
const STALENESS_WINDOW_MONTHS = 12;

// Single-event lookup is the only cross-event query allowed in the
// write-path methods per ADR-0005 Decision E refinement: "no cross-event
// consent state derivation; single-event lookups for referential linkage
// are allowed". Used in recordConsentEvent to populate revoked_event_id.
//
// PR-4 introduces a SECOND category — the resolver path — that performs
// controlled cross-event reads for consent state derivation, bounded to
// the body of resolveConsentState() only. ADR-0006 (forthcoming
// retroactive PR-4.1) documents this two-category model. The R4 static
// guardrail (consent.refusal-r4.spec.ts) enforces the boundary
// mechanically.

// PR-2 precedent #6: transaction boundary lives in the repository.
// PR-2 precedent #4: no update method — the immutable ledger is enforced
// here (no method exposed) AND in the database (BEFORE UPDATE trigger).
@Injectable()
export class ConsentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async recordConsentEvent<T extends ConsentActionValue>(
    input: RecordConsentEventInput & { action: T },
  ): Promise<ConsentEventResponseShape<T>> {
    // Defense-in-depth: refuse any action value not in the locked set.
    // Belt-and-suspenders alongside the OpenAPI schema validation
    // (additionalProperties: false), the class-validator pipe
    // (forbidNonWhitelisted: true), and the service layer's hardcoded
    // literals. Matches the R8 / R9 idiom where Charter refusals are
    // enforced at multiple layers, not relying on type safety alone.
    if (input.action !== 'granted' && input.action !== 'revoked') {
      throw new AramoError(
        'INTERNAL_ERROR',
        `recordConsentEvent received an unsupported action: ${String(input.action)}`,
        500,
        {
          requestId: input.requestId,
          details: { received_action: String(input.action) },
        },
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Idempotency check (unchanged from PR-2)
      const existing = await tx.idempotencyKey.findUnique({
        where: {
          tenant_id_key: {
            tenant_id: input.tenant_id,
            key: input.idempotencyKey,
          },
        },
      });
      if (existing !== null) {
        if (existing.request_hash !== input.requestHash) {
          throw new AramoError(
            'IDEMPOTENCY_KEY_CONFLICT',
            'Same idempotency key used with a different request body',
            409,
            { requestId: input.requestId },
          );
        }
        // Internal cast: the persisted JSON body is the discriminated
        // shape we wrote on the original call; the runtime guarantee
        // is provided by the Decision A/D contract (revoke records
        // always carry revoked_event_id; grant records never do).
        return existing.response_body as unknown as ConsentEventResponseShape<T>;
      }

      // 2. For revoked, perform single-event lookup BEFORE the writes
      //    (Decision A). Lookup runs inside the same transaction; if it
      //    fails the whole tx aborts before any write (preserves R13).
      let revokedEventId: string | null = null;
      if (input.action === 'revoked') {
        const priorGrant = await tx.talentConsentEvent.findFirst({
          where: {
            tenant_id: input.tenant_id,
            talent_id: input.talent_id,
            scope: input.scope,
            action: 'granted',
          },
          orderBy: { occurred_at: 'desc' },
          select: { id: true },
        });
        revokedEventId = priorGrant?.id ?? null;
      }

      // 3. Insert TalentConsentEvent (action set server-side per PR-2 #16)
      const eventId = uuidv7();
      const occurredAt = new Date(input.occurred_at);
      const isGrant = input.action === 'granted';
      const expiresAt =
        isGrant && input.expires_at !== undefined
          ? new Date(input.expires_at)
          : null;
      const event = await tx.talentConsentEvent.create({
        data: {
          id: eventId,
          tenant_id: input.tenant_id,
          talent_id: input.talent_id,
          scope: input.scope,
          action: input.action,
          captured_by_actor_id: input.captured_by_actor_id,
          captured_method: input.captured_method,
          consent_version: input.consent_version,
          consent_text_snapshot:
            isGrant && input.consent_text_snapshot !== undefined
              ? input.consent_text_snapshot
              : null,
          consent_document_id: input.consent_document_id ?? null,
          occurred_at: occurredAt,
          expires_at: expiresAt,
          metadata: (input.metadata ?? null) as never,
        },
      });

      // 4. Insert ConsentAuditEvent. Action-specific event_payload:
      //    granted → { event_id, scope }
      //    revoked → §2.7 canonical audit structure (Decisions A/B/C)
      const auditPayload = isGrant
        ? { event_id: eventId, scope: input.scope }
        : {
            event_id: eventId,
            scope: input.scope,
            revoked_event_id: revokedEventId,         // Decision A
            in_flight_operations_halted: [],          // Decision B
            propagation_completed_at: null,           // Decision C
          };
      await tx.consentAuditEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          actor_id: input.captured_by_actor_id,
          actor_type:
            input.captured_method === 'self_signup' ? 'self' : 'recruiter',
          event_type: isGrant
            ? 'consent.grant.recorded'
            : 'consent.revoke.recorded',
          subject_id: input.talent_id,
          event_payload: auditPayload as never,
        },
      });

      // 5. Insert OutboxEvent (per Architecture v2.0 §7.6)
      const outboxPayload = isGrant
        ? {
            event_id: eventId,
            talent_id: input.talent_id,
            scope: input.scope,
          }
        : {
            event_id: eventId,
            talent_id: input.talent_id,
            scope: input.scope,
            revoked_event_id: revokedEventId,
          };
      await tx.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: isGrant ? 'consent.granted' : 'consent.revoked',
          event_payload: outboxPayload as never,
        },
      });

      // 6. Build response. The conditional return type discriminates
      //    by T at call sites; here in the implementation we build the
      //    union and cast once at the return statement.
      const response: ConsentGrantResponseDto | ConsentRevokeResponseDto =
        isGrant
          ? ({
              event_id: eventId,
              tenant_id: input.tenant_id,
              talent_id: input.talent_id,
              scope: input.scope,
              action: 'granted',
              captured_method: input.captured_method,
              ...(input.captured_by_actor_id !== null && {
                captured_by_actor_id: input.captured_by_actor_id,
              }),
              consent_version: input.consent_version,
              ...(input.consent_document_id !== undefined && {
                consent_document_id: input.consent_document_id,
              }),
              occurred_at: occurredAt.toISOString(),
              ...(expiresAt !== null && { expires_at: expiresAt.toISOString() }),
              recorded_at: event.created_at.toISOString(),
              ...(input.metadata !== undefined && { metadata: input.metadata }),
            } satisfies ConsentGrantResponseDto)
          : ({
              event_id: eventId,
              tenant_id: input.tenant_id,
              talent_id: input.talent_id,
              scope: input.scope,
              action: 'revoked',
              captured_method: input.captured_method,
              ...(input.captured_by_actor_id !== null && {
                captured_by_actor_id: input.captured_by_actor_id,
              }),
              consent_version: input.consent_version,
              ...(input.consent_document_id !== undefined && {
                consent_document_id: input.consent_document_id,
              }),
              occurred_at: occurredAt.toISOString(),
              recorded_at: event.created_at.toISOString(),
              revoked_event_id: revokedEventId,            // Decision A/D
              ...(input.metadata !== undefined && { metadata: input.metadata }),
            } satisfies ConsentRevokeResponseDto);

      // 7. Persist idempotency record so future replays return identical body
      await tx.idempotencyKey.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          key: input.idempotencyKey,
          request_hash: input.requestHash,
          response_status: 201,
          response_body: response as never,
        },
      });

      // Single internal cast to the conditional public type. The branch
      // above guarantees grant→ConsentGrantResponseDto and
      // revoked→ConsentRevokeResponseDto; the public type signature
      // re-discriminates for callers.
      return response as ConsentEventResponseShape<T>;
    });
  }

  /**
   * Resolver-path read. Per ADR-0005 Decision E, write paths are bound by
   * "no cross-event consent state derivation." ADR-0006 (forthcoming
   * retroactive PR-4.1) extends Decision E to permit controlled
   * cross-event derivation in resolver paths under strict constraints.
   * This method is the only ledger reader permitted to do cross-event
   * derivation for consent state.
   *
   * Operations permitted within this method body (per ADR-0006):
   *   - tx.talentConsentEvent.findMany  (cross-event read for partition + latest-per-source)
   *   - tx.consentAuditEvent.create     (decision-log write)
   *
   * Operations forbidden in this method body:
   *   - tx.talentConsentEvent.update / delete (immutability preserved)
   *   - Any read from non-ledger tables (R4)
   *
   * Algorithm (Decisions A through L, PR-4):
   *   1. Decision C: derive required scope from operation
   *   2. Decision G validation: channel required when scope is contacting
   *   3. Read all ledger events for (tenant_id, talent_id) — partition in memory
   *   4. Decision K: empty ledger → result: error, reason: consent_state_unknown
   *   5. Decision E: validate scope dependency chain — 422 if any dep denied
   *   6. Decision D: most-restrictive computation for the requested scope
   *   7. Decision F: staleness check (contacting only, 12 months)
   *   8. Decision G: channel constraint check (contacting only)
   *   9. Decision H: persist ConsentAuditEvent decision-log row
   *   10. Return ConsentDecisionDto
   *
   * The resolver computation + audit write happen in a single transaction
   * (R13). Failure of either rolls back atomically.
   */
  async resolveConsentState(
    input: ResolveConsentStateInput,
  ): Promise<ConsentDecisionDto> {
    const requiredScope = OPERATION_SCOPE_MAP[input.operation] as ConsentScopeValue;

    // Decision G validation (pre-transaction): channel required when scope
    // is contacting. Returns 400 VALIDATION_ERROR; not logged to audit
    // because the request itself is malformed, not a consent decision.
    if (requiredScope === 'contacting' && input.channel === undefined) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'channel field is required when operation maps to contacting scope',
        400,
        {
          requestId: input.requestId,
          details: {
            missing_field: 'channel',
            operation: input.operation,
            derived_scope: requiredScope,
          },
        },
      );
    }

    // The transaction returns either:
    //   - { decision }              for the 200 path (allowed/denied/error)
    //   - { decision, deferredThrow } for the 422 path; the AramoError is
    //                                 thrown AFTER the tx commits so the
    //                                 decision-log audit row persists per
    //                                 Decision H.
    type ResolverTxResult =
      | { decision: ConsentDecisionDto; deferredThrow?: undefined }
      | { decision: ConsentDecisionDto; deferredThrow: AramoError };

    const txResult = await this.prisma.$transaction(async (tx): Promise<ResolverTxResult> => {
      // Idempotency check (optional per Phase 1 §6). Inside the same
      // transaction so a concurrent same-key call serializes via the
      // idempotencyKey unique constraint. Cache hit short-circuits before
      // any resolver computation or audit write — preserves the directive's
      // "do not re-run resolver, do not emit new decision-log entry"
      // requirement.
      if (input.idempotencyKey !== undefined) {
        const existing = await tx.idempotencyKey.findUnique({
          where: {
            tenant_id_key: {
              tenant_id: input.tenant_id,
              key: input.idempotencyKey,
            },
          },
        });
        if (existing !== null) {
          if (existing.request_hash !== input.requestHash) {
            throw new AramoError(
              'IDEMPOTENCY_KEY_CONFLICT',
              'Same idempotency key used with a different request body',
              409,
              { requestId: input.requestId },
            );
          }
          return { decision: existing.response_body as unknown as ConsentDecisionDto };
        }
      }

      const decisionId = uuidv7();
      const computedAt = new Date();

      // Cross-event ledger read. Permitted here (resolver path) per
      // ADR-0006. Partitioning + latest-per-source happens in memory.
      const events = await tx.talentConsentEvent.findMany({
        where: {
          tenant_id: input.tenant_id,
          talent_id: input.talent_id,
        },
        orderBy: { occurred_at: 'desc' },
      });

      // Decision K: empty ledger → result: error
      if (events.length === 0) {
        const decision = await this.completeDecision(tx, input, {
          result: 'error',
          scope: requiredScope,
          reason_code: 'consent_state_unknown',
          log_message: `consent_state_missing for talent ${input.talent_id}`,
          decision_id: decisionId,
          computed_at: computedAt.toISOString(),
        });
        return { decision };
      }

      // Decision E: validate scope dependency chain
      const dependencyChain = SCOPE_DEPENDENCY_CHAIN[requiredScope];
      const failedDependencies: ConsentScopeValue[] = [];
      for (const depScope of dependencyChain) {
        if (computeMostRestrictiveStateForScope(events, depScope) !== 'allowed') {
          failedDependencies.push(depScope);
        }
      }
      if (failedDependencies.length > 0) {
        const decision: ConsentDecisionDto = {
          result: 'denied',
          scope: requiredScope,
          denied_scopes: failedDependencies,
          reason_code: 'scope_dependency_unmet',
          display_message: `Required consent scope(s) not granted: ${failedDependencies.join(', ')}`,
          log_message: `scope_dependency_unmet: ${failedDependencies.join(', ')}`,
          decision_id: decisionId,
          computed_at: computedAt.toISOString(),
        };
        // Persist decision-log row inside the tx so Decision H ("every
        // check generates a decision-log entry") holds even for the 422
        // path. Idempotency is NOT cached for 422 because a state change
        // (e.g., a new grant for a missing dependency) should re-evaluate
        // on retry.
        await persistDecisionAudit(tx, input, decision);
        // The 422 throw is DEFERRED until after the tx commits. Throwing
        // inside the tx would roll back the audit write. The 422 envelope
        // embeds the ConsentDecision in error.details.consent_decision
        // per Phase 1 §1 canonical pattern.
        return {
          decision,
          deferredThrow: new AramoError(
            'INVALID_SCOPE_COMBINATION',
            'Required consent scope dependency unmet',
            422,
            {
              requestId: input.requestId,
              details: { consent_decision: decision },
            },
          ),
        };
      }

      // Decision D: most-restrictive computation for the requested scope
      const requestedScopeState = computeMostRestrictiveStateForScope(
        events,
        requiredScope,
      );
      if (requestedScopeState !== 'allowed') {
        const decision = await this.completeDecision(tx, input, {
          result: 'denied',
          scope: requiredScope,
          denied_scopes: [requiredScope],
          reason_code:
            requestedScopeState === 'no_grant'
              ? 'consent_not_granted'
              : 'consent_revoked',
          log_message: `${requiredScope}_denied: ${requestedScopeState}`,
          decision_id: decisionId,
          computed_at: computedAt.toISOString(),
        });
        return { decision };
      }

      // Decision F: staleness — contacting only, 12 months
      if (requiredScope === 'contacting') {
        const latestGrant = findLatestGrantForScope(events, 'contacting');
        if (latestGrant !== null && isStale(latestGrant.occurred_at, computedAt)) {
          const decision = await this.completeDecision(tx, input, {
            result: 'denied',
            scope: 'contacting',
            denied_scopes: ['contacting'],
            reason_code: 'stale_consent',
            display_message: 'Consent has expired. Refresh required.',
            log_message: 'contacting_denied: stale_consent',
            decision_id: decisionId,
            computed_at: computedAt.toISOString(),
          });
          return { decision };
        }
      }

      // Decision G: channel constraint check (contacting only). The
      // input.channel presence was already validated above.
      if (requiredScope === 'contacting') {
        const channel = input.channel as ContactChannel;
        const permittedChannels = computePermittedChannelsIntersection(
          events,
          'contacting',
        );
        if (permittedChannels !== null && !permittedChannels.includes(channel)) {
          const decision = await this.completeDecision(tx, input, {
            result: 'denied',
            scope: 'contacting',
            denied_scopes: ['contacting'],
            reason_code: 'channel_not_consented',
            display_message: `Channel '${channel}' is not permitted by current consent.`,
            log_message: `contacting_denied: channel_not_consented (${channel})`,
            decision_id: decisionId,
            computed_at: computedAt.toISOString(),
          });
          return { decision };
        }
      }

      // All checks passed — allowed
      const decision = await this.completeDecision(tx, input, {
        result: 'allowed',
        scope: requiredScope,
        log_message: `${requiredScope}_allowed`,
        decision_id: decisionId,
        computed_at: computedAt.toISOString(),
      });
      return { decision };
    });

    if (txResult.deferredThrow !== undefined) {
      throw txResult.deferredThrow;
    }
    return txResult.decision;
  }

  // Wraps the persist-and-return pattern used in every non-throwing
  // resolver branch. Keeps the resolver body readable without leaking
  // the audit-write detail at every return statement.
  //
  // Persists the decision-log audit row (Decision H) and, when an
  // Idempotency-Key was provided, the cached response. Failure of either
  // write rolls back the whole transaction.
  private async completeDecision(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    input: ResolveConsentStateInput,
    decision: ConsentDecisionDto,
  ): Promise<ConsentDecisionDto> {
    await persistDecisionAudit(tx, input, decision);
    if (input.idempotencyKey !== undefined) {
      await tx.idempotencyKey.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          key: input.idempotencyKey,
          request_hash: input.requestHash,
          response_status: 200,
          response_body: decision as never,
        },
      });
    }
    return decision;
  }

  /**
   * Batch resolver-path read for the state endpoint (PR-5). Per ADR-0006
   * Decision G (this PR), this is the canonical batch resolver: one
   * transactional findMany + in-memory derivation across all 5 scopes,
   * vs. five sequential resolveConsentState calls (which would do 5x
   * redundant reads, each in its own transaction).
   *
   * Per ADR-0006 Implementation Precedent O, this method sits in the
   * resolver region. The findMany call is in the existing
   * resolver-region allow-list (no R4 guardrail update).
   *
   * Per ADR-0006 Decision D, the source-aware most-restrictive
   * intersection algorithm is reused unchanged: partition by
   * captured_method, latest per partition by occurred_at, most
   * restrictive across partitions.
   *
   * Per Decision D (this PR-5), the response always returns all 5
   * ConsentScope values; scopes without events return status: "no_grant"
   * with all timestamps null. Deterministic contract — callers do not
   * have to infer which scopes are "missing."
   *
   * Per Decision E (this PR-5), no staleness logic in response.
   * Staleness is the check endpoint's concern, not the state endpoint's.
   *
   * Per Decision F (this PR-5), is_anonymized is always false in PR-5;
   * the talent module that provides identity-existence detection does
   * not exist yet (deferred to a future PR). The schema field is in
   * place for forward-compatibility.
   *
   * Per Decision H (this PR-5), informational read endpoints do NOT
   * write ConsentAuditEvent rows. Only enforcement endpoints
   * (check/grant/revoke) write decision-log entries. The
   * enforcement-vs-informational distinction is the most structurally
   * significant precedent ADR-0007 will document.
   */
  async resolveAllScopes(
    input: ResolveAllScopesInput,
  ): Promise<TalentConsentStateResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const computedAt = new Date();

      const events = await tx.talentConsentEvent.findMany({
        where: {
          tenant_id: input.tenant_id,
          talent_id: input.talent_id,
        },
      });

      const scopes: TalentConsentScopeStateDto[] = CONSENT_SCOPES.map(
        (scope) => deriveScopeStateForReadEndpoint(events, scope),
      );

      return {
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        is_anonymized: false,
        computed_at: computedAt.toISOString(),
        scopes,
      };
    });
  }

  /**
   * Resolver-path read for the history endpoint (PR-6). Per ADR-0007
   * Decision G pattern, this is the third sibling resolver: write seam
   * `recordConsentEvent`, point read `resolveConsentState` (PR-4), batch
   * read `resolveAllScopes` (PR-5), keyset-paginated history `resolveHistory`
   * (PR-6).
   *
   * Per ADR-0006 Implementation Precedent O, this method sits in the
   * resolver region. It uses only `tx.talentConsentEvent.findMany` from
   * the existing resolver-region allow-list (no R4 guardrail update).
   * `findFirst`, `aggregate`, `groupBy`, and raw SQL are forbidden per
   * directive §6.
   *
   * Per ADR-0007 Decision E (extended to history per directive §6):
   * historical events preserve their original `action`. No staleness
   * computation; staleness is enforcement metadata applied at check
   * time only and is never written into historical records.
   *
   * Per ADR-0007 Decision H (read endpoints don't write decision-log
   * entries): no `tx.consentAuditEvent.create` call.
   *
   * Per directive §5 ordering and pagination:
   *   - ORDER BY created_at DESC, id DESC (database-side, not in memory)
   *   - cursor predicate (created_at, id) < (cursor.created_at, cursor.event_id)
   *     in Prisma OR/AND form
   *   - LIMIT applied in the database
   *   - Scope filter applied before pagination; cursor traverses the
   *     filtered set
   *   - Supporting index added in PR-6 schema migration:
   *     @@index([tenant_id, talent_id, created_at(sort: Desc), id(sort: Desc)])
   *
   * Per directive §5 field naming: the DB column `id` maps to the
   * API/DTO field `event_id`. Prisma references `id`; the cursor and
   * response surface reference `event_id`. The mapping is the only
   * renaming permitted.
   *
   * Per directive §4 + §7 test 7: never 404 on empty. Empty result
   * returns { events: [], next_cursor: null, is_anonymized: false }
   * with HTTP 200.
   *
   * Per ADR-0007 Decision F (PR-5 precedent): is_anonymized hardcoded
   * `false` until the talent module ships RTBF detection.
   */
  async resolveHistory(
    input: ResolveHistoryInput,
  ): Promise<ConsentHistoryResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      // Build the where clause: tenant + talent (always); scope (optional);
      // cursor predicate (optional). The cursor predicate uses Prisma's
      // OR/AND form per directive §5.
      const where: Record<string, unknown> = {
        tenant_id: input.tenant_id,
        talent_id: input.talent_id,
      };
      if (input.scope !== undefined) {
        where['scope'] = input.scope;
      }
      if (input.cursor !== undefined) {
        const cursor = input.cursor;
        where['OR'] = [
          { created_at: { lt: cursor.created_at } },
          {
            AND: [
              { created_at: cursor.created_at },
              { id: { lt: cursor.event_id } },
            ],
          },
        ];
      }

      // findMany with database-side ordering + limit. Fetch limit+1 to
      // detect whether a next page exists without a separate count query.
      const rows = await tx.talentConsentEvent.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
      });

      const hasMore = rows.length > input.limit;
      const pageRows = hasMore ? rows.slice(0, input.limit) : rows;

      const events: ConsentHistoryEventDto[] = pageRows.map((row) => ({
        event_id: row.id,
        scope: row.scope as ConsentScopeValue,
        action: row.action,
        created_at: row.created_at.toISOString(),
        expires_at: row.expires_at !== null ? row.expires_at.toISOString() : null,
      }));

      const lastRow = pageRows[pageRows.length - 1];
      const next_cursor =
        hasMore && lastRow !== undefined
          ? encodeCursor({
              created_at: lastRow.created_at,
              event_id: lastRow.id,
            })
          : null;

      return {
        events,
        next_cursor,
        is_anonymized: false,
      };
    });
  }
}

// ----------------------------------------------------------------------
// Resolver-path helpers. These are module-private (not exported) so the
// R4 guardrail (which scans the repository file for table accesses) can
// classify them as part of the resolver-path category.
// ----------------------------------------------------------------------

type LedgerEvent = {
  id: string;
  scope: string;
  action: string;
  captured_method: string;
  occurred_at: Date;
  expires_at: Date | null;
  metadata: unknown;
};

type ScopeState = 'allowed' | 'denied' | 'no_grant';

// Decision D: source-aware most-restrictive. Partition by captured_method,
// take latest per partition by occurred_at, apply most-restrictive across
// partitions. A revoked or expired latest in any source produces denied.
// All-granted across sources (with at least one source contributing)
// produces allowed. No events for the scope from any source produces
// no_grant. The Counterintuitive Example from §2.7 lines 2416-2422
// (Indeed restricted + signup full → contacting restricted) is the
// canonical case this function must produce correctly.
function computeMostRestrictiveStateForScope(
  events: LedgerEvent[],
  scope: ConsentScopeValue,
): ScopeState {
  const scopeEvents = events.filter((e) => e.scope === scope);
  if (scopeEvents.length === 0) {
    return 'no_grant';
  }
  const latestPerSource = new Map<string, LedgerEvent>();
  for (const ev of scopeEvents) {
    const prior = latestPerSource.get(ev.captured_method);
    if (prior === undefined || ev.occurred_at.getTime() > prior.occurred_at.getTime()) {
      latestPerSource.set(ev.captured_method, ev);
    }
  }
  let anyDenied = false;
  let anyGranted = false;
  for (const ev of latestPerSource.values()) {
    if (ev.action === 'revoked' || ev.action === 'expired') {
      anyDenied = true;
    } else if (ev.action === 'granted') {
      anyGranted = true;
    }
  }
  if (anyDenied) {
    return 'denied';
  }
  return anyGranted ? 'allowed' : 'no_grant';
}

// Decision F: latest grant for the scope (across all sources). Used for
// the 12-month staleness window check.
function findLatestGrantForScope(
  events: LedgerEvent[],
  scope: ConsentScopeValue,
): LedgerEvent | null {
  let latest: LedgerEvent | null = null;
  for (const ev of events) {
    if (ev.scope !== scope || ev.action !== 'granted') {
      continue;
    }
    if (latest === null || ev.occurred_at.getTime() > latest.occurred_at.getTime()) {
      latest = ev;
    }
  }
  return latest;
}

function isStale(occurredAt: Date, now: Date): boolean {
  // 12 calendar months. Computed via month arithmetic so a grant on
  // 2025-04-30 becomes stale on 2026-04-30, regardless of leap days.
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - STALENESS_WINDOW_MONTHS);
  return occurredAt.getTime() < cutoff.getTime();
}

// Decision G: intersection of permitted channels across the latest grant
// per source for the scope. Each TalentConsentEvent.metadata MAY carry
// `permitted_channels: ContactChannel[]`. Absence means "all channels
// permitted by default" for that grant (sources without an explicit
// restriction contribute the full ContactChannel set to the intersection).
//
// The metadata convention is locked here (PR-4): grants that need to
// restrict channels carry `permitted_channels` as a string[] of
// ContactChannel values. Returns null when no source carries an explicit
// restriction (i.e., all channels permitted everywhere); returns the
// intersected permitted set otherwise.
function computePermittedChannelsIntersection(
  events: LedgerEvent[],
  scope: ConsentScopeValue,
): ContactChannel[] | null {
  const scopeGrants = events.filter(
    (e) => e.scope === scope && e.action === 'granted',
  );
  if (scopeGrants.length === 0) {
    return null;
  }
  const latestGrantPerSource = new Map<string, LedgerEvent>();
  for (const ev of scopeGrants) {
    const prior = latestGrantPerSource.get(ev.captured_method);
    if (prior === undefined || ev.occurred_at.getTime() > prior.occurred_at.getTime()) {
      latestGrantPerSource.set(ev.captured_method, ev);
    }
  }
  let intersection: Set<ContactChannel> | null = null;
  let anyExplicitRestriction = false;
  for (const ev of latestGrantPerSource.values()) {
    const meta = ev.metadata as Record<string, unknown> | null;
    const permitted = meta?.['permitted_channels'];
    if (Array.isArray(permitted)) {
      anyExplicitRestriction = true;
      const sourceSet = new Set<ContactChannel>(
        permitted.filter((v): v is ContactChannel => typeof v === 'string'),
      );
      if (intersection === null) {
        intersection = sourceSet;
      } else {
        // Snapshot to a local const so TS narrowing (intersection !== null
        // → Set<ContactChannel>) survives across the filter closure. The
        // inline form ([...intersection].filter(...)) widens to never[]
        // under the consent lib's strict tsconfig.
        const prev: Set<ContactChannel> = intersection;
        intersection = new Set([...prev].filter((c) => sourceSet.has(c)));
      }
    }
  }
  return anyExplicitRestriction && intersection !== null
    ? [...intersection]
    : null;
}

// Decision H: persists a ConsentAuditEvent row with event_type
// 'consent.check.decision' for every check call (allowed/denied/error).
// event_payload carries the full ConsentDecision shape plus the
// resolver inputs (operation, channel) for forensic traceability.
async function persistDecisionAudit(
  tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
  input: ResolveConsentStateInput,
  decision: ConsentDecisionDto,
): Promise<void> {
  await tx.consentAuditEvent.create({
    data: {
      id: uuidv7(),
      tenant_id: input.tenant_id,
      actor_id: null,
      actor_type: 'system',
      event_type: 'consent.check.decision',
      subject_id: input.talent_id,
      event_payload: {
        decision_id: decision.decision_id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        operation: input.operation,
        scope: decision.scope ?? null,
        channel: input.channel ?? null,
        result: decision.result,
        denied_scopes: decision.denied_scopes ?? [],
        reason_code: decision.reason_code ?? null,
        computed_at: decision.computed_at,
      } as never,
    },
  });
}

// PR-5 Decision C/D: derive per-scope state for the read endpoint.
// Distinct from computeMostRestrictiveStateForScope (PR-4) which collapses
// revoked + expired into "denied" for the check endpoint's
// allowed/denied/error semantic. The state endpoint distinguishes them.
//
// Status priority (most-restrictive across sources):
//   - any latest-per-source revoked  → 'revoked'
//   - else any latest-per-source expired → 'expired'
//   - else any latest-per-source granted → 'granted'
//   - else (no events for this scope) → 'no_grant'
//
// Timestamps:
//   - granted_at: latest event with action='granted' across all sources;
//                 null if no grant event exists for this scope
//   - revoked_at: latest event with action='revoked' across all sources;
//                 null if not revoked
//   - expires_at: from the latest grant event's expires_at field
//                 (TalentConsentEvent.expires_at); null when absent
function deriveScopeStateForReadEndpoint(
  events: LedgerEvent[],
  scope: ConsentScopeValue,
): TalentConsentScopeStateDto {
  const scopeEvents = events.filter((e) => e.scope === scope);
  if (scopeEvents.length === 0) {
    return {
      scope,
      status: 'no_grant',
      granted_at: null,
      revoked_at: null,
      expires_at: null,
    };
  }

  const latestPerSource = new Map<string, LedgerEvent>();
  for (const ev of scopeEvents) {
    const prior = latestPerSource.get(ev.captured_method);
    if (prior === undefined || ev.occurred_at.getTime() > prior.occurred_at.getTime()) {
      latestPerSource.set(ev.captured_method, ev);
    }
  }

  let anyRevoked = false;
  let anyExpired = false;
  let anyGranted = false;
  for (const ev of latestPerSource.values()) {
    if (ev.action === 'revoked') {
      anyRevoked = true;
    } else if (ev.action === 'expired') {
      anyExpired = true;
    } else if (ev.action === 'granted') {
      anyGranted = true;
    }
  }
  let status: ConsentScopeStatus;
  if (anyRevoked) {
    status = 'revoked';
  } else if (anyExpired) {
    status = 'expired';
  } else if (anyGranted) {
    status = 'granted';
  } else {
    status = 'no_grant';
  }

  const latestGrant = findLatestForAction(scopeEvents, 'granted');
  const latestRevoke = findLatestForAction(scopeEvents, 'revoked');

  return {
    scope,
    status,
    granted_at: latestGrant?.occurred_at.toISOString() ?? null,
    revoked_at: latestRevoke?.occurred_at.toISOString() ?? null,
    expires_at: latestGrant?.expires_at?.toISOString() ?? null,
  };
}

function findLatestForAction(
  events: LedgerEvent[],
  action: string,
): LedgerEvent | null {
  let latest: LedgerEvent | null = null;
  for (const ev of events) {
    if (ev.action !== action) {
      continue;
    }
    if (latest === null || ev.occurred_at.getTime() > latest.occurred_at.getTime()) {
      latest = ev;
    }
  }
  return latest;
}
