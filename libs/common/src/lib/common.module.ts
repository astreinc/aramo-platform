import { Module } from '@nestjs/common';

import { RequestIdMiddleware } from './middleware/request-id.middleware.js';

@Module({
  providers: [RequestIdMiddleware],
  exports: [RequestIdMiddleware],
})
export class CommonModule {}
