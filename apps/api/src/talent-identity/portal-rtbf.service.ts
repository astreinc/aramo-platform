import { Injectable, Logger } from '@nestjs/common';
import { AramoError, normalizeEmail } from '@aramo/common';
import { PortalIdentityRepository } from '@aramo/portal-identity';
import { RefreshTokenService } from '@aramo/auth-storage';

// Portal P4 P4b (Aramo-Portal-P4-Directive-v1_0-LOCKED §PR-2, D-2/D-3) — the
// talent RTBF orchestration: a signed-in portal user erases their OWN platform
// identity. Keyed off the session `sub` ONLY (a portal user can only ever erase
// themselves — the whole surface is self-service self-deletion, which is why it
// needs no dedicated scope: Option A gate).
//
// D-2 — platform-rail erasure, NOT the tenants':
//   eraseByPortalUser — the portal_identity rows: NoticeDelivery (P4a),
//     PortalLoginToken, the PortalUser row itself.
//   Tenant-rail records are untouched — each tenant is a separate controller.
//
// ATI-SEP-1 T10 WP4 — the former step 1 (purgeCluster over the cross-tenant
// identity index: fingerprints, cluster, arrival stamps, DormantLink,
// cluster-keyed PortalDispute) is GONE with the identity_index / platform_trust
// schemas. PortalUser.cluster_id is inert (Addendum A4); it is deleted with the
// PortalUser row and never dereferenced.
//
// Ordering: delete portal_identity rows → revoke sessions. Each step is atomic; a
// mid-sequence failure leaves the identity re-erasable (idempotent — a re-run
// finds no user, revokes defensively, and succeeds).
//
// D-3 — GRAVE type-to-confirm (the erase-talent re-type-the-id pattern, as UI): the
// caller must re-type their OWN email; a mismatch refuses with no erasure.
@Injectable()
export class PortalRtbfService {
  private readonly logger = new Logger(PortalRtbfService.name);

  constructor(
    private readonly portalIdentity: PortalIdentityRepository,
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

    // D-2 — the portal_identity rows (NoticeDelivery + login tokens + the
    // PortalUser row, whose inert cluster_id goes with it).
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
      notice_deliveries_deleted: erased.notice_deliveries_deleted,
      login_tokens_deleted: erased.login_tokens_deleted,
      portal_user_deleted: erased.portal_user_deleted,
      sessions_revoked: revoked.revoked_count,
    });
  }
}
