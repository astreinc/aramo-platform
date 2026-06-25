// Domain-Enforcement P2b §2 — the DNS resolver port (ports-and-adapters).
//
// A narrow capability: read the TXT records at a DNS name. The DnsVerificationService
// (the orchestration: mint token, resolve, match, transition) consumes this; the
// real adapter wraps Node's built-in `dns`, the stub returns canned records so
// tests never hit the network. Mirrors the MailerPort shape (libs/mailer) — a
// generic injectable port behind a Symbol token, selected by env at module bind.

// DI token for the DnsResolverPort. Injected via @Inject(DNS_RESOLVER_PORT)
// wherever DNS TXT resolution is needed (today: DnsVerificationService).
export const DNS_RESOLVER_PORT = 'DNS_RESOLVER_PORT';

export interface DnsResolverPort {
  // Resolve the TXT records at `name`. Returns the raw shape of Node's
  // dns.promises.resolveTxt: an array of records, each a string[] of the
  // chunks that make up that record (TXT values can be split into ≤255-char
  // chunks by DNS; callers join the chunks of a record before matching).
  // Implementations MUST resolve to [] when the name has no TXT records
  // (NXDOMAIN / ENODATA) rather than throwing — "no record yet" is the common,
  // non-error path (the tenant has not published the challenge yet).
  resolveTxt(name: string): Promise<string[][]>;
}
