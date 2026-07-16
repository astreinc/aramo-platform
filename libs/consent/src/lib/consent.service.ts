import { Injectable } from '@nestjs/common';
import { AramoError, hashCanonicalizedBody } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';

import { ConsentRepository } from './consent.repository.js';
import {
  CONSENT_TEXT_CURRENT_VERSION,
  hashPortalConsentText,
  renderPortalConsentText,
} from './consent-texts.js';
import type { ConsentCheckRequestDto } from './dto/consent-check-request.dto.js';
import type { ConsentDecisionDto } from './dto/consent-decision.dto.js';
import type { ConsentGrantRequestDto } from './dto/consent-grant-request.dto.js';
import type { ConsentGrantResponseDto } from './dto/consent-grant-response.dto.js';
import type { ConsentRevokeRequestDto } from './dto/consent-revoke-request.dto.js';
import type { ConsentRevokeResponseDto } from './dto/consent-revoke-response.dto.js';
import type { TalentConsentStateResponseDto } from './dto/talent-consent-state-response.dto.js';
import type { ConsentHistoryResponseDto } from './dto/consent-history-response.dto.js';
import type { ConsentDecisionLogEventType } from './dto/consent-decision-log-entry.dto.js';
import type { ConsentDecisionLogResponseDto } from './dto/consent-decision-log-response.dto.js';
import type { ConsentScopeValue } from './dto/consent-grant-request.dto.js';
import { CONSENT_SCOPES } from './dto/consent-grant-request.dto.js';
import type { PortalConsentTextResponseDto } from './dto/portal-consent-text.dto.js';
import {
  CursorDecodeError,
  decodeCursor,
  type HistoryCursorPayload,
} from './util/history-cursor.js';

// Portal P2 P2a (Directive ruling 4) — the default consent term. Engine constant,
// NOT tenant config; NO cron. A grant records expires_at = occurred_at + this;
// the state read derives expiry. Renewal = a fresh grant (append-only).
export const CONSENT_DEFAULT_TERM_MONTHS = 12;

// Service trusts the controller boundary's class-validator pass.
// Tenant id and (when applicable) actor id come from the JWT, not the body.
@Injectable()
export class ConsentService {
  constructor(private readonly consentRepo: ConsentRepository) {}

  async grant(
    request: ConsentGrantRequestDto,
    idempotencyKey: string,
    authContext: AuthContextType,
    requestId: string,
  ): Promise<ConsentGrantResponseDto> {
    return this.consentRepo.recordConsentEvent({
      action: 'granted',
      tenant_id: authContext.tenant_id,
      talent_record_id: request.talent_record_id,
      scope: request.scope,
      captured_method: request.captured_method,
      captured_by_actor_id: this.deriveActorId(authContext),
      consent_version: request.consent_version,
      consent_text_snapshot: request.consent_text_snapshot,
      consent_document_id: request.consent_document_id,
      occurred_at: request.occurred_at,
      expires_at: request.expires_at,
      metadata: request.metadata,
      idempotencyKey,
      requestHash: hashCanonicalizedBody(request),
      requestId,
    });
  }

  async revoke(
    request: ConsentRevokeRequestDto,
    idempotencyKey: string,
    authContext: AuthContextType,
    requestId: string,
  ): Promise<ConsentRevokeResponseDto> {
    return this.consentRepo.recordConsentEvent({
      action: 'revoked',
      tenant_id: authContext.tenant_id,
      talent_record_id: request.talent_record_id,
      scope: request.scope,
      captured_method: request.captured_method,
      captured_by_actor_id: this.deriveActorId(authContext),
      consent_version: request.consent_version,
      // No expires_at, no consent_text_snapshot — grant-only fields.
      consent_document_id: request.consent_document_id,
      occurred_at: request.occurred_at,
      metadata: request.metadata,
      idempotencyKey,
      requestHash: hashCanonicalizedBody(request),
      requestId,
    });
  }

  /**
   * Runtime consent check (PR-4). Idempotency-Key is OPTIONAL per Phase 1
   * §6: when present + same body matches a prior call, the original
   * ConsentDecision is returned from the idempotency table without
   * re-running the resolver or emitting a new decision-log entry. Same
   * key + different body returns 409 IDEMPOTENCY_KEY_CONFLICT. When
   * absent, every call runs the resolver and writes a fresh decision-log
   * entry (Decision H).
   */
  async check(
    request: ConsentCheckRequestDto,
    idempotencyKey: string | undefined,
    authContext: AuthContextType,
    requestId: string,
  ): Promise<ConsentDecisionDto> {
    return this.consentRepo.resolveConsentState({
      tenant_id: authContext.tenant_id,
      talent_record_id: request.talent_record_id,
      operation: request.operation,
      channel: request.channel,
      idempotencyKey,
      requestHash: hashCanonicalizedBody(request),
      requestId,
    });
  }

  /**
   * Informational state read (PR-5). Returns the current consent state
   * per scope for the requested talent within the JWT's tenant context.
   * No idempotency, no operation/channel parameters, no decision log
   * write (Decision H — informational endpoints don't log).
   */
  async getState(
    talent_record_id: string,
    authContext: AuthContextType,
    requestId: string,
  ): Promise<TalentConsentStateResponseDto> {
    return this.consentRepo.resolveAllScopes({
      tenant_id: authContext.tenant_id,
      talent_record_id,
      requestId,
    });
  }

  /**
   * Informational history read (PR-6). Returns a keyset-paginated page
   * of consent ledger events for the requested talent within the JWT's
   * tenant context. No idempotency, no decision log write (Decision H).
   *
   * The controller is responsible for:
   *   - validating talent_record_id format
   *   - clamping/validating limit per directive §5
   *   - decoding the cursor and mapping decode errors to HTTP 400
   *     VALIDATION_ERROR (cursor errors must not propagate as 500)
   *
   * The service trusts those guarantees and forwards to the resolver.
   */
  async getHistory(
    talent_record_id: string,
    scope: ConsentScopeValue | undefined,
    limit: number,
    cursor: HistoryCursorPayload | undefined,
    authContext: AuthContextType,
    requestId: string,
  ): Promise<ConsentHistoryResponseDto> {
    return this.consentRepo.resolveHistory({
      tenant_id: authContext.tenant_id,
      talent_record_id,
      scope,
      limit,
      cursor,
      requestId,
    });
  }

  /**
   * Informational decision-log read (PR-7). Returns a keyset-paginated
   * page of audit-event entries for the requested talent within the JWT's
   * tenant context. No idempotency, no decision-log write (Decision H —
   * sharpest in PR-7 because the endpoint reads the very table the
   * convention prohibits writing to).
   *
   * The controller is responsible for:
   *   - validating talent_record_id format
   *   - validating event_type against the closed set per PR-7 §7
   *   - clamping/validating limit per PR-6 §5
   *   - decoding the cursor and mapping decode errors to HTTP 400
   *     VALIDATION_ERROR (cursor errors must not propagate as 500)
   *
   * The service trusts those guarantees and forwards to the resolver.
   */
  async getDecisionLog(
    talent_record_id: string,
    event_type: ConsentDecisionLogEventType | undefined,
    limit: number,
    cursor: HistoryCursorPayload | undefined,
    authContext: AuthContextType,
    requestId: string,
  ): Promise<ConsentDecisionLogResponseDto> {
    return this.consentRepo.resolveDecisionLog({
      tenant_id: authContext.tenant_id,
      talent_record_id,
      event_type,
      limit,
      cursor,
      requestId,
    });
  }

  private deriveActorId(authContext: AuthContextType): string | null {
    return authContext.consumer_type === 'recruiter' ? authContext.sub : null;
  }

  // ===========================================================================
  // Portal P2 P2a (Directive rulings 2/4/5/6) — the PORTAL-ACTOR parallel
  // entry. These are ADD-not-rename: the tenant-actor grant/revoke above are
  // untouched (byte-identical guards). The portal record id comes from the
  // OPEN-4 chain (the controller's resolveMemberOr404), never a request body —
  // no "who" oracle. The actor is the portal principal (authContext.sub =
  // PortalUser.id, captured_method 'portal_self_service'). Every grant AND revoke
  // records the D7 consent-evidence object (channel 'portal') on the audit stream.
  // ===========================================================================

  async grantAsPortal(input: {
    talent_record_id: string; // resolved from the OPEN-4 chain
    scope: ConsentScopeValue;
    authContext: AuthContextType; // record-tenant scoped, portal principal
    idempotencyKey: string;
    requestId: string;
    consentTextVersion?: string;
    now?: Date;
  }): Promise<ConsentGrantResponseDto> {
    const now = input.now ?? new Date();
    const evidence = hashPortalConsentText(
      input.consentTextVersion ?? CONSENT_TEXT_CURRENT_VERSION,
      { recipient_tenant_id: input.authContext.tenant_id, scope: input.scope },
    );
    // Read-derived term: record expires_at = now + CONSENT_DEFAULT_TERM_MONTHS.
    const expiresAt = new Date(now);
    expiresAt.setMonth(expiresAt.getMonth() + CONSENT_DEFAULT_TERM_MONTHS);
    return this.consentRepo.recordConsentEvent({
      action: 'granted',
      tenant_id: input.authContext.tenant_id,
      talent_record_id: input.talent_record_id,
      scope: input.scope,
      captured_method: 'portal_self_service',
      captured_by_actor_id: input.authContext.sub,
      consent_version: evidence.version,
      occurred_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      idempotencyKey: input.idempotencyKey,
      // Idempotency: stable across replays of the same (record, scope, action) —
      // server-generated timestamps are deliberately excluded so a re-submit
      // under the same key is a replay, not a 409 conflict.
      requestHash: hashCanonicalizedBody({
        portal_consent_grant: {
          talent_record_id: input.talent_record_id,
          scope: input.scope,
        },
      }),
      requestId: input.requestId,
      consent_evidence: {
        consent_text_hash: evidence.hash,
        consent_text_version: evidence.version,
        // P4 forward contract: versioned platform notices ship in P4; null until then.
        notice_version: null,
        channel: 'portal',
      },
    });
  }

  async revokeAsPortal(input: {
    talent_record_id: string;
    scope: ConsentScopeValue;
    authContext: AuthContextType;
    idempotencyKey: string;
    requestId: string;
    consentTextVersion?: string;
    now?: Date;
  }): Promise<ConsentRevokeResponseDto> {
    const now = input.now ?? new Date();
    const evidence = hashPortalConsentText(
      input.consentTextVersion ?? CONSENT_TEXT_CURRENT_VERSION,
      { recipient_tenant_id: input.authContext.tenant_id, scope: input.scope },
    );
    // Revocation is immediate + idempotent (revoking a non-active grant is a
    // no-op success — the append-only ledger records the revoke; state stays
    // inactive). No expires_at (grant-only).
    return this.consentRepo.recordConsentEvent({
      action: 'revoked',
      tenant_id: input.authContext.tenant_id,
      talent_record_id: input.talent_record_id,
      scope: input.scope,
      captured_method: 'portal_self_service',
      captured_by_actor_id: input.authContext.sub,
      consent_version: evidence.version,
      occurred_at: now.toISOString(),
      idempotencyKey: input.idempotencyKey,
      requestHash: hashCanonicalizedBody({
        portal_consent_revoke: {
          talent_record_id: input.talent_record_id,
          scope: input.scope,
        },
      }),
      requestId: input.requestId,
      consent_evidence: {
        consent_text_hash: evidence.hash,
        consent_text_version: evidence.version,
        notice_version: null,
        channel: 'portal',
      },
    });
  }

  /**
   * Portal P2 P2b (§PR-2) — render the EXACT versioned consent text the portal
   * user must see before granting (the D7 hash preimage). Rendering here shares
   * `renderPortalConsentText` with the grant path's hashing, so the displayed
   * bytes ARE the preimage. Returns all 5 scopes at the current version
   * (deterministic; the UI picks the scope the user is granting). The recipient
   * is named by tenant_id (the canonical legal clause) — the friendlier tenant
   * name is UI chrome the controller supplies separately.
   */
  getPortalConsentTexts(recipientTenantId: string): PortalConsentTextResponseDto {
    return {
      version: CONSENT_TEXT_CURRENT_VERSION,
      texts: CONSENT_SCOPES.map((scope) => ({
        scope,
        text: renderPortalConsentText(CONSENT_TEXT_CURRENT_VERSION, {
          recipient_tenant_id: recipientTenantId,
          scope,
        }),
      })),
    };
  }

  /**
   * Portal P2 P2b (§PR-2) — the append-only consent history for the portal
   * management UI. Delegates to getHistory (PR-6) whose ConsentHistoryEvent is
   * already closed at 5 ENGAGEMENT-class fields (event_id, scope, action,
   * created_at, expires_at — NO actor/recruiter/trust field), so it is safe for
   * the talent-facing surface as-is. This method owns the raw query-param
   * parsing (limit/scope/cursor) so cursor internals stay inside @aramo/consent
   * and the portal controller passes strings verbatim; validation errors map to
   * 400 (never a 500). Mirrors the recruiter history route's clamps (limit
   * default 50 / max 200) deliberately — the portal read must not diverge.
   */
  async getPortalHistory(input: {
    talent_record_id: string;
    scopeRaw?: string;
    limitRaw?: string;
    cursorRaw?: string;
    authContext: AuthContextType; // record-tenant scoped by the controller
    requestId: string;
  }): Promise<ConsentHistoryResponseDto> {
    const scope = this.parsePortalScopeFilter(input.scopeRaw, input.requestId);
    const limit = this.parsePortalLimit(input.limitRaw, input.requestId);
    const cursor = this.parsePortalCursor(input.cursorRaw, input.requestId);
    return this.getHistory(
      input.talent_record_id,
      scope,
      limit,
      cursor,
      input.authContext,
      input.requestId,
    );
  }

  private parsePortalLimit(limitRaw: string | undefined, requestId: string): number {
    if (limitRaw === undefined || limitRaw === '') return 50;
    if (!/^-?\d+$/.test(limitRaw)) {
      throw new AramoError('VALIDATION_ERROR', 'limit must be a positive integer', 400, {
        requestId,
        details: { invalid_field: 'limit' },
      });
    }
    const parsed = Number.parseInt(limitRaw, 10);
    if (parsed < 1) {
      throw new AramoError('VALIDATION_ERROR', 'limit must be at least 1', 400, {
        requestId,
        details: { invalid_field: 'limit' },
      });
    }
    return parsed > 200 ? 200 : parsed;
  }

  private parsePortalScopeFilter(
    scopeRaw: string | undefined,
    requestId: string,
  ): ConsentScopeValue | undefined {
    if (scopeRaw === undefined || scopeRaw === '') return undefined;
    if (!(CONSENT_SCOPES as readonly string[]).includes(scopeRaw)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `scope must be one of ${CONSENT_SCOPES.join(', ')}`,
        400,
        { requestId, details: { invalid_field: 'scope' } },
      );
    }
    return scopeRaw as ConsentScopeValue;
  }

  private parsePortalCursor(
    cursorRaw: string | undefined,
    requestId: string,
  ): HistoryCursorPayload | undefined {
    if (cursorRaw === undefined || cursorRaw === '') return undefined;
    try {
      return decodeCursor(cursorRaw);
    } catch (err) {
      if (err instanceof CursorDecodeError) {
        throw new AramoError('VALIDATION_ERROR', err.message, 400, {
          requestId,
          details: { invalid_field: 'cursor' },
        });
      }
      throw err;
    }
  }
}
