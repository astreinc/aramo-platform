import { Injectable } from '@nestjs/common';
import { TalentRecordRepository } from '@aramo/talent-record';
import { TalentEvidenceRepository } from '@aramo/talent-evidence';

import type { TalentEmbeddingFactsPort } from './talent-embedding-facts.port.js';
import type { TalentSemanticFacts } from './talent-semantic-document.js';

// Enterprise Search GS-2A — the concrete facts loader for the Talent embedding pipeline. Composes
// the authoritative recruiting facts from two owning libs: TalentRecord (title/key_skills/
// current_employer/city/state) + authoritative TalentWorkHistoryEntry (role_title/employer_name/
// experience_summary/location). Returns null when the Talent is NOT a live embeddable subject
// (not found OR record_status != 'live' — superseded/erased) so the worker invalidates any stale
// vector. This is the ONLY place the two schemas are joined; the pure P3 projection turns the
// returned facts into the deterministic, PII-minimized semantic document.
@Injectable()
export class TalentEmbeddingFactsAdapter implements TalentEmbeddingFactsPort {
  constructor(
    private readonly talentRecords: TalentRecordRepository,
    private readonly evidence: TalentEvidenceRepository,
  ) {}

  async load(input: {
    tenant_id: string;
    talent_record_id: string;
  }): Promise<TalentSemanticFacts | null> {
    const record = await this.talentRecords.findById({
      tenant_id: input.tenant_id,
      id: input.talent_record_id,
    });
    // Live subjects only — a superseded/erased/absent record yields null → invalidation.
    if (record === null || record.record_status !== 'live') return null;

    const workHistory = await this.evidence.findAuthoritativeWorkHistoryForEmbedding({
      tenant_id: input.tenant_id,
      talent_id: input.talent_record_id,
    });

    return {
      title: record.title,
      key_skills: record.key_skills,
      current_employer: record.current_employer,
      city: record.city,
      state: record.state,
      work_history: workHistory.map((w) => ({
        role_title: w.role_title,
        employer_name: w.employer_name,
        experience_summary: w.experience_summary,
        location: w.location,
        start_date: w.start_date === null ? null : w.start_date.toISOString(),
        id: w.id,
      })),
    };
  }
}
