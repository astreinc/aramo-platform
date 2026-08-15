import { describe, expect, it } from 'vitest';
import type { ImportBatchView } from '@aramo/import';

import { CONNECTOR_SERVICE_ACCOUNT_ID } from '../lib/domain/connector-actor.js';
import { ConnectorExecutionOrchestrator } from '../lib/execution/connector-execution.orchestrator.js';
import { EXTERNAL_IDENTITY_CONFLICT_REASON } from '../lib/handoff/requisition-import-handoff.port.js';

import { FakeDeliveryLedger, FakeHandoff } from './support/fakes.js';

// T8-CONNECTOR-A — the load-bearing distinction (directive §15/§19/§41, Architect
// check #2): exact transport redelivery is a benign no-op; a changed-content
// delivery for an existing external identity is an unsupported business
// amendment — no mutation, no infinite retry.

const TENANT = '01900000-0000-7000-8000-0000000000a1';
const CONN = '01900000-0000-7000-8000-000000000a11';

function batchView(over: Partial<ImportBatchView>): ImportBatchView {
  return {
    id: 'batch-1',
    tenant_id: TENANT,
    site_id: null,
    imported_by_id: CONNECTOR_SERVICE_ACCOUNT_ID,
    target_entity: 'requisition',
    source_filename: 'connector:acme_vms:conn',
    row_count: 1,
    success_count: 1,
    failure_count: 0,
    status: 'committed',
    created_at: '2026-08-14T00:00:00.000Z',
    committed_at: '2026-08-14T00:00:00.000Z',
    reverted_at: null,
    ...over,
  };
}

const record = {
  source_system: 'acme_vms',
  external_req_id: 'REQ-1',
  title: 'Engineer',
  openings: 1,
  company_id: '01900000-0000-7000-8000-0000000000c0',
};

function input(delivery_key: string) {
  return {
    tenant_id: TENANT,
    connection_id: CONN,
    provider_key: 'acme_vms',
    delivery_key,
    records: [record],
    requestId: 'req-1',
  };
}

describe('ConnectorExecutionOrchestrator — transport idempotency', () => {
  it('creates a new ImportBatch for a fresh delivery and marks it processed (machine actor)', async () => {
    const ledger = new FakeDeliveryLedger();
    const handoff = new FakeHandoff({ batch: batchView({}) });
    const orch = new ConnectorExecutionOrchestrator(ledger, handoff);

    const out = await orch.execute(input('DLV-1'));

    expect(out).toEqual({ outcome: 'PROCESSED', import_batch_id: 'batch-1' });
    expect(handoff.runCalls).toHaveLength(1);
    // machine actor + minimum scope, never a human
    expect(handoff.runCalls[0].imported_by_id).toBe(CONNECTOR_SERVICE_ACCOUNT_ID);
    expect(handoff.runCalls[0].scopes).toEqual(['requisition:import:write']);
    expect(ledger.snapshot()[0]).toMatchObject({ status: 'processed', import_batch_id: 'batch-1' });
  });

  it('EXACT transport redelivery (same delivery_key already processed) → ALREADY_PROCESSED, handoff NOT invoked, no second batch', async () => {
    const ledger = new FakeDeliveryLedger();
    ledger.seed({
      id: 'd-existing',
      tenant_id: TENANT,
      connection_id: CONN,
      delivery_key: 'DLV-1',
      status: 'processed',
      import_batch_id: 'batch-1',
      detail_code: null,
    });
    const handoff = new FakeHandoff({ batch: batchView({ id: 'batch-2' }) });
    const orch = new ConnectorExecutionOrchestrator(ledger, handoff);

    const out = await orch.execute(input('DLV-1'));

    expect(out).toEqual({ outcome: 'ALREADY_PROCESSED', import_batch_id: 'batch-1' });
    expect(handoff.runCalls).toHaveLength(0); // ImportService NEVER invoked again
  });

  it('CHANGED content for an EXISTING external identity (different delivery_key) → UNSUPPORTED_EXISTING_REQUISITION_UPDATE, no mutation', async () => {
    const ledger = new FakeDeliveryLedger();
    // The identity was already ingested by a prior delivery; the new delivery
    // has a different key (changed content) and P2 rejects it as an identity
    // conflict — CREATE-only, so nothing is mutated.
    const handoff = new FakeHandoff({
      batch: batchView({ id: 'batch-3', success_count: 0, failure_count: 1, status: 'rejected' }),
      failures: [{ row_number: 1, failure_reason: EXTERNAL_IDENTITY_CONFLICT_REASON }],
    });
    const orch = new ConnectorExecutionOrchestrator(ledger, handoff);

    const out = await orch.execute(input('DLV-2-changed'));

    expect(out).toEqual({
      outcome: 'UNSUPPORTED_EXISTING_REQUISITION_UPDATE',
      import_batch_id: 'batch-3',
    });
    expect(ledger.snapshot()[0]).toMatchObject({
      status: 'unsupported',
      detail_code: 'UNSUPPORTED_EXISTING_REQUISITION_UPDATE',
    });
  });

  it('REDELIVERY of an unsupported delivery → still UNSUPPORTED, handoff NOT invoked (no infinite retry)', async () => {
    const ledger = new FakeDeliveryLedger();
    ledger.seed({
      id: 'd-unsupported',
      tenant_id: TENANT,
      connection_id: CONN,
      delivery_key: 'DLV-2-changed',
      status: 'unsupported',
      import_batch_id: 'batch-3',
      detail_code: 'UNSUPPORTED_EXISTING_REQUISITION_UPDATE',
    });
    const handoff = new FakeHandoff({ batch: batchView({}) });
    const orch = new ConnectorExecutionOrchestrator(ledger, handoff);

    const out = await orch.execute(input('DLV-2-changed'));

    expect(out.outcome).toBe('UNSUPPORTED_EXISTING_REQUISITION_UPDATE');
    expect(handoff.runCalls).toHaveLength(0);
  });

  it('a non-identity canonical validation failure → FAILED, permanent (not retryable)', async () => {
    const ledger = new FakeDeliveryLedger();
    const handoff = new FakeHandoff({
      batch: batchView({ id: 'batch-4', success_count: 0, failure_count: 1, status: 'rejected' }),
      failures: [{ row_number: 1, failure_reason: 'MISSING_REQUIRED_FIELD' }],
    });
    const orch = new ConnectorExecutionOrchestrator(ledger, handoff);

    const out = await orch.execute(input('DLV-3'));

    expect(out).toMatchObject({ outcome: 'FAILED', retryable: false, detail_code: 'MISSING_REQUIRED_FIELD' });
  });
});
