import { describe, expect, it } from 'vitest';

import { ConnectorAdapterRegistry } from '../lib/adapter/connector-adapter.registry.js';
import { ConnectionServiceError } from '../lib/connection/integration-connection.service.js';
import {
  CONNECTOR_QUEUE_ATTEMPTS,
  CONNECTOR_QUEUE_BACKOFF,
  ConnectorTransientError,
  classifyFailure,
  shouldRetry,
} from '../lib/execution/failure-taxonomy.js';
import { ConnectorSecretResolutionError } from '../lib/secrets/connector-secret-resolver.js';

import { FakeConnectorAdapter } from './support/fakes.js';

// T8-CONNECTOR-A — BullMQ failure taxonomy (directive §17, Architect check #4).

describe('connector failure taxonomy', () => {
  it('transient transport/infra failures retry within a fixed bound', () => {
    for (const reason of ['timeout', 'provider_unavailable', 'throttled', 'secret_backend_unavailable'] as const) {
      const err = new ConnectorTransientError(reason, reason);
      expect(classifyFailure(err)).toBe('transient');
      expect(shouldRetry(err)).toBe(true);
    }
    expect(CONNECTOR_QUEUE_ATTEMPTS).toBeGreaterThan(0);
    expect(Number.isFinite(CONNECTOR_QUEUE_ATTEMPTS)).toBe(true); // no infinite retry
    expect(CONNECTOR_QUEUE_BACKOFF.type).toBe('exponential');
  });

  it('config/secret/service errors are PERMANENT (no retry loop)', () => {
    expect(shouldRetry(new ConnectorSecretResolutionError('CONNECTION_NOT_FOUND', 'x'))).toBe(false);
    expect(shouldRetry(new ConnectorSecretResolutionError('CONNECTOR_SECRET_UNAVAILABLE', 'x'))).toBe(false);
    expect(shouldRetry(new ConnectionServiceError('CONNECTOR_CONFIGURATION_INVALID', 'x'))).toBe(false);
    expect(shouldRetry(new ConnectionServiceError('CONNECTION_ILLEGAL_TRANSITION', 'x'))).toBe(false);
  });

  it('unknown errors default to PERMANENT — no queue storm on a permanently broken connection', () => {
    expect(classifyFailure(new Error('mapping rejected'))).toBe('permanent');
    expect(shouldRetry(new Error('canonical validation rejected'))).toBe(false);
    expect(shouldRetry('weird')).toBe(false);
  });
});

describe('connector adapter registry (extensible, no vendor enum)', () => {
  it('resolves a registered adapter by provider key and returns null otherwise', async () => {
    const registry = new ConnectorAdapterRegistry();
    expect(registry.resolve('fake')).toBeNull();
    const adapter = new FakeConnectorAdapter({ delivery_key: 'D1', records: [] });
    registry.register(adapter);
    expect(registry.has('fake')).toBe(true);
    expect(registry.resolve('fake')).toBe(adapter);
    expect(registry.resolve('unregistered_provider')).toBeNull();

    const out = await registry.resolve('fake')!.fetchExecutionInput({
      tenant_id: 't',
      connection_id: 'c',
      provider_key: 'fake',
      cursor: null,
      credential: null,
    });
    expect(out.delivery_key).toBe('D1');
  });
});
