import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';

import { loadMailerConfig } from './mailer.config.js';
import { MAILER_PORT } from './tokens.js';
import { SesMailerAdapter } from './ses-mailer.adapter.js';
import { SesMailerClientFactory } from './ses-mailer-client.factory.js';
import { StubMailerAdapter } from './stub-mailer.adapter.js';

// Email-S1 §1 / §3 — MailerModule: a CLEAN, SINGLE-IMPORT LEAF module.
//
// THE BINDING LESSON (Email-S1 §3, the cognito multi-instance fix):
// this module is bound the safe way — it is PURELY STATICALLY imported,
// with NO forRoot. Under NestJS 11's ByReferenceModuleOpaqueKeyFactory the
// collision the cognito/financials fixes chased arises ONLY when the same
// module is keyed two ways (a static class-import AND a dynamic forRoot
// object). A pure static leaf is always the same class-keyed instance
// across the whole graph — there is no second copy for a binding to leak
// across. (Same property IdentityCoreModule documents for itself.) So
// MAILER_PORT binds once, here, and every importer resolves that one
// binding. We deliberately do NOT use forRoot.
//
// PROVIDER SELECTION (Email-S1 §4): MAILER_PORT is bound via a useFactory
// that picks the adapter by env (MAILER_PROVIDER) — prod => SesMailerAdapter,
// local/dev/test => StubMailerAdapter. loadMailerConfig() fails LOUD on an
// unset/invalid provider or a SES mode missing SES_FROM_ADDRESS, so a
// misconfig throws at module-binding time rather than silently degrading.
//
// Both adapters are registered as providers so Nest can construct the
// selected one with its deps. Construction is side-effect-free (the SES
// client + its config load are lazy in SesMailerClientFactory), so eagerly
// instantiating the unused adapter touches neither AWS nor SES env.

@Module({
  providers: [
    SesMailerClientFactory,
    SesMailerAdapter,
    StubMailerAdapter,
    {
      provide: 'SesMailerAdapterLogger',
      useFactory: () => createAramoLogger(SesMailerAdapter.name),
    },
    {
      provide: 'StubMailerAdapterLogger',
      useFactory: () => createAramoLogger(StubMailerAdapter.name),
    },
    {
      provide: MAILER_PORT,
      useFactory: (ses: SesMailerAdapter, stub: StubMailerAdapter) => {
        // Fails loud on misconfig (unset/invalid provider, or ses without
        // a from-address) — never returns a silently-degraded mailer.
        const { provider } = loadMailerConfig();
        return provider === 'ses' ? ses : stub;
      },
      inject: [SesMailerAdapter, StubMailerAdapter],
    },
  ],
  exports: [MAILER_PORT],
})
export class MailerModule {}
