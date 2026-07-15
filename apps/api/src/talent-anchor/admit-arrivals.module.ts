import { Module } from '@nestjs/common';
import { IdentityIndexModule } from '@aramo/identity-index';
import { SourcedTalentModule } from '@aramo/sourced-talent';

import { AdmitArrivalsService } from './admit-arrivals.service.js';

// TR-2b B2b (Directive §PR-2.2) — the narrow context module for the admit-arrivals
// backfill CLI + its integration spec. Imports only the two stores the admission
// touches (L1 sourced_talent + the PII-free identity index), so the CLI boots a
// minimal graph (not the whole AppModule). apps/api is untagged — no nx edge.
@Module({
  imports: [IdentityIndexModule, SourcedTalentModule],
  providers: [AdmitArrivalsService],
  exports: [AdmitArrivalsService],
})
export class AdmitArrivalsModule {}
