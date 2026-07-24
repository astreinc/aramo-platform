import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app/app.module.js';
import { IntakeExceptionFilter } from './app/intake/intake-exception.filter.js';

// PUB-5 intake handler — a standalone NestJS service colocated on the public
// host (compose-network only; nginx proxies /intake/). ZERO @aramo/* imports.
// The email is the record — no database, no persistence.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      errorHttpStatusCode: 422,
    }),
  );
  app.useGlobalFilters(new IntakeExceptionFilter());
  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
