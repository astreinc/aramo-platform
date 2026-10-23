import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { TalentRecordRepository } from '@aramo/talent-record';
import {
  TechnicalScreeningService,
  type ScreeningPublicationRow,
  type ScreeningSessionRow,
} from '@aramo/technical-screening';

// TIP-E2E INC-3 — row-level access for the screening routes
// (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §8). The acting tenant comes ONLY from the
// verified auth context. A talent record (or session) that is absent, owned by
// another tenant, or outside a site-scoped actor's site is the SAME 404
// NOT_FOUND — the existing pool-open tenant+site contract, never broadened.
// Site checks use the CURRENT TalentRecord's site (§10.3), so a merge re-key is
// honoured at access time.

export interface AccessibleTalent {
  id: string;
  site_id: string | null;
  record_status: string;
}

@Injectable()
export class ScreeningAccessService {
  constructor(
    private readonly talentRecords: TalentRecordRepository,
    private readonly screening: TechnicalScreeningService,
  ) {}

  assertRecruiter(auth: AuthContextType, requestId: string): void {
    if (auth.consumer_type !== 'recruiter') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'technical screening is recruiter-only', 403, {
        requestId,
        details: { consumer_type: auth.consumer_type },
      });
    }
  }

  async talentFor(auth: AuthContextType, talentRecordId: string, requestId: string): Promise<AccessibleTalent> {
    const record = await this.talentRecords.findById({ tenant_id: auth.tenant_id, id: talentRecordId });
    if (record === null || !siteVisible(auth, record.site_id)) throw notFound(requestId);
    return { id: record.id, site_id: record.site_id, record_status: record.record_status ?? 'live' };
  }

  assertLive(talent: AccessibleTalent, requestId: string): void {
    if (talent.record_status !== 'live') {
      throw new AramoError(
        'TALENT_RECORD_SUPERSEDED',
        `talent record ${talent.id} is ${talent.record_status}`,
        422,
        { requestId },
      );
    }
  }

  // Session → its CURRENT talent record → tenant + site check (404 concealment).
  async sessionFor(
    auth: AuthContextType,
    sessionId: string,
    requestId: string,
  ): Promise<{ session: ScreeningSessionRow; talent: AccessibleTalent }> {
    const session = await this.screening.findSession(auth.tenant_id, sessionId);
    if (session === null) throw notFound(requestId);
    const talent = await this.talentFor(auth, session.talent_record_id, requestId);
    return { session, talent };
  }

  // The publication's status label (directive §5), derived from the ATS-local
  // ScreeningPublication state alone — ATI-SEP-1 T10 WP1: no trust-ledger read.
  // PUBLISHED → 'VALID' (the "Published" label); anything else → null (the UI
  // labels PENDING / FAILED / CONFLICT from `state`). The response shape is
  // unchanged.
  trustStatuses(publications: ScreeningPublicationRow[]): Map<string, string | null> {
    const out = new Map<string, string | null>();
    for (const p of publications) out.set(p.id, p.state === 'PUBLISHED' ? 'VALID' : null);
    return out;
  }
}

function siteVisible(auth: AuthContextType, recordSiteId: string | null): boolean {
  if (auth.site_id === undefined || auth.site_id === null) return true; // tenant-wide principal
  return recordSiteId === null || recordSiteId === auth.site_id;
}

function notFound(requestId: string): AramoError {
  return new AramoError('NOT_FOUND', 'not found', 404, { requestId });
}
