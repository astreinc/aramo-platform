import { Global, Injectable, Module } from '@nestjs/common';
import { PipelineModule, PipelineRepository } from '@aramo/pipeline';
import {
  PIPELINE_SITE_READER,
  type PipelineAuthorizationContext,
  type PipelineSiteReader,
} from '@aramo/submittal';

// INC-1b (TIP-E2E) — composition-root adapter for the submittal PipelineSiteReader
// port. This is the ONLY place the submittal lifecycle authorization is bound to
// @aramo/pipeline; libs/submittal stays decoupled (it depends only on the port
// interface, never on the Pipeline domain). In-process DI seam — the TS interface
// is the contract (no Pact/HTTP). Provided @Global so the SubmittalController (in
// libs/submittal's own module) can inject PIPELINE_SITE_READER, mirroring the
// CompanyClientCheckPort composition (ADR-0032 R7 precedent).
@Injectable()
export class PipelineSiteReaderAdapter implements PipelineSiteReader {
  constructor(private readonly pipelines: PipelineRepository) {}

  async resolveForAuthorization(args: {
    tenant_id: string;
    pipeline_id: string;
  }): Promise<PipelineAuthorizationContext | null> {
    // Authoritative, tenant-scoped Pipeline read. Null (absent / not in tenant) is
    // a fail-closed signal for the caller — never a free pass.
    const p = await this.pipelines.findById({
      tenant_id: args.tenant_id,
      id: args.pipeline_id,
    });
    if (p === null) return null;
    return {
      site_id: p.site_id,
      requisition_id: p.requisition_id,
      talent_record_id: p.talent_record_id,
    };
  }
}

@Global()
@Module({
  imports: [PipelineModule],
  providers: [
    PipelineSiteReaderAdapter,
    { provide: PIPELINE_SITE_READER, useExisting: PipelineSiteReaderAdapter },
  ],
  exports: [PIPELINE_SITE_READER],
})
export class PipelineSiteReaderModule {}
