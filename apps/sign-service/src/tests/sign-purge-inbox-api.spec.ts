import 'reflect-metadata';
import type { AuthContextType } from '@aramo/auth';
import { REQUIRED_SCOPES_KEY } from '@aramo/authorization';
import { ESIGN_SCOPE } from '@aramo/identity';
import { describe, expect, it, vi } from 'vitest';

import { RecipientInboxService } from '../app/inbox/recipient-inbox.service.js';
import { SignApiController } from '../app/integrations/sign-api.controller.js';
import { SignApiService } from '../app/integrations/sign-api.service.js';

// Retention and Purge directive (ebd41d99) — the recipient side of per-party delete (R-10,
// LD-5) and the retention setting / purge state over the Sign API (W1, §3.7). Writes are
// dark unless SIGN_PURGE_ENABLED=1 (the engine's `enabled`).

const USER = '11111111-1111-7111-8111-111111111111';
const USER_TENANT = '22222222-2222-7222-8222-222222222222';
const SENDER_TENANT = '33333333-3333-7333-8333-333333333333';
const auth: AuthContextType = { sub: USER, consumer_type: 'sign', actor_kind: 'user', tenant_id: USER_TENANT, scopes: [], iat: 0, exp: 0 };

const row = (envelope_id: string, over: Record<string, unknown> = {}) => ({
  id: `b-${envelope_id}`,
  envelope_tenant_id: SENDER_TENANT,
  envelope_id,
  signer_id: 's1',
  created_at: new Date(),
  envelope: { subject: 'Offer letter', status: 'COMPLETED', sent_at: new Date(), completed_at: new Date(), expires_at: null, purge_state: null, purge_level: null, purge_due_at: null, purge_executed_at: null, ...over },
  signer: { name: 'Bob', status: 'SIGNED', signed_at: new Date() },
});

function inbox(opts: { enabled?: boolean; deleted?: string[]; one?: unknown; partyDelete?: string; partyRestore?: string } = {}) {
  const repo = {
    listForUser: vi.fn(async () => [row('e1'), row('e2')]),
    getForUser: vi.fn(async () => (opts.one === undefined ? row('e1') : opts.one)),
    revoke: vi.fn(async () => true),
  };
  const identity = { findTenantNameById: vi.fn(async () => ({ name: 'n', display_name: 'Northwind' })) };
  const purges = {
    deletedEnvelopeIds: vi.fn(async () => opts.deleted ?? []),
    partyDelete: vi.fn(async () => opts.partyDelete ?? 'deleted'),
    partyRestore: vi.fn(async () => opts.partyRestore ?? 'restored'),
  };
  const engine = { enabled: opts.enabled ?? true };
  return { svc: new RecipientInboxService(repo as never, identity as never, purges as never, engine as never), repo, purges };
}

describe('recipient inbox — DocuSign "Deleted" folder (R-10)', () => {
  it('deletes for this recipient only, keyed by the user, on the binding’s envelope and sender tenant', async () => {
    const { svc, purges, repo } = inbox();
    await expect(svc.deleteForMe(auth, 'b-e1', 'r')).resolves.toEqual({ deleted: true });
    expect(purges.partyDelete).toHaveBeenCalledWith(SENDER_TENANT, 'e1', { kind: 'RECIPIENT', key: USER }, USER);
    expect(repo.revoke).not.toHaveBeenCalled(); // the binding is kept (unlike `remove`)
  });

  it('restores; a purged envelope answers 410 ENVELOPE_PURGED', async () => {
    await expect(inbox().svc.restoreForMe(auth, 'b-e1', 'r')).resolves.toEqual({ restored: true });
    await expect(inbox({ partyRestore: 'purged' }).svc.restoreForMe(auth, 'b-e1', 'r')).rejects.toMatchObject({ statusCode: 410, code: 'ENVELOPE_PURGED' });
  });

  it('refuses while purge is disabled (dark) — nothing is written', async () => {
    const { svc, purges } = inbox({ enabled: false });
    await expect(svc.deleteForMe(auth, 'b-e1', 'r')).rejects.toMatchObject({ statusCode: 403, code: 'ESIGN_FEATURE_NOT_AVAILABLE' });
    await expect(svc.restoreForMe(auth, 'b-e1', 'r')).rejects.toMatchObject({ statusCode: 403 });
    expect(purges.partyDelete).not.toHaveBeenCalled();
  });

  it('refuses a non-terminal envelope and a foreign binding', async () => {
    await expect(inbox({ one: row('e1', { status: 'SENT' }) }).svc.deleteForMe(auth, 'b-e1', 'r')).rejects.toMatchObject({ statusCode: 409 });
    await expect(inbox({ one: null }).svc.deleteForMe(auth, 'nope', 'r')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('the inbox hides deleted envelopes; ?folder=deleted lists only them; items carry purge', async () => {
    const { svc } = inbox({ deleted: ['e2'] });
    const all = await svc.list(auth);
    const ids = [...all.waiting, ...all.completed, ...all.other].map((i) => i.id);
    expect(ids).toEqual(['b-e1']);
    const del = await svc.list(auth, 'deleted');
    expect([...del.waiting, ...del.completed, ...del.other].map((i) => i.id)).toEqual(['b-e2']);
    expect(all.completed[0]).not.toHaveProperty('purge');
    await expect(svc.list(auth, 'bogus', 'r')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a purged envelope is listed with its purge state and cannot be downloaded', async () => {
    const executed = new Date('2026-11-20T00:00:00.000Z');
    const repo = { listForUser: vi.fn(async () => [row('e3', { purge_state: 'EXECUTED', purge_level: 'DOCUMENTS', purge_due_at: new Date(), purge_executed_at: executed })]) };
    const svc = new RecipientInboxService(repo as never, { findTenantNameById: vi.fn(async () => null) } as never, { deletedEnvelopeIds: vi.fn(async () => []) } as never, { enabled: true } as never);
    const out = await svc.list(auth);
    const item = [...out.waiting, ...out.completed, ...out.other][0];
    expect(item).toMatchObject({ can_download: false, purge: { state: 'EXECUTED', level: 'DOCUMENTS', due_at: null, executed_at: executed.toISOString() } });
  });

  it('without the purge repository (older wiring) the inbox behaves exactly as before', async () => {
    const repo = { listForUser: vi.fn(async () => [row('e1')]) };
    const svc = new RecipientInboxService(repo as never, { findTenantNameById: vi.fn(async () => null) } as never);
    const out = await svc.list(auth);
    expect(out.completed.map((i) => i.id)).toEqual(['b-e1']);
  });
});

// ── Sign API ──────────────────────────────────────────────────────────────────
const INST = '44444444-4444-7444-8444-444444444444';
const integ = (over: Record<string, unknown> = {}) => ({ application_key: 'aramo-ats', application_kind: 'FIRST_PARTY', installation_id: INST, mode: 'USER' as const, external_actor: null, external_role: null, grant_kind: 'STANDARD' as const, bound_envelope_id: null, ...over });
const apiAuth = (scopes: string[]): AuthContextType => ({ sub: USER, consumer_type: 'sign', actor_kind: 'user', tenant_id: SENDER_TENANT, scopes, iat: 0, exp: 0 });

function api(opts: { enabled?: boolean; status?: unknown } = {}) {
  const repo = { getEnvelope: vi.fn(async () => ({ id: 'e1', created_by: USER, installation_id: INST, source_application: 'aramo-ats' })) };
  const provider = { getEnvelope: vi.fn(async () => ({ envelope_id: 'e1', status: 'COMPLETED' })) };
  const purges = {
    getPolicy: vi.fn(async () => ({ tenant_id: SENDER_TENANT, retention_days: 30, purge_level: 'DOCUMENTS', updated_at: new Date('2026-10-31T00:00:00.000Z'), updated_by: USER })),
    setPolicy: vi.fn(async (_t: string, p: { retention_days: number | null; purge_level: string }) => ({ tenant_id: SENDER_TENANT, ...p, updated_at: new Date('2026-10-31T00:00:00.000Z'), updated_by: USER })),
    status: vi.fn(async () => (opts.status === undefined ? null : opts.status)),
  };
  const engine = { enabled: opts.enabled ?? true };
  return { svc: new SignApiService(repo as never, provider as never, {} as never, {} as never, {} as never, purges as never, engine as never), purges };
}

describe('Sign API — retention setting (W1) and envelope purge state (§3.7)', () => {
  it('routes: read needs sign:envelope:read, write needs sign:settings:manage', () => {
    const proto = SignApiController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, proto['getRetentionPolicy']!)).toEqual([ESIGN_SCOPE.ENVELOPE_READ]);
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, proto['setRetentionPolicy']!)).toEqual([ESIGN_SCOPE.SETTINGS_MANAGE]);
  });

  it('reads the installation tenant’s setting; can_edit only when enabled and allowed', async () => {
    const { svc, purges } = api();
    await expect(svc.getRetentionPolicy(apiAuth([ESIGN_SCOPE.ENVELOPE_READ]), integ(), 'r')).resolves.toMatchObject({ retention_days: 30, purge_level: 'DOCUMENTS', can_edit: false });
    expect(purges.getPolicy).toHaveBeenCalledWith(SENDER_TENANT);
    await expect(svc.getRetentionPolicy(apiAuth([ESIGN_SCOPE.SETTINGS_MANAGE]), integ(), 'r')).resolves.toMatchObject({ can_edit: true });
    await expect(api({ enabled: false }).svc.getRetentionPolicy(apiAuth([ESIGN_SCOPE.SETTINGS_MANAGE]), integ(), 'r')).resolves.toMatchObject({ can_edit: false });
  });

  it('writes with the sender validation; dark while disabled', async () => {
    const { svc, purges } = api();
    await expect(svc.setRetentionPolicy(apiAuth([ESIGN_SCOPE.SETTINGS_MANAGE]), integ(), { retention_days: 365, purge_level: 'DOCUMENTS_AND_METADATA' }, 'r')).resolves.toMatchObject({ retention_days: 365, purge_level: 'DOCUMENTS_AND_METADATA' });
    expect(purges.setPolicy).toHaveBeenCalledWith(SENDER_TENANT, { retention_days: 365, purge_level: 'DOCUMENTS_AND_METADATA' }, USER);
    await expect(svc.setRetentionPolicy(apiAuth([]), integ(), { retention_days: null }, 'r')).resolves.toMatchObject({ retention_days: null, purge_level: 'DOCUMENTS' });
    for (const bad of [0, 10000, 1.5, '30']) {
      await expect(svc.setRetentionPolicy(apiAuth([]), integ(), { retention_days: bad }, 'r')).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'invalid_retention_days' } } });
    }
    await expect(svc.setRetentionPolicy(apiAuth([]), integ(), { retention_days: 30, purge_level: 'ALL' }, 'r')).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'invalid_purge_level' } } });
    const dark = api({ enabled: false });
    await expect(dark.svc.setRetentionPolicy(apiAuth([]), integ(), { retention_days: 30 }, 'r')).rejects.toMatchObject({ statusCode: 403, code: 'ESIGN_FEATURE_NOT_AVAILABLE' });
    expect(dark.purges.setPolicy).not.toHaveBeenCalled();
  });

  it('an event grant cannot read or change the setting', async () => {
    const grant = integ({ grant_kind: 'EVENT_ARTIFACT', bound_envelope_id: 'e1' });
    await expect(api().svc.getRetentionPolicy(apiAuth([ESIGN_SCOPE.ENVELOPE_READ]), grant, 'r')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('envelope detail carries the DocuSign purge state and due date', async () => {
    await expect(api().svc.get(apiAuth([ESIGN_SCOPE.ENVELOPE_READ]), integ(), 'e1', 'r')).resolves.toEqual({ envelope_id: 'e1', status: 'COMPLETED', purge_state: null, purge_due_at: null });
    const due = new Date('2026-11-14T00:00:00.000Z');
    const queued = api({ status: { state: 'QUEUED', level: 'DOCUMENTS_AND_METADATA', reason: 'retention', queued_at: new Date(), due_at: due, waiting_until: null, executed_at: null } });
    await expect(queued.svc.get(apiAuth([ESIGN_SCOPE.ENVELOPE_READ]), integ(), 'e1', 'r')).resolves.toMatchObject({ purge_state: 'documents_and_metadata_queued', purge_due_at: due.toISOString() });
    const done = api({ status: { state: 'EXECUTED', level: 'DOCUMENTS', reason: 'retention', queued_at: new Date(), due_at: due, waiting_until: null, executed_at: new Date() } });
    await expect(done.svc.get(apiAuth([ESIGN_SCOPE.ENVELOPE_READ]), integ(), 'e1', 'r')).resolves.toMatchObject({ purge_state: 'executed', purge_due_at: null });
  });
});
