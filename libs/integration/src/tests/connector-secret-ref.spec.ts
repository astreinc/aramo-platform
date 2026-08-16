import { describe, expect, it } from 'vitest';

import {
  assertConnectorSecretRefBinding,
  buildConnectorSecretRef,
  deriveConnectorSecretManagerId,
  parseConnectorSecretRef,
} from '../lib/secrets/connector-secret-ref.js';

// T8-CONNECTOR-A — tenant-bound opaque secret reference (directive §7/§8).
// These prove the isolation property at the reference layer: a secret_ref is
// server-generated, encodes its (tenant, connection) binding, and cannot be
// re-pointed at another tenant's secret by input manipulation.

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const TENANT_B = '01900000-0000-7000-8000-0000000000b2';
const CONN_1 = '01900000-0000-7000-8000-000000000c11';
const CONN_2 = '01900000-0000-7000-8000-000000000c22';

describe('connector secret_ref — construction/parse', () => {
  it('builds a stable opaque, versioned, tenant-bound reference', () => {
    expect(buildConnectorSecretRef({ tenant_id: TENANT_A, connection_id: CONN_1 })).toBe(
      `connector:v1:${TENANT_A}:${CONN_1}`,
    );
  });

  it('round-trips build → parse', () => {
    const ref = buildConnectorSecretRef({ tenant_id: TENANT_A, connection_id: CONN_1 });
    expect(parseConnectorSecretRef(ref)).toEqual({
      version: 'v1',
      tenant_id: TENANT_A,
      connection_id: CONN_1,
    });
  });

  it('rejects a non-uuid tenant/connection at build', () => {
    expect(() => buildConnectorSecretRef({ tenant_id: 'nope', connection_id: CONN_1 })).toThrow(
      /invalid tenant_id/,
    );
  });

  it.each([
    ['malformed (too few parts)', 'connector:v1:only-three'],
    ['wrong prefix', `secretpath:v1:${TENANT_A}:${CONN_1}`],
    ['unsupported version', `connector:v9:${TENANT_A}:${CONN_1}`],
    ['non-uuid segment', 'connector:v1:not-a-uuid:also-not'],
    ['arbitrary aws path', `aramo/prod/connector/${TENANT_A}/${CONN_1}`],
  ])('parse rejects %s', (_label, ref) => {
    expect(() => parseConnectorSecretRef(ref)).toThrow();
  });
});

describe('connector secret_ref — tenant isolation (§8)', () => {
  it('binding assertion passes when ref matches the executing connection', () => {
    const ref = buildConnectorSecretRef({ tenant_id: TENANT_A, connection_id: CONN_1 });
    expect(() =>
      assertConnectorSecretRefBinding(ref, { tenant_id: TENANT_A, connection_id: CONN_1 }),
    ).not.toThrow();
  });

  it('REJECTS a Tenant-B ref asserted against a Tenant-A connection (cross-tenant substitution)', () => {
    const foreignRef = buildConnectorSecretRef({ tenant_id: TENANT_B, connection_id: CONN_2 });
    expect(() =>
      assertConnectorSecretRefBinding(foreignRef, { tenant_id: TENANT_A, connection_id: CONN_1 }),
    ).toThrow(/binding mismatch/);
  });

  it('REJECTS a ref whose connection id was swapped (same tenant, different connection)', () => {
    const ref = buildConnectorSecretRef({ tenant_id: TENANT_A, connection_id: CONN_1 });
    expect(() =>
      assertConnectorSecretRefBinding(ref, { tenant_id: TENANT_A, connection_id: CONN_2 }),
    ).toThrow(/binding mismatch/);
  });
});

describe('connector secret_ref — server-derived Secrets Manager id', () => {
  it('derives an env-scoped, tenant-namespaced, server-controlled SM id', () => {
    expect(
      deriveConnectorSecretManagerId({ env: 'prod', tenant_id: TENANT_A, connection_id: CONN_1 }),
    ).toBe(`aramo/prod/connector/${TENANT_A}/${CONN_1}`);
  });

  it('refuses to derive without an env', () => {
    expect(() =>
      deriveConnectorSecretManagerId({ env: '', tenant_id: TENANT_A, connection_id: CONN_1 }),
    ).toThrow(/ARAMO_ENV/);
  });

  it('refuses to derive from a non-uuid (no client-controlled path injection)', () => {
    expect(() =>
      deriveConnectorSecretManagerId({
        env: 'prod',
        tenant_id: '../../../etc/passwd',
        connection_id: CONN_1,
      }),
    ).toThrow(/invalid tenant_id/);
  });
});
