import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';

import { ConversationIntelligenceModule } from '../lib/conversation-intelligence.module.js';
import { RequisitionAnalysisContextSnapshotService } from '../lib/requisition-analysis-context-snapshot.service.js';
import { REQUISITION_ANALYSIS_CONTEXT_READER } from '../lib/reader/requisition-analysis-context-reader.js';
import { RequisitionGoldenProfileContextReader } from '../lib/reader/requisition-golden-profile-context.reader.js';

// CI-B2 wiring — the module DI graph resolves without a database
// connection (the per-lib PrismaServices are lazy — no $connect at
// construction). Proves the reader token binds to the concrete adapter
// and the exported service resolves with its cross-lib read dependencies.
describe('ConversationIntelligenceModule wiring', () => {
  it('compiles and resolves the snapshot service + bound reader adapter', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConversationIntelligenceModule],
    }).compile();

    const service = moduleRef.get(RequisitionAnalysisContextSnapshotService);
    expect(service).toBeInstanceOf(RequisitionAnalysisContextSnapshotService);

    const reader = moduleRef.get(REQUISITION_ANALYSIS_CONTEXT_READER);
    expect(reader).toBeInstanceOf(RequisitionGoldenProfileContextReader);

    await moduleRef.close();
  });
});
