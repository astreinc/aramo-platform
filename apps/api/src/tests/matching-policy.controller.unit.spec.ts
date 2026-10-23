import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { REQUIRED_SCOPES_KEY, RolesGuard } from '@aramo/authorization';
import { DEFAULT_EVIDENCE_THRESHOLDS } from '@aramo/matching';
import {
  MatchingPolicyVersionNotFoundError,
  type MatchingPolicyRepository,
  type MatchingPolicyVersionRow,
} from '@aramo/skills-taxonomy';
import { describe, expect, it, vi } from 'vitest';

import { MatchingPolicyController } from '../matching-policy/matching-policy.controller.js';
import { StoreMatchingPolicySource } from '../matching-policy/matching-policy.source.js';

// ATI-SEP-1 A2 A-c (P1) — the platform MatchingPolicy routes: class guards, per-route
// platform:matching_policy:{read,write} scopes, the consumer_type=platform tripwire on
// EVERY route (checked before any store call — a tenant token can neither read nor
// write), strict thresholds validation, error mapping, and the store-backed
// MATCHING_POLICY_SOURCE adapter.

const READ = 'platform:matching_policy:read';
const WRITE = 'platform:matching_policy:write';
const RID = 'req-1';
const V1 = '019a0000-0000-7000-8000-00000000a001';
const V2 = '019a0000-0000-7000-8000-00000000a0b2';

const ROUTE_SCOPES: Record<string, string> = {
  getPolicy: READ,
  createVersion: WRITE,
  activateVersion: WRITE,
};

function auth(consumer_type: string, scopes: string[] = [READ, WRITE]): AuthContextType {
  return {
    sub: '01900000-0000-7000-8000-0000000ac001',
    consumer_type: consumer_type as AuthContextType['consumer_type'],
    actor_kind: 'user' as AuthContextType['actor_kind'],
    tenant_id: '01900000-0000-7000-8000-000000000100',
    scopes,
    iat: 0,
    exp: 0,
  };
}

function row(over: Partial<MatchingPolicyVersionRow> = {}): MatchingPolicyVersionRow {
  return {
    id: V1,
    version_number: 1,
    status: 'ACTIVE',
    evidence_thresholds: { ...DEFAULT_EVIDENCE_THRESHOLDS },
    note: null,
    created_by: null,
    created_at: new Date('2026-10-23T00:00:00.000Z'),
    activated_by: null,
    activated_at: new Date('2026-10-23T00:00:00.000Z'),
    retired_at: null,
    ...over,
  };
}

function build() {
  const store = {
    listVersions: vi.fn(async () => [row({ id: V2, version_number: 2, status: 'DRAFT', activated_at: null }), row()]),
    getActive: vi.fn(async () => row()),
    getById: vi.fn(async (id: string) => (id === V2 ? row({ id: V2, version_number: 2, status: 'DRAFT' }) : null)),
    createVersion: vi.fn(async (i: { evidence_thresholds: Record<string, unknown> }) =>
      row({ id: V2, version_number: 2, status: 'DRAFT', evidence_thresholds: i.evidence_thresholds, activated_at: null }),
    ),
    activateVersion: vi.fn(async (id: string) => ({ row: row({ id, version_number: 2 }), changed: true })),
  };
  const c = new MatchingPolicyController(store as unknown as MatchingPolicyRepository);
  return { c, store };
}

function call(c: MatchingPolicyController, name: string, a: AuthContextType): Promise<unknown> {
  switch (name) {
    case 'getPolicy':
      return c.getPolicy(a, RID);
    case 'createVersion':
      return c.createVersion({ evidence_thresholds: { ...DEFAULT_EVIDENCE_THRESHOLDS } }, a, RID);
    case 'activateVersion':
      return c.activateVersion(V2, a, RID);
    default:
      throw new Error(name);
  }
}

async function errorOf(p: Promise<unknown>): Promise<{
  code: string;
  statusCode: number;
  context?: { details?: Record<string, unknown> };
}> {
  try {
    await p;
  } catch (e) {
    return e as { code: string; statusCode: number; context?: { details?: Record<string, unknown> } };
  }
  throw new Error('expected a refusal');
}

describe('MatchingPolicyController — authorization surface', () => {
  it('class guards are JwtAuthGuard + RolesGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MatchingPolicyController)).toEqual([JwtAuthGuard, RolesGuard]);
  });

  it('every route carries exactly one platform:matching_policy scope (read → read, changes → write)', () => {
    const proto = MatchingPolicyController.prototype as unknown as Record<string, unknown>;
    const handlers = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor' && Reflect.getMetadata('path', proto[n] as object) !== undefined,
    );
    expect(handlers.sort()).toEqual(Object.keys(ROUTE_SCOPES).sort());
    for (const h of handlers) {
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, proto[h] as object), h).toEqual([ROUTE_SCOPES[h]]);
    }
  });

  it.each(Object.keys(ROUTE_SCOPES))('%s refuses a tenant-tier token (tier_mismatch) before any store call', async (name) => {
    const { c, store } = build();
    for (const consumer of ['recruiter', 'portal', 'ingestion']) {
      const e = await errorOf(call(c, name, auth(consumer)));
      expect(e.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(e.statusCode).toBe(403);
      expect(e.context?.details?.['reason']).toBe('tier_mismatch');
    }
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });

  it('RolesGuard: a platform token with only :read is refused on a write route; with :write, admitted', () => {
    const guard = new RolesGuard(new Reflector());
    const ctx = (scopes: string[]): ExecutionContext =>
      ({
        getHandler: () => MatchingPolicyController.prototype.createVersion,
        getClass: () => MatchingPolicyController,
        switchToHttp: () => ({ getRequest: () => ({ authContext: auth('platform', scopes), requestId: RID }) }),
      }) as unknown as ExecutionContext;
    expect(() => guard.canActivate(ctx([READ]))).toThrow(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    expect(() => guard.canActivate(ctx(['platform:skill:manage']))).toThrow(
      expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }),
    );
    expect(guard.canActivate(ctx([READ, WRITE]))).toBe(true);
  });
});

describe('MatchingPolicyController — behaviour', () => {
  it('getPolicy returns the ACTIVE version and the history newest first', async () => {
    const { c } = build();
    const r = await c.getPolicy(auth('platform'), RID);
    expect(r.active?.id).toBe(V1);
    expect(r.versions.map((v) => v.version_number)).toEqual([2, 1]);
    expect(r.versions[0]?.created_at).toBe('2026-10-23T00:00:00.000Z');
  });

  it('createVersion validates strictly and appends a DRAFT attributed to the platform actor', async () => {
    const { c, store } = build();
    const e = await errorOf(
      c.createVersion({ evidence_thresholds: { architect: { count: 0, requires_ingested: true } } }, auth('platform'), RID),
    );
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.statusCode).toBe(400);
    expect(Array.isArray(e.context?.details?.['errors'])).toBe(true);
    expect(store.createVersion).not.toHaveBeenCalled();

    const v = await c.createVersion(
      { evidence_thresholds: { ...DEFAULT_EVIDENCE_THRESHOLDS, architect: { count: 4, requires_ingested: true } }, note: 'n' },
      auth('platform'),
      RID,
    );
    expect(v.status).toBe('DRAFT');
    expect(store.createVersion).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'n', actor: { id: '01900000-0000-7000-8000-0000000ac001', type: 'user' } }),
    );
  });

  it('activateVersion maps an unknown id to 404 NOT_FOUND', async () => {
    const { c, store } = build();
    store.getById.mockResolvedValueOnce(null);
    const e = await errorOf(c.activateVersion(V1, auth('platform'), RID));
    expect(e.code).toBe('NOT_FOUND');
    expect(e.statusCode).toBe(404);

    store.activateVersion.mockRejectedValueOnce(new MatchingPolicyVersionNotFoundError(V2));
    const e2 = await errorOf(c.activateVersion(V2, auth('platform'), RID));
    expect(e2.code).toBe('NOT_FOUND');
  });

  it('activateVersion refuses a version whose stored document the engine could not read', async () => {
    const { c, store } = build();
    store.getById.mockResolvedValueOnce(row({ id: V2, status: 'DRAFT', evidence_thresholds: { architect: 3 } }));
    const e = await errorOf(c.activateVersion(V2, auth('platform'), RID));
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(store.activateVersion).not.toHaveBeenCalled();
  });

  it('activateVersion returns the now-ACTIVE version', async () => {
    const { c } = build();
    const v = await c.activateVersion(V2, auth('platform'), RID);
    expect(v.status).toBe('ACTIVE');
    expect(v.id).toBe(V2);
  });
});

describe('StoreMatchingPolicySource', () => {
  it('returns null when the store holds no ACTIVE version', async () => {
    const store = { getActive: vi.fn(async () => null) };
    const src = new StoreMatchingPolicySource(store as unknown as MatchingPolicyRepository);
    expect(await src.getActivePolicy()).toBeNull();
  });

  it('returns the parsed ACTIVE version', async () => {
    const store = { getActive: vi.fn(async () => row()) };
    const src = new StoreMatchingPolicySource(store as unknown as MatchingPolicyRepository);
    expect(await src.getActivePolicy()).toEqual({ version_number: 1, evidence_thresholds: DEFAULT_EVIDENCE_THRESHOLDS });
  });

  it('throws on a malformed stored document (never a silent fallback)', async () => {
    const store = { getActive: vi.fn(async () => row({ evidence_thresholds: {} })) };
    const src = new StoreMatchingPolicySource(store as unknown as MatchingPolicyRepository);
    await expect(src.getActivePolicy()).rejects.toThrow(/malformed/);
  });
});
