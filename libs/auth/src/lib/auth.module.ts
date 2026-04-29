import { Module } from '@nestjs/common';

import { JwtAuthGuard } from './jwt-auth.guard.js';

@Module({
  providers: [JwtAuthGuard],
  exports: [JwtAuthGuard],
})
export class AuthModule {}
