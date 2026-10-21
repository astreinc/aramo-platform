import { Inject, Injectable } from '@nestjs/common';
import { AramoError, createAramoLogger, type AramoLogger } from '@aramo/common';

import {
  TenantRepository,
  type DomainVerificationRow,
} from '../tenant.repository.js';
import {
  DNS_RESOLVER_PORT,
  type DnsResolverPort,
} from '../dns/dns-resolver.port.js';
import { loadDnsConfig } from '../dns/dns.config.js';
import {
  DomainClaimService,
  type PromoteOutcome,
} from '../domain-claim/domain-claim.service.js';
import {
  generateDomainVerificationToken,
  isDomainVerificationStatus,
  type DomainVerificationStatus,
} from '../util/domain-verification.js';

import {
  buildRecordName,
  buildRecordValue,
  type DomainVerificationView,
} from './domain-verification.view.js';

// Domain-Enforcement P2b §3/§4/§5 — the verification orchestration: mint token,
// resolve DNS, match, transition. P1's invite domain-lock works regardless of
// status.
//
// Domain-Enforcement P3 (LOCKED) §4 overrides P2b §5 / §8.10 ("VERIFIED gates
// nothing") ONLY as follows:
//   • on the transition into VERIFIED, the tenant's domain claim is promoted to
//     AUTHORITATIVE (DomainClaimService.promoteOnVerified — advisory lock + same-
//     transaction audit live there). A promotion refused because another
//     organization holds the domain ('CONFLICT') leaves the tenant VERIFIED (P2b
//     sticky) with a non-authoritative claim; the operator resolves it (§6). A
//     re-check of an already-VERIFIED tenant whose claim is not AUTHORITATIVE
//     retries the promotion (idempotent — 'ALREADY' when nothing to do).
//   • re-issuing the token while VERIFIED is refused (409, reason already_verified).
// P2b's DNS mechanism (record name/value, token, check) is unchanged.
//
// All operations are on the CALLER's own tenant (tenant_id pinned from the JWT at
// the controller). The audit events are emitted by the controller (the app-layer
// two-call seam), driven by the `issued` / `verified` flags returned here.

@Injectable()
export class DomainVerificationService {
  private readonly logger: AramoLogger = createAramoLogger('DomainVerificationService');

  constructor(
    private readonly tenants: TenantRepository,
    @Inject(DNS_RESOLVER_PORT) private readonly dns: DnsResolverPort,
    private readonly claims: DomainClaimService,
  ) {}

  // GET — the current status + the record-to-publish (name + value).
  async getStatus(
    tenantId: string,
    requestId: string,
  ): Promise<DomainVerificationView> {
    const row = await this.loadOrThrow(tenantId, requestId);
    return this.toView(row);
  }

  // POST — mint a fresh token → PENDING. Idempotent re-issue from UNVERIFIED /
  // PENDING: always mints a new token and overwrites (the old DNS record becomes
  // inert). Returns `issued:true` so the controller emits
  // identity.domain.verification.requested.
  //
  // P3 §4 — refused while VERIFIED (VERIFIED is sticky, P2b :15): 409 with
  // details.reason 'already_verified'; nothing changes.
  async requestVerification(
    tenantId: string,
    requestId: string,
  ): Promise<{ view: DomainVerificationView; issued: true; domain: string }> {
    const row = await this.loadOrThrow(tenantId, requestId);
    const domain = this.requireAllowedDomain(row, requestId);
    if (this.statusOf(row, requestId) === 'VERIFIED') {
      throw alreadyVerifiedError(requestId);
    }

    const updated = await this.mintToken(tenantId);
    return { view: await this.toView(updated), issued: true, domain };
  }

  // P3 §5 — the delegate link's read: make sure there is a record to publish.
  // Mints the P2b token ONLY when none exists yet (status UNVERIFIED) — the owner
  // delegated the verification, so producing the first record is within the
  // grant. NEVER rotates an existing token (the delegate cannot re-issue) and
  // never touches a VERIFIED tenant. `issued` drives the requested audit event.
  async ensureTokenForDelegate(
    tenantId: string,
    requestId: string,
  ): Promise<{ view: DomainVerificationView; issued: boolean; domain: string }> {
    const row = await this.loadOrThrow(tenantId, requestId);
    const domain = this.requireAllowedDomain(row, requestId);
    if (
      this.statusOf(row, requestId) === 'VERIFIED' ||
      row.domain_verification_token !== null
    ) {
      return { view: await this.toView(row), issued: false, domain };
    }
    const updated = await this.mintToken(tenantId);
    return { view: await this.toView(updated), issued: true, domain };
  }

  private mintToken(tenantId: string): Promise<DomainVerificationRow> {
    return this.tenants.updateDomainVerification(tenantId, {
      domain_verification_status: 'PENDING',
      domain_verification_token: generateDomainVerificationToken(),
      domain_token_issued_at: new Date(),
      domain_verified_at: null,
    });
  }

  // POST /check — resolve the TXT record + match. Match → VERIFIED (sets
  // verified_at), returns `verified:true` so the controller emits
  // identity.domain.verified, and promotes the domain claim (P3 §4). No match →
  // stays PENDING (NOT an error — DNS not propagated yet; the common, retryable
  // path). Already VERIFIED → no DNS re-check, no transition, no verified audit
  // (sticky); the claim promotion is retried only when the claim is not yet
  // AUTHORITATIVE. `claim_outcome` is the promotion result (null when none ran).
  async checkVerification(
    tenantId: string,
    requestId: string,
  ): Promise<{
    view: DomainVerificationView;
    verified: boolean;
    domain: string;
    claim_outcome: PromoteOutcome | null;
  }> {
    const row = await this.loadOrThrow(tenantId, requestId);
    const domain = this.requireAllowedDomain(row, requestId);

    // Already verified — sticky: no DNS re-check, no transition, no audit. A
    // claim that is not yet authoritative is promoted (retry after an operator
    // released the other holder, or after a failed promotion).
    if (this.statusOf(row, requestId) === 'VERIFIED') {
      const claim = await this.claims.claimOf(tenantId);
      const claim_outcome =
        claim?.claim === 'AUTHORITATIVE' ? null : await this.promote(tenantId);
      return { view: await this.toView(row), verified: false, domain, claim_outcome };
    }
    // Nothing to check until a token has been minted.
    if (row.domain_verification_token === null) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Request verification first — no token has been issued for this domain',
        400,
        { requestId, details: { reason: 'no_token_issued' } },
      );
    }

    const { recordPrefix, valuePrefix } = loadDnsConfig();
    const recordName = buildRecordName(recordPrefix, domain);
    const expected = buildRecordValue(valuePrefix, row.domain_verification_token);

    const records = await this.dns.resolveTxt(recordName);
    // Each TXT record is an array of ≤255-char chunks — join before comparing.
    const matched = records.some((chunks) => chunks.join('') === expected);

    if (!matched) {
      // DNS not propagated / not published yet — stay PENDING (no penalty).
      return { view: await this.toView(row), verified: false, domain, claim_outcome: null };
    }

    const updated = await this.tenants.updateDomainVerification(tenantId, {
      domain_verification_status: 'VERIFIED',
      domain_verified_at: new Date(),
    });
    // P3 §4 — VERIFIED → AUTHORITATIVE claim (refused while held elsewhere).
    const claim_outcome = await this.promote(tenantId);
    return { view: await this.toView(updated), verified: true, domain, claim_outcome };
  }

  // The promotion is FAIL-SOFT here: VERIFIED is already persisted (the P2b
  // truth), and a later check retries the promotion (the sticky branch above),
  // so a transient promotion failure never turns a successful verification into
  // an error. Returns null when the promotion threw.
  private async promote(tenantId: string): Promise<PromoteOutcome | null> {
    try {
      return await this.claims.promoteOnVerified(tenantId);
    } catch (err) {
      this.logger.warn({
        event: 'domain_claim_promotion_failed',
        tenant_id: tenantId,
        error_message: (err as Error).message,
      });
      return null;
    }
  }

  private async loadOrThrow(
    tenantId: string,
    requestId: string,
  ): Promise<DomainVerificationRow> {
    const row = await this.tenants.findDomainVerificationById(tenantId);
    if (row === null) {
      throw new AramoError('NOT_FOUND', 'Tenant not found', 404, {
        requestId,
        details: { tenant_id: tenantId },
      });
    }
    return row;
  }

  private requireAllowedDomain(
    row: DomainVerificationRow,
    requestId: string,
  ): string {
    if (row.allowed_domain === null || row.allowed_domain.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'This tenant has no locked domain to verify',
        400,
        { requestId, details: { reason: 'no_allowed_domain' } },
      );
    }
    return row.allowed_domain;
  }

  // Read the persisted status through the closed-set guard (halt-and-surface on a
  // value outside the set — mirrors the audit repo's closed-set posture).
  private statusOf(
    row: DomainVerificationRow,
    requestId = 'domain-verification',
  ): DomainVerificationStatus {
    const s = row.domain_verification_status;
    if (!isDomainVerificationStatus(s)) {
      throw new AramoError(
        'INTERNAL_ERROR',
        `Tenant.domain_verification_status outside closed set: ${s}`,
        500,
        { requestId, details: { received_status: s } },
      );
    }
    return s;
  }

  private async toView(row: DomainVerificationRow): Promise<DomainVerificationView> {
    const status = this.statusOf(row);
    const domain = row.allowed_domain;
    let recordName: string | null = null;
    let recordValue: string | null = null;
    if (domain !== null && domain.length > 0) {
      const { recordPrefix, valuePrefix } = loadDnsConfig();
      recordName = buildRecordName(recordPrefix, domain);
      if (row.domain_verification_token !== null) {
        recordValue = buildRecordValue(valuePrefix, row.domain_verification_token);
      }
    }
    const claim = (await this.claims.claimOf(row.id))?.claim ?? null;
    // P3 §4 — VERIFIED but not authoritative, and the domain is held: the holder
    // is another organization (an own PROVISIONAL claim is itself a holder and
    // would have been promoted). Existence only — never who.
    const conflict =
      status === 'VERIFIED' &&
      domain !== null &&
      claim !== 'AUTHORITATIVE' &&
      claim !== 'PROVISIONAL' &&
      (await this.claims.isDomainHeld(domain));
    return {
      status,
      allowed_domain: domain,
      record_name: recordName,
      record_value: recordValue,
      verified_at: row.domain_verified_at?.toISOString() ?? null,
      token_issued_at: row.domain_token_issued_at?.toISOString() ?? null,
      domain_claim: claim,
      domain_claim_conflict: conflict,
    };
  }
}

// P3 §4 — re-issue while VERIFIED (VERIFIED is sticky): DOMAIN_ALREADY_VERIFIED,
// details.reason = 'already_verified'.
export function alreadyVerifiedError(requestId: string): AramoError {
  return new AramoError(
    'DOMAIN_ALREADY_VERIFIED',
    'This domain is already verified',
    409,
    { requestId, details: { reason: 'already_verified' } },
  );
}
