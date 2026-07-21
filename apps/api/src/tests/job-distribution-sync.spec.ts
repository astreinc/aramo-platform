import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildChannelPostingPayload,
  channelPostingContentHash,
  type ChannelPostingInput,
  type ChannelPostingStateRow,
  type PublishableRequisitionRow,
  type TenantChannelConfigRow,
} from '@aramo/job-distribution';

import { JobDistributionSyncService } from '../job-distribution/job-distribution-sync.service.js';
import { JOB_DISTRIBUTION_PER_TICK_MUTATION_CAP } from '../job-distribution/job-distribution-sync.queue.constants.js';

// SRC-2 PR-3 (R4) — orchestration transition table + caps + fail-closed, deps
// mocked (no DB / no live connector). The integration spec proves the same paths
// against real Postgres.

const TENANT = '11111111-1111-7111-8111-1111111111aa';

function req(over: Partial<PublishableRequisitionRow> = {}): PublishableRequisitionRow {
  return {
    id: 'req-1',
    tenant_id: TENANT,
    title: 'Staff Engineer',
    description: 'Build things',
    city: 'Austin',
    state_code: 'TX',
    job_type: 'FULL_TIME',
    work_arrangement: 'REMOTE',
    openings: 2,
    advertised_pay_min: '80.00',
    advertised_pay_max: '120.00',
    advertised_pay_period: 'HOURLY',
    advertised_pay_currency: 'USD',
    public_listing: true,
    updated_at: '2026-07-21T00:00:00.000Z',
    ...over,
  };
}

// Recompute the exact content hash the service will produce for a given row, so
// NOOP (hash-equal) can be set up deterministically.
function hashFor(r: PublishableRequisitionRow): string {
  const input: ChannelPostingInput = {
    requisition_id: r.id,
    tenant_id: r.tenant_id,
    title: r.title,
    description: r.description,
    city: r.city,
    state_code: r.state_code,
    country: 'US',
    job_type: r.job_type,
    work_arrangement: r.work_arrangement,
    openings: r.openings,
    advertised_pay_min: r.advertised_pay_min,
    advertised_pay_max: r.advertised_pay_max,
    advertised_pay_period: r.advertised_pay_period,
    advertised_pay_currency: r.advertised_pay_currency,
    public_listing: r.public_listing,
    posted_at: r.updated_at,
    updated_at: r.updated_at,
  };
  return channelPostingContentHash(buildChannelPostingPayload(input));
}

function stateRow(over: Partial<ChannelPostingStateRow>): ChannelPostingStateRow {
  return {
    id: 'state-1',
    tenant_id: TENANT,
    requisition_id: 'req-1',
    channel: 'indeed',
    external_posting_id: 'SRC-POST-1',
    content_hash: 'stale',
    last_synced_at: null,
    sync_status: 'LIVE',
    tombstoned_at: null,
    ...over,
  };
}

const ENABLED_CONFIG: TenantChannelConfigRow = {
  tenant_id: TENANT,
  channel: 'indeed',
  config: { employer_ids: [{ type: 'INDEED', id: 'emp-1' }] },
};

interface Mocks {
  requisitions: { listPublishableForChannelSync: ReturnType<typeof vi.fn> };
  postingStates: Record<string, ReturnType<typeof vi.fn>>;
  connector: { createOrUpdate: ReturnType<typeof vi.fn>; expire: ReturnType<typeof vi.fn> };
  tokens: { isConfigured: boolean; getAccessToken: ReturnType<typeof vi.fn> };
}

function makeService(opts: {
  configs?: TenantChannelConfigRow[];
  publishable?: PublishableRequisitionRow[];
  states?: ChannelPostingStateRow[];
  isConfigured?: boolean;
  createImpl?: () => Promise<{ sourcedPostingId: string }>;
}): { service: JobDistributionSyncService; mocks: Mocks } {
  const mocks: Mocks = {
    requisitions: {
      listPublishableForChannelSync: vi.fn().mockResolvedValue(opts.publishable ?? []),
    },
    postingStates: {
      listEnabledConfigs: vi.fn().mockResolvedValue(opts.configs ?? [ENABLED_CONFIG]),
      listStatesForTenantChannel: vi.fn().mockResolvedValue(opts.states ?? []),
      markPending: vi.fn().mockResolvedValue(undefined),
      markLive: vi.fn().mockResolvedValue(undefined),
      markExpired: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
    },
    connector: {
      createOrUpdate:
        opts.createImpl !== undefined
          ? vi.fn().mockImplementation(opts.createImpl)
          : vi.fn().mockResolvedValue({ sourcedPostingId: 'SRC-NEW' }),
      expire: vi.fn().mockResolvedValue(undefined),
    },
    tokens: {
      isConfigured: opts.isConfigured ?? true,
      getAccessToken: vi.fn().mockResolvedValue('tok'),
    },
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const service = new JobDistributionSyncService(
    mocks.requisitions as never,
    mocks.postingStates as never,
    mocks.connector as never,
    mocks.tokens as never,
    logger as never,
  );
  return { service, mocks };
}

describe('JobDistributionSyncService.tick', () => {
  beforeEach(() => {
    delete process.env['ARAMO_INDEED_APPLY_WEBHOOK_SECRET'];
  });

  it('fail-closed: credentials unset → skipped, no reads or mutations', async () => {
    const { service, mocks } = makeService({ isConfigured: false });
    const result = await service.tick();
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('indeed_credentials_unset');
    expect(mocks.postingStates['listEnabledConfigs']).not.toHaveBeenCalled();
  });

  it('disabled tenants are untouched (listEnabledConfigs returns none)', async () => {
    const { service, mocks } = makeService({ configs: [] });
    const result = await service.tick();
    expect(result.tenants).toBe(0);
    expect(mocks.requisitions.listPublishableForChannelSync).not.toHaveBeenCalled();
  });

  it('enabled but unconfigured (no employer_ids) → skipped, no publishable read', async () => {
    const { service, mocks } = makeService({
      configs: [{ tenant_id: TENANT, channel: 'indeed', config: {} }],
    });
    const result = await service.tick();
    expect(result.tenants).toBe(1);
    expect(result.created).toBe(0);
    expect(mocks.requisitions.listPublishableForChannelSync).not.toHaveBeenCalled();
  });

  it('CREATE: no existing state → PENDING_CREATE then markLive, created=1', async () => {
    const { service, mocks } = makeService({ publishable: [req()], states: [] });
    const result = await service.tick();
    expect(result.created).toBe(1);
    expect(mocks.postingStates['markPending']).toHaveBeenCalledWith(
      expect.objectContaining({ sync_status: 'PENDING_CREATE' }),
    );
    expect(mocks.postingStates['markLive']).toHaveBeenCalledWith(
      expect.objectContaining({ external_posting_id: 'SRC-NEW' }),
    );
    expect(mocks.connector.createOrUpdate).toHaveBeenCalledTimes(1);
  });

  it('UPDATE: existing state with a stale hash → updated=1', async () => {
    const { service, mocks } = makeService({
      publishable: [req()],
      states: [stateRow({ content_hash: 'stale', sync_status: 'LIVE' })],
    });
    const result = await service.tick();
    expect(result.updated).toBe(1);
    expect(mocks.postingStates['markPending']).toHaveBeenCalledWith(
      expect.objectContaining({ sync_status: 'PENDING_UPDATE' }),
    );
  });

  it('NOOP: existing LIVE state with the current hash → no connector call', async () => {
    const r = req();
    const { service, mocks } = makeService({
      publishable: [r],
      states: [stateRow({ content_hash: hashFor(r), sync_status: 'LIVE' })],
    });
    const result = await service.tick();
    expect(result.noop).toBe(1);
    expect(mocks.connector.createOrUpdate).not.toHaveBeenCalled();
  });

  it('EXPIRE: a state whose requisition left the publishable set → expired=1', async () => {
    const { service, mocks } = makeService({
      publishable: [],
      states: [stateRow({ requisition_id: 'gone-req', external_posting_id: 'SRC-OLD' })],
    });
    const result = await service.tick();
    expect(result.expired).toBe(1);
    expect(mocks.connector.expire).toHaveBeenCalledWith('SRC-OLD');
    expect(mocks.postingStates['markExpired']).toHaveBeenCalled();
  });

  it('ERROR (re-enterable): connector throws → markError, errors=1, no markLive', async () => {
    const { service, mocks } = makeService({
      publishable: [req()],
      states: [],
      createImpl: async () => {
        throw new Error('indeed 500');
      },
    });
    const result = await service.tick();
    expect(result.errors).toBe(1);
    expect(mocks.postingStates['markError']).toHaveBeenCalled();
    expect(mocks.postingStates['markLive']).not.toHaveBeenCalled();
  });

  it('per-tick mutation cap bounds the number of upserts', async () => {
    const many = Array.from({ length: JOB_DISTRIBUTION_PER_TICK_MUTATION_CAP + 10 }, (_, i) =>
      req({ id: `req-${i}` }),
    );
    const { service, mocks } = makeService({ publishable: many, states: [] });
    const result = await service.tick();
    expect(result.created).toBe(JOB_DISTRIBUTION_PER_TICK_MUTATION_CAP);
    expect(mocks.connector.createOrUpdate).toHaveBeenCalledTimes(
      JOB_DISTRIBUTION_PER_TICK_MUTATION_CAP,
    );
  });
});
