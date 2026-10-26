import 'reflect-metadata';
import type { AuthContextType } from '@aramo/auth';
import { EnvelopeIllegalTransitionError, EnvelopeRevisionMismatchError } from '@aramo/sign';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { EsignSenderController } from '../app/sender/esign-sender.controller.js';
import { envelopeEtag, senderHttp } from '../app/sender/envelope-contracts.js';
import { SenderContextService } from '../app/sender/sender-context.service.js';
import { SenderEnvelopeService } from '../app/sender/sender-envelope.service.js';

// Aramo Sign Mobile (W7) — sender draft contracts at unit level:
//   D-W6-1  the document upload answers with the new revision and its ETag;
//   D-W6-2  documents[].pages in the sender detail (stored, filled on first read);
//   D-W6-3  deleting a DRAFT envelope (authority, If-Match, 409 envelope_not_draft,
//           stored bytes removed after commit);
//   B-11    user.identity_provider on the sender context.
// The database guarantees and the HTTP surface are proven in
// sign-mobile-sender-drafts.integration.spec.ts.

const ENV = 'e5000000-0000-7000-8000-0000000000a1';
const DOC = 'e5000000-0000-7000-8000-0000000000a2';
const BROWSER: AuthContextType = {
  sub: '11111111-1111-7111-8111-111111111111',
  consumer_type: 'sign',
  actor_kind: 'user',
  tenant_id: '22222222-2222-7222-8222-222222222222',
  scopes: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send'],
  iat: 0,
  exp: 0,
};
const NATIVE: AuthContextType = { ...BROWSER, client: 'native', dsid: 'ds-1' };
const OTHER_USER: AuthContextType = { ...BROWSER, sub: '33333333-3333-7333-8333-333333333333' };

async function pdfOf(sizes: Array<[number, number]>): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (const s of sizes) pdf.addPage(s);
  return pdf.save();
}

function envelope(over: Record<string, unknown> = {}) {
  return {
    id: ENV, subject: 'Offer', status: 'DRAFT', created_by: BROWSER.sub, source_application: 'aramo-sign', created_at: new Date(), sent_at: null,
    completed_at: null, declined_at: null, voided_at: null, expires_at: null, routing_mode: 'PARALLEL', revision: 3, message: null, documents: [], signers: [],
    ...over,
  };
}

function doc(over: Record<string, unknown> = {}) {
  return { id: DOC, title: 'Offer', ordinal: 0, source_mode: 'OWNED', content_type: 'application/pdf', byte_size: 10, source_sha256: 'a'.repeat(64), fields: [], page_sizes: null, ...over };
}

function harness(opts: { env?: Record<string, unknown>; source?: Uint8Array | Error } = {}) {
  const repo = {
    getEnvelopeDetail: vi.fn(async () => envelope(opts.env)),
    getDocument: vi.fn(async () => ({ source_mode: 'OWNED', document_ref: null, document_revision_ref: null, source_object_key: 'esign/source/t/e/o' })),
    savePageSizes: vi.fn(async () => undefined),
    listEnvelopeEvents: vi.fn(async () => []),
    addDraftDocument: vi.fn(async () => ({ id: DOC, title: 'Offer', ordinal: 0, byte_size: 10, revision: 4 })),
    deleteDraft: vi.fn(async () => ({ source_object_keys: ['esign/source/t/e/o1', 'esign/source/t/e/o2'], document_count: 2, recipient_count: 1 })),
  };
  const ctx = {
    tenantKind: vi.fn(async () => 'BUSINESS'),
    assertCanAuthor: vi.fn(async () => undefined),
    assertCanAuthorTenant: vi.fn(async () => ({ id: BROWSER.tenant_id, kind: 'BUSINESS' })),
  };
  const storage = {
    putOwnedSource: vi.fn(async () => ({ source_object_key: 'esign/source/t/e/new', byte_size: 10, source_sha256: 'b'.repeat(64) })),
    deleteOwnedSource: vi.fn(async () => undefined),
  };
  const sources = {
    getSourcePdf: vi.fn(async () => {
      if (opts.source instanceof Error) throw opts.source;
      return opts.source ?? new Uint8Array();
    }),
  };
  const storageGate = { reserveUpload: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
  const svc = new SenderEnvelopeService(
    repo as never, {} as never, ctx as never, { findUserById: vi.fn(async () => null) } as never,
    storage as never, sources as never, storageGate as never,
  );
  return { svc, repo, storage, sources, storageGate };
}

describe('D-W6-1 — the upload answers with the envelope revision and its ETag', () => {
  it('the service returns the revision the write produced (and the measured pages, stored with the document)', async () => {
    const { svc, repo } = harness();
    const bytes = await pdfOf([[612, 792], [595.28, 841.89]]);
    const out = await svc.upload(BROWSER, ENV, { filename: 'offer.pdf', content_base64: Buffer.from(bytes).toString('base64') }, 'r');
    expect(out).toMatchObject({ id: DOC, envelope_id: ENV, revision: 4, page_count: 2 });
    expect(out.pages).toEqual([{ width: 612, height: 792 }, { width: 595.28, height: 841.89 }]);
    expect(repo.addDraftDocument).toHaveBeenCalledWith(expect.objectContaining({ pages: out.pages }));
  });

  it('the controller sets ETag "{id}.{revision}" on the upload response', async () => {
    const envelopes = { upload: vi.fn(async () => ({ id: DOC, revision: 9 })) };
    const controller = new EsignSenderController({} as never, envelopes as never);
    const res = { setHeader: vi.fn() };
    const out = await controller.upload(BROWSER, 'r', ENV, { content_base64: 'x' }, res as never, envelopeEtag(ENV, 8), 'key-1');
    expect(out).toEqual({ id: DOC, revision: 9 });
    expect(res.setHeader).toHaveBeenCalledWith('ETag', `"${ENV}.9"`);
    expect(envelopes.upload).toHaveBeenCalledWith(BROWSER, ENV, { content_base64: 'x' }, 'r', { ifMatch: envelopeEtag(ENV, 8), idempotencyKey: 'key-1' });
  });

  it('a native upload without If-Match is refused 428 before anything is stored', async () => {
    const { svc, storage, repo } = harness();
    await expect(svc.upload(NATIVE, ENV, { content_base64: 'eA==' }, 'r')).rejects.toMatchObject({ statusCode: 428 });
    expect(storage.putOwnedSource).not.toHaveBeenCalled();
    expect(repo.addDraftDocument).not.toHaveBeenCalled();
  });
});

describe('D-W6-2 — documents[].pages in the sender detail', () => {
  it('stored page sizes are reported as they are, with no source read', async () => {
    const { svc, sources } = harness({ env: { documents: [doc({ page_sizes: { pages: [{ width: 612, height: 792 }] } })] } });
    const d = await svc.detail(BROWSER, ENV, 'r');
    expect(d.documents[0]).toMatchObject({ id: DOC, page_count: 1, pages: [{ width: 612, height: 792 }] });
    expect(sources.getSourcePdf).not.toHaveBeenCalled();
  });

  it('a document uploaded before page sizes were stored is measured on read and the result stored', async () => {
    const { svc, repo } = harness({ env: { documents: [doc()] }, source: await pdfOf([[612, 792], [792, 612], [612, 792]]) });
    const d = await svc.detail(BROWSER, ENV, 'r');
    const pages = [{ width: 612, height: 792 }, { width: 792, height: 612 }, { width: 612, height: 792 }];
    expect(d.documents[0]).toMatchObject({ page_count: 3, pages });
    expect(repo.savePageSizes).toHaveBeenCalledWith(BROWSER.tenant_id, DOC, pages);
  });

  it('an unreadable source leaves pages null (the detail never fails on it)', async () => {
    const { svc, repo } = harness({ env: { documents: [doc()] }, source: new Error('storage down') });
    const d = await svc.detail(BROWSER, ENV, 'r');
    expect(d.documents[0]).toMatchObject({ page_count: null, pages: null });
    expect(repo.savePageSizes).not.toHaveBeenCalled();
  });

  it('internal visibility reads (events) never fetch a source to fill page sizes', async () => {
    const { svc, sources } = harness({ env: { documents: [doc()] } });
    await svc.events(BROWSER, ENV, 'r');
    expect(sources.getSourcePdf).not.toHaveBeenCalled();
  });
});

describe('D-W6-3 — delete a DRAFT envelope', () => {
  it('deletes under the If-Match revision, then removes every stored source and releases its storage', async () => {
    const { svc, repo, storage, storageGate } = harness();
    await expect(svc.deleteDraft(NATIVE, ENV, 'r', envelopeEtag(ENV, 3))).resolves.toBeUndefined();
    expect(repo.deleteDraft).toHaveBeenCalledWith({ tenant_id: BROWSER.tenant_id, envelope_id: ENV, actor_ref: BROWSER.sub, expected_revision: 3 });
    expect(storage.deleteOwnedSource.mock.calls).toEqual([['esign/source/t/e/o1'], ['esign/source/t/e/o2']]);
    expect(storageGate.release.mock.calls).toEqual([[BROWSER.tenant_id, 'esign/source/t/e/o1'], [BROWSER.tenant_id, 'esign/source/t/e/o2']]);
  });

  it('a native delete without If-Match is 428 before any write; a browser may omit it', async () => {
    const { svc, repo } = harness();
    await expect(svc.deleteDraft(NATIVE, ENV, 'r')).rejects.toMatchObject({ statusCode: 428, context: { details: { reason: 'precondition_required' } } });
    expect(repo.deleteDraft).not.toHaveBeenCalled();
    await svc.deleteDraft(BROWSER, ENV, 'r');
    expect(repo.deleteDraft).toHaveBeenCalledWith({ tenant_id: BROWSER.tenant_id, envelope_id: ENV, actor_ref: BROWSER.sub });
  });

  it('a sent envelope is refused 409 envelope_not_draft; a stale If-Match maps to 412 with the current revision', async () => {
    const sent = harness();
    sent.repo.deleteDraft.mockRejectedValueOnce(new EnvelopeIllegalTransitionError('SENT', 'edit(DRAFT-only)'));
    await expect(sent.svc.deleteDraft(BROWSER, ENV, 'r')).rejects.toMatchObject({ statusCode: 409, context: { details: { reason: 'envelope_not_draft' } } });
    expect(sent.storage.deleteOwnedSource).not.toHaveBeenCalled();
    const stale = harness();
    const e = new EnvelopeRevisionMismatchError(ENV, 5, 3);
    stale.repo.deleteDraft.mockRejectedValueOnce(e);
    await expect(stale.svc.deleteDraft(BROWSER, ENV, 'r', envelopeEtag(ENV, 3))).rejects.toBe(e);
    expect(senderHttp(e, 'r')).toMatchObject({ statusCode: 412, context: { details: { reason: 'revision_mismatch', current_revision: 5 } } });
  });

  it('another member’s draft reads as not found (no organization read scope); with read:all but no manage:all it is 403', async () => {
    const { svc, repo } = harness({ env: { created_by: BROWSER.sub } });
    await expect(svc.deleteDraft(OTHER_USER, ENV, 'r')).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.deleteDraft({ ...OTHER_USER, scopes: [...OTHER_USER.scopes, 'sign:envelope:read:all'] }, ENV, 'r')).rejects.toMatchObject({
      statusCode: 403,
      context: { details: { reason: 'envelope_not_owned' } },
    });
    expect(repo.deleteDraft).not.toHaveBeenCalled();
  });

  it('an envelope another application sent is refused (managed_by_source_application), like every edit', async () => {
    const { svc, repo } = harness({ env: { source_application: 'aramo-ats' } });
    await expect(svc.deleteDraft(BROWSER, ENV, 'r')).rejects.toMatchObject({ statusCode: 409, context: { details: { reason: 'managed_by_source_application' } } });
    expect(repo.deleteDraft).not.toHaveBeenCalled();
  });

  it('a storage failure after the commit never fails the delete', async () => {
    const { svc, storage } = harness();
    storage.deleteOwnedSource.mockRejectedValue(new Error('s3 down'));
    await expect(svc.deleteDraft(BROWSER, ENV, 'r')).resolves.toBeUndefined();
  });
});

describe('B-11 — user.identity_provider on the sender context', () => {
  function context(idps?: { recordedIdpsOf: (u: string) => Promise<string[]>; policyOf: (t: string) => Promise<{ enforced: boolean; pin: string | null }> }) {
    const tenants = {
      findById: vi.fn(async () => ({ id: BROWSER.tenant_id, name: 'Co', kind: 'BUSINESS', is_active: true, status: 'ACTIVE' })),
      findSlugById: vi.fn(async () => 'co'),
      findOrganizationNameById: vi.fn(async () => 'Co Inc'),
    };
    const identity = {
      findUserById: vi.fn(async () => ({ id: BROWSER.sub, email: 'a@co.test', display_name: 'Ann' })),
      findMembership: vi.fn(async () => null),
      findRoleKeysForMembership: vi.fn(async () => []),
    };
    return new SenderContextService(tenants as never, identity as never, undefined, undefined, idps as never);
  }
  const policy = (enforced: boolean, pin: string | null) => async () => ({ enforced, pin });

  it('the one provider recorded on the user’s sign-in link', async () => {
    const view = await context({ recordedIdpsOf: async () => ['microsoft'], policyOf: policy(false, null) }).context(BROWSER, 'r');
    expect(view.user).toEqual({ id: BROWSER.sub, email: 'a@co.test', display_name: 'Ann', identity_provider: 'microsoft' });
  });

  it('no recorded provider: the pin of a tenant that enforces it; otherwise null', async () => {
    expect((await context({ recordedIdpsOf: async () => [], policyOf: policy(true, 'google') }).context(BROWSER, 'r')).user.identity_provider).toBe('google');
    expect((await context({ recordedIdpsOf: async () => [], policyOf: policy(false, 'google') }).context(BROWSER, 'r')).user.identity_provider).toBeNull();
  });

  it('never a guess: two recorded providers, an unknown provider, a failing read or no policy service → null', async () => {
    expect((await context({ recordedIdpsOf: async () => ['google', 'microsoft'], policyOf: policy(true, 'google') }).context(BROWSER, 'r')).user.identity_provider).toBeNull();
    expect((await context({ recordedIdpsOf: async () => ['facebook'], policyOf: policy(false, null) }).context(BROWSER, 'r')).user.identity_provider).toBeNull();
    expect(
      (
        await context({
          recordedIdpsOf: async () => {
            throw new Error('db');
          },
          policyOf: policy(true, 'google'),
        }).context(BROWSER, 'r')
      ).user.identity_provider,
    ).toBeNull();
    expect((await context().context(BROWSER, 'r')).user.identity_provider).toBeNull();
  });
});
