import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SignatureRoutingRepository } from '../lib/signature-routing.repository.js';

// Multi-Provider directive §E — explicit, audited provider selection; a provider
// switch never rewrites the route frozen on an existing request.

const MIGRATIONS = [
  '../../../metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  '../../prisma/migrations/20261018130000_init_signature_routing/migration.sql',
  '../../prisma/migrations/20261018140500_provider_oauth_state/migration.sql',
].map((p) => resolve(__dirname, p));
const T1 = '0190bbbb-0000-7000-8000-000000000001';
const T2 = '0190bbbb-0000-7000-8000-000000000002';
const DOC = '0190cccc-0000-7000-8000-000000000001';
const REV = '0190cccc-0000-7000-8000-000000000002';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('signature routing (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let repo: SignatureRoutingRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    for (const m of MIGRATIONS) await pg.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    repo = new SignatureRoutingRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  it('a tenant with no selection uses the built-in Aramo Sign', async () => {
    expect(await repo.getSelectedProvider(T1)).toEqual({ provider: 'aramo_sign', explicit: false });
  });

  it('a selection is explicit and audited; re-selecting the same provider is a no-op', async () => {
    expect(await repo.selectProvider({ tenant_id: T1, provider: 'docusign', actor_id: 'admin-1' })).toEqual({ from: 'aramo_sign', to: 'docusign', changed: true });
    expect(await repo.selectProvider({ tenant_id: T1, provider: 'docusign', actor_id: 'admin-1' })).toMatchObject({ changed: false });
    expect(await repo.getSelectedProvider(T1)).toEqual({ provider: 'docusign', explicit: true });
    const events = await repo.listSelectionEvents(T1);
    expect(events.map((e) => [e.from_provider, e.to_provider, e.actor_id])).toEqual([['aramo_sign', 'docusign', 'admin-1']]);
    expect(await repo.getSelectedProvider(T2)).toMatchObject({ provider: 'aramo_sign' });
  });

  it('the audit trail is append-only', async () => {
    await expect(pg.query(`UPDATE signature_routing."SignatureProviderSelectionEvent" SET actor_id = 'x'`)).rejects.toThrow(/append-only/);
    await expect(pg.query(`DELETE FROM signature_routing."SignatureProviderSelectionEvent"`)).rejects.toThrow(/append-only/);
  });

  it('a provider switch does not move an existing request: its route stays frozen', async () => {
    await repo.recordRoute({ tenant_id: T2, document_id: DOC, document_revision_id: REV, provider: 'aramo_sign', provider_envelope_ref: 'env-1' });
    await repo.recordRoute({ tenant_id: T2, document_id: DOC, document_revision_id: REV, provider: 'aramo_sign', provider_envelope_ref: 'env-1' });
    await repo.selectProvider({ tenant_id: T2, provider: 'adobe_sign', actor_id: 'admin-2' });
    expect(await repo.findRoute(T2, DOC, REV)).toMatchObject({ provider: 'aramo_sign', provider_envelope_ref: 'env-1' });
    const n = await pg.query(`SELECT count(*)::int AS n FROM signature_routing."SignatureRequestRoute" WHERE tenant_id = $1`, [T2]);
    expect(n.rows[0].n).toBe(1);
    expect(await repo.findRoute(T1, DOC, REV)).toBeNull();
  });

  it('only known providers can be stored', async () => {
    await expect(pg.query(`INSERT INTO signature_routing."TenantSignatureProvider" (tenant_id, provider, selected_by) VALUES ($1, 'acme_sign', 'x')`, [T2])).rejects.toThrow(/provider_check/);
  });

  // §G — OAuth connect state: single-use, bound to the tenant + user + provider that
  // started it, expiring; a replayed or foreign state is refused.
  it('OAuth state is single-use, expiring and bound to tenant, user and provider', async () => {
    const st = await repo.createOAuthState({ tenant_id: T1, user_id: 'admin-1', provider: 'docusign', code_verifier: 'v'.repeat(64), ttl_ms: 600_000 });
    expect(st.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await repo.consumeOAuthState({ state: st.state, tenant_id: T2, user_id: 'admin-1', provider: 'docusign' })).toBeNull();
    expect(await repo.consumeOAuthState({ state: st.state, tenant_id: T1, user_id: 'other', provider: 'docusign' })).toBeNull();
    expect(await repo.consumeOAuthState({ state: st.state, tenant_id: T1, user_id: 'admin-1', provider: 'adobe_sign' })).toBeNull();
    expect(await repo.consumeOAuthState({ state: st.state, tenant_id: T1, user_id: 'admin-1', provider: 'docusign' })).toEqual({ code_verifier: 'v'.repeat(64) });
    expect(await repo.consumeOAuthState({ state: st.state, tenant_id: T1, user_id: 'admin-1', provider: 'docusign' })).toBeNull();
    const old = await repo.createOAuthState({ tenant_id: T1, user_id: 'admin-1', provider: 'docusign', code_verifier: 'x', ttl_ms: -1 });
    expect(await repo.consumeOAuthState({ state: old.state, tenant_id: T1, user_id: 'admin-1', provider: 'docusign' })).toBeNull();
  });

  it('a provider envelope resolves back to its tenant, document and revision', async () => {
    await repo.recordRoute({ tenant_id: T1, document_id: DOC, document_revision_id: REV, provider: 'docusign', provider_envelope_ref: 'ds-77' });
    expect(await repo.findRouteByEnvelope('docusign', 'ds-77')).toMatchObject({ tenant_id: T1, document_id: DOC, document_revision_id: REV });
    expect(await repo.findRouteByEnvelope('adobe_sign', 'ds-77')).toBeNull();
  });

  it('an accepted external send is recorded in the usage stream (operational, not a quota)', async () => {
    await repo.recordExternalSend(T1, 'docusign');
    const r = await pg.query(`SELECT event_type FROM metering."UsageEvent" WHERE tenant_id = $1`, [T1]);
    expect(r.rows.map((x) => x.event_type)).toEqual(['sign.external.envelope.sent.docusign']);
  });
});
