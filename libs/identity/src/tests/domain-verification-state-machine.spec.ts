import { describe, expect, it, beforeEach } from 'vitest';
import { AramoError } from '@aramo/common';

import type {
  TenantRepository,
  DomainVerificationRow,
} from '../lib/tenant.repository.js';
import type { DnsResolverPort } from '../lib/dns/dns-resolver.port.js';
import type {
  DomainClaimService,
  DomainClaimState,
  DomainClaimView,
  PromoteOutcome,
} from '../lib/domain-claim/domain-claim.service.js';
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

// Domain-Enforcement P3 §4 — a controllable stand-in for DomainClaimService
// (promoteOnVerified + the two reads the view uses). `heldElsewhere` simulates
// another organization holding the domain.
class FakeClaims {
  public claim: DomainClaimState | null = 'PROVISIONAL';
  public heldElsewhere = false;
  public promoteCalls = 0;
  public failNext = false;
  async promoteOnVerified(): Promise<PromoteOutcome> {
    this.promoteCalls += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('db down');
    }
    if (this.claim === 'AUTHORITATIVE') return 'ALREADY';
    if (this.heldElsewhere) return 'CONFLICT';
    this.claim = 'AUTHORITATIVE';
    return 'PROMOTED';
  }
  async claimOf(): Promise<DomainClaimView | null> {
    return this.claim === null
      ? null
      : { domain: DOMAIN, claim: this.claim, expires_at: null, reason: null, exception: false };
  }
  async isDomainHeld(): Promise<boolean> {
    return this.heldElsewhere || this.claim === 'PROVISIONAL' || this.claim === 'AUTHORITATIVE';
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
  claims: FakeClaims;
} {
  const repo = new FakeTenantRepo(row);
  const resolver = new FakeResolver();
  const claims = new FakeClaims();
  const svc = new DomainVerificationService(
    repo as unknown as TenantRepository,
    resolver,
    claims as unknown as DomainClaimService,
  );
  return { svc, repo, resolver, claims };
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

describe('DomainVerificationService — P3 §4 claim promotion + re-issue refusal', () => {
  async function verify(svc: DomainVerificationService, resolver: FakeResolver) {
    const req = await svc.requestVerification(TENANT, 'rq');
    resolver.records = [[req.view.record_value as string]];
    return svc.checkVerification(TENANT, 'rq');
  }

  it('the transition into VERIFIED promotes the claim → AUTHORITATIVE (outcome PROMOTED)', async () => {
    const { svc, resolver, claims } = makeService(makeRow());
    const { view, verified, claim_outcome } = await verify(svc, resolver);
    expect(verified).toBe(true);
    expect(claims.promoteCalls).toBe(1);
    expect(claim_outcome).toBe('PROMOTED');
    expect(view.domain_claim).toBe('AUTHORITATIVE');
    expect(view.domain_claim_conflict).toBe(false);
  });

  it('a promotion refused because another organization holds the domain keeps VERIFIED and reports the conflict', async () => {
    const { svc, resolver, claims } = makeService(makeRow());
    claims.claim = 'LAPSED';
    claims.heldElsewhere = true;
    const { view, verified, claim_outcome } = await verify(svc, resolver);
    expect(verified).toBe(true);
    expect(claim_outcome).toBe('CONFLICT');
    expect(view.status).toBe('VERIFIED'); // P2b sticky — not rolled back
    expect(view.domain_claim).toBe('LAPSED');
    expect(view.domain_claim_conflict).toBe(true);
  });

  it('no promotion runs while PENDING (no match)', async () => {
    const { svc, claims } = makeService(makeRow());
    await svc.requestVerification(TENANT, 'rq');
    const { claim_outcome } = await svc.checkVerification(TENANT, 'rq');
    expect(claim_outcome).toBeNull();
    expect(claims.promoteCalls).toBe(0);
  });

  it('a re-check of a VERIFIED tenant retries the promotion only while the claim is not AUTHORITATIVE', async () => {
    const { svc, resolver, claims } = makeService(makeRow());
    claims.claim = 'LAPSED';
    claims.heldElsewhere = true;
    await verify(svc, resolver); // CONFLICT
    claims.heldElsewhere = false; // the operator released the other holder
    const retry = await svc.checkVerification(TENANT, 'rq');
    expect(retry.verified).toBe(false); // no second VERIFIED transition
    expect(retry.claim_outcome).toBe('PROMOTED');
    expect(retry.view.domain_claim).toBe('AUTHORITATIVE');
    const calls = claims.promoteCalls;
    const again = await svc.checkVerification(TENANT, 'rq');
    expect(again.claim_outcome).toBeNull(); // already authoritative — nothing to do
    expect(claims.promoteCalls).toBe(calls);
  });

  it('a failing promotion is fail-soft: VERIFIED stands, outcome null, a later check repairs it', async () => {
    const { svc, resolver, claims } = makeService(makeRow());
    claims.failNext = true;
    const first = await verify(svc, resolver);
    expect(first.verified).toBe(true);
    expect(first.claim_outcome).toBeNull();
    expect(first.view.status).toBe('VERIFIED');
    const repair = await svc.checkVerification(TENANT, 'rq');
    expect(repair.claim_outcome).toBe('PROMOTED');
  });

  it('re-issue while VERIFIED is refused: 409 already_verified, the token is untouched', async () => {
    const { svc, resolver, repo } = makeService(makeRow());
    await verify(svc, resolver);
    const token = repo.row.domain_verification_token;
    await expect(svc.requestVerification(TENANT, 'rq')).rejects.toMatchObject({
      statusCode: 409,
      context: { details: { reason: 'already_verified' } },
    });
    expect(repo.row.domain_verification_token).toBe(token);
    expect(repo.row.domain_verification_status).toBe('VERIFIED');
  });

  it('ensureTokenForDelegate mints the FIRST token only — never rotates an existing one', async () => {
    const { svc, repo } = makeService(makeRow());
    const first = await svc.ensureTokenForDelegate(TENANT, 'rq');
    expect(first.issued).toBe(true);
    expect(first.view.status).toBe('PENDING');
    const token = repo.row.domain_verification_token;
    const second = await svc.ensureTokenForDelegate(TENANT, 'rq');
    expect(second.issued).toBe(false);
    expect(repo.row.domain_verification_token).toBe(token);
    expect(second.view.record_value).toBe(first.view.record_value);
  });

  it('ensureTokenForDelegate leaves a VERIFIED tenant alone', async () => {
    const { svc, repo } = makeService(
      makeRow({ domain_verification_status: 'VERIFIED', domain_verification_token: 'tok', domain_verified_at: new Date() }),
    );
    const r = await svc.ensureTokenForDelegate(TENANT, 'rq');
    expect(r.issued).toBe(false);
    expect(r.view.status).toBe('VERIFIED');
    expect(repo.row.domain_verification_token).toBe('tok');
  });
});
