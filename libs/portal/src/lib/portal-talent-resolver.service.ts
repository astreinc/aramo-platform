import { Injectable } from '@nestjs/common';

// ATI-SEP-1 T10 WP4 — Addendum A4 (Talent Portal identity deferral; gap
// GAP-PORTAL-ID-1). The legacy OPEN-4 chain (sub → PortalUser.cluster_id →
// PERSON_CLUSTER holders in the trust ledger → survivor subjects → ATS refs) is
// RETIRED with the talent_trust / platform_trust / identity_index schemas. Until
// the Portal identity increment re-binds a portal account to its authorized ATS
// relationships through versioned service contracts (A4 target boundary), a
// portal session resolves NO talent: every method answers "no resolvable
// talent" and every caller returns ONE uniform, non-leaking 404 NOT_AVAILABLE.
//
// PortalUser rows and their (now inert) cluster_id column stay in place — no
// destructive migration of portal_identity data (A4 §3). This resolver reads
// nothing, so it cannot become an existence oracle.

export interface PortalRecordRef {
  tenant_id: string;
  record_id: string;
}

@Injectable()
export class PortalTalentResolverService {
  /**
   * The portal user's resolvable ATS records across tenants, or `null` when the
   * portal session cannot be resolved to a talent (always, under A4 /
   * GAP-PORTAL-ID-1). Callers map `null` to the uniform 404 NOT_AVAILABLE.
   */
  async resolveRecords(_portalUserId: string): Promise<PortalRecordRef[] | null> {
    return null;
  }

  /**
   * Membership resolution for a per-record call: the {tenant_id, record_id} if
   * `recordId` is resolvable for the caller, else null → the caller returns the
   * uniform 404 NOT_AVAILABLE (never "exists but not yours"). Always null under
   * A4 / GAP-PORTAL-ID-1.
   */
  async resolveMemberRecord(
    _portalUserId: string,
    _recordId: string,
  ): Promise<PortalRecordRef | null> {
    return null;
  }
}
