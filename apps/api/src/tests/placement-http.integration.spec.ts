import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PlacementRepository, PrismaService } from '@aramo/placement';

import { PlacementController } from '../placement/placement.controller.js';

// Track 3 / E1-b — the guarded PlacementProcess surface at the controller + repo
// level against real Postgres 17. The JWT/guard layer is covered by app-module-di
// + the shared guard specs; here we drive the controller with a constructed
// AuthContext to prove the DATA-DEPENDENT transition authorization and the create/
// read paths end-to-end. All placement scopes ship with ZERO default grants, so a
// caller must be given the exact class scope or the transition is refused.

const INIT_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260803180000_init_placement_model/migration.sql');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const auth = (scopes: string[], tenant: string): any => ({ sub: 'u', tenant_id: tenant, actor_kind: 'user', consumer_type: 'tenant', scopes });

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; cur += '$$'; i += 1; continue; }
    if (sql[i] === ';' && !inDollar) { out.push(cur); cur = ''; } else cur += sql[i];
  }
  if (cur.trim()) out.push(cur);
  return out;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('E1-b PlacementController (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let setup: PrismaService;
  let prisma: PrismaService;
  let ctrl: PlacementController;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17').start();
    const url = container.getConnectionUri();
    setup = new PrismaService(url);
    await setup.$connect();
    for (const s of splitDdl(readFileSync(INIT_MIGRATION, 'utf8'))) {
      if (s.trim()) await setup.$executeRawUnsafe(s.trim());
    }
    prisma = new PrismaService(url);
    await prisma.$connect();
    ctrl = new PlacementController(new PlacementRepository(prisma));
  }, 120_000);

  afterAll(async () => {
    await setup?.$disconnect();
    await prisma?.$disconnect();
    await container?.stop();
  });

  const body = () => ({ submittal_id: randomUUID(), requisition_id: randomUUID(), talent_record_id: randomUUID() });

  async function make(tenant: string): Promise<string> {
    const v = await ctrl.create(auth(['placement:create'], tenant), 'r', body());
    expect(v.state).toBe('OFFER_EXTENDED');
    return v.id;
  }

  it('create returns OFFER_EXTENDED', async () => {
    const id = await make(randomUUID());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('an ordinary-progression transition needs placement:transition', async () => {
    const t = randomUUID();
    const id = await make(t);
    // Without the class scope → 403.
    await expect(ctrl.transition(auth([], t), 'r', id, { to: 'OFFER_ACCEPTED' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { authority_class: 'transition', required_scope: 'placement:transition' } },
    });
    // With it → succeeds.
    const moved = await ctrl.transition(auth(['placement:transition'], t), 'r', id, { to: 'OFFER_ACCEPTED' });
    expect(moved.state).toBe('OFFER_ACCEPTED');
  });

  it('a terminal transition needs placement:terminate (not :transition)', async () => {
    const t = randomUUID();
    const id = await make(t);
    // Holding :transition is NOT enough for a terminal edge.
    await expect(ctrl.transition(auth(['placement:transition'], t), 'r', id, { to: 'OFFER_DECLINED' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      context: { details: { authority_class: 'terminate', required_scope: 'placement:terminate' } },
    });
    const done = await ctrl.transition(auth(['placement:terminate'], t), 'r', id, { to: 'OFFER_DECLINED' });
    expect(done.state).toBe('OFFER_DECLINED');
  });

  it('the activate edge (READY_TO_START->STARTED) needs placement:activate', async () => {
    const t = randomUUID();
    const id = await make(t);
    const s = auth(['placement:transition', 'placement:activate'], t);
    await ctrl.transition(s, 'r', id, { to: 'OFFER_ACCEPTED' });
    await ctrl.transition(s, 'r', id, { to: 'PRE_START' });
    await ctrl.transition(s, 'r', id, { to: 'READY_TO_START' });
    // Without :activate the live edge is refused even holding :transition.
    await expect(ctrl.transition(auth(['placement:transition'], t), 'r', id, { to: 'STARTED' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      context: { details: { authority_class: 'activate', required_scope: 'placement:activate' } },
    });
    const live = await ctrl.transition(s, 'r', id, { to: 'STARTED' });
    expect(live.state).toBe('STARTED');
  });

  it('an illegal edge is refused by the matrix (PLACEMENT_STATE_INVALID 422) even with the scope', async () => {
    const t = randomUUID();
    const id = await make(t);
    // OFFER_EXTENDED -> READY_TO_START is not a legal edge; scope class of the
    // target (transition) is held, so the refusal is the matrix, not authz.
    await expect(ctrl.transition(auth(['placement:transition'], t), 'r', id, { to: 'READY_TO_START' })).rejects.toMatchObject({
      code: 'PLACEMENT_STATE_INVALID',
      statusCode: 422,
    });
  });

  it('get is tenant-isolated and 404s a foreign/absent id', async () => {
    const t = randomUUID();
    const id = await make(t);
    expect((await ctrl.get(auth(['placement:read'], t), 'r', id)).id).toBe(id);
    await expect(ctrl.get(auth(['placement:read'], randomUUID()), 'r', id)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });
});
