import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { IdentityRepository } from '@aramo/identity';
import { MAILER_PORT, type MailerPort, loadMailerConfig } from '@aramo/mailer';
import { DEFAULT_SIGN_BASE_URL, signBaseUrl } from '@aramo/sign';
import {
  RenewalNoticeRepository,
  RenewalNoticeService,
  renewalNoticeLeadDays,
  renewalNoticesEnabled,
  type RenewalNoticeRecipientPort,
  type RenewalNoticeRunCounts,
} from '@aramo/subscription';

// Aramo Sign Remaining-Work Consolidated Directive v1.0 (LOCKED, 32e5e3e1) A3 — the Aramo renewal
// notice job: once an hour, an email to the subscribing owner of each open self-service Sign
// subscription whose 12-month commitment ends within SIGN_RENEWAL_NOTICE_DAYS (default 30), saying
// it then continues month to month at the monthly price, how to cancel (the billing settings link)
// and when a cancellation takes effect (ToS v2.0 B5.1). One notice per subscription and commitment
// end (subscription."RenewalNoticeDelivery"); see libs/subscription renewal-notice.ts.
//
// OFF BY DEFAULT: scheduled only when SIGN_RENEWAL_NOTICES_ENABLED=1 (separate PO authorization;
// the wording goes to counsel first). The same plain interval pattern as the other sign-service
// workers; a `busy` latch stops a slow run from overlapping itself, and the evidence table's unique
// claim keeps two processes from sending the same notice. A failing run logs and waits for the next.

export const SIGN_RENEWAL_NOTICE_INTERVAL_MS = 3_600_000;

/** The interval, or null when the job is off. */
export function signRenewalNoticeInterval(env: NodeJS.ProcessEnv = process.env): number | null {
  return renewalNoticesEnabled(env) ? SIGN_RENEWAL_NOTICE_INTERVAL_MS : null;
}

/**
 * The notice goes to the owner who subscribed (TenantSubscription.activated_by) while that user is
 * active, else to the tenant's current owner; nobody else. Null: no recipient (recorded SUPPRESSED).
 */
@Injectable()
export class SignRenewalNoticeRecipients implements RenewalNoticeRecipientPort {
  constructor(private readonly identity: IdentityRepository) {}

  async recipientFor(args: { tenant_id: string; activated_by: string | null; tenant_kind: string }): Promise<{ email: string } | null> {
    if (args.activated_by !== null) {
      const user = await this.identity.findUserById(args.activated_by);
      if (user !== null && user.is_active && user.deactivated_at === null) {
        const member = await this.identity.findMembership({ user_id: user.id, tenant_id: args.tenant_id });
        if (member !== null && member.is_active) return { email: user.email };
      }
    }
    const owner = await this.identity.findTenantOwner(args.tenant_id);
    return owner === null ? null : { email: owner.email };
  }
}

@Injectable()
export class SignRenewalNoticeWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(SignRenewalNoticeWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly store: RenewalNoticeRepository,
    private readonly recipients: SignRenewalNoticeRecipients,
    @Inject(MAILER_PORT) private readonly mailer: MailerPort,
  ) {}

  /** True once the interval is scheduled (only when enabled). */
  get scheduled(): boolean {
    return this.timer !== null;
  }

  onApplicationBootstrap(): void {
    const interval = signRenewalNoticeInterval();
    if (interval === null) return;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
    this.log.log(`renewal notices enabled (${renewalNoticeLeadDays()} days before the commitment end)`);
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One run. Public so tests drive it deterministically. */
  async tick(now?: () => Date): Promise<RenewalNoticeRunCounts | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const service = new RenewalNoticeService({
        store: this.store,
        recipients: this.recipients,
        mailer: this.mailer,
        provider: loadMailerConfig().provider,
        settings_base_url: signBaseUrl() ?? DEFAULT_SIGN_BASE_URL,
        lead_days: renewalNoticeLeadDays(),
        ...(now !== undefined ? { now } : {}),
      });
      const r = await service.run();
      if (r.due > 0) this.log.log(`renewal notices: ${r.due} due (sent ${r.sent}, failed ${r.failed}, suppressed ${r.suppressed}, done ${r.already_done}, in doubt ${r.in_doubt})`);
      return r;
    } catch (err) {
      this.log.error(`renewal notice run failed: ${(err as Error).message}`);
      return null;
    } finally {
      this.busy = false;
    }
  }
}
