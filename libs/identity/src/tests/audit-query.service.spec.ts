import { AramoError } from '@aramo/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AuditQueryService,
  MAX_LIMIT,
} from '../lib/audit/audit-query.service.js';
import type { AuditEventRow } from '../lib/audit/identity-audit.repository.js';
import { encodeCursor } from '../lib/util/identity-audit-cursor.js';

// Settings Rebuild D2 — AuditQueryService unit tests (pagination, actor
// resolution, filter validation) with mocked repo + prisma.

function row(over: Partial<AuditEventRow> & { id: string; created_at: Date }): AuditEventRow {
  return {
    tenant_id: 'tenant-1',
    actor_id: 'user-1',
    actor_type: 'user',
    event_type: 'identity.tenant_setting.updated',
    subject_id: 'subj-1',
    event_payload: { key: 'x' },
    ...over,
  } as AuditEventRow;
}

function makeService(rows: AuditEventRow[]) {
  const findByTenant = vi.fn(async () => rows);
  const userFindMany = vi.fn(async () => [
    { id: 'user-1', display_name: 'Priya Nair', email: 'priya@x.com' },
  ]);
  const svc = new AuditQueryService(
    { findByTenant } as never,
    { user: { findMany: userFindMany } } as never,
  );
  return { svc, findByTenant, userFindMany };
}

const BASE = {
  tenant_id: 'tenant-1',
  viewerScopes: ['compensation:view:bill'],
  requestId: 'req-1',
};

describe('AuditQueryService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pins tenant_id from the caller (never the request)', async () => {
    const { svc, findByTenant } = makeService([]);
    await svc.query({ ...BASE });
    expect(findByTenant).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'tenant-1' }),
    );
  });

  it('returns a next_cursor only when there is another page', async () => {
    const d = new Date('2026-06-01T00:00:00.000Z');
    // limit defaults to 50; return 51 rows → hasMore.
    const many = Array.from({ length: 51 }, (_, i) =>
      row({ id: `id-${String(i).padStart(3, '0')}`, created_at: d }),
    );
    const { svc } = makeService(many);
    const res = await svc.query({ ...BASE });
    expect(res.items).toHaveLength(50);
    expect(res.next_cursor).not.toBeNull();

    const { svc: svc2 } = makeService(many.slice(0, 10));
    const res2 = await svc2.query({ ...BASE });
    expect(res2.items).toHaveLength(10);
    expect(res2.next_cursor).toBeNull();
  });

  it('resolves the actor display name from the user table', async () => {
    const { svc } = makeService([row({ id: 'a', created_at: new Date() })]);
    const res = await svc.query({ ...BASE });
    expect(res.items[0]?.actor.display).toBe('Priya Nair');
  });

  it('labels system/service actors without a user lookup', async () => {
    const { svc } = makeService([
      row({ id: 'a', created_at: new Date(), actor_type: 'system', actor_id: null, event_type: 'identity.tenant.created' }),
    ]);
    const res = await svc.query({ ...BASE });
    expect(res.items[0]?.actor.display).toBe('System');
  });

  it('clamps limit to MAX_LIMIT', async () => {
    const { svc, findByTenant } = makeService([]);
    await svc.query({ ...BASE, limit: '5000' });
    expect(findByTenant).toHaveBeenCalledWith(
      expect.objectContaining({ limit: MAX_LIMIT }),
    );
  });

  it('rejects a bad cursor / event_type / limit / date as 400', async () => {
    const { svc } = makeService([]);
    await expect(svc.query({ ...BASE, cursor: 'not-base64!!' })).rejects.toThrow(AramoError);
    await expect(svc.query({ ...BASE, event_type: 'not.a.real.type' })).rejects.toThrow(AramoError);
    await expect(svc.query({ ...BASE, limit: '0' })).rejects.toThrow(AramoError);
    await expect(svc.query({ ...BASE, from: 'yesterday' })).rejects.toThrow(AramoError);
    await expect(svc.query({ ...BASE, actor_id: 'not-a-uuid' })).rejects.toThrow(AramoError);
  });

  it('passes a decoded cursor + composed filters to the repo', async () => {
    const cur = encodeCursor({ created_at: new Date('2026-06-01T00:00:00.000Z'), event_id: '01900000-0000-7000-8000-000000000001' });
    const { svc, findByTenant } = makeService([]);
    await svc.query({
      ...BASE,
      cursor: cur,
      event_type: 'identity.session.issued',
      actor_id: '01900000-0000-7000-8000-0000000000ab',
      from: '2026-05-01T00:00:00.000Z',
    });
    const arg = findByTenant.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['cursor']).toMatchObject({ event_id: '01900000-0000-7000-8000-000000000001' });
    expect(arg['filters']).toMatchObject({
      event_type: 'identity.session.issued',
      actor_id: '01900000-0000-7000-8000-0000000000ab',
    });
  });
});
