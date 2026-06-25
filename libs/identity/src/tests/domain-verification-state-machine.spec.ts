import { describe, expect, it, beforeEach } from 'vitest';
import { AramoError } from '@aramo/common';

import type {
  TenantRepository,
  DomainVerificationRow,
} from '../lib/tenant.repository.js';
import type { DnsResolverPort } from '../lib/dns/dns-resolver.port.js';
import { DomainVerificationService } from '../lib/domain-verification/domain-verification.service.js';

// Domain-Enforcement P2b §5 — the state-machine proof (stub DNS).
//
// UNVERIFIED → [request] → PENDING → [check + match] → VERIFIED, with:
//   • re-issue rotates the token,
//   • a check with no match stays PENDING (NOT an error — DNS not propagated),
//   • VERIFIED is sticky (a re-check after VERIFIED is a no-op),
//   • check before any request is a 400 (no token),
//   • request/check with no allowed_domain is a 400.
//
// Uses an in-memory fake repo + a controllable fake resolver — the transitions
// are exercised deterministically. (The DI binding is proven separately in
// dns-resolver-binding.di.spec.ts; the endpoints + audit + scope-gate through the
// real PG graph in apps/api's domain-verification integration spec.)
//
// DNS_PROVIDER is defaulted to 'stub' by vitest.shared.ts, so loadDnsConfig()
// (read inside the service for the record prefix/value) resolves the defaults
// '_aramo-challenge' / 'aramo-domain-verification='.

const TENANT = '11111111-0000-7000-8000-aaaaaaaaaaaa';
const DOMAIN = 'acme.corp';

class FakeTenantRepo {
  constructor(public row: DomainVerificationRow) {}
  async findDomainVerificationById(
    id: string,
  ): Promise<DomainVerificationRow | null> {
    return id === this.row.id ? { ...this.row } : null;
  }
  async updateDomainVerification(
    id: string,
    patch: Partial<DomainVerificationRow>,
  ): Promise<DomainVerificationRow> {
    this.row = { ...this.row, ...patch };
    return { ...this.row };
  }
}

class FakeResolver implements DnsResolverPort {
  public records: string[][] = [];
  async resolveTxt(): Promise<string[][]> {
    return this.records;
  }
}

function makeRow(over: Partial<DomainVerificationRow> = {}): DomainVerificationRow {
  return {
    id: TENANT,
    allowed_domain: DOMAIN,
    domain_verification_status: 'UNVERIFIED',
    domain_verification_token: null,
    domain_verified_at: null,
    domain_token_issued_at: null,
    ...over,
  };
}

function makeService(row: DomainVerificationRow): {
  svc: DomainVerificationService;
  repo: FakeTenantRepo;
  resolver: FakeResolver;
} {
  const repo = new FakeTenantRepo(row);
  const resolver = new FakeResolver();
  const svc = new DomainVerificationService(
    repo as unknown as TenantRepository,
    resolver,
  );
  return { svc, repo, resolver };
}

describe('DomainVerificationService — state machine (P2b §5)', () => {
  let svc: DomainVerificationService;
  let repo: FakeTenantRepo;
  let resolver: FakeResolver;

  beforeEach(() => {
    ({ svc, repo, resolver } = makeService(makeRow()));
  });

  it('UNVERIFIED initial: getStatus shows the record NAME but no value yet', async () => {
    const view = await svc.getStatus(TENANT, 'rq');
    expect(view.status).toBe('UNVERIFIED');
    expect(view.allowed_domain).toBe(DOMAIN);
    expect(view.record_name).toBe('_aramo-challenge.acme.corp');
    expect(view.record_value).toBeNull(); // nothing minted yet
    expect(view.verified_at).toBeNull();
  });

  it('request → PENDING + token minted; value is the prefixed token', async () => {
    const { view, issued } = await svc.requestVerification(TENANT, 'rq');
    expect(issued).toBe(true);
    expect(view.status).toBe('PENDING');
    expect(view.record_name).toBe('_aramo-challenge.acme.corp');
    expect(view.record_value).toMatch(/^aramo-domain-verification=.+/);
    expect(view.token_issued_at).not.toBeNull();
    expect(repo.row.domain_verification_token).not.toBeNull();
  });

  it('re-issue rotates the token (fresh value overwrites)', async () => {
    const first = await svc.requestVerification(TENANT, 'rq');
    const firstToken = repo.row.domain_verification_token;
    const second = await svc.requestVerification(TENANT, 'rq');
    expect(repo.row.domain_verification_token).not.toBe(firstToken);
    expect(second.view.record_value).not.toBe(first.view.record_value);
    expect(second.view.status).toBe('PENDING');
  });

  it('check with a MATCHING TXT → VERIFIED (verified_at set, verified:true)', async () => {
    const req = await svc.requestVerification(TENANT, 'rq');
    // Publish the exact value the tenant was told to publish.
    resolver.records = [[req.view.record_value as string]];
    const { view, verified } = await svc.checkVerification(TENANT, 'rq');
    expect(verified).toBe(true);
    expect(view.status).toBe('VERIFIED');
    expect(view.verified_at).not.toBeNull();
  });

  it('check joins multi-CHUNK TXT records before matching', async () => {
    const req = await svc.requestVerification(TENANT, 'rq');
    const val = req.view.record_value as string;
    const mid = Math.floor(val.length / 2);
    // DNS may split a TXT value into ≤255-char chunks; the matcher joins them.
    resolver.records = [[val.slice(0, mid), val.slice(mid)]];
    const { verified } = await svc.checkVerification(TENANT, 'rq');
    expect(verified).toBe(true);
  });

  it('check with NO match stays PENDING (not an error — DNS not propagated)', async () => {
    await svc.requestVerification(TENANT, 'rq');
    resolver.records = [['some-other-unrelated-txt']]; // not our challenge
    const { view, verified } = await svc.checkVerification(TENANT, 'rq');
    expect(verified).toBe(false);
    expect(view.status).toBe('PENDING'); // retryable, no penalty
  });

  it('VERIFIED is sticky: a re-check after VERIFIED is a no-op even if the record vanished', async () => {
    const req = await svc.requestVerification(TENANT, 'rq');
    resolver.records = [[req.view.record_value as string]];
    await svc.checkVerification(TENANT, 'rq'); // → VERIFIED
    resolver.records = []; // record removed
    const { view, verified } = await svc.checkVerification(TENANT, 'rq');
    expect(verified).toBe(false); // no new transition, no audit
    expect(view.status).toBe('VERIFIED'); // stays VERIFIED
  });

  it('check before any request → 400 (no token issued)', async () => {
    await expect(svc.checkVerification(TENANT, 'rq')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('request with no allowed_domain → 400 (nothing to verify)', async () => {
    ({ svc } = makeService(makeRow({ allowed_domain: null })));
    await expect(svc.requestVerification(TENANT, 'rq')).rejects.toBeInstanceOf(
      AramoError,
    );
  });

  it('missing tenant → 404', async () => {
    await expect(
      svc.getStatus('99999999-0000-7000-8000-000000000000', 'rq'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
