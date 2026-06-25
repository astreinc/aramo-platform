import type { DomainVerificationStatus } from '../util/domain-verification.js';

// Domain-Enforcement P2b §6 — the GET/POST response shape for the
// domain-verification surface. The UI renders the status badge + the exact TXT
// record to publish (name + value) + the verified timestamp.
export interface DomainVerificationView {
  // The 3-state machine value (UNVERIFIED | PENDING | VERIFIED).
  readonly status: DomainVerificationStatus;
  // The domain being verified (P1's allowed_domain). null when the tenant has
  // no locked domain yet (legacy/test rows) — then there is nothing to publish.
  readonly allowed_domain: string | null;
  // The TXT record NAME to publish, e.g. "_aramo-challenge.acme.corp". null when
  // there is no allowed_domain to derive it from.
  readonly record_name: string | null;
  // The TXT record VALUE to publish, e.g.
  // "aramo-domain-verification=<token>". null until a token has been minted
  // (status UNVERIFIED → request verification first). PUBLIC by design.
  readonly record_value: string | null;
  // Set when status === VERIFIED.
  readonly verified_at: string | null;
  // When the current token was minted (observability; NO hard expiry).
  readonly token_issued_at: string | null;
}

// Build the dedicated-subdomain record name (§4). e.g.
// buildRecordName('_aramo-challenge', 'acme.corp') === '_aramo-challenge.acme.corp'.
export function buildRecordName(
  recordPrefix: string,
  allowedDomain: string,
): string {
  return `${recordPrefix}.${allowedDomain}`;
}

// Build the prefixed record value (§4). e.g.
// buildRecordValue('aramo-domain-verification=', '<tok>') === 'aramo-domain-verification=<tok>'.
export function buildRecordValue(valuePrefix: string, token: string): string {
  return `${valuePrefix}${token}`;
}
