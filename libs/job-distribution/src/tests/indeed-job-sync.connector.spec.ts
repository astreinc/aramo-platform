import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelPostingPayload } from '../lib/channel-posting.types.js';
import {
  IndeedConnectorError,
  IndeedJobSyncConnector,
  type IndeedJobContext,
} from '../lib/indeed/indeed-job-sync.connector.js';
import { IndeedTokenService } from '../lib/indeed/indeed-token.service.js';

// SRC-2 PR-3 (R6) — the GraphQL connector: request-building + response-parsing
// against fixture responses. `fetch` stubbed; the token service faked.

const tokens = { getAccessToken: async () => 'tok-1' } as unknown as IndeedTokenService;

function payload(over: Partial<ChannelPostingPayload> = {}): ChannelPostingPayload {
  return {
    external_requisition_ref: 'req-1',
    title: 'Staff Engineer',
    description: 'Build things',
    location: { city: 'Austin', state_code: 'TX', country: 'US' },
    job_type: 'FULL_TIME',
    work_arrangement: 'REMOTE',
    openings: 2,
    advertised_compensation: {
      min: '80.00',
      max: '120.00',
      period: 'HOURLY',
      currency: 'USD',
    },
    public_listing: true,
    posted_at: '2026-07-21T00:00:00.000Z',
    updated_at: '2026-07-21T00:00:00.000Z',
    ...over,
  };
}

const ctx: IndeedJobContext = {
  jobPostingId: 'req-1',
  sourceName: 'tenant-src',
  companyName: 'Acme Inc',
  employerIds: [{ type: 'INDEED', id: 'emp-9' }],
  apply: { postUrl: 'https://acme.aramo.ai/v1/webhooks/indeed/apply', apiToken: 'shh' },
};

function okGraphql(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => '',
  } as unknown as Response;
}

function lastRequestBody(spy: ReturnType<typeof vi.spyOn>): {
  query: string;
  variables: { input: { jobPostings: Array<{ body: Record<string, unknown>; metadata: Record<string, unknown> }> } };
} {
  const call = spy.mock.calls[spy.mock.calls.length - 1];
  return JSON.parse((call[1] as RequestInit).body as string);
}

describe('IndeedJobSyncConnector', () => {
  afterEach(() => vi.restoreAllMocks());

  it('createOrUpdate posts the create mutation with Bearer auth + idempotency keys + minor-units salary + applyMethod', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okGraphql({
        data: {
          jobsIngest: {
            createSourcedJobPostings: {
              results: [{ jobPosting: { sourcedPostingId: 'SRC-POST-42' } }],
            },
          },
        },
      }),
    );
    const connector = new IndeedJobSyncConnector(tokens);

    const res = await connector.createOrUpdate(payload(), ctx);
    expect(res.sourcedPostingId).toBe('SRC-POST-42');

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok-1');

    const sent = lastRequestBody(fetchSpy);
    expect(sent.query).toContain('createSourcedJobPostings');
    const posting = sent.variables.input.jobPostings[0];
    // Idempotency key = (jobPostingId, sourceName).
    expect(posting.metadata['jobPostingId']).toBe('req-1');
    expect((posting.metadata['jobSource'] as Record<string, unknown>)['sourceName']).toBe('tenant-src');
    expect((posting.metadata['jobSource'] as Record<string, unknown>)['employerIds']).toEqual([
      { type: 'INDEED', id: 'emp-9' },
    ]);
    // Salary: minor units via string arithmetic; period mapped HOURLY→HOUR.
    expect(posting.body['salary']).toEqual({ currency: 'USD', period: 'HOUR', minimumMinor: 8000 });
    // Apply loop closed (RECON-3).
    expect(posting.metadata['indeedApply']).toEqual({
      postUrl: 'https://acme.aramo.ai/v1/webhooks/indeed/apply',
      apiToken: 'shh',
    });
  });

  it('omits salary when advertised comp is absent, and applyMethod when apply is null', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okGraphql({
        data: {
          jobsIngest: {
            createSourcedJobPostings: { results: [{ jobPosting: { sourcedPostingId: 'x' } }] },
          },
        },
      }),
    );
    const connector = new IndeedJobSyncConnector(tokens);
    await connector.createOrUpdate(
      payload({ advertised_compensation: { min: null, max: null, period: null, currency: null } }),
      { ...ctx, apply: null },
    );
    const posting = lastRequestBody(fetchSpy).variables.input.jobPostings[0];
    expect(posting.body['salary']).toBeUndefined();
    expect(posting.metadata['indeedApply']).toBeUndefined();
  });

  it('expire posts the expire mutation keyed on sourcedPostingId', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(okGraphql({ data: { jobsIngest: { expireSourcedJobsBySourcedPostingId: { results: [] } } } }));
    const connector = new IndeedJobSyncConnector(tokens);
    await connector.expire('SRC-POST-42');
    const sent = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.query).toContain('expireSourcedJobsBySourcedPostingId');
    expect(sent.variables.input.sourcedPostingIds).toEqual(['SRC-POST-42']);
  });

  it('throws IndeedConnectorError on a GraphQL errors array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okGraphql({ errors: [{ message: 'bad input' }] }),
    );
    const connector = new IndeedJobSyncConnector(tokens);
    await expect(connector.createOrUpdate(payload(), ctx)).rejects.toThrow(IndeedConnectorError);
  });

  it('throws when no sourcedPostingId is returned', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okGraphql({ data: { jobsIngest: { createSourcedJobPostings: { results: [] } } } }),
    );
    const connector = new IndeedJobSyncConnector(tokens);
    await expect(connector.createOrUpdate(payload(), ctx)).rejects.toThrow(/no sourcedPostingId/);
  });
});
