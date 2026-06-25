import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';

import { loadDnsConfig } from './dns.config.js';
import { DNS_RESOLVER_PORT } from './dns-resolver.port.js';
import { NodeDnsAdapter } from './node-dns.adapter.js';
import { StubDnsAdapter } from './stub-dns.adapter.js';

// Domain-Enforcement P2b §2 — DnsResolverModule: a CLEAN, SINGLE-IMPORT LEAF
// module (the MailerModule shape, verbatim posture).
//
// THE BINDING LESSON (mirrors mailer §3 / the cognito multi-instance fix): this
// module is bound the safe way — PURELY STATICALLY imported, NO forRoot. Under
// NestJS 11's ByReferenceModuleOpaqueKeyFactory the multi-instance collision the
// cognito/financials fixes chased arises ONLY when a module is keyed two ways (a
// static class-import AND a dynamic forRoot object). A pure static leaf is always
// the same class-keyed instance across the graph — there is no second copy for a
// binding to leak across. So DNS_RESOLVER_PORT binds once, here, and every
// importer resolves that one binding. We deliberately do NOT use forRoot.
//
// PROVIDER SELECTION: DNS_RESOLVER_PORT is bound via a useFactory that picks the
// adapter by env (DNS_PROVIDER) — prod => NodeDnsAdapter (real lookups),
// local/dev/test => StubDnsAdapter. loadDnsConfig() fails LOUD on an unset/
// invalid provider, so a misconfig throws at module-binding time rather than
// silently degrading. Both adapters are registered as providers so Nest can
// construct the selected one; construction is side-effect-free (no network at
// build), so eagerly instantiating the unused adapter is harmless.

@Module({
  providers: [
    NodeDnsAdapter,
    StubDnsAdapter,
    {
      provide: 'NodeDnsAdapterLogger',
      useFactory: () => createAramoLogger(NodeDnsAdapter.name),
    },
    {
      provide: 'StubDnsAdapterLogger',
      useFactory: () => createAramoLogger(StubDnsAdapter.name),
    },
    {
      provide: DNS_RESOLVER_PORT,
      useFactory: (node: NodeDnsAdapter, stub: StubDnsAdapter) => {
        // Fails loud on misconfig (unset/invalid provider) — never returns a
        // silently-degraded resolver.
        const { provider } = loadDnsConfig();
        return provider === 'node' ? node : stub;
      },
      inject: [NodeDnsAdapter, StubDnsAdapter],
    },
  ],
  exports: [DNS_RESOLVER_PORT],
})
export class DnsResolverModule {}
