// Workspace-root Prisma config (Prisma 7+).
//
// Prisma 7 removed the `url = env("DATABASE_URL")` property from
// schema.prisma datasource blocks. Connection URLs for `prisma migrate`
// must be supplied via prisma.config.ts. The PrismaClient runtime
// receives its URL from the Nest module wiring (PrismaService) — this
// config file is consulted only by the `prisma` CLI.
//
// PR-2 precedent: this config currently points at the consent module
// because consent is the only module with models in PR-2. The other
// three module schemas (libs/audit, libs/auth, libs/common) remain
// stub-only and do not need migrations yet.
//
// When a future PR introduces models in another lib, the config will
// need to evolve — see "precedent reflection" in the PR-2 report-back
// for options (per-lib prisma.config.ts files vs a multi-schema config
// vs a CLI flag flip per command).

import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'libs/consent/prisma/schema.prisma',
  migrations: {
    path: 'libs/consent/prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});
