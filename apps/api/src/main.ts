import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const port = process.env['PORT'] ?? 3000;
  const app = await NestFactory.create(AppModule);
  // class-validator at the controller boundary. whitelist+forbidNonWhitelisted
  // enforces the OpenAPI `additionalProperties: false` contract for every DTO.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  Logger.log('aramo-core api starting', 'Bootstrap');
  await app.listen(port);
}

void bootstrap();
