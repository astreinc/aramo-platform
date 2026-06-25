import { promises as dnsPromises } from 'node:dns';

import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';

import type { DnsResolverPort } from './dns-resolver.port.js';

// Domain-Enforcement P2b §2 — NodeDnsAdapter: the REAL DNS resolver.
//
// Wraps Node's built-in dns.promises.resolveTxt (NO new dependency; outbound DNS
// is more basic than the box's existing SES/Cognito egress). resolveTxt already
// returns string[][] (one string[] of ≤255-char chunks per TXT record), which is
// exactly the port shape — no transform needed.
//
// "No record yet" is NOT an error in this domain (the tenant has not published
// the challenge). Node throws ENOTFOUND/ENODATA for a name with no TXT records;
// we map those to [] so the caller's match logic simply finds no match and stays
// PENDING. Any OTHER error (e.g. a malformed name, SERVFAIL) propagates so a real
// resolver fault surfaces rather than masquerading as "not propagated yet".

const EMPTY_TXT_CODES = new Set(['ENOTFOUND', 'ENODATA']);

@Injectable()
export class NodeDnsAdapter implements DnsResolverPort {
  constructor(
    @Inject('NodeDnsAdapterLogger') private readonly logger: AramoLogger,
  ) {}

  async resolveTxt(name: string): Promise<string[][]> {
    try {
      const records = await dnsPromises.resolveTxt(name);
      this.logger.log({
        event: 'dns.node.resolved',
        name,
        record_count: records.length,
      });
      return records;
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code !== undefined && EMPTY_TXT_CODES.has(code)) {
        // No TXT records at the name — the common "not published / not
        // propagated yet" path. Surface as empty, not an error.
        this.logger.log({ event: 'dns.node.no_records', name, code });
        return [];
      }
      throw err;
    }
  }
}
