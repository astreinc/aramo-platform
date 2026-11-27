import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { EsignSenderConsumerGuard } from '@aramo/identity';
import { SignFolderNameTakenError, type SignFolderItemKind } from '@aramo/sign';
import { FOLDER_COPY, FOLDERS_PER_USER_MAX } from '@aramo/sign-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SignFoldersController } from '../app/folders/sign-folders.controller.js';
import { SignFoldersService, parseFolderParam } from '../app/folders/sign-folders.service.js';
import { RecipientInboxService } from '../app/inbox/recipient-inbox.service.js';
import { SenderEnvelopeService } from '../app/sender/sender-envelope.service.js';

// SIGN-FREE-PARITY-1 S7 (FP-R8) — a user's own folders: per user within the tenant, an item
// in at most one folder, deleting a folder never deletes an envelope, the Deleted folder unchanged.

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const TENANT = '22222222-2222-4222-8222-222222222222';
const auth = (sub = USER): AuthContextType => ({ sub, consumer_type: 'sign', actor_kind: 'user', tenant_id: TENANT, scopes: [], iat: 0, exp: 0 });

interface Folder { id: string; tenant_id: string; owner_user_id: string; name: string }
interface Item { folder_id: string; item_kind: SignFolderItemKind; item_ref: string }

// An in-memory SignUserFolderRepository with the same ownership filters.
function memoryRepo() {
  const folders: Folder[] = [];
  let items: Item[] = [];
  let n = 0;
  const mine = (t: string, u: string) => folders.filter((f) => f.tenant_id === t && f.owner_user_id === u);
  const repo = {
    folders,
    items: () => items,
    list: vi.fn(async (t: string, u: string) =>
      mine(t, u).map((f) => ({ id: f.id, name: f.name, created_at: new Date(0), updated_at: new Date(0), sender_items: items.filter((i) => i.folder_id === f.id && i.item_kind === 'SENDER').length, recipient_items: items.filter((i) => i.folder_id === f.id && i.item_kind === 'RECIPIENT').length })),
    ),
    count: vi.fn(async (t: string, u: string) => mine(t, u).length),
    find: vi.fn(async (t: string, u: string, id: string) => mine(t, u).find((f) => f.id === id) ?? null),
    create: vi.fn(async (t: string, u: string, name: string) => {
      if (mine(t, u).some((f) => f.name.toLowerCase() === name.toLowerCase())) throw new SignFolderNameTakenError();
      n += 1;
      const id = `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      folders.push({ id, tenant_id: t, owner_user_id: u, name });
      return { id };
    }),
    rename: vi.fn(async (t: string, u: string, id: string, name: string) => {
      const f = mine(t, u).find((x) => x.id === id);
      if (f === undefined) return false;
      f.name = name;
      return true;
    }),
    remove: vi.fn(async (t: string, u: string, id: string) => {
      const i = folders.findIndex((f) => f.id === id && f.tenant_id === t && f.owner_user_id === u);
      if (i < 0) return false;
      folders.splice(i, 1);
      items = items.filter((x) => x.folder_id !== id);
      return true;
    }),
    placements: vi.fn(async (t: string, u: string, kind: SignFolderItemKind) => {
      const ids = new Set(mine(t, u).map((f) => f.id));
      return new Map(items.filter((i) => i.item_kind === kind && ids.has(i.folder_id)).map((i) => [i.item_ref, i.folder_id]));
    }),
    itemRefs: vi.fn(async (t: string, u: string, folder_id: string, kind: SignFolderItemKind) =>
      mine(t, u).some((f) => f.id === folder_id) ? items.filter((i) => i.folder_id === folder_id && i.item_kind === kind).map((i) => i.item_ref) : [],
    ),
    place: vi.fn(async (t: string, u: string, folder_id: string, kind: SignFolderItemKind, ref: string) => {
      const ids = new Set(mine(t, u).map((f) => f.id));
      if (!ids.has(folder_id)) return false;
      items = items.filter((i) => !(i.item_kind === kind && i.item_ref === ref && ids.has(i.folder_id)));
      items.push({ folder_id, item_kind: kind, item_ref: ref });
      return true;
    }),
    unplace: vi.fn(async (t: string, u: string, kind: SignFolderItemKind, ref: string) => {
      const ids = new Set(mine(t, u).map((f) => f.id));
      items = items.filter((i) => !(i.item_kind === kind && i.item_ref === ref && ids.has(i.folder_id)));
    }),
  };
  return repo;
}

describe('folders — create, rename, delete (per user)', () => {
  it('creates with the shared name rule and lists only the owner’s folders', async () => {
    const repo = memoryRepo();
    const svc = new SignFoldersService(repo as never);
    const f = await svc.create(auth(), { name: '  Leases   2026 ' }, 'r');
    expect(f).toMatchObject({ name: 'Leases 2026', sender_items: 0, recipient_items: 0 });
    expect((await svc.list(auth())).items).toHaveLength(1);
    expect((await svc.list(auth(OTHER))).items).toHaveLength(0);
    expect(await svc.list(auth())).toMatchObject({ limit: FOLDERS_PER_USER_MAX, name_max: 60, can_create: true });
  });

  it.each([
    ['empty', { name: '  ' }, 'folder_name_empty'],
    ['too long', { name: 'x'.repeat(61) }, 'folder_name_too_long'],
    ['not a string', { name: 7 }, 'folder_name_empty'],
  ])('refuses a %s name', async (_n, body, reason) => {
    const svc = new SignFoldersService(memoryRepo() as never);
    await expect(svc.create(auth(), body, 'r')).rejects.toMatchObject({ statusCode: 400, context: { details: { reason } } });
  });

  it('refuses a name the owner already has (without case); another user may use it', async () => {
    const svc = new SignFoldersService(memoryRepo() as never);
    await svc.create(auth(), { name: 'Tax' }, 'r');
    await expect(svc.create(auth(), { name: 'TAX' }, 'r')).rejects.toMatchObject({ statusCode: 400, message: FOLDER_COPY.folder_name_taken });
    await expect(svc.create(auth(OTHER), { name: 'Tax' }, 'r')).resolves.toMatchObject({ name: 'Tax' });
  });

  it('caps folders per user', async () => {
    const repo = memoryRepo();
    for (let i = 0; i < FOLDERS_PER_USER_MAX; i += 1) repo.folders.push({ id: `x-${i}`, tenant_id: TENANT, owner_user_id: USER, name: `F${i}` });
    const svc = new SignFoldersService(repo as never);
    await expect(svc.create(auth(), { name: 'One more' }, 'r')).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'folder_limit_reached' } } });
    expect((await svc.list(auth())).can_create).toBe(false);
  });

  it('renames (keeping its own name is allowed); another user’s folder is 404', async () => {
    const svc = new SignFoldersService(memoryRepo() as never);
    const a = await svc.create(auth(), { name: 'A' }, 'r');
    await svc.create(auth(), { name: 'B' }, 'r');
    await expect(svc.rename(auth(), a.id, { name: 'a' }, 'r')).resolves.toMatchObject({ name: 'a' });
    await expect(svc.rename(auth(), a.id, { name: 'b' }, 'r')).rejects.toMatchObject({ context: { details: { reason: 'folder_name_taken' } } });
    await expect(svc.rename(auth(OTHER), a.id, { name: 'Mine' }, 'r')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('deleting a folder removes its items only; another user’s folder is 404', async () => {
    const repo = memoryRepo();
    const svc = new SignFoldersService(repo as never);
    const a = await svc.create(auth(), { name: 'A' }, 'r');
    await svc.place(auth(), a.id, 'SENDER', 'env-1', 'r');
    await expect(svc.remove(auth(OTHER), a.id, 'r')).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.remove(auth(), a.id, 'r')).resolves.toEqual({ deleted: true });
    expect(repo.items()).toHaveLength(0);
  });

  it('an item is in at most one folder: moving replaces', async () => {
    const repo = memoryRepo();
    const svc = new SignFoldersService(repo as never);
    const a = await svc.create(auth(), { name: 'A' }, 'r');
    const b = await svc.create(auth(), { name: 'B' }, 'r');
    await svc.place(auth(), a.id, 'SENDER', 'env-1', 'r');
    await svc.place(auth(), b.id, 'SENDER', 'env-1', 'r');
    expect((await svc.placements(auth(), 'SENDER')).get('env-1')).toBe(b.id);
    expect(repo.items()).toHaveLength(1);
    await expect(svc.place(auth(OTHER), a.id, 'SENDER', 'env-2', 'r')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('the list `folder` value is the Deleted folder, a folder id, or refused', () => {
    expect(parseFolderParam(undefined, 'r')).toEqual({ kind: 'all' });
    expect(parseFolderParam('deleted', 'r')).toEqual({ kind: 'deleted' });
    expect(parseFolderParam('F0000000-0000-4000-8000-000000000001', 'r')).toEqual({ kind: 'user', id: 'f0000000-0000-4000-8000-000000000001' });
    expect(() => parseFolderParam('archive', 'r')).toThrow(/unknown folder/);
  });

  it('every route is any signed-in Sign user (JWT + Sign consumer), like the inbox', () => {
    for (const m of ['list', 'create', 'rename', 'remove'] as const) {
      const guards = Reflect.getMetadata(GUARDS_METADATA, SignFoldersController.prototype[m]) as unknown[];
      expect(guards).toEqual([JwtAuthGuard, EsignSenderConsumerGuard]);
    }
  });
});

describe('folders — the sender list', () => {
  const ENV_A = 'e0000000-0000-4000-8000-00000000000a';
  const ENV_D = 'e0000000-0000-4000-8000-00000000000d';
  function sender() {
    const repo = { listEnvelopes: vi.fn(async () => []), lastEventAt: vi.fn(async () => new Map()), countByStatus: vi.fn(async () => ({})) };
    const context = { tenantKind: vi.fn(async () => 'PERSONAL'), assertCanAuthor: vi.fn(async () => undefined) };
    const purges = { deletedEnvelopeIds: vi.fn(async () => [ENV_D]) };
    const folders = new SignFoldersService(memoryRepo() as never);
    const args: unknown[] = Array(22).fill(undefined);
    args[0] = repo;
    args[2] = context;
    args[3] = { findUserById: vi.fn(async () => null) };
    args[12] = purges;
    args[21] = folders;
    const svc = new (SenderEnvelopeService as unknown as new (...a: unknown[]) => SenderEnvelopeService)(...args);
    return { svc, repo, folders };
  }

  it('a folder lists only what the user put in it, never a deleted envelope; no folder lists everything not deleted', async () => {
    const { svc, repo, folders } = sender();
    const f = await folders.create(auth(), { name: 'Leases' }, 'r');
    await folders.place(auth(), f.id, 'SENDER', ENV_A, 'r');
    await folders.place(auth(), f.id, 'SENDER', ENV_D, 'r');
    await svc.list(auth(), { folder: f.id }, 'r');
    expect(repo.listEnvelopes).toHaveBeenLastCalledWith(expect.objectContaining({ only_ids: [ENV_A], created_by: USER }));
    await svc.list(auth(), {}, 'r');
    expect(repo.listEnvelopes).toHaveBeenLastCalledWith(expect.objectContaining({ exclude_ids: [ENV_D] }));
    await svc.list(auth(), { folder: 'deleted' }, 'r');
    expect(repo.listEnvelopes).toHaveBeenLastCalledWith(expect.objectContaining({ only_ids: [ENV_D] }));
  });

  it('another user’s folder is 404; an unknown value is 400', async () => {
    const { svc, folders } = sender();
    const theirs = await folders.create(auth(OTHER), { name: 'Theirs' }, 'r');
    await expect(svc.list(auth(), { folder: theirs.id }, 'r')).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.list(auth(), { folder: 'archive' }, 'r')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('moving checks the envelope is visible to the caller first', async () => {
    const { svc, folders } = sender();
    const f = await folders.create(auth(), { name: 'Leases' }, 'r');
    const visible = vi.spyOn(svc, 'assertVisible').mockResolvedValueOnce(undefined);
    await expect(svc.moveToFolder(auth(), ENV_A, { folder_id: f.id }, 'r')).resolves.toEqual({ folder_id: f.id });
    expect(visible).toHaveBeenCalledWith(expect.objectContaining({ sub: USER }), ENV_A, 'r');
    visible.mockRejectedValueOnce(Object.assign(new Error('not found'), { statusCode: 404 }));
    await expect(svc.moveToFolder(auth(), ENV_D, { folder_id: f.id }, 'r')).rejects.toMatchObject({ statusCode: 404 });
    expect((await folders.placements(auth(), 'SENDER')).has(ENV_D)).toBe(false);
  });
});

describe('folders — the recipient inbox', () => {
  let savedBase: string | undefined;
  beforeEach(() => {
    savedBase = process.env['ARAMO_SIGN_BASE_URL'];
    process.env['ARAMO_SIGN_BASE_URL'] = 'https://sign.example.test';
  });
  afterEach(() => {
    if (savedBase === undefined) delete process.env['ARAMO_SIGN_BASE_URL'];
    else process.env['ARAMO_SIGN_BASE_URL'] = savedBase;
  });

  const BINDING_1 = 'b1000000-0000-4000-8000-000000000001';
  const BINDING_2 = 'b1000000-0000-4000-8000-000000000002';
  const row = (id: string, signer_id: string, envelope_id: string) => ({
    id,
    source: 'bound',
    turn: 'now',
    link_live: true,
    envelope_tenant_id: '33333333-3333-4333-8333-333333333333',
    envelope_id,
    signer_id,
    created_at: new Date(),
    envelope: { subject: 'Offer letter', status: 'SENT', sent_at: new Date(), completed_at: null, expires_at: new Date(Date.now() + 86_400_000) },
    signer: { name: 'Bob', status: 'PENDING', signed_at: null },
  });

  function inbox() {
    const rows = [row(BINDING_1, 's1', 'e1'), row(BINDING_2, 's2', 'e2')];
    const repo = {
      removedSignerIds: vi.fn(async () => new Set<string>()),
      listForUser: vi.fn(async () => rows),
      getForUser: vi.fn(async (_u: string, id: string) => rows.find((r) => r.id === id) ?? null),
    };
    const identity = { findUserById: vi.fn(async () => null), findTenantNameById: vi.fn(async () => ({ name: 'northwind', display_name: 'Northwind' })) };
    const folderRepo = memoryRepo();
    const folders = new SignFoldersService(folderRepo as never);
    const svc = new RecipientInboxService(repo as never, identity as never, undefined, undefined, folders);
    return { svc, folders, folderRepo };
  }
  const all = (r: { waiting: Array<{ id: string; folder_id: string | null }>; completed: Array<{ id: string; folder_id: string | null }>; other: Array<{ id: string; folder_id: string | null }> }) => [...r.waiting, ...r.completed, ...r.other];

  it('a received item moves into the user’s folder (keyed by their signer id) and the folder lists only it', async () => {
    const { svc, folders, folderRepo } = inbox();
    const f = await folders.create(auth(), { name: 'Offers' }, 'r');
    await expect(svc.moveToFolder(auth(), BINDING_1, { folder_id: f.id }, 'r')).resolves.toEqual({ folder_id: f.id });
    expect(folderRepo.items()).toEqual([{ folder_id: f.id, item_kind: 'RECIPIENT', item_ref: 's1' }]);
    const everything = all(await svc.list(auth()));
    expect(everything.map((i) => [i.id, i.folder_id])).toEqual([[BINDING_1, f.id], [BINDING_2, null]]);
    expect(all(await svc.list(auth(), f.id, 'r')).map((i) => i.id)).toEqual([BINDING_1]);
    await expect(svc.removeFromFolder(auth(), BINDING_1, 'r')).resolves.toEqual({ folder_id: null });
    expect(all(await svc.list(auth(), f.id, 'r'))).toHaveLength(0);
  });

  it('another user’s folder, an unknown item or a missing folder_id is refused', async () => {
    const { svc, folders } = inbox();
    const theirs = await folders.create(auth(OTHER), { name: 'Theirs' }, 'r');
    await expect(svc.moveToFolder(auth(), BINDING_1, { folder_id: theirs.id }, 'r')).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.list(auth(), theirs.id, 'r')).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.moveToFolder(auth(), 'b9000000-0000-4000-8000-000000000009', { folder_id: theirs.id }, 'r')).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.moveToFolder(auth(), BINDING_1, {}, 'r')).rejects.toMatchObject({ statusCode: 400 });
  });
});
