import { Module } from '@nestjs/common';

import { RolesGuard } from './roles.guard.js';

// AuthorizationModule — providers for the @RequireScopes / @RequireSiteMatch
// guard surface. Imported by apps/api AppModule (consumer-side) so the
// RolesGuard provider is available to controllers that wire it via
// @UseGuards(JwtAuthGuard, RolesGuard).
//
// No exports of AuthN; libs/auth remains the canonical AuthN owner.
@Module({
  providers: [RolesGuard],
  exports: [RolesGuard],
})
export class AuthorizationModule {}
