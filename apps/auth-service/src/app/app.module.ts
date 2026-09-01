import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CommonModule, RequestIdMiddleware } from '@aramo/common';
import { PORTAL_SESSION_SCOPES } from '@aramo/auth-core';
import { AuthorizationResolverModule } from '@aramo/identity';

import { AuthServiceModule } from './auth/auth.module.js';

@Module({
  imports: [
    CommonModule,
    // HF-AUTH-1 — @Global resolver binding so /session (auth.controller) can
    // resolve the compact cookie's effective scopes server-side (portal fixed
    // set, stale/fail-closed identical to the api guard).
    AuthorizationResolverModule.forRoot({
      portalScopes: PORTAL_SESSION_SCOPES,
      scopeCacheTtlSeconds: 300,
    }),
    AuthServiceModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
