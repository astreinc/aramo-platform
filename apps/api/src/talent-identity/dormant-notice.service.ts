import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import { NOTICE_TEXT_CURRENT_VERSION, renderPlatformNoticeEmail } from '@aramo/consent';
import { MAILER_PORT, type MailerPort } from '@aramo/mailer';
import { PlatformTrustRepository } from '@aramo/platform-trust';
import { PortalIdentityRepository } from '@aramo/portal-identity';

// Portal P4 P4a (Aramo-Portal-P4-Directive-v1_0-LOCKED §PR-1.4, D-1/D-4/D-5) — the
// dormant-notice delivery orchestration. Called by the identity-lifecycle sweep's
// DARK duty ONLY when the master flag is on (production DORMANT_LINK_MINTING_ENABLED
// stays false; exercised only by the flag-on test param). Given a freshly-minted
// PENDING_NOTICE DormantLink for a cluster, it walks the D-4 portal-rail join,
// delivers the versioned platform notice, writes the DURABLE portal_identity
// delivery record, and only THEN transitions the link to NOTICED + expires_at.
//
// Ordering is the D14 provenance guarantee: send → write NoticeDelivery →
// transition. A send failure leaves the link PENDING_NOTICE (retried next sweep);
// platform_trust never learns the email/portal_user_id (only the version string +
// timestamp cross the wall). A cluster with no portal identity (nobody ever signed
// in) cannot be delivered to — it stays PENDING_NOTICE, logged, not an error.

// expires_at = noticed + 12 months (directive §PR-1.4). The horizon business rule
// lives here in the orchestration; the repo writes what it is given.
const NOTICE_EXPIRY_MONTHS = 12;

export interface DeliverNoticeResult {
  delivered: boolean;
  reason?: 'no_portal_identity' | 'delivery_failed';
}

@Injectable()
export class DormantNoticeService {
  constructor(
    private readonly platformTrust: PlatformTrustRepository,
    private readonly portalIdentity: PortalIdentityRepository,
    @Inject(MAILER_PORT) private readonly mailer: MailerPort,
    @Inject('DormantNoticeServiceLogger')
    private readonly logger: LoggerService,
  ) {}

  /**
   * Deliver the platform notice for a PENDING_NOTICE dormant link + record it +
   * transition to NOTICED. Idempotent at the sweep level (the caller only invokes
   * this for a link it just observed PENDING_NOTICE). Returns whether a delivery
   * was effected.
   */
  async deliverForCluster(input: {
    dormantLinkId: string;
    clusterId: string;
    now: Date;
  }): Promise<DeliverNoticeResult> {
    // D-4 join: DormantLink.cluster_id → PortalUser.cluster_id → PortalUser.id.
    const portals = await this.portalIdentity.findPortalsByClusterId(
      input.clusterId,
    );
    if (portals.length === 0) {
      // A dormant cluster with no portal identity: nothing to deliver to. Stays
      // PENDING_NOTICE (a future login that mints a portal identity is picked up
      // by a later sweep). Not an error.
      this.logger.log({
        event: 'dormant_notice_no_portal_identity',
        cluster_id: input.clusterId,
        dormant_link_id: input.dormantLinkId,
      });
      return { delivered: false, reason: 'no_portal_identity' };
    }

    // Deterministic primary target (oldest portal for the cluster).
    const target = portals[0]!;
    const email = renderPlatformNoticeEmail(NOTICE_TEXT_CURRENT_VERSION);

    // Send FIRST — a failure leaves the link PENDING_NOTICE (D14: no NOTICED
    // without a delivery). platform_trust never sees the address.
    try {
      await this.mailer.send({
        to: target.email_normalized,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
    } catch (err) {
      this.logger.warn({
        event: 'dormant_notice_delivery_failed',
        cluster_id: input.clusterId,
        dormant_link_id: input.dormantLinkId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { delivered: false, reason: 'delivery_failed' };
    }

    // The DURABLE portal_identity record — the provenance the DormantLink
    // transition is licensed by (D-4).
    await this.portalIdentity.insertNoticeDelivery({
      portal_user_id: target.id,
      notice_version: NOTICE_TEXT_CURRENT_VERSION,
      channel: 'email',
      delivered_at: input.now,
    });

    // Only now: transition PENDING_NOTICE → NOTICED + expires_at (12mo horizon).
    const expiresAt = new Date(input.now);
    expiresAt.setMonth(expiresAt.getMonth() + NOTICE_EXPIRY_MONTHS);
    await this.platformTrust.recordNoticeDelivered({
      id: input.dormantLinkId,
      notice_version: NOTICE_TEXT_CURRENT_VERSION,
      notice_delivered_at: input.now,
      expires_at: expiresAt,
    });

    this.logger.log({
      event: 'dormant_notice_delivered',
      cluster_id: input.clusterId,
      dormant_link_id: input.dormantLinkId,
      notice_version: NOTICE_TEXT_CURRENT_VERSION,
    });
    return { delivered: true };
  }
}
