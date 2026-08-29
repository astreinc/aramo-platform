import { Module } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { ClientSelectionOutboxRepository } from './client-selection-outbox.repository.js';

// Lane 2 / L2-F (F1) — the client_selection schema's outbox module, imported by
// libs/outbox-publisher so the publisher can drain client_selection.OutboxEvent (the
// 7th namespace; mirrors PipelineOutboxModule). FORWARD edge only — client-selection
// does not import outbox-publisher.
@Module({
  providers: [PrismaService, ClientSelectionOutboxRepository],
  exports: [ClientSelectionOutboxRepository],
})
export class ClientSelectionOutboxModule {}
