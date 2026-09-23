import { Injectable } from '@nestjs/common';
import { TalentRecordRepository } from '@aramo/talent-record';

import {
  TalentEmailUnavailableError,
  type EmailRecipientResolver,
  type ResolveRecipientRequest,
} from './email-recipient-resolver.port.js';

// COMM-C4 (RCE-1) — resolves the authoritative requisition-contact recipient
// from the live TalentRecord. `findContactByIds` is tenant-scoped and filters
// record_status='live', so a cross-tenant or absent Talent yields no entry and
// this fails closed with TalentEmailUnavailableError (no client-supplied address
// can substitute).
@Injectable()
export class TalentEmailRecipientAdapter implements EmailRecipientResolver {
  constructor(private readonly talents: TalentRecordRepository) {}

  async resolveRecipientEmail(req: ResolveRecipientRequest): Promise<string> {
    const contacts = await this.talents.findContactByIds(req.tenant_id, [req.talent_record_id]);
    const email = contacts.get(req.talent_record_id)?.email ?? null;
    if (email === null || email.length === 0) {
      throw new TalentEmailUnavailableError(req.talent_record_id);
    }
    return email;
  }
}
