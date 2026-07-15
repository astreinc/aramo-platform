import { Injectable } from '@nestjs/common';
import { PortalIdentityRepository } from '@aramo/portal-identity';
import { TalentTrustService } from '@aramo/talent-trust';

// Portal P1 PR-2a — the OPEN-4 resolution chain. Replaces the transitional
// `sub`-passthrough: a portal session's JWT `sub` (= PortalUser.id) resolves to
// the portal user's ATS records ACROSS tenants, entirely through the platform-rail
// index-ref graph (no cross-tenant tenant-rail read):
//
//   sub → PortalUser → cluster_id
//       → cross-tenant PERSON_CLUSTER holders (findClusterHolders)
//       → per tenant: resolveSubjectRef(PERSON_CLUSTER) (husk → survivor, the
//         canonical standing resolver)
//       → the survivor's own ATS_TALENT_RECORD ref = the LIVE TalentRecord
//         (superseded records' subjects are husks, resolved PAST — so a
//         chain-resolved record is live by construction).
//
// A portal user with `cluster_id` null or zero live records is a VALID EMPTY state,
// never an error. Membership is validated through this chain for every per-record
// read — a record id not reachable here yields a UNIFORM 404 (oracle-resistant:
// no "exists but not yours").

export interface PortalRecordRef {
  tenant_id: string;
  record_id: string;
}

@Injectable()
export class PortalTalentResolverService {
  constructor(
    private readonly portalIdentity: PortalIdentityRepository,
    private readonly trust: TalentTrustService,
  ) {}

  /** The portal user's records across tenants (empty = valid). */
  async resolveRecords(portalUserId: string): Promise<PortalRecordRef[]> {
    const user = await this.portalIdentity.findPortalById(portalUserId);
    if (user === null || user.cluster_id === null) return [];
    const clusterId = user.cluster_id;

    const holders = await this.trust.findClusterHolders(clusterId);
    const out: PortalRecordRef[] = [];
    const seenTenants = new Set<string>();
    for (const holder of holders) {
      // One subject holds a given PERSON_CLUSTER ref per tenant (the unique);
      // dedupe defensively.
      if (seenTenants.has(holder.tenant_id)) continue;
      seenTenants.add(holder.tenant_id);

      // Husk → survivor via the standing resolver (the PERSON_CLUSTER ref in
      // this tenant). Null when the ref resolves to nothing live.
      const survivor = await this.trust.resolveSubjectRef({
        tenant_id: holder.tenant_id,
        ref_type: 'PERSON_CLUSTER',
        ref_id: clusterId,
      });
      if (survivor === null) continue;

      // The survivor's OWN refs (listSubjectRefs is intentionally origin-keyed —
      // correct here since `survivor` is already merge-followed). Its
      // ATS_TALENT_RECORD ref, if promoted, is the live record.
      const refs = await this.trust.listSubjectRefs(holder.tenant_id, survivor.id);
      const ats = refs.find((r) => r.ref_type === 'ATS_TALENT_RECORD');
      if (ats === undefined) continue; // resolved but not promoted → no record
      out.push({ tenant_id: holder.tenant_id, record_id: ats.ref_id });
    }
    return out;
  }

  /**
   * Membership resolution for a per-record read: the {tenant_id, record_id} if
   * `recordId` is in the caller's chain, else null → the caller returns a UNIFORM
   * 404 (never "exists but not yours").
   */
  async resolveMemberRecord(
    portalUserId: string,
    recordId: string,
  ): Promise<PortalRecordRef | null> {
    const records = await this.resolveRecords(portalUserId);
    return records.find((r) => r.record_id === recordId) ?? null;
  }
}
