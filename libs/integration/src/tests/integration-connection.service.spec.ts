import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IntegrationConnectionRow } from '../lib/domain/integration-connection.js';
import type { IntegrationConnectionRepository } from '../lib/connection/integration-connection.repository.js';
import {
  ConnectionServiceError,
  IntegrationConnectionService,
} from '../lib/connection/integration-connection.service.js';
import type { SecretsManagerWriterPort } from '../lib/secrets/secrets-manager-writer.port.js';

// T8-CONNECTOR-A — connection service (directive §14/§34, Architect checks #1/#2).

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const TENANT_B = '01900000-0000-7000-8000-0000000000b2';

let idSeq = 0;

class FakeConnectionRepo {
  readonly rows = new Map<string, IntegrationConnectionRow>();

  async create(args: {
    tenant_id: string;
    provider_key: string;
    config?: unknown;
    provider_account_id?: string | null;
  }): Promise<IntegrationConnectionRow> {
    idSeq += 1;
    const id = `01900000-0000-7000-8000-0000000000${String(idSeq).padStart(2, '0')}`;
    const now = new Date();
    const row: IntegrationConnectionRow = {
      id,
      tenant_id: args.tenant_id,
      provider_key: args.provider_key,
      status: 'disconnected',
      secret_ref: null,
      config: args.config ?? null,
      provider_account_id: args.provider_account_id ?? null,
      cursor: null,
      last_attempted_at: null,
      last_successful_at: null,
      last_error_code: null,
      last_error_summary: null,
      version: 0,
      created_at: now,
      updated_at: now,
    };
    this.rows.set(id, row);
    return row;
  }
  async findByIdForTenant(t: string, id: string): Promise<IntegrationConnectionRow | null> {
    const r = this.rows.get(id);
    return r && r.tenant_id === t ? r : null;
  }
  async listForTenant(t: string): Promise<IntegrationConnectionRow[]> {
    return [...this.rows.values()].filter((r) => r.tenant_id === t);
  }
  async setSecretRef(t: string, id: string, secret_ref: string): Promise<number> {
    const r = await this.findByIdForTenant(t, id);
    if (r === null) return 0;
    this.rows.set(id, { ...r, secret_ref, status: 'configured' });
    return 1;
  }
  async setStatus(t: string, id: string, status: IntegrationConnectionRow['status']): Promise<number> {
    const r = await this.findByIdForTenant(t, id);
    if (r === null) return 0;
    this.rows.set(id, { ...r, status });
    return 1;
  }
  async recordSuccess(t: string, id: string): Promise<void> {
    const r = await this.findByIdForTenant(t, id);
    if (r) this.rows.set(id, { ...r, status: 'active', last_error_code: null, last_successful_at: new Date() });
  }
  async recordError(t: string, id: string, code: string, summary: string): Promise<void> {
    const r = await this.findByIdForTenant(t, id);
    if (r) this.rows.set(id, { ...r, status: 'degraded', last_error_code: code, last_error_summary: summary });
  }
}

class FakeWriter implements SecretsManagerWriterPort {
  readonly puts: Array<{ secretId: string; value: string }> = [];
  async putSecretValue(secretId: string, value: string): Promise<void> {
    this.puts.push({ secretId, value });
  }
}

function make() {
  const repo = new FakeConnectionRepo();
  const writer = new FakeWriter();
  const svc = new IntegrationConnectionService(
    repo as unknown as IntegrationConnectionRepository,
    writer,
  );
  return { repo, writer, svc };
}

describe('IntegrationConnectionService', () => {
  beforeEach(() => {
    process.env['ARAMO_ENV'] = 'test';
  });
  afterEach(() => {
    delete process.env['ARAMO_ENV'];
  });

  it('normalizes provider_key and rejects an invalid one', async () => {
    const { svc } = make();
    const view = await svc.createConnection({ tenant_id: TENANT_A, provider_key: 'acme_vms' });
    expect(view.provider_key).toBe('acme_vms');
    expect(view.status).toBe('disconnected');
    expect(view.has_secret).toBe(false);
    await expect(svc.createConnection({ tenant_id: TENANT_A, provider_key: 'bad key!' })).rejects.toThrow(
      /provider_key/,
    );
  });

  it('setCredential is WRITE-ONLY: server-generates secret_ref, derives SM id, stores value in SM — never in the row/view', async () => {
    const { svc, repo, writer } = make();
    const created = await svc.createConnection({ tenant_id: TENANT_A, provider_key: 'acme_vms' });
    const view = await svc.setCredential({ tenant_id: TENANT_A, id: created.id, credential: 'super-secret-token' });

    // Value went ONLY to Secrets Manager under the server-derived id.
    expect(writer.puts).toEqual([
      { secretId: `aramo/test/connector/${TENANT_A}/${created.id}`, value: 'super-secret-token' },
    ]);
    // The stored secret_ref is the opaque handle, NOT the raw value.
    const stored = repo.rows.get(created.id)!;
    expect(stored.secret_ref).toBe(`connector:v1:${TENANT_A}:${created.id}`);
    expect(stored.secret_ref).not.toContain('super-secret-token');
    // The view exposes has_secret only — no secret_ref, no raw value anywhere.
    expect(view.status).toBe('configured');
    expect(view.has_secret).toBe(true);
    expect(JSON.stringify(view)).not.toContain('super-secret-token');
    expect(JSON.stringify(view)).not.toContain('secret_ref');
    expect(JSON.stringify(view)).not.toContain('aramo/test/connector');
  });

  it('refuses to enable a connection with no configured credential', async () => {
    const { svc } = make();
    const c = await svc.createConnection({ tenant_id: TENANT_A, provider_key: 'acme_vms' });
    await expect(svc.enable(TENANT_A, c.id)).rejects.toMatchObject({
      code: 'CONNECTOR_CONFIGURATION_INVALID',
    });
  });

  it('governed lifecycle: configure → enable(active) → execution_failure(degraded) → execution_success(active recovery) → disable(disabled, history kept)', async () => {
    const { svc, repo } = make();
    const c = await svc.createConnection({ tenant_id: TENANT_A, provider_key: 'acme_vms' });
    await svc.setCredential({ tenant_id: TENANT_A, id: c.id, credential: 'tok' });
    expect((await svc.enable(TENANT_A, c.id)).status).toBe('active');

    await svc.recordExecutionFailure(TENANT_A, c.id, 'CONNECTOR_EXECUTION_UNAVAILABLE', 'timeout');
    expect(repo.rows.get(c.id)!.status).toBe('degraded');

    await svc.recordExecutionSuccess(TENANT_A, c.id);
    expect(repo.rows.get(c.id)!.status).toBe('active'); // recovered only via the governed service path

    expect((await svc.disable(TENANT_A, c.id)).status).toBe('disabled');
    expect(repo.rows.has(c.id)).toBe(true); // history preserved — no delete
  });

  it('is tenant-safe: tenant B cannot read tenant A\'s connection', async () => {
    const { svc } = make();
    const c = await svc.createConnection({ tenant_id: TENANT_A, provider_key: 'acme_vms' });
    await expect(svc.getConnection(TENANT_B, c.id)).rejects.toBeInstanceOf(ConnectionServiceError);
    await expect(svc.getConnection(TENANT_B, c.id)).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
  });
});
