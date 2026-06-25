import 'reflect-metadata';
import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DnsResolverModule } from '../lib/dns/dns-resolver.module.js';
import { DNS_RESOLVER_PORT } from '../lib/dns/dns-resolver.port.js';
import { NodeDnsAdapter } from '../lib/dns/node-dns.adapter.js';
import { StubDnsAdapter } from '../lib/dns/stub-dns.adapter.js';
import type { DnsResolverPort } from '../lib/dns/dns-resolver.port.js';

// Domain-Enforcement P2b §2 — the committed DI resolution proof for
// DNS_RESOLVER_PORT (the standing lesson: every new port gets one).
//
// Mirrors the mailer/cognito/financials binding DI specs: boot the REAL module
// graph and assert what the token resolves to. What this proves:
//   1. PROD graph (DNS_PROVIDER=node) → DNS_RESOLVER_PORT resolves the REAL
//      NodeDnsAdapter, NOT the stub.
//   2. Non-prod (DNS_PROVIDER=stub) → resolves the StubDnsAdapter.
//   3. Fail-LOUD: an unset provider and an invalid provider each throw at
//      module-binding time — never a silent degrade.
//   4. MULTI-INSTANCE IMMUNITY (the cognito bug cannot recur): DnsResolverModule
//      is a pure static leaf (no forRoot), so a nested consumer resolves the
//      SAME DNS_RESOLVER_PORT instance as the root — one binding, no second copy.
//
// No real DNS: in prod-graph mode we only RESOLVE the adapter (no .resolveTxt()
// call), so the network is never touched.

@Injectable()
class DnsConsumerService {
  constructor(@Inject(DNS_RESOLVER_PORT) readonly dns: DnsResolverPort) {}
}

@Module({
  imports: [DnsResolverModule],
  providers: [DnsConsumerService],
  exports: [DnsConsumerService],
})
class ConsumerModule {}

describe('Dns-Resolver-Binding — DNS_RESOLVER_PORT through real DI', () => {
  const ENV_KEYS = ['DNS_PROVIDER', 'DNS_RECORD_PREFIX', 'DNS_VALUE_PREFIX'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('prod graph (DNS_PROVIDER=node) binds the REAL NodeDnsAdapter (NOT the stub)', async () => {
    process.env['DNS_PROVIDER'] = 'node';

    const moduleRef = await Test.createTestingModule({
      imports: [DnsResolverModule],
    }).compile();

    const bound = moduleRef.get(DNS_RESOLVER_PORT);
    expect(bound).toBeInstanceOf(NodeDnsAdapter);
    expect(bound).not.toBeInstanceOf(StubDnsAdapter);
  });

  it('non-prod (DNS_PROVIDER=stub) binds the StubDnsAdapter', async () => {
    process.env['DNS_PROVIDER'] = 'stub';

    const moduleRef = await Test.createTestingModule({
      imports: [DnsResolverModule],
    }).compile();

    const bound = moduleRef.get(DNS_RESOLVER_PORT);
    expect(bound).toBeInstanceOf(StubDnsAdapter);
    expect(bound).not.toBeInstanceOf(NodeDnsAdapter);
  });

  it('fails LOUD when DNS_PROVIDER is unset', async () => {
    delete process.env['DNS_PROVIDER'];

    await expect(
      Test.createTestingModule({ imports: [DnsResolverModule] }).compile(),
    ).rejects.toThrow(/DNS_PROVIDER/);
  });

  it('fails LOUD when DNS_PROVIDER is invalid', async () => {
    process.env['DNS_PROVIDER'] = 'cloudflare';

    await expect(
      Test.createTestingModule({ imports: [DnsResolverModule] }).compile(),
    ).rejects.toThrow(/DNS_PROVIDER/);
  });

  it('multi-instance immune: a nested consumer resolves the SAME DNS_RESOLVER_PORT as root (the cognito bug cannot recur)', async () => {
    process.env['DNS_PROVIDER'] = 'stub';

    const moduleRef = await Test.createTestingModule({
      imports: [DnsResolverModule, ConsumerModule],
    }).compile();

    const rootBound = moduleRef.get(DNS_RESOLVER_PORT);
    const consumer = moduleRef.get(DnsConsumerService);

    expect(consumer.dns).toBe(rootBound);
    expect(consumer.dns).toBeInstanceOf(StubDnsAdapter);
  });
});
