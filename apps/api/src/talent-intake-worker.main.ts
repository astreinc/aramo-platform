import { NestFactory } from '@nestjs/core';
import { createAramoLogger } from '@aramo/common';

import { TalentIntakeWorkerModule } from './talent-intake-consumer/talent-intake-worker.module.js';

// ADR-0033 / single-box — entrypoint for the `talent-intake-worker` container.
// Runs the lease-safe Talent Intake outbox drain with the REAL application DI
// graph for this path, WITHOUT an HTTP server and without the other API
// background workers. Same production image as the API (aramo-api:<sha>),
// different command. Transport is config-driven (TALENT_INTAKE_TRANSPORT); on the
// single box it is `singlebox` (in-process delivery to TalentIntakeMessageHandler).
async function bootstrap(): Promise<void> {
  const logger = createAramoLogger('TalentIntakeWorker');
  const app = await NestFactory.createApplicationContext(TalentIntakeWorkerModule, {
    bufferLogs: false,
  });
  app.enableShutdownHooks();

  // The drain's own interval is unref'd (so it never blocks test/API shutdown);
  // this ref'd keep-alive is the worker process's reason to stay running. Cleared
  // on shutdown so the process can exit cleanly.
  const keepAlive = setInterval(() => undefined, 1 << 30);

  logger.log({ event: 'talent_intake_worker_started' });

  const shutdown = async (signal: string): Promise<void> => {
    logger.log({ event: 'talent_intake_worker_shutdown', signal });
    clearInterval(keepAlive);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('talent-intake-worker failed to start', err);
  process.exit(1);
});
