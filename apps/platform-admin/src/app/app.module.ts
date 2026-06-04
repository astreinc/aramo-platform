import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CommonModule, RequestIdMiddleware } from '@aramo/common';

import { PlatformModule } from './platform/platform.module.js';

@Module({
  imports: [CommonModule, PlatformModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
