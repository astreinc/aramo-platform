import { Injectable } from '@nestjs/common';
import { ConsentRepository } from '@aramo/consent';
import { TalentRecordRepository } from '@aramo/talent-record';
import type {
  AuthorizedTalentRecord,
  AuthorizedTalentRetrievalReadPort,
} from '@aramo/talent-intelligence';

// TIP-E2E INC-2 — AuthorizedTalentRetrievalReadAdapter (apps/api composition root).
// Pool-open tenant-scoped Talent retrieval with ADAPTER-ENFORCED do_not_contact
// suppression (Correction A) applied BEFORE returning. Reuses the consent
// authority's contactability outcome — no new consent operation, no duplicated
// policy. Required DI (no @Optional, no silent fallback). Projection limited to the
// existing consumer's fields; NOT a general raw-PII interface.
@Injectable()
export class AuthorizedTalentRetrievalReadAdapter
  implements AuthorizedTalentRetrievalReadPort
{
  constructor(
    private readonly talent: TalentRecordRepository,
    private readonly consent: ConsentRepository,
  ) {}

  async getTalent(input: {
    tenant_id: string;
    talent_id: string;
  }): Promise<AuthorizedTalentRecord | null> {
    const v = await this.talent.findById({ tenant_id: input.tenant_id, id: input.talent_id });
    if (v === null) return null;
    // Correction A — authoritative contactability; fail-closed default do_not_contact.
    // Suppress contact channels iff do_not_contact (the pipeline-talent-enrichment
    // rule). Non-contact attributes below are governed by talent:read, NOT by this.
    const summary = await this.consent.findContactingConsentSummaryForTalentIds({
      tenant_id: input.tenant_id,
      talent_record_ids: [input.talent_id],
    });
    const suppress = (summary.get(input.talent_id) ?? 'do_not_contact') === 'do_not_contact';
    return {
      id: v.id,
      first_name: v.first_name,
      last_name: v.last_name,
      title: v.title,
      city: v.city,
      state: v.state,
      email1: suppress ? null : v.email1,
      phone_cell: suppress ? null : v.phone_cell,
      work_authorization: v.work_authorization ?? null,
      desired_pay: v.desired_pay,
      current_pay: v.current_pay,
      engagement_type: v.engagement_type ?? null,
      availability_status: v.availability_status ?? null,
      date_available: v.date_available,
      key_skills: v.key_skills,
      source: v.source,
      owner_id: v.owner_id,
      created_at: v.created_at,
      recruiting_ready: v.recruiting_ready ?? false,
      record_status: v.record_status === 'superseded' ? 'superseded' : 'live',
      superseded_by_record_id: v.superseded_by_record_id ?? null,
      contactable: !suppress,
    };
  }
}
