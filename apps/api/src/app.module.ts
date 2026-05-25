import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CommonModule, RequestIdMiddleware } from '@aramo/common';
import { AuthModule } from '@aramo/auth';
import { ConsentModule } from '@aramo/consent';
import { EngagementModule } from '@aramo/engagement';
import { IngestionModule } from '@aramo/ingestion';
import { MatchingModule } from '@aramo/matching';
import { PortalModule } from '@aramo/portal';
import { SubmittalModule } from '@aramo/submittal';

@Module({
  imports: [
    CommonModule,
    AuthModule,
    ConsentModule,
    EngagementModule,
    IngestionModule,
    MatchingModule,
    PortalModule,
    SubmittalModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // PR-2 precedent: RequestIdMiddleware applies to every route. Future
    // PRs do not need to re-wire it for new endpoints.
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
