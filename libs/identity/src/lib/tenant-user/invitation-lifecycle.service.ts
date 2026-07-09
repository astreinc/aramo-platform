import { Inject, Injectable, Logger } from '@nestjs/common';
import { MAILER_PORT, type MailerPort } from '@aramo/mailer';

import { IdentityService } from '../identity.service.js';
import { TenantService } from '../tenant.service.js';
import {
  SYSTEM_SERVICE_ACCOUNT_ID,
  TENANT_OWNER_ROLE_KEY,
} from '../util/tenant-lifecycle.js';

import {
  loadInviteLinkConfig,
  renderAcceptanceEmail,
} from './invite-emails.js';

// Invite-S2 (Pattern-2) — InvitationLifecycleService.
//
// The home of the PUBLIC acceptance flow (§3). Kept SEPARATE from
// TenantUserLifecycleService because acceptance is reached by an UN-guarded
// public controller (the invitee has no JWT yet) — it must not be entangled
// with the admin invite/disable guard chain or the Cognito/financials ports
// that service holds. It depends only on IdentityService (the identity-writes
// stay in libs/identity) + the S1 MailerPort (the confirmation email).
//
// acceptInvitation does NOT issue a session and does NOT force sign-in: it
// validates the token, flips the membership INVITED → ACCEPTED, sends the
// acceptance-confirmation email, and tells the invitee to sign in when ready.
// Invalid / expired / used / revoked tokens surface as a clear 4xx from
// IdentityService.acceptInvitationByToken (never a 500).
@Injectable()
export class InvitationLifecycleService {
  private readonly logger = new Logger(InvitationLifecycleService.name);

  constructor(
    private readonly identitySvc: IdentityService,
    private readonly tenantSvc: TenantService,
    @Inject(MAILER_PORT) private readonly mailer: MailerPort,
  ) {}

  // The public-endpoint entry point. Returns the accepted state (NO session,
  // NO token) for the controller's 200 body.
  async acceptInvitation(args: {
    raw_token: string;
    request_id: string;
  }): Promise<{ status: 'ACCEPTED'; tenant_id: string }> {
    // Validate + flip INVITED → ACCEPTED (atomic; emits the accepted audit).
    // A bad token throws a 4xx from here — before any email is attempted.
    const ctx = await this.identitySvc.acceptInvitationByToken({
      raw_token: args.raw_token,
      request_id: args.request_id,
    });

    // Platform-Console Increment-2 PR-1 (workstream D, R9) — inline tenant
    // activation. Transaction boundary: POST-COMMIT + idempotent + best-effort,
    // mirroring the confirmation-email seam below (the accept already committed;
    // the activation must never fail the acceptance). No event bus exists for
    // identity audit events (R9), so this is a direct in-process call, not a
    // subscriber. Fires ONLY for a tenant_owner acceptance (R10 discriminator);
    // transitionTenantStatus itself is the idempotency gate — it activates only
    // PROVISIONED→ACTIVE and no-ops when the tenant is already ACTIVE (re-accept
    // race / non-first owner). Because acceptance is pre-authentication (recon
    // finding 1), this completes before the owner's first login, so the mint
    // gate never sees the owner blocked.
    if (ctx.role_keys.includes(TENANT_OWNER_ROLE_KEY)) {
      try {
        await this.tenantSvc.transitionTenantStatus({
          tenant_id: ctx.tenant_id,
          to: 'ACTIVE',
          actor_id: SYSTEM_SERVICE_ACCOUNT_ID,
          actor_type: 'system',
          source: 'invitation_acceptance',
          request_id: args.request_id,
          related: {
            membershipId: ctx.membership_id,
            invitationId: ctx.invitation_id,
          },
        });
      } catch (err) {
        this.logger.warn(
          `invitation accept — tenant activation failed (acceptance committed; tenant stays PROVISIONED, mint-gate allows it): ${(err as Error).message}`,
        );
      }
    }

    // Send the acceptance-confirmation email (no token — just a sign-in
    // pointer). BEST-EFFORT: the acceptance already committed, so a send
    // failure must not fail the request (it logs LOUD; the stub mailer warns
    // when no real email is sent).
    try {
      const tenantLabel = ctx.tenant_display_name ?? ctx.tenant_name;
      const { signInUrl } = loadInviteLinkConfig();
      const email = renderAcceptanceEmail({ tenantLabel, signInUrl });
      if (ctx.email.length > 0) {
        await this.mailer.send({
          to: ctx.email,
          subject: email.subject,
          html: email.html,
          text: email.text,
        });
      }
    } catch (err) {
      this.logger.warn(
        `invitation accept — confirmation email send failed (acceptance committed): ${(err as Error).message}`,
      );
    }

    return { status: 'ACCEPTED', tenant_id: ctx.tenant_id };
  }
}
