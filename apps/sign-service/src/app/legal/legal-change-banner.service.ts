import { Inject, Injectable, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { TenantRepository } from '@aramo/identity';
import {
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_REGISTRY,
  LegalChangeNoticeRepository,
  StaticUpcomingLegalChangeSource,
  UPCOMING_LEGAL_CHANGE_SOURCE,
  upcomingLegalNotices,
  type LegalDocumentVersion,
  type UpcomingLegalChangeSource,
  type UpcomingLegalNotice,
} from '@aramo/subscription';

// Privacy Notice 1.1 remediation E-6 — the in-service channel of the account-holder notice: the
// Sign workspace banner for an upcoming legal-document version with a future effective date.
//
//   notices(tenant, user)   the upcoming changes that concern this account (a Personal-only
//                           document is not shown to a Business account), minus those this user
//                           has dismissed.
//   record(…, SHOWN)        the banner was displayed: the in-service delivery is recorded once
//                           (channel IN_SERVICE, status SENT, first-shown time).
//   record(…, ACKNOWLEDGED) the user dismissed it: the acknowledgement time is recorded once and
//                           the banner stops showing for that version.
//
// The list of upcoming changes comes from UPCOMING_LEGAL_CHANGE_SOURCE (default: the governed,
// empty UPCOMING_LEGAL_CHANGES list — nothing shows until a reviewed change announces a version).
// The future-effective legal-version resolver (E-5) is meant to bind that token.

export type LegalNoticeEvent = 'SHOWN' | 'ACKNOWLEDGED';

@Injectable()
export class LegalChangeBannerService {
  private readonly source: UpcomingLegalChangeSource;
  private readonly legal: readonly LegalDocumentVersion[];

  constructor(
    private readonly evidence: LegalChangeNoticeRepository,
    private readonly tenants: TenantRepository,
    @Optional() @Inject(UPCOMING_LEGAL_CHANGE_SOURCE) source?: UpcomingLegalChangeSource,
    @Optional() @Inject(LEGAL_DOCUMENT_REGISTRY) legal?: readonly LegalDocumentVersion[],
  ) {
    this.source = source ?? new StaticUpcomingLegalChangeSource();
    this.legal = legal ?? LEGAL_DOCUMENTS;
  }

  private async upcomingFor(tenant_id: string, now: Date): Promise<UpcomingLegalNotice[]> {
    const tenant = await this.tenants.findById(tenant_id);
    if (tenant === null) return [];
    return upcomingLegalNotices(this.source, tenant.kind, now, this.legal);
  }

  /** The upcoming changes this user has not dismissed. */
  async notices(tenant_id: string, user_id: string, now: Date = new Date()): Promise<UpcomingLegalNotice[]> {
    const upcoming = await this.upcomingFor(tenant_id, now);
    if (upcoming.length === 0) return [];
    const done = await this.evidence.acknowledgedInService(
      user_id,
      upcoming.map((n) => ({ document_key: n.key, version: n.version })),
    );
    return upcoming.filter((n) => !done.has(`${n.key}@${n.version}`));
  }

  /** Record that the banner for one upcoming change was shown to, or dismissed by, this user. */
  async record(tenant_id: string, user_id: string, body: unknown, requestId: string, now: Date = new Date()): Promise<UpcomingLegalNotice[]> {
    const b = body as { key?: unknown; version?: unknown; event?: unknown } | null;
    if (
      b === null ||
      typeof b !== 'object' ||
      typeof b.key !== 'string' ||
      typeof b.version !== 'string' ||
      (b.event !== 'SHOWN' && b.event !== 'ACKNOWLEDGED') ||
      b.key.length > 100 ||
      b.version.length > 20
    ) {
      throw new AramoError('VALIDATION_ERROR', 'Name the notice (key, version) and the event (SHOWN or ACKNOWLEDGED)', 400, {
        requestId,
        details: { field: 'event' },
      });
    }
    const notice = (await this.upcomingFor(tenant_id, now)).find((n) => n.key === b.key && n.version === b.version);
    if (notice === undefined) {
      throw new AramoError('VALIDATION_ERROR', 'There is no upcoming change to this document for your account', 400, {
        requestId,
        details: { reason: 'legal_notice_not_upcoming', key: b.key },
      });
    }
    await this.evidence.recordInService(
      { document_key: notice.key, version: notice.version, effective_date: notice.effective_date, user_id, tenant_id, event: b.event },
      now,
    );
    return this.notices(tenant_id, user_id, now);
  }
}
