import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';

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
// resolve DNS, match, transition. INFORMATIONAL (PO ruling (a)): no transition
// gates any other action — P1's invite domain-lock works regardless of status.
//
// All operations are on the CALLER's own tenant (tenant_id pinned from the JWT at
// the controller). The audit events are emitted by the controller (the app-layer
// two-call seam), driven by the `issued` / `verified` flags returned here.

@Injectable()
export class DomainVerificationService {
  constructor(
    private readonly tenants: TenantRepository,
    @Inject(DNS_RESOLVER_PORT) private readonly dns: DnsResolverPort,
  ) {}

  // GET — the current status + the record-to-publish (name + value).
  async getStatus(
    tenantId: string,
    requestId: string,
  ): Promise<DomainVerificationView> {
    const row = await this.loadOrThrow(tenantId, requestId);
    return this.toView(row);
  }

  // POST — mint a fresh token → PENDING. Idempotent re-issue: always mints a new
  // token and overwrites (the old DNS record becomes inert). Returns `issued:true`
  // so the controller emits identity.domain.verification.requested.
  async requestVerification(
    tenantId: string,
    requestId: string,
  ): Promise<{ view: DomainVerificationView; issued: true; domain: string }> {
    const row = await this.loadOrThrow(tenantId, requestId);
    const domain = this.requireAllowedDomain(row, requestId);

    const token = generateDomainVerificationToken();
    const updated = await this.tenants.updateDomainVerification(tenantId, {
      domain_verification_status: 'PENDING',
      domain_verification_token: token,
      domain_token_issued_at: new Date(),
      // Re-issuing from a previously VERIFIED state would reset to PENDING; in
      // practice the UI only offers re-issue from UNVERIFIED/PENDING. Clearing
      // verified_at keeps the row consistent with the PENDING status.
      domain_verified_at: null,
    });
    return { view: this.toView(updated), issued: true, domain };
  }

  // POST /check — resolve the TXT record + match. Match → VERIFIED (sets
  // verified_at), returns `verified:true` so the controller emits
  // identity.domain.verified. No match → stays PENDING (NOT an error — DNS not
  // propagated yet; the common, retryable path). Already VERIFIED → no-op
  // (sticky), `verified:false`, no audit.
  async checkVerification(
    tenantId: string,
    requestId: string,
  ): Promise<{
    view: DomainVerificationView;
    verified: boolean;
    domain: string;
  }> {
    const row = await this.loadOrThrow(tenantId, requestId);
    const domain = this.requireAllowedDomain(row, requestId);

    // Already verified — sticky, no re-check, no transition, no audit.
    if (this.statusOf(row, requestId) === 'VERIFIED') {
      return { view: this.toView(row), verified: false, domain };
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
      return { view: this.toView(row), verified: false, domain };
    }

    const updated = await this.tenants.updateDomainVerification(tenantId, {
      domain_verification_status: 'VERIFIED',
      domain_verified_at: new Date(),
    });
    return { view: this.toView(updated), verified: true, domain };
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

  private toView(row: DomainVerificationRow): DomainVerificationView {
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
    return {
      status,
      allowed_domain: domain,
      record_name: recordName,
      record_value: recordValue,
      verified_at: row.domain_verified_at?.toISOString() ?? null,
      token_issued_at: row.domain_token_issued_at?.toISOString() ?? null,
    };
  }
}
