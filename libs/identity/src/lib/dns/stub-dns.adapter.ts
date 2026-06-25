import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';

import type { DnsResolverPort } from './dns-resolver.port.js';

// Domain-Enforcement P2b §2 — StubDnsAdapter: the non-prod (local/dev/test) DNS
// resolver. Performs NO network I/O. Mirrors the StubMailerAdapter posture:
//
// FAIL-LOUD, NOT SILENT: every resolve logs at WARN that this is the stub (no
// real DNS was queried), so a prod box accidentally bound to it (DNS_PROVIDER
// misconfigured) screams in the logs rather than silently "verifying" domains
// against canned data.
//
// By default it returns [] (no TXT records) → the verification check finds no
// match and the tenant stays PENDING (the honest local default: nothing is
// published in a test DNS). Tests prime it via setRecords(name, records) to
// simulate the tenant having published the challenge, then assert the VERIFIED
// transition — all through the real module graph, no network.

@Injectable()
export class StubDnsAdapter implements DnsResolverPort {
  private readonly canned = new Map<string, string[][]>();

  constructor(
    @Inject('StubDnsAdapterLogger') private readonly logger: AramoLogger,
  ) {}

  // Test seam: prime the TXT records returned for a name. Passing a flat
  // string[] is the common case (one record, one chunk); it is normalized to
  // the string[][] port shape.
  setRecords(name: string, records: ReadonlyArray<string | string[]>): void {
    this.canned.set(
      name,
      records.map((r) => (Array.isArray(r) ? [...r] : [r])),
    );
  }

  // Test seam: clear all primed records (default empty = no match → PENDING).
  reset(): void {
    this.canned.clear();
  }

  async resolveTxt(name: string): Promise<string[][]> {
    const records = this.canned.get(name) ?? [];
    this.logger.warn({
      event: 'dns.stub.no_real_lookup',
      message:
        'StubDnsAdapter: NO real DNS queried (DNS_PROVIDER=stub). ' +
        'If this is production, domain verification is misconfigured.',
      name,
      record_count: records.length,
    });
    return records.map((r) => [...r]);
  }
}
