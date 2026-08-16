import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildConnectorSecretRef } from '../lib/secrets/connector-secret-ref.js';
import {
  ConnectorSecretResolver,
  ConnectorSecretResolutionError,
} from '../lib/secrets/connector-secret-resolver.js';

import { FakeConnectionLoader, FakeSecretsManager } from './support/fakes.js';

// T8-CONNECTOR-A — resolver isolation proof (directive §7/§8, Architect check #1).
// The Secrets Manager must NEVER be reached for a foreign-tenant, unconfigured,
// or mis-bound connection; the derived SM id must come from the connection's own
// tenant/id.

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const TENANT_B = '01900000-0000-7000-8000-0000000000b2';
const CONN_A = '01900000-0000-7000-8000-000000000a11';
const CONN_B = '01900000-0000-7000-8000-000000000b22';

describe('ConnectorSecretResolver — tenant isolation', () => {
  beforeEach(() => {
    process.env['ARAMO_ENV'] = 'test';
  });
  afterEach(() => {
    delete process.env['ARAMO_ENV'];
  });

  function build(rows: Array<{ id: string; tenant_id: string; secret_ref: string | null }>) {
    const sm = new FakeSecretsManager({
      [`aramo/test/connector/${TENANT_A}/${CONN_A}`]: 'tenant-A-credential',
      [`aramo/test/connector/${TENANT_B}/${CONN_B}`]: 'tenant-B-credential',
    });
    const resolver = new ConnectorSecretResolver(new FakeConnectionLoader(rows), sm);
    return { resolver, sm };
  }

  it('resolves the credential for a configured, tenant-owned connection (derives SM id from the connection row)', async () => {
    const { resolver, sm } = build([
      {
        id: CONN_A,
        tenant_id: TENANT_A,
        secret_ref: buildConnectorSecretRef({ tenant_id: TENANT_A, connection_id: CONN_A }),
      },
    ]);
    const value = await resolver.resolveForExecution({ tenant_id: TENANT_A, connection_id: CONN_A });
    expect(value).toBe('tenant-A-credential');
    expect(sm.requested).toEqual([`aramo/test/connector/${TENANT_A}/${CONN_A}`]);
  });

  it('does NOT resolve Tenant B\'s connection under Tenant A — tenant-safe NOT_FOUND, SM never reached', async () => {
    const { resolver, sm } = build([
      {
        id: CONN_B,
        tenant_id: TENANT_B,
        secret_ref: buildConnectorSecretRef({ tenant_id: TENANT_B, connection_id: CONN_B }),
      },
    ]);
    await expect(
      resolver.resolveForExecution({ tenant_id: TENANT_A, connection_id: CONN_B }),
    ).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
    expect(sm.requested).toEqual([]); // Secrets Manager NEVER reached
  });

  it('rejects a connection with no configured secret (SM never reached)', async () => {
    const { resolver, sm } = build([{ id: CONN_A, tenant_id: TENANT_A, secret_ref: null }]);
    await expect(
      resolver.resolveForExecution({ tenant_id: TENANT_A, connection_id: CONN_A }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_SECRET_UNAVAILABLE' });
    expect(sm.requested).toEqual([]);
  });

  it('rejects a tampered secret_ref bound to a different tenant (SM never reached)', async () => {
    // The row is Tenant A's, but its stored secret_ref was forged to bind Tenant B.
    const { resolver, sm } = build([
      {
        id: CONN_A,
        tenant_id: TENANT_A,
        secret_ref: buildConnectorSecretRef({ tenant_id: TENANT_B, connection_id: CONN_B }),
      },
    ]);
    await expect(
      resolver.resolveForExecution({ tenant_id: TENANT_A, connection_id: CONN_A }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_SECRET_BINDING_MISMATCH' });
    expect(sm.requested).toEqual([]);
  });

  it('throws a typed ConnectorSecretResolutionError (internal, not a governed ErrorCode)', async () => {
    const { resolver } = build([]);
    await expect(
      resolver.resolveForExecution({ tenant_id: TENANT_A, connection_id: CONN_A }),
    ).rejects.toBeInstanceOf(ConnectorSecretResolutionError);
  });
});
