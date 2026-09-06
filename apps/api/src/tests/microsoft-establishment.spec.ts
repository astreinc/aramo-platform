import { describe, expect, it, vi } from 'vitest';
import type { IntegrationConnectionView } from '@aramo/integration';

import { MicrosoftConfigResolver } from '../microsoft/microsoft-config.resolver.js';
import { MicrosoftAuthorizationOrchestrator } from '../microsoft/microsoft-authorization.orchestrator.js';

// COMM PART B — tenant-admin Microsoft establishment: connection create/update,
// client-secret WRITE-ONLY custody (Secrets Manager, never returned), and the
// never-throw configuration_state. Tenant configuration and recruiter delegated
// authorization are distinct axes.

const TENANT_A = '00000000-0000-7000-8000-00000000a001';
const TENANT_B = '00000000-0000-7000-8000-00000000b001';

function connView(over: Partial<IntegrationConnectionView> = {}): IntegrationConnectionView {
  return {
    id: 'conn-1',
    tenant_id: TENANT_A,
    provider_key: 'microsoft_graph',
    status: 'configured',
    has_secret: true,
    provider_account_id: null,
    last_attempted_at: null,
    last_successful_at: null,
    last_error_code: null,
    last_error_summary: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function makeConnections() {
  return {
    findConnectionByProviderKey: vi.fn().mockResolvedValue(null),
    createConnection: vi.fn().mockResolvedValue(connView({ status: 'created', has_secret: false })),
    updateConnection: vi.fn().mockResolvedValue(connView({ status: 'configured', has_secret: true })),
    setCredential: vi.fn().mockResolvedValue(connView({ status: 'configured', has_secret: true })),
  };
}

function makeResolver(connections: ReturnType<typeof makeConnections>) {
  const secrets = { getSecretValue: vi.fn().mockResolvedValue('irrelevant') };
  return new MicrosoftConfigResolver(connections as never, secrets as never);
}

const identities = { countByStatus: vi.fn().mockResolvedValue({ active: 0, disabled: 0, reauth_required: 0, unmapped: 0 }) };
function makeOrchestrator(resolver: MicrosoftConfigResolver) {
  return new MicrosoftAuthorizationOrchestrator({} as never, resolver, identities as never);
}

describe('MicrosoftConfigResolver.configureConnection (PART B)', () => {
  it('creates a connection with config = client_id + authority_tenant when none exists', async () => {
    const connections = makeConnections();
    const resolver = makeResolver(connections);
    await resolver.configureConnection(TENANT_A, {
      client_id: 'app-123',
      authority_tenant: 'contoso.onmicrosoft.com',
      client_secret: 'super-secret',
    });
    expect(connections.createConnection).toHaveBeenCalledWith({
      tenant_id: TENANT_A,
      provider_key: 'microsoft_graph',
      config: { client_id: 'app-123', authority_tenant: 'contoso.onmicrosoft.com' },
    });
  });

  it('writes the client secret WRITE-ONLY via setCredential — never persisted in config/returned', async () => {
    const connections = makeConnections();
    const resolver = makeResolver(connections);
    const summary = await resolver.configureConnection(TENANT_A, {
      client_id: 'app-123',
      authority_tenant: 'contoso',
      client_secret: 'super-secret',
    });
    expect(connections.setCredential).toHaveBeenCalledWith(expect.objectContaining({ credential: 'super-secret' }));
    // The non-secret config write must NOT include the secret.
    const createdConfig = connections.createConnection.mock.calls[0]![0].config as Record<string, unknown>;
    expect(JSON.stringify(createdConfig)).not.toContain('super-secret');
    // The summary is secret-free.
    expect(JSON.stringify(summary)).not.toContain('super-secret');
    expect(summary.has_secret).toBe(true);
  });

  it('updates an existing connection (no duplicate) and can rotate the secret', async () => {
    const connections = makeConnections();
    connections.findConnectionByProviderKey.mockResolvedValue(connView({ id: 'existing', has_secret: true }));
    const resolver = makeResolver(connections);
    await resolver.configureConnection(TENANT_A, { client_id: 'app-9', authority_tenant: 'contoso', client_secret: 'rotated' });
    expect(connections.createConnection).not.toHaveBeenCalled();
    expect(connections.updateConnection).toHaveBeenCalledWith(TENANT_A, 'existing', {
      config: { client_id: 'app-9', authority_tenant: 'contoso' },
    });
    expect(connections.setCredential).toHaveBeenCalledWith(expect.objectContaining({ credential: 'rotated' }));
  });

  it('omitting client_secret on update keeps the stored secret (no setCredential)', async () => {
    const connections = makeConnections();
    connections.findConnectionByProviderKey.mockResolvedValue(connView({ id: 'existing', has_secret: true }));
    const resolver = makeResolver(connections);
    const summary = await resolver.configureConnection(TENANT_A, { client_id: 'app-9', authority_tenant: 'contoso' });
    expect(connections.setCredential).not.toHaveBeenCalled();
    expect(summary.has_secret).toBe(true); // preserved
  });

  it('tenant isolation — every op is scoped to the acting tenant', async () => {
    const connections = makeConnections();
    const resolver = makeResolver(connections);
    await resolver.configureConnection(TENANT_B, { client_id: 'x', authority_tenant: 'y', client_secret: 'z' });
    expect(connections.findConnectionByProviderKey).toHaveBeenCalledWith(TENANT_B, 'microsoft_graph');
    expect(connections.createConnection.mock.calls[0]![0].tenant_id).toBe(TENANT_B);
    expect(connections.setCredential.mock.calls[0]![0].tenant_id).toBe(TENANT_B);
  });
});

describe('MicrosoftAuthorizationOrchestrator.getProviderStatus (PART B / B5 — never throws)', () => {
  it('NOT_CONFIGURED with zero recruiter bindings when no connection (safe-disconnected)', async () => {
    const connections = makeConnections();
    connections.findConnectionByProviderKey.mockResolvedValue(null);
    const orch = makeOrchestrator(makeResolver(connections));
    const s = await orch.getProviderStatus(TENANT_A);
    expect(s.configuration_state).toBe('NOT_CONFIGURED');
    expect(s.connection_id).toBeNull();
    expect(s.identities.active).toBe(0);
  });

  it('CONFIGURED when a usable connection exists (config + secret)', async () => {
    const connections = makeConnections();
    connections.findConnectionByProviderKey.mockResolvedValue(connView({ status: 'configured', has_secret: true }));
    const orch = makeOrchestrator(makeResolver(connections));
    expect((await orch.getProviderStatus(TENANT_A)).configuration_state).toBe('CONFIGURED');
  });

  it('REQUIRES_ATTENTION when the connection exists but has no secret', async () => {
    const connections = makeConnections();
    connections.findConnectionByProviderKey.mockResolvedValue(connView({ status: 'configured', has_secret: false }));
    const orch = makeOrchestrator(makeResolver(connections));
    expect((await orch.getProviderStatus(TENANT_A)).configuration_state).toBe('REQUIRES_ATTENTION');
  });

  it('configured provider with zero recruiter bindings ≠ unconfigured (distinct axes)', async () => {
    const connections = makeConnections();
    connections.findConnectionByProviderKey.mockResolvedValue(connView({ has_secret: true }));
    identities.countByStatus.mockResolvedValueOnce({ active: 0, disabled: 0, reauth_required: 0, unmapped: 0 });
    const orch = makeOrchestrator(makeResolver(connections));
    const s = await orch.getProviderStatus(TENANT_A);
    expect(s.configuration_state).toBe('CONFIGURED'); // configured...
    expect(s.identities.active).toBe(0); // ...but no recruiter authorized yet
  });
});
