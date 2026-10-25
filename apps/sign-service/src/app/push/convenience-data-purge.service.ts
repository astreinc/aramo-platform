import { Injectable, Logger } from '@nestjs/common';
import { SignNotificationRepository, type PurgeCounts } from '@aramo/sign';

// Aramo Sign Mobile — M-A3 §9 (correction 6): closing an account revokes every push
// device of the user and deletes their notification convenience data (devices and
// token material, the feed, preferences). It runs right after the close commits (the
// close lives in the identity schema, this data in sign), and the close route runs it
// again on every repeat, so a failed first run is completed by an idempotent retry.
// Each run is audited in SignConvenienceDataPurge with counts only.
// Signing evidence (the ledger, executed documents, certificates, legal acceptances)
// is NOT touched.

export const ACCOUNT_CLOSE_PURGE_REASON = 'account_closed';

@Injectable()
export class ConvenienceDataPurgeService {
  private readonly log = new Logger('ConvenienceDataPurge');

  constructor(private readonly repo: SignNotificationRepository) {}

  async purgeForAccountClose(owner: { tenant_id: string; user_id: string }): Promise<PurgeCounts | null> {
    try {
      return await this.repo.purgeOwner(owner, ACCOUNT_CLOSE_PURGE_REASON);
    } catch (err) {
      // Never fail the close itself; the next close request (idempotent) retries.
      this.log.warn(`convenience-data purge after account close failed: ${(err as Error).name}`);
      return null;
    }
  }
}
