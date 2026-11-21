import 'reflect-metadata';
import type { AuthContextType } from '@aramo/auth';
import { AramoError } from '@aramo/common';
import { ESIGN_ROLE_PERMISSIONS } from '@aramo/identity';
import { describe, expect, it, vi } from 'vitest';

import { RecipientInboxService } from '../app/inbox/recipient-inbox.service.js';
import {
  INBOX_ACTION_KEYS,
  inboxActions,
  inboxDownloadDecision,
  type InboxActionEntry,
} from '../app/inbox/inbox-actions.js';
import { SignRetentionController } from '../app/retention/sign-retention.controller.js';
import {
  SENDER_ACTION_KEYS,
  SENDER_ACTION_RULES,
  senderActionDecision,
  senderActions,
  type ActionEnvelope,
  type CheckResult,
  type Refusal,
  type SenderActionFacts,
  type SenderActionKey,
} from '../app/sender/envelope-actions.js';
import { EsignSenderController } from '../app/sender/esign-sender.controller.js';
import { SenderContextService } from '../app/sender/sender-context.service.js';
import { SenderEnvelopeService, canSelfSignNow } from '../app/sender/sender-envelope.service.js';

// Aramo-Sign-Client-Rule-Consolidation-Directive-v1_0-LOCKED (480ecdbb) §3 C1 — the server
// sends what the caller may do (`actions`), each key from ONE predicate that the action's
// route also enforces (C1-2). Covered here:
//   1. every predicate across actors (owner, other member, Sign Admin, read-only Viewer),
//      own-app vs other-app, every status, purged, Deleted folder, purge off, feature off,
//      Personal authoring closed;
//   2. the boundary scope each rule names IS the route decorator's scope;
//   3. for every action, running the real route gives the predicate's refusal exactly
//      (code, HTTP status, details.reason) whenever a service-enforced check refuses, and never
//      an availability refusal when the predicate allows (locked checks are left to the
//      repository / engine, which the route reaches);
//   4. list rows and the detail carry `actions` computed by the same predicates;
//   5. the inbox item rules (sign / download / delete / restore / report).

const TENANT = '22222222-2222-7222-8222-222222222222';
const OWNER = '11111111-1111-7111-8111-111111111111';
const OTHER = '33333333-3333-7333-8333-333333333333';
const ENV_ID = '44444444-4444-7444-8444-444444444444';
const RID = 'req-c1';

function auth(scopes: readonly string[], sub: string): AuthContextType {
  return { sub, consumer_type: 'sign', actor_kind: 'user', tenant_id: TENANT, scopes: [...scopes], iat: 0, exp: 0 };
}
const ACTORS = {
  owner_sender: auth(ESIGN_ROLE_PERMISSIONS.sign_sender, OWNER),
  other_sender: auth(ESIGN_ROLE_PERMISSIONS.sign_sender, OTHER),
  admin: auth(ESIGN_ROLE_PERMISSIONS.sign_admin, OTHER),
  viewer: auth(ESIGN_ROLE_PERMISSIONS.sign_viewer, OTHER),
} as const;
type ActorKey = keyof typeof ACTORS;

const STATUSES = ['DRAFT', 'SENT', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED'] as const;

interface Fixture {
  status: (typeof STATUSES)[number];
  source_application: string;
  purge_state: string | null;
  envelope_mode: 'STANDARD' | 'SELF';
  kind: 'BUSINESS' | 'PERSONAL';
  purge_enabled: boolean;
  in_person: boolean;
  deleted: boolean;
  in_person_signer: boolean;
}

const BASE: Fixture = {
  status: 'SENT',
  source_application: 'aramo-sign',
  purge_state: null,
  envelope_mode: 'STANDARD',
  kind: 'BUSINESS',
  purge_enabled: true,
  in_person: true,
  deleted: false,
  in_person_signer: false,
};

function signers(f: Fixture) {
  const s = (id: string, kind: string, order: number) => ({
    id,
    name: id,
    email: `${id}@x.test`,
    status: 'PENDING',
    signing_order: order,
    recipient_kind: kind,
    bound_user_id: null,
    copy_delivery: null,
    witness_for_signer_id: null,
    signer_role: null,
    access_code_hash: null,
    access_code_locked_at: null,
    delegated_at: null,
    identity_verification_method: null,
    identity_verification_locked_at: null,
    viewed_at: null,
    signed_at: null,
    declined_at: null,
    decline_reason: null,
  });
  return [s('s1', f.in_person_signer ? 'IN_PERSON_SIGNER' : 'SIGNER', 1)];
}

function row(f: Fixture) {
  return {
    id: ENV_ID,
    subject: 'Offer',
    status: f.status,
    created_by: OWNER,
    source_application: f.source_application,
    envelope_mode: f.envelope_mode,
    routing_mode: 'PARALLEL',
    allow_delegation: false,
    revision: 3,
    message: null,
    signer_date_format: null,
    created_at: new Date('2026-11-01T00:00:00Z'),
    updated_at: new Date('2026-11-01T00:00:00Z'),
    sent_at: f.status === 'DRAFT' ? null : new Date('2026-11-02T00:00:00Z'),
    completed_at: null,
    declined_at: null,
    voided_at: null,
    expires_at: new Date('2099-01-01T00:00:00Z'),
    purge_state: f.purge_state,
    purge_level: f.purge_state === null ? null : 'DOCUMENTS',
    purge_due_at: null,
    purge_executed_at: null,
    documents: [],
    signers: signers(f),
  };
}

function actionEnvelope(f: Fixture): ActionEnvelope {
  const r = row(f);
  return { status: r.status, owner_id: r.created_by, source_application: r.source_application, envelope_mode: r.envelope_mode, routing_mode: r.routing_mode, expires_at: r.expires_at, purge_state: r.purge_state, recipients: r.signers };
}

function facts(f: Fixture, a: AuthContextType): SenderActionFacts {
  return {
    can_author: f.kind === 'BUSINESS',
    purge_enabled: f.purge_enabled,
    in_person_available: f.in_person,
    deleted: f.deleted,
    can_self_sign_now: canSelfSignNow(a, row(f)),
    inbox_item: false,
  };
}

// S-1 — the owner reads their own; the organization only with sign:envelope:read:all in a BUSINESS tenant.
function visible(a: AuthContextType, f: Fixture): boolean {
  return a.sub === OWNER || (f.kind === 'BUSINESS' && a.scopes.includes('sign:envelope:read:all'));
}

function harness(f: Fixture) {
  const env = row(f);
  const repo = {
    getEnvelopeDetail: vi.fn(async () => env),
    listEnvelopes: vi.fn(async () => [env]),
    lastEventAt: vi.fn(async () => new Map()),
    countByStatus: vi.fn(async () => ({})),
    reminderHistory: vi.fn(async () => []),
    updateDraft: vi.fn(async () => 4),
    deleteDraft: vi.fn(async () => ({ source_object_keys: [], document_count: 0, recipient_count: 0 })),
  };
  const provider = {
    voidEnvelope: vi.fn(async () => undefined),
    sendEnvelope: vi.fn(async () => undefined),
    remindEnvelopeSigner: vi.fn(async () => undefined),
    getExecutedArtifacts: vi.fn(async () => ({ documents: [], certificate: null })),
  };
  const tenants = {
    findById: vi.fn(async () => ({ id: TENANT, name: 'Astre', kind: f.kind, is_active: true, status: 'ACTIVE' })),
    findSlugById: vi.fn(async () => 'astre'),
    findOrganizationNameById: vi.fn(async () => 'Astre'),
  };
  const identity = { findUserById: vi.fn(async () => null), findMembership: vi.fn(async () => null), findRoleKeysForMembership: vi.fn(async () => []) };
  const context = new SenderContextService(tenants as never, identity as never);
  const engine = { issueHostedSession: vi.fn(async () => ({ signer_id: 's1', raw_token: 'tok', expires_at: new Date('2099-01-01T00:00:00Z') })) };
  const features = {
    isAvailable: vi.fn(() => f.in_person),
    assertAvailable: vi.fn((feature_key: string, requestId: string) => {
      if (!f.in_person) throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'This feature is not available in Aramo Sign yet', 403, { requestId, details: { feature_key } });
    }),
  };
  const purges = {
    deletedEnvelopeIds: vi.fn(async () => (f.deleted ? [ENV_ID] : [])),
    isDeletedBy: vi.fn(async () => f.deleted),
    partyDelete: vi.fn(async () => 'deleted'),
    partyRestore: vi.fn(async () => 'restored'),
    queue: vi.fn(async () => 'queued'),
    dequeue: vi.fn(async () => 'dequeued'),
    status: vi.fn(async () => null),
  };
  const purgeEngine = { enabled: f.purge_enabled, queueTargeted: vi.fn() };
  const svc = new SenderEnvelopeService(
    repo as never,
    provider as never,
    context,
    identity as never,
    {} as never,
    {} as never,
    { reserveUpload: vi.fn(), release: vi.fn() } as never,
    undefined,
    undefined,
    undefined,
    engine as never,
    features as never,
    purges as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    purgeEngine as never,
  );
  const retention = new SignRetentionController(purges as never, purgeEngine as never, svc);
  return { svc, retention, repo, provider, purges, engine };
}

// The route each action is enforced by (browser client: no If-Match precondition).
const ROUTES: Record<Exclude<SenderActionKey, 'sign'>, (h: ReturnType<typeof harness>, a: AuthContextType) => Promise<unknown>> = {
  edit: (h, a) => h.svc.update(a, ENV_ID, { subject: 'Renamed' }, RID),
  send: (h, a) => h.svc.send(a, ENV_ID, {}, RID),
  delete_draft: (h, a) => h.svc.deleteDraft(a, ENV_ID, RID),
  void: (h, a) => h.svc.void(a, ENV_ID, { reason: 'wrong file' }, RID),
  remind: (h, a) => h.svc.remind(a, ENV_ID, {}, RID),
  delete: (h, a) => h.retention.deleteForTenant(a, RID, ENV_ID),
  restore: (h, a) => h.retention.restoreForTenant(a, RID, ENV_ID),
  download: (h, a) => h.svc.executed(a, ENV_ID, RID),
  certificate: (h, a) => h.svc.executed(a, ENV_ID, RID),
  host_in_person: (h, a) => h.svc.hostedSession(a, ENV_ID, { signer_id: 's1' }, RID),
  purge: (h, a) => h.retention.queuePurge(a, RID, ENV_ID, { level: 'DOCUMENTS' }),
  dequeue_purge: (h, a) => h.retention.dequeuePurge(a, RID, ENV_ID),
};

// The first refusal the ROUTE itself raises for this action: boundary checks are the
// decorator's (the actor is assumed through it), and a locked check hands over to the
// repository / engine (the route reaches it).
// Checks a route makes before it reads the envelope (so before S-1 visibility).
const PRE_READ_CHECKS = new Set(['author', 'purge_enabled', 'feature:in_person_signing']);

function firstRouteRefusal(action: SenderActionKey, a: AuthContextType, f: Fixture): Refusal | 'reaches_lock' | 'not_found' | null {
  let read = false;
  for (const check of SENDER_ACTION_RULES[action]) {
    if (check.enforced_by === 'boundary') continue;
    if (!read && !PRE_READ_CHECKS.has(check.id)) {
      read = true;
      if (!visible(a, f)) return 'not_found';
    }
    const r: CheckResult = check.test(a, actionEnvelope(f), facts(f, a));
    if (r === null) continue;
    if (check.enforced_by === 'locked') return 'reaches_lock';
    if (r === 'noop') return null;
    return r;
  }
  return null;
}

const AVAILABILITY_REASONS = new Set([
  'personal_sending_not_enabled',
  'managed_by_source_application',
  'envelope_not_owned',
  'envelope_not_draft',
  'purge_not_enabled',
  'self_sign_no_reminders',
]);
function isAvailabilityRefusal(e: AramoError): boolean {
  const reason = (e.context.details as { reason?: string } | undefined)?.reason;
  if (reason !== undefined && AVAILABILITY_REASONS.has(reason)) return true;
  if (e.code === 'ENVELOPE_ILLEGAL_TRANSITION' && (/^envelope is /.test(e.message) || e.message.startsWith('Executed documents exist only'))) return true;
  if (e.code === 'ENVELOPE_PURGED') return true;
  return e.code === 'ESIGN_FEATURE_NOT_AVAILABLE';
}

const VARIANTS: Array<[string, Partial<Fixture>]> = [
  ...STATUSES.map((status): [string, Partial<Fixture>] => [status, { status }]),
  ['other-app SENT', { source_application: 'aramo-ats' }],
  ['other-app COMPLETED', { status: 'COMPLETED', source_application: 'aramo-ats' }],
  ['COMPLETED purged', { status: 'COMPLETED', purge_state: 'EXECUTED' }],
  ['COMPLETED purge queued', { status: 'COMPLETED', purge_state: 'QUEUED' }],
  ['COMPLETED deleted', { status: 'COMPLETED', deleted: true }],
  ['COMPLETED purge off', { status: 'COMPLETED', purge_enabled: false }],
  ['SENT self-sign', { envelope_mode: 'SELF' }],
  ['SENT in-person signer', { in_person_signer: true }],
  ['SENT in-person, feature off', { in_person_signer: true, in_person: false }],
  ['DRAFT Personal (authoring closed)', { status: 'DRAFT', kind: 'PERSONAL' }],
  ['SENT Personal (authoring closed)', { kind: 'PERSONAL' }],
];

describe('C1 predicates — the actions matrix', () => {
  const a = (k: ActorKey) => ACTORS[k];
  const act = (k: ActorKey, over: Partial<Fixture>) => senderActions(a(k), actionEnvelope({ ...BASE, ...over }), facts({ ...BASE, ...over }, a(k)));

  it('every action key is defined by exactly one rule list', () => {
    expect(Object.keys(SENDER_ACTION_RULES).sort()).toEqual([...SENDER_ACTION_KEYS].sort());
    expect(SENDER_ACTION_KEYS).toHaveLength(13);
  });

  it('owner of a DRAFT: edit, send, delete the draft and void; nothing that needs a sent or finished envelope', () => {
    expect(act('owner_sender', { status: 'DRAFT' })).toEqual({
      edit: true, send: true, delete_draft: true, void: true, remind: false, delete: false, restore: false,
      download: false, certificate: false, sign: false, host_in_person: false, purge: false, dequeue_purge: false,
    });
  });

  it('owner of a SENT envelope: void and remind only', () => {
    expect(act('owner_sender', { status: 'SENT' })).toMatchObject({ edit: false, send: false, delete_draft: false, void: true, remind: true, download: false });
  });

  it('owner of a COMPLETED envelope: download, certificate and delete; purge needs sign:envelope:manage:all', () => {
    expect(act('owner_sender', { status: 'COMPLETED' })).toMatchObject({ void: false, remind: false, download: true, certificate: true, delete: true, restore: false, purge: false, dequeue_purge: false });
  });

  it("S-1 — another member's envelope: a Sender can change nothing; a Sign Admin may", () => {
    const changes: SenderActionKey[] = ['edit', 'send', 'delete_draft', 'void'];
    for (const k of changes) expect(act('other_sender', { status: 'DRAFT' })[k]).toBe(false);
    for (const k of changes) expect(act('admin', { status: 'DRAFT' })[k]).toBe(true);
    expect(act('other_sender', { status: 'COMPLETED' })).toMatchObject({ delete: false, download: true });
    expect(act('admin', { status: 'COMPLETED' })).toMatchObject({ delete: true, purge: true });
  });

  it('a read-only Viewer: download and certificate of a completed envelope, nothing else', () => {
    for (const status of STATUSES) {
      const out = act('viewer', { status });
      for (const k of SENDER_ACTION_KEYS) expect(out[k], `${status} ${k}`).toBe((k === 'download' || k === 'certificate') && status === 'COMPLETED');
    }
  });

  it('S-3 — an envelope another application sent is never changed in Sign, even by a Sign Admin; reading it is', () => {
    for (const k of ['edit', 'send', 'delete_draft', 'void', 'remind', 'delete', 'restore', 'host_in_person'] as const) {
      expect(act('admin', { source_application: 'aramo-ats' })[k]).toBe(false);
      expect(act('admin', { status: 'COMPLETED', source_application: 'aramo-ats', deleted: true })[k]).toBe(false);
    }
    expect(act('admin', { status: 'COMPLETED', source_application: 'aramo-ats' }).download).toBe(true);
  });

  it('every status: edit / send / delete_draft only for DRAFT; void for anything not finished; remind while signing is open', () => {
    for (const status of STATUSES) {
      const out = act('owner_sender', { status });
      expect(out.edit).toBe(status === 'DRAFT');
      expect(out.send).toBe(status === 'DRAFT');
      expect(out.delete_draft).toBe(status === 'DRAFT');
      expect(out.void).toBe(['DRAFT', 'SENT', 'IN_PROGRESS'].includes(status));
      expect(out.remind).toBe(['SENT', 'IN_PROGRESS'].includes(status));
      expect(out.delete).toBe(['COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED'].includes(status));
      expect(out.download).toBe(status === 'COMPLETED');
    }
  });

  it('purged (EXECUTED): no download, certificate or restore; purge already done; delete stays as the server allows', () => {
    expect(act('admin', { status: 'COMPLETED', purge_state: 'EXECUTED', deleted: true })).toMatchObject({ download: false, certificate: false, restore: false, purge: false, dequeue_purge: false });
    expect(act('admin', { status: 'COMPLETED', purge_state: 'EXECUTED' }).delete).toBe(true);
  });

  it('Deleted folder: delete when not in it, restore when in it', () => {
    expect(act('owner_sender', { status: 'COMPLETED' })).toMatchObject({ delete: true, restore: false });
    expect(act('owner_sender', { status: 'COMPLETED', deleted: true })).toMatchObject({ delete: false, restore: true });
  });

  it('purge off (SIGN_PURGE_ENABLED unset): no delete, restore, purge or dequeue for anyone', () => {
    expect(act('admin', { status: 'COMPLETED', purge_enabled: false })).toMatchObject({ delete: false, restore: false, purge: false, dequeue_purge: false });
    expect(act('admin', { status: 'COMPLETED', purge_enabled: false, deleted: true }).restore).toBe(false);
  });

  it('purge needs sign:envelope:manage:all and a completed, declined or voided envelope; dequeue only while queued', () => {
    for (const status of STATUSES) expect(act('admin', { status }).purge).toBe(['COMPLETED', 'DECLINED', 'VOIDED'].includes(status));
    expect(act('admin', { status: 'COMPLETED', purge_state: 'QUEUED' })).toMatchObject({ purge: true, dequeue_purge: true });
    expect(act('owner_sender', { status: 'COMPLETED', purge_state: 'QUEUED' })).toMatchObject({ purge: false, dequeue_purge: false });
  });

  it('self-sign envelope: nobody to remind', () => {
    expect(act('owner_sender', { envelope_mode: 'SELF' }).remind).toBe(false);
  });

  it('host in person: an in-person signer whose turn it is, while the feature is available', () => {
    expect(act('owner_sender', { in_person_signer: true }).host_in_person).toBe(true);
    expect(act('owner_sender', { in_person_signer: true, in_person: false }).host_in_person).toBe(false);
    expect(act('owner_sender', {}).host_in_person).toBe(false);
    expect(act('viewer', { in_person_signer: true }).host_in_person).toBe(false);
  });

  it('plan / tenant: a Personal account without Personal sending authors and changes nothing', () => {
    for (const status of ['DRAFT', 'SENT'] as const) {
      const out = act('owner_sender', { status, kind: 'PERSONAL' });
      for (const k of ['edit', 'send', 'delete_draft', 'void', 'remind', 'host_in_person'] as const) expect(out[k]).toBe(false);
    }
  });

  it('sign: the self-sign session rule or an inbox item to sign through', () => {
    const f = { ...BASE };
    const env = actionEnvelope(f);
    expect(senderActions(ACTORS.owner_sender, env, { ...facts(f, ACTORS.owner_sender), can_self_sign_now: true }).sign).toBe(true);
    expect(senderActions(ACTORS.owner_sender, env, { ...facts(f, ACTORS.owner_sender), inbox_item: true }).sign).toBe(true);
    expect(senderActions(ACTORS.owner_sender, env, facts(f, ACTORS.owner_sender)).sign).toBe(false);
  });
});

describe('C1-2 — the boundary scope each rule names is the route decorator scope', () => {
  const REQUIRED_SCOPES_KEY = 'aramo:authorization:required_scopes';
  const sender = EsignSenderController.prototype as unknown as Record<string, object>;
  const retention = SignRetentionController.prototype as unknown as Record<string, object>;
  const handler: Record<Exclude<SenderActionKey, 'sign'>, object> = {
    edit: sender['update']!,
    send: sender['send']!,
    delete_draft: sender['deleteDraft']!,
    void: sender['void']!,
    remind: sender['remind']!,
    delete: retention['deleteForTenant']!,
    restore: retention['restoreForTenant']!,
    download: sender['executed']!,
    certificate: sender['executed']!,
    host_in_person: sender['hostedSession']!,
    purge: retention['queuePurge']!,
    dequeue_purge: retention['dequeuePurge']!,
  };
  it.each(Object.keys(handler) as Array<keyof typeof handler>)('%s', (action) => {
    const scopes = SENDER_ACTION_RULES[action].filter((c) => c.enforced_by === 'boundary').map((c) => c.scope);
    expect(scopes).toHaveLength(1);
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler[action])).toEqual(scopes);
  });
});

describe('C1-2 — the route refuses exactly when the predicate does (same code, status and reason)', () => {
  const cases: Array<[Exclude<SenderActionKey, 'sign'>, ActorKey, string, Partial<Fixture>]> = [];
  for (const action of Object.keys(ROUTES) as Array<Exclude<SenderActionKey, 'sign'>>) {
    for (const actor of Object.keys(ACTORS) as ActorKey[]) {
      for (const [label, over] of VARIANTS) cases.push([action, actor, label, over]);
    }
  }

  it.each(cases)('%s as %s on %s', async (action, actorKey, _label, over) => {
    const a = ACTORS[actorKey];
    const f = { ...BASE, ...over };
    // The decorator refuses an actor without the scope before the route runs.
    const scope = SENDER_ACTION_RULES[action].find((c) => c.enforced_by === 'boundary')?.scope;
    if (scope !== undefined && !a.scopes.includes(scope)) {
      expect(senderActionDecision(action, a, actionEnvelope(f), facts(f, a))).not.toBeNull();
      return;
    }
    const h = harness(f);
    const expected = firstRouteRefusal(action, a, f);
    // S-1 visibility: an envelope the caller cannot read is never listed (so it carries no
    // actions); once the route reads it, it answers 404.
    if (expected === 'not_found') {
      await expect(ROUTES[action](h, a)).rejects.toMatchObject({ code: 'ENVELOPE_NOT_FOUND', statusCode: 404 });
      return;
    }
    let thrown: unknown = undefined;
    try {
      await ROUTES[action](h, a);
    } catch (e) {
      thrown = e;
    }
    if (expected !== null && expected !== 'reaches_lock' && expected !== 'not_found') {
      expect(thrown).toBeInstanceOf(AramoError);
      const e = thrown as AramoError;
      expect({ code: e.code, status: e.statusCode, reason: (e.context.details as { reason?: string } | undefined)?.reason }).toEqual({
        code: expected.code,
        status: expected.status,
        reason: (expected.details as { reason?: string } | undefined)?.reason,
      });
      expect(senderActions(a, actionEnvelope(f), facts(f, a))[action]).toBe(false);
    } else if (thrown !== undefined) {
      // Past every service check: anything left is a content check on the request (e.g. not
      // ready to send), never an availability refusal.
      expect(thrown).toBeInstanceOf(AramoError);
      expect(isAvailabilityRefusal(thrown as AramoError), `${(thrown as AramoError).code} ${(thrown as AramoError).message}`).toBe(false);
    }
  });
});

describe('C1-1 — list rows and the detail carry actions from the same predicates', () => {
  it.each(VARIANTS)('%s', async (_label, over) => {
    for (const actorKey of ['owner_sender', 'admin'] as const) {
      const a = ACTORS[actorKey];
      const f = { ...BASE, ...over };
      if (!visible(a, f)) continue;
      const expected = senderActions(a, actionEnvelope(f), facts(f, a));
      const h = harness(f);
      const list = await h.svc.list(a, f.deleted ? { folder: 'deleted' } : {}, RID);
      expect(list.items[0]!.actions).toEqual(expected);
      expect((await h.svc.detail(a, ENV_ID, RID)).actions).toEqual(expected);
    }
  });

  it('the list adds no per-row query: Deleted-folder membership comes from the one id list', async () => {
    const h = harness({ ...BASE, status: 'COMPLETED' });
    await h.svc.list(ACTORS.owner_sender, {}, RID);
    expect(h.purges.deletedEnvelopeIds).toHaveBeenCalledTimes(1);
    expect(h.purges.isDeletedBy).not.toHaveBeenCalled();
  });

  it('ADD-not-rename (C1-3): editable, can_self_sign_now and can_remind keep their meaning', async () => {
    const h = harness({ ...BASE, status: 'DRAFT' });
    // A Sign Admin reads another member's draft: `editable` stays status + own-app only.
    const d = await h.svc.detail(ACTORS.admin, ENV_ID, RID);
    expect(d.editable).toBe(true);
    expect(d.can_self_sign_now).toBe(false);
    const sent = await harness(BASE).svc.detail(ACTORS.owner_sender, ENV_ID, RID);
    expect(sent.recipients[0]!.can_remind).toBe(true);
    expect(sent.actions.remind).toBe(true);
  });
});

describe('C1 — recipient inbox item actions', () => {
  const entry = (over: Partial<InboxActionEntry> = {}): InboxActionEntry => ({
    source: 'bound',
    envelope_status: 'SENT',
    signer_status: 'PENDING',
    envelope_expires_at: null,
    purge_state: null,
    turn: 'now',
    link_live: true,
    ...over,
  });
  const folder = { in_deleted_folder: false, removed: false };

  it('the keys', () => {
    expect(Object.keys(inboxActions(entry(), folder)).sort()).toEqual([...INBOX_ACTION_KEYS].sort());
  });

  it('sign: signable, the recipient’s turn, a live emailed link, not expired', () => {
    expect(inboxActions(entry(), folder).sign).toBe(true);
    expect(inboxActions(entry({ turn: 'later' }), folder).sign).toBe(false);
    expect(inboxActions(entry({ link_live: false }), folder).sign).toBe(false);
    expect(inboxActions(entry({ signer_status: 'SIGNED' }), folder).sign).toBe(false);
    expect(inboxActions(entry({ envelope_status: 'COMPLETED' }), folder).sign).toBe(false);
    expect(inboxActions(entry({ envelope_expires_at: new Date('2000-01-01T00:00:00Z') }), folder).sign).toBe(false);
  });

  it('download: a completed envelope the user signed, bound, not purged', () => {
    const done = { envelope_status: 'COMPLETED', signer_status: 'SIGNED' };
    expect(inboxActions(entry(done), folder).download).toBe(true);
    expect(inboxActions(entry({ ...done, purge_state: 'EXECUTED' }), folder).download).toBe(false);
    expect(inboxActions(entry({ ...done, source: 'discovered' }), folder).download).toBe(false);
    expect(inboxActions(entry({ envelope_status: 'COMPLETED', signer_status: 'DECLINED' }), folder).download).toBe(false);
  });

  it('delete / restore follow the Deleted folder; report needs a binding', () => {
    expect(inboxActions(entry(), folder)).toMatchObject({ delete: true, restore: false, report: true });
    expect(inboxActions(entry(), { in_deleted_folder: true, removed: true })).toMatchObject({ delete: false, restore: true });
    expect(inboxActions(entry(), { in_deleted_folder: true, removed: false })).toMatchObject({ delete: false, restore: false });
    expect(inboxActions(entry({ source: 'discovered' }), folder).report).toBe(false);
  });

  it('the signed-copy route refuses exactly when download is false (same code, status)', async () => {
    const variants: Array<Partial<InboxActionEntry>> = [
      { envelope_status: 'COMPLETED', signer_status: 'SIGNED' },
      { envelope_status: 'COMPLETED', signer_status: 'SIGNED', purge_state: 'EXECUTED' },
      { envelope_status: 'SENT', signer_status: 'PENDING' },
      { envelope_status: 'COMPLETED', signer_status: 'DECLINED' },
    ];
    for (const v of variants) {
      const e = entry(v);
      const r = {
        id: ENV_ID,
        envelope_tenant_id: TENANT,
        envelope_id: ENV_ID,
        signer_id: 's1',
        envelope: { status: e.envelope_status, purge_state: e.purge_state ?? null },
        signer: { status: e.signer_status },
      };
      const repo = { getForUser: vi.fn(async () => r), issueRecipientCopyAccess: vi.fn(async () => 'raw') };
      const prev = process.env['ARAMO_SIGN_BASE_URL'];
      process.env['ARAMO_SIGN_BASE_URL'] = 'https://sign.example.test';
      const svc = new RecipientInboxService(repo as never, {} as never);
      const decision = inboxDownloadDecision(e);
      try {
        if (decision === null) {
          await expect(svc.signedCopy(auth([], OWNER), ENV_ID, RID)).resolves.toMatchObject({ download_url: expect.any(String) });
        } else {
          await expect(svc.signedCopy(auth([], OWNER), ENV_ID, RID)).rejects.toMatchObject({ code: (decision as Refusal).code, statusCode: (decision as Refusal).status });
        }
      } finally {
        if (prev === undefined) delete process.env['ARAMO_SIGN_BASE_URL'];
        else process.env['ARAMO_SIGN_BASE_URL'] = prev;
      }
    }
  });
});
