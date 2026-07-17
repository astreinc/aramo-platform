import { Injectable, Logger } from '@nestjs/common';
import { AramoError, normalizeEmail } from '@aramo/common';
import { ClusterPurgeService } from '@aramo/identity-index';
import { PortalIdentityRepository } from '@aramo/portal-identity';
import { RefreshTokenService } from '@aramo/auth-storage';

// Portal P4 P4b (Aramo-Portal-P4-Directive-v1_0-LOCKED §PR-2, D-2/D-3) — the
// talent RTBF orchestration: a signed-in portal user erases their OWN platform
// identity. Keyed off the session `sub` ONLY (a portal user can only ever erase
// themselves — the whole surface is self-service self-deletion, which is why it
// needs no dedicated scope: Option A gate).
//
// D-2 — platform-rail erasure, NOT the tenants':
//   purgeCluster(cluster_id, 'talent_rtbf')  — fingerprints, cluster, arrival
//     stamps, DormantLink, cluster-keyed PortalDispute, and NULLs PortalUser.cluster_id
//   → then eraseByPortalUser — the portal_identity residue purgeCluster leaves:
//     NoticeDelivery (P4a, explicit — the D-2 ruling now due), PortalLoginToken,
//     the PortalUser row itself.
//   Tenant-rail records are untouched — each tenant is a separate controller.
//
// Ordering: purge (cluster-keyed) → delete residue → revoke sessions. Each step is
// atomic; a mid-sequence failure leaves the identity re-erasable (idempotent — a
// re-run finds the now-cluster-less user and finishes the residue delete).
//
// D-3 — GRAVE type-to-confirm (the erase-talent re-type-the-id pattern, as UI): the
// caller must re-type their OWN email; a mismatch refuses with no erasure.
@Injectable()
export class PortalRtbfService {
  private readonly logger = new Logger(PortalRtbfService.name);

  constructor(
    private readonly portalIdentity: PortalIdentityRepository,
    private readonly purge: ClusterPurgeService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  /**
   * Erase the caller's own platform identity. Idempotent: a re-run over an
   * already-erased identity is a no-op success (nothing to confirm, nothing to
   * delete). Returns nothing — the terminal state is the response.
   */
  async eraseSelf(input: {
    portalUserId: string;
    confirmation: string;
    requestId: string;
  }): Promise<void> {
    const user = await this.portalIdentity.findPortalById(input.portalUserId);
    if (user === null) {
      // Already erased (or the session outlived its user) — the identity is gone.
      // Revoke any lingering sessions defensively and succeed (terminal).
      await this.refreshTokens.revokeAllForUser({ user_id: input.portalUserId });
      return;
    }

    // D-3 grave confirm: re-type your own email. Server-enforced (defense beyond
    // the UI type-to-confirm), byte-compared on the normalized form.
    if (normalizeEmail(input.confirmation) !== user.email_normalized) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'confirmation does not match',
        400,
        { requestId: input.requestId, details: { invalid_field: 'confirmation' } },
      );
    }

    // D-2 step 1 — purge the platform-rail cluster-keyed data (if the identity is
    // linked to a cluster). platform_trust/identity_index/ingestion, NEVER tenant.
    if (user.cluster_id !== null) {
      await this.purge.purgeCluster(user.cluster_id, 'talent_rtbf');
    }

    // D-2 step 2 — the portal_identity residue purgeCluster does not delete
    // (NoticeDelivery + login tokens + the PortalUser row).
    const erased = await this.portalIdentity.eraseByPortalUser({
      portalUserId: user.id,
      emailNormalized: user.email_normalized,
    });

    // D-3 — destroy every live portal session for the erased identity.
    const revoked = await this.refreshTokens.revokeAllForUser({
      user_id: user.id,
    });

    // Structured audit (log-based; caller tag talent_rtbf; Gate-5 evidence — the
    // NoticeDelivery count is explicit). No tenant-rail row is written (D-2).
    this.logger.log({
      event: 'portal_identity_erased',
      caller: 'talent_rtbf',
      portal_user_id: user.id,
      cluster_id: user.cluster_id,
      notice_deliveries_deleted: erased.notice_deliveries_deleted,
      login_tokens_deleted: erased.login_tokens_deleted,
      portal_user_deleted: erased.portal_user_deleted,
      sessions_revoked: revoked.revoked_count,
    });
  }
}
