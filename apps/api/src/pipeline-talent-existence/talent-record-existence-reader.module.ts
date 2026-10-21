import { Global, Injectable, Module } from '@nestjs/common';
import {
  TALENT_RECORD_EXISTENCE_READER,
  type TalentRecordExistenceReaderPort,
} from '@aramo/pipeline';
import { TalentRecordModule, TalentRecordRepository } from '@aramo/talent-record';

// Lane2-DDR §0/§6 — the composition-root adapter for the Pipeline
// TALENT_RECORD_EXISTENCE_READER port. This is the ONLY place the Pipeline's Add-Talent
// precondition is joined to talent-record truth; libs/pipeline depends solely on the port
// interface (no new nx edge). @Global so the PipelineController (in its own module) can
// inject the STRING token. Reads the id only — never the PII record.
@Injectable()
export class TalentRecordExistenceReaderAdapter implements TalentRecordExistenceReaderPort {
  constructor(private readonly talentRecords: TalentRecordRepository) {}

  existsInTenant(input: { tenant_id: string; talent_record_id: string }): Promise<boolean> {
    return this.talentRecords.existsInTenant({
      tenant_id: input.tenant_id,
      id: input.talent_record_id,
    });
  }
}

@Global()
@Module({
  imports: [TalentRecordModule],
  providers: [
    TalentRecordExistenceReaderAdapter,
    { provide: TALENT_RECORD_EXISTENCE_READER, useExisting: TalentRecordExistenceReaderAdapter },
  ],
  exports: [TALENT_RECORD_EXISTENCE_READER],
})
export class TalentRecordExistenceReaderModule {}
