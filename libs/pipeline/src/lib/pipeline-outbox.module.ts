import { Module } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { PipelineOutboxRepository } from './pipeline-outbox.repository.js';

// Lane 2 / L2-B — the pipeline schema's outbox module, imported by
// libs/outbox-publisher so the publisher can drain pipeline.OutboxEvent (house
// pattern; mirrors PlacementOutboxModule / SelectionModule exporting their outbox
// repository). A FORWARD edge only — pipeline does not import outbox-publisher.
@Module({
  providers: [PrismaService, PipelineOutboxRepository],
  exports: [PipelineOutboxRepository],
})
export class PipelineOutboxModule {}
