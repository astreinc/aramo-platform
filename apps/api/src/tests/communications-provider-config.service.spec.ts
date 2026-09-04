import { describe, expect, it, vi } from 'vitest';
import { ZoomPhoneAdapter, decodeZoomCredential } from '@aramo/communications';

import { CommunicationsApiService } from '../communications/communications-api.service.js';

// COMM-C1 — fast unit proofs for the tenant communication provider CONFIGURATION
// orchestration (list / configure-credential / test). No DB, no testcontainers:
// the IntegrationConnectionService + repo are mocked so we can assert the
// credential-path CLOSURE precisely — the raw Zoom bundle is encoded and handed
// to the Integration credential path (→ Secrets Manager), never persisted or
// returned. HTTP-boundary authz + the real Postgres secret_ref write are proven
// separately in communications-authz.integration.spec.ts.

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const CONNECTION = '01900000-0000-7000-8000-0000000000c1';

interface ConnRow {
  id: string;
  tenant_id: string;
  provider_key: string;
  status: 'disconnected' | 'configured' | 'active' | 'degraded' | 'disabled';
  has_secret: boolean;
  provider_account_id: string | null;
  last_attempted_at: string | null;
  last_successful_at: string | null;
  last_error_code: string | null;
  last_error_summary: string | null;
  created_at: string;
  updated_at: string;
}

function baseRow(over: Partial<ConnRow> = {}): ConnRow {
  return {
    id: CONNECTION,
    tenant_id: TENANT_A,
    provider_key: 'zoom_phone',
    status: 'configured',
    has_secret: true,
    provider_account_id: 'zoom-acct-1',
    last_attempted_at: null,
    last_successful_at: null,
    last_error_code: null,
    last_error_summary: null,
    created_at: '2026-09-03T00:00:00.000Z',
    updated_at: '2026-09-03T00:00:00.000Z',
    ...over,
  };
}

// A mutable in-memory connection store so configure→re-read stays consistent.
function makeHarness(initial: ConnRow[] = []) {
  const store = [...initial];
  const setCredential = vi.fn(async (args: { tenant_id: string; id: string; credential: string }) => {
    const row = store.find((c) => c.id === args.id);
    if (row) {
      row.has_secret = true;
      row.status = 'configured';
    }
    return row;
  });
  const connections = {
    listConnections: vi.fn(async (t: string) => store.filter((c) => c.tenant_id === t)),
    getConnection: vi.fn(async (t: string, id: string) =>
      store.find((c) => c.tenant_id === t && c.id === id),
    ),
    createConnection: vi.fn(
      async (args: { tenant_id: string; provider_key: string; provider_account_id?: string | null }) => {
        const row = baseRow({
          id: '01900000-0000-7000-8000-0000000000c9',
          tenant_id: args.tenant_id,
          provider_key: args.provider_key,
          status: 'disconnected',
          has_secret: false,
          provider_account_id: args.provider_account_id ?? null,
        });
        store.push(row);
        return row;
      },
    ),
    updateConnection: vi.fn(
      async (t: string, id: string, patch: { provider_account_id?: string | null }) => {
        const row = store.find((c) => c.tenant_id === t && c.id === id);
        if (row && patch.provider_account_id !== undefined) row.provider_account_id = patch.provider_account_id;
        return row;
      },
    ),
    setCredential,
  } as unknown as ConstructorParameters<typeof CommunicationsApiService>[2];

  const providers = {
    resolve: vi.fn((key: string) => (key === 'zoom_phone' ? new ZoomPhoneAdapter() : null)),
  } as unknown as ConstructorParameters<typeof CommunicationsApiService>[1];

  const repo = {
    listProviderIdentitiesForConnection: vi.fn(async () => []),
  } as unknown as ConstructorParameters<typeof CommunicationsApiService>[0];

  const service = new CommunicationsApiService(repo, providers, connections);
  return { service, connections, providers, repo, setCredential, store };
}

describe('CommunicationsApiService — COMM-C1 provider configuration', () => {
  it('lists an unconfigured provider as not_configured with capability posture', async () => {
    const { service } = makeHarness([]);
    const items = await service.listProviderConfigurations(TENANT_A);
    expect(items).toHaveLength(1);
    const zoom = items[0];
    expect(zoom.provider_key).toBe('zoom_phone');
    expect(zoom.display_name).toBe('Zoom Phone');
    expect(zoom.connection_id).toBeNull();
    expect(zoom.configuration_state).toBe('not_configured');
    expect(zoom.credential_configured).toBe(false);
    // Voice is executable; SMS is declared but NOT executable in PR-1.
    expect(zoom.capabilities.voice).toEqual({ supported: true, execution: 'available' });
    expect(zoom.capabilities.sms).toEqual({ supported: true, execution: 'not_available' });
  });

  it('reflects a configured connection (credential present, account bound)', async () => {
    const { service } = makeHarness([baseRow()]);
    const [zoom] = await service.listProviderConfigurations(TENANT_A);
    expect(zoom.configuration_state).toBe('configured');
    expect(zoom.credential_configured).toBe(true);
    expect(zoom.provider_account_id).toBe('zoom-acct-1');
  });

  it('configure ENCODES the bundle and writes it through the Integration credential path', async () => {
    const { service, setCredential, connections } = makeHarness([]);
    const dto = await service.configureZoomCredential(
      TENANT_A,
      { access_token: 'atk-123', refresh_token: 'rtk-456', account_id: 'zoom-acct-9' },
      'req-1',
    );
    // Provisioned a connection, then wrote the credential ONCE.
    expect(connections.createConnection).toHaveBeenCalledTimes(1);
    expect(setCredential).toHaveBeenCalledTimes(1);
    // The value handed to Secrets Manager is the ENCODED Zoom bundle, not a raw
    // field — decodes back to the same access/refresh tokens.
    const written = setCredential.mock.calls[0][0].credential as string;
    const decoded = decodeZoomCredential(written);
    expect(decoded.access_token).toBe('atk-123');
    expect(decoded.refresh_token).toBe('rtk-456');
    // The returned config is SECRET-FREE — no token appears anywhere in it.
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('atk-123');
    expect(serialized).not.toContain('rtk-456');
    expect(dto.credential_configured).toBe(true);
  });

  it('rejects an invalid credential bundle with VALIDATION_ERROR (400)', async () => {
    const { service, setCredential } = makeHarness([]);
    await expect(
      service.configureZoomCredential(TENANT_A, { access_token: '' }, 'req-2'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    // Fail-closed: no secret write attempted on an invalid bundle.
    expect(setCredential).not.toHaveBeenCalled();
  });

  it('test returns a truthful STRUCTURAL health result, never a live-ping claim', async () => {
    const { service } = makeHarness([baseRow({ provider_account_id: 'zoom-acct-1' })]);
    const result = await service.testProviderConnection(TENANT_A, 'req-3');
    expect(result).toEqual({
      provider_key: 'zoom_phone',
      healthy: true,
      detail: null,
      checked: 'structural',
    });
  });

  it('test on an unbound account is truthfully unhealthy (no fake success)', async () => {
    const { service } = makeHarness([baseRow({ provider_account_id: null })]);
    const result = await service.testProviderConnection(TENANT_A, 'req-4');
    expect(result.healthy).toBe(false);
    expect(result.checked).toBe('structural');
  });

  it('test with no provider connection is fail-closed (409 PROVIDER_NOT_CONFIGURED)', async () => {
    const { service } = makeHarness([]);
    await expect(service.testProviderConnection(TENANT_A, 'req-5')).rejects.toMatchObject({
      code: 'COMMUNICATION_PROVIDER_NOT_CONFIGURED',
      statusCode: 409,
    });
  });

  it('reuses (does not duplicate) an existing connection on re-configure', async () => {
    const { service, connections } = makeHarness([baseRow({ has_secret: false, status: 'disconnected' })]);
    await service.configureZoomCredential(TENANT_A, { access_token: 'atk-x' }, 'req-6');
    // No second connection created — the existing zoom_phone row is reused.
    expect(connections.createConnection).not.toHaveBeenCalled();
  });
});
