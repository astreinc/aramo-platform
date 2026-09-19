import { Global, Injectable, Module } from '@nestjs/common';
import { TalentEvidenceModule, TalentEvidenceRepository } from '@aramo/talent-evidence';
import {
  RESUME_EDITION_READER,
  type ResumeEditionReaderPort,
  type ResumeEditionSummary,
} from '@aramo/pipeline';

// TALENT-INTEL-1 TI-1D-D — the composition-root adapter for the Pipeline
// RESUME_EDITION_READER port. This is the ONLY place the (scope:ats) Pipeline is
// joined to (scope:cip) talent-evidence; libs/pipeline depends solely on the port
// interface (no nx cycle, no cross-scope module edge). @Global so the
// PipelineController (in its own module) can inject the STRING token. It reads the
// TI-1D-C edition projection (which already computes is_default) and maps it to the
// port's ResumeEditionSummary — NO résumé text, NO evidence payload.
@Injectable()
export class ResumeEditionReaderAdapter implements ResumeEditionReaderPort {
  constructor(private readonly evidence: TalentEvidenceRepository) {}

  async listResumeEditions(input: {
    tenant_id: string;
    talent_id: string;
  }): Promise<ResumeEditionSummary[]> {
    const rows = await this.evidence.findResumeEditionsWithDocumentByTalent({
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
    });
    return rows.map((r) => ({
      edition_id: r.id,
      lifecycle_status: r.lifecycle_status,
      is_default: r.is_default,
      purpose: r.purpose,
      label: r.label,
      filename: r.document_filename,
      mime_type: r.document_mime_type,
      created_at: r.created_at.toISOString(),
    }));
  }
}

@Global()
@Module({
  imports: [TalentEvidenceModule],
  providers: [
    ResumeEditionReaderAdapter,
    { provide: RESUME_EDITION_READER, useExisting: ResumeEditionReaderAdapter },
  ],
  exports: [RESUME_EDITION_READER],
})
export class ResumeEditionReaderModule {}
