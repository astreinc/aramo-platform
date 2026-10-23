import { describe, expect, it, vi } from 'vitest';

import { loadIntelligenceConfig } from '../lib/intelligence-config.js';
import { IntelligenceClient, IntelligenceRejectedError, type IntelligenceFetch } from '../lib/intelligence-client.js';

// ATI-SEP-1 T10 (Addendum A3 T10-2 / T10-3) — the ATS client methods of the TI
// evidence lifecycle: method, path, query and body of every call (fake fetch).

const ENV = {
  INTELLIGENCE_SERVICE_URL: 'http://ti.test:3004',
  INTELLIGENCE_ATS_CLIENT_ID: 'aramo-ats',
  INTELLIGENCE_ATS_CLIENT_SECRET: 's'.repeat(40),
};
const BASE = 'http://ti.test:3004';
const D = '0190ffff-0000-7000-8000-00000000000d';
const P = '0190ffff-0000-7000-8000-00000000000e';
const X = '0190ffff-0000-7000-8000-00000000000a';
const REF_A = { tenant_id: 'ten-a', talent_id: 'tal-1' };
const REF_B = { tenant_id: 'ten-b', talent_id: 'tal 2' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function harness(reply: unknown = { ok: true }, status = 200) {
  const fetchImpl = vi.fn<IntelligenceFetch>(async (url) =>
    url.endsWith('/v1/oauth/token') ? json(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 900, scope: '' }) : json(status, reply),
  );
  const client = new IntelligenceClient(loadIntelligenceConfig(ENV), fetchImpl);
  const last = () => {
    const call = fetchImpl.mock.calls.filter(([u]) => !u.endsWith('/v1/oauth/token')).at(-1);
    if (!call) throw new Error('no call');
    const [url, init] = call;
    return { method: init.method, url, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) };
  };
  return { client, last };
}

const tuple = (r: { tenant_id: string; talent_id: string }) => ({ source_system_id: 'ARAMO_ATS', source_tenant_id: r.tenant_id, external_talent_id: r.talent_id });

describe('IntelligenceClient — T10 evidence lifecycle', () => {
  it('M-1 / M-6 verification status', async () => {
    const h = harness({ items: [] });
    await h.client.listReferenceVerifications(REF_A);
    expect(h.last()).toEqual({ method: 'GET', url: `${BASE}/v1/references/ARAMO_ATS/ten-a/tal-1/verifications`, body: undefined });
    await h.client.aggregateVerifications([REF_A, REF_B]);
    expect(h.last()).toEqual({ method: 'GET', url: `${BASE}/v1/verifications?reference=ARAMO_ATS%2Ften-a%2Ftal-1&reference=ARAMO_ATS%2Ften-b%2Ftal+2`, body: undefined });
  });

  it('M-4 portal side: open / list / get / respond / withdraw', async () => {
    const h = harness({ dispute_id: D });
    await h.client.openDispute({ ...REF_A, assertion_id: X, statement: 'Not mine.' });
    expect(h.last()).toEqual({ method: 'POST', url: `${BASE}/v1/disputes`, body: { portal_context: tuple(REF_A), assertion_id: X, statement: 'Not mine.' } });
    await h.client.listPortalDisputes([REF_A], { status: 'open' });
    expect(h.last().url).toBe(`${BASE}/v1/disputes?reference=ARAMO_ATS%2Ften-a%2Ftal-1&status=open`);
    await h.client.getPortalDispute(D, [REF_A]);
    expect(h.last()).toMatchObject({ method: 'GET', url: `${BASE}/v1/disputes/${D}?reference=ARAMO_ATS%2Ften-a%2Ftal-1` });
    await h.client.respondToDispute(D, { ...REF_A, statement: 'More.' });
    expect(h.last()).toEqual({ method: 'POST', url: `${BASE}/v1/disputes/${D}/respond`, body: { portal_context: tuple(REF_A), statement: 'More.' } });
    await h.client.withdrawDispute(D, REF_A);
    expect(h.last().body).toEqual({ portal_context: tuple(REF_A) });
    await h.client.withdrawDispute(D, { ...REF_A, actor: 'pu-1' });
    expect(h.last()).toEqual({ method: 'POST', url: `${BASE}/v1/disputes/${D}/withdraw`, body: { portal_context: tuple(REF_A), actor: 'pu-1' } });
  });

  it('M-4 tenant side: worklist, detail and the five dispositions', async () => {
    const h = harness({ dispute_id: D, status: 'UNDER_REVIEW' });
    await h.client.listTenantDisputes('ten-a');
    expect(h.last()).toEqual({ method: 'GET', url: `${BASE}/v1/tenants/ten-a/disputes`, body: undefined });
    await h.client.listTenantDisputes('ten-a', { status: 'all', cursor: 'c1', limit: 10 });
    expect(h.last().url).toBe(`${BASE}/v1/tenants/ten-a/disputes?status=all&cursor=c1&limit=10`);
    await h.client.getTenantDispute('ten-a', D);
    expect(h.last().url).toBe(`${BASE}/v1/tenants/ten-a/disputes/${D}`);
    const by = { tenant_id: 'ten-a', actor: 'user-1' };
    await h.client.triageDispute(D, by);
    expect(h.last()).toEqual({ method: 'POST', url: `${BASE}/v1/disputes/${D}/triage`, body: { source_tenant_id: 'ten-a', actor: 'user-1' } });
    for (const [fn, path] of [
      [h.client.requestDisputeInfo.bind(h.client), 'request-info'],
      [h.client.correctDispute.bind(h.client), 'correct'],
      [h.client.upholdDispute.bind(h.client), 'uphold'],
    ] as const) {
      await fn(D, { ...by, note: 'n' });
      expect(h.last()).toEqual({ method: 'POST', url: `${BASE}/v1/disputes/${D}/${path}`, body: { source_tenant_id: 'ten-a', actor: 'user-1', note: 'n' } });
    }
    await h.client.extendDispute(D, by);
    expect(h.last()).toEqual({ method: 'POST', url: `${BASE}/v1/disputes/${D}/extend`, body: { source_tenant_id: 'ten-a', actor: 'user-1' } });
  });

  it('M-2 proposals and M-3 contradiction resolution', async () => {
    const h = harness({ items: [], next_cursor: null });
    await h.client.listProposals('ten-a', { status: 'OPEN', kind: 'VERIFY_CONTACT', limit: 25 });
    expect(h.last().url).toBe(`${BASE}/v1/tenants/ten-a/proposals?status=OPEN&kind=VERIFY_CONTACT&limit=25`);
    await h.client.dismissProposal(P, { tenant_id: 'ten-a', actor: 'user-1', justification: 'Known.' });
    expect(h.last()).toEqual({ method: 'POST', url: `${BASE}/v1/proposals/${P}/dismiss`, body: { source_tenant_id: 'ten-a', actor: 'user-1', justification: 'Known.' } });
    await h.client.actOnProposal(P, { tenant_id: 'ten-a', actor: 'user-1', action: 'VERIFICATION_REQUESTED' });
    expect(h.last()).toEqual({ method: 'POST', url: `${BASE}/v1/proposals/${P}/act`, body: { source_tenant_id: 'ten-a', actor: 'user-1', action: 'VERIFICATION_REQUESTED' } });
    await h.client.resolveContradiction({ ...REF_A, assertion_id: X }, { resolution: 'KEEP', reason: 'r', actor: 'user-1' });
    expect(h.last()).toEqual({
      method: 'POST',
      url: `${BASE}/v1/references/ARAMO_ATS/ten-a/tal-1/assertions/${X}/contradiction-resolution`,
      body: { resolution: 'KEEP', reason: 'r', actor: 'user-1' },
    });
  });

  it('a lifecycle refusal is a typed IntelligenceRejectedError (status + code)', async () => {
    const h = harness({ error: { code: 'PROPOSAL_NOT_OPEN', message: 'refused: PROPOSAL_NOT_OPEN' } }, 409);
    await expect(h.client.dismissProposal(P, { tenant_id: 'ten-a', actor: 'u', justification: 'j' })).rejects.toMatchObject({
      name: 'IntelligenceRejectedError',
      status: 409,
      code: 'PROPOSAL_NOT_OPEN',
    });
    await expect(h.client.dismissProposal(P, { tenant_id: 'ten-a', actor: 'u', justification: 'j' })).rejects.toBeInstanceOf(IntelligenceRejectedError);
  });
});
