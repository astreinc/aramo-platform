import { Module } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { PlacementOutboxRepository } from './placement-outbox.repository.js';

// Track 3 / E1-c — the placement schema's outbox module, imported by
// libs/outbox-publisher so the publisher can drain placement.OutboxEvent (house
// pattern; mirrors EngagementModule exporting EngagementOutboxRepository). A
// FORWARD edge only — placement does not import outbox-publisher.
@Module({
  providers: [PrismaService, PlacementOutboxRepository],
  exports: [PlacementOutboxRepository],
})
export class PlacementOutboxModule {}
