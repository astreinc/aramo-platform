import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  // Local default; production deployments must set PORT explicitly.
  const port = process.env.PORT ?? 3000;
  const app = await NestFactory.create(AppModule);
  Logger.log('aramo-core api starting', 'Bootstrap');
  await app.listen(port);
}

void bootstrap();
