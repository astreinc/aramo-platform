import { Module } from '@nestjs/common';

import { RtrQualifiedTransitionGuardModule } from './rtr/rtr-qualified-transition-guard.module.js';
import { TechnicalScreeningApiModule } from './technical-screening/technical-screening-api.module.js';

// Talent Lifecycle R1–R5 Impl Directive v1.2 §4.5 — this process's module graph contains
// PipelineRepository (via MicrosoftModule), so the MANDATORY RTR guard is bound here too:
// no process that can run a Pipeline transition may lack it (an unbound guard refuses
// `qualified`). A process-local root keeps TechnicalScreeningApiModule itself unchanged.
@Module({ imports: [TechnicalScreeningApiModule, RtrQualifiedTransitionGuardModule] })
export class ScreeningPublicationRedriveModule {}
