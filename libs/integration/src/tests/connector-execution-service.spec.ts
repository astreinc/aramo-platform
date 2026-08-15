import { describe, expect, it } from 'vitest';
import type { ImportBatchView } from '@aramo/import';

import { ConnectorAdapterRegistry } from '../lib/adapter/connector-adapter.registry.js';
import type { ConnectorAdapter } from '../lib/adapter/connector-adapter.port.js';
import type { IntegrationConnectionRepository } from '../lib/connection/integration-connection.repository.js';
import { ConnectorExecutionOrchestrator } from '../lib/execution/connector-execution.orchestrator.js';
import { ConnectorExecutionService } from '../lib/execution/connector-execution.service.js';
import { ConnectorTransientError } from '../lib/execution/failure-taxonomy.js';
import { EXTERNAL_IDENTITY_CONFLICT_REASON } from '../lib/handoff/requisition-import-handoff.port.js';
import type { ConnectorSecretResolver } from '../lib/secrets/connector-secret-resolver.js';

import { FakeDeliveryLedger, FakeHandoff } from './support/fakes.js';

// T8-CONNECTOR-A — processor-facing execution service: DELIBERATE outcome→retry
// translation (Architect check #4). Transient → re-throw (BullMQ retries);
// terminal → return (no auto-retry).

const TENANT = '01900000-0000-7000-8000-0000000000a1';
const CONN = '01900000-0000-7000-8000-000000000a11';

class FakeRepo {
  status: string[] = [];
  errors: string[] = [];
  attempts = 0;
  successes = 0;
  constructor(private readonly row: { provider_key: string; secret_ref: string | null } | null) {}
  async recordAttempt() {
    this.attempts += 1;
  }
  async findByIdForTenant() {
    return this.row === null
      ? null
      : { id: CONN, tenant_id: TENANT, provider_key: this.row.provider_key, status: 'active', secret_ref: this.row.secret_ref, cursor: null };
  }
  async recordSuccess() {
    this.successes += 1;
  }
  async recordError(_t: string, _id: string, code: string) {
    this.errors.push(code);
  }
}

function batch(over: Partial<ImportBatchView>): ImportBatchView {
  return {
    id: 'batch-1', tenant_id: TENANT, site_id: null, imported_by_id: 'x', target_entity: 'requisition',
    source_filename: 's', row_count: 1, success_count: 1, failure_count: 0, status: 'committed',
    created_at: '2026-08-14T00:00:00.000Z', committed_at: '2026-08-14T00:00:00.000Z', reverted_at: null, ...over,
  };
}

const record = { source_system: 'fake', external_req_id: 'R1', title: 'T', openings: 1, company_id: '01900000-0000-7000-8000-0000000000c0' };

function fakeAdapter(behavior: 'ok' | 'transient'): ConnectorAdapter {
  return {
    providerKey: 'fake',
    async fetchExecutionInput() {
      if (behavior === 'transient') throw new ConnectorTransientError('timeout', 'provider timed out');
      return { delivery_key: 'D1', records: [record] };
    },
  };
}

const noResolver = {} as unknown as ConnectorSecretResolver; // secret_ref null → never called

function make(repo: FakeRepo, adapter?: ConnectorAdapter) {
  const registry = new ConnectorAdapterRegistry();
  if (adapter) registry.register(adapter);
  const orch = new ConnectorExecutionOrchestrator(new FakeDeliveryLedger(), new FakeHandoff({ batch: batch({}) }));
  return new ConnectorExecutionService(repo as unknown as IntegrationConnectionRepository, noResolver, registry, orch);
}

describe('ConnectorExecutionService — outcome→retry translation', () => {
  it('PROCESSED → returns outcome and recovers the connection (recordSuccess)', async () => {
    const repo = new FakeRepo({ provider_key: 'fake', secret_ref: null });
    const svc = make(repo, fakeAdapter('ok'));
    const out = await svc.runDelivery({ tenant_id: TENANT, connection_id: CONN, requestId: 'r' });
    expect(out.outcome).toBe('PROCESSED');
    expect(repo.successes).toBe(1);
    expect(repo.attempts).toBe(1);
  });

  it('transient adapter failure → RE-THROWS (BullMQ retries) + degrades connection', async () => {
    const repo = new FakeRepo({ provider_key: 'fake', secret_ref: null });
    const svc = make(repo, fakeAdapter('transient'));
    await expect(svc.runDelivery({ tenant_id: TENANT, connection_id: CONN, requestId: 'r' })).rejects.toBeInstanceOf(
      ConnectorTransientError,
    );
    expect(repo.errors).toContain('CONNECTOR_EXECUTION_UNAVAILABLE');
  });

  it('permanent config (no adapter registered) → RETURNS FAILED (no throw, no retry)', async () => {
    const repo = new FakeRepo({ provider_key: 'unregistered', secret_ref: null });
    const svc = make(repo /* no adapter */);
    const out = await svc.runDelivery({ tenant_id: TENANT, connection_id: CONN, requestId: 'r' });
    expect(out).toMatchObject({ outcome: 'FAILED', retryable: false });
    expect(repo.errors).toContain('CONNECTOR_CONFIGURATION_INVALID');
  });

  it('UNSUPPORTED amendment → returns outcome without degrading the connection', async () => {
    const repo = new FakeRepo({ provider_key: 'fake', secret_ref: null });
    const registry = new ConnectorAdapterRegistry();
    registry.register(fakeAdapter('ok'));
    const orch = new ConnectorExecutionOrchestrator(
      new FakeDeliveryLedger(),
      new FakeHandoff({
        batch: batch({ success_count: 0, failure_count: 1, status: 'rejected' }),
        failures: [{ row_number: 1, failure_reason: EXTERNAL_IDENTITY_CONFLICT_REASON }],
      }),
    );
    const svc = new ConnectorExecutionService(repo as unknown as IntegrationConnectionRepository, noResolver, registry, orch);
    const out = await svc.runDelivery({ tenant_id: TENANT, connection_id: CONN, requestId: 'r' });
    expect(out.outcome).toBe('UNSUPPORTED_EXISTING_REQUISITION_UPDATE');
    expect(repo.successes).toBe(0);
    expect(repo.errors).toEqual([]); // delivery-level; connection not degraded
  });
});
