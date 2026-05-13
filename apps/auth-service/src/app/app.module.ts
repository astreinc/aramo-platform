import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CommonModule, RequestIdMiddleware } from '@aramo/common';

import { AuthServiceModule } from './auth/auth.module.js';

@Module({
  imports: [CommonModule, AuthServiceModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
