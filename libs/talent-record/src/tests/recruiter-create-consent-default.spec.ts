import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { TalentRecordController } from '../lib/talent-record.controller.js';
import { TalentCreateFromDraftService } from '../lib/talent-create-from-draft.service.js';
import { TalentIntakePromotionService } from '../lib/talent-intake/talent-intake-promotion.service.js';
import {
  applyRecruiterCreateConsentDefault,
  type RecruiterCreateConsentDefaultPort,
} from '../lib/recruiter-create-consent-default.port.js';

// CONSENT-RECRUITER-CREATE-DEFAULT-1 (Amendment v1.0 LOCKED) — the three recruiter
// create paths (§2) each invoke the at-create consent-default port EXACTLY ONCE,
// AFTER the TalentRecord exists; a port failure never fails the create (§5); an
// unbound port is a no-op.

const TENANT = '11111111-1111-7111-8111-111111111111';
const AUTH = {
  sub: 'recruiter-1',
  tenant_id: TENANT,
  consumer_type: 'recruiter',
  scopes: ['talent:create'],
} as unknown as AuthContextType;

const RESUME_DOC = {
  storage_key: 's3/resume.pdf',
  file_name: 'resume.pdf',
  mime_type: 'application/pdf',
  size_bytes: 42,
  source_map_version: 'resume-source-map/v1',
  resume_text_hash: 'hash-9',
};

function manualBody(over: Record<string, unknown> = {}) {
  return {
    first_name: 'Ada',
    last_name: 'Lovelace',
    email1: 'ada@example.com',
    phone_cell: '555-0100',
    ...over,
  };
}

function draftRow(over: Record<string, unknown> = {}) {
  return {
    id: 'draft-1',
    tenant_id: TENANT,
    source_kind: 'CREATE_DRAFT_UPLOAD',
    status: 'READY_FOR_REVIEW',
    talent_id: null,
    talent_document_id: null,
    resume_edition_id: null,
    ...over,
  };
}

function makePort(fail = false): RecruiterCreateConsentDefaultPort & {
  recordDefault: ReturnType<typeof vi.fn>;
} {
  return {
    recordDefault: fail
      ? vi.fn().mockRejectedValue(Object.assign(new Error('consent down'), { code: 'INTERNAL_ERROR' }))
      : vi.fn().mockResolvedValue(undefined),
  };
}

function make(opts: { port?: RecruiterCreateConsentDefaultPort; draft?: unknown } = {}) {
  const repo = {
    findActiveByEmail: vi.fn().mockResolvedValue(null),
    findActiveDuplicate: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation(async (args: { id?: string }) => ({
      id: args.id ?? 'tal-generated',
      first_name: 'Ada',
      last_name: 'Lovelace',
    })),
  };
  const talentExtraction = {
    findResumeExtractionDraftById: vi
      .fn()
      .mockResolvedValue(opts.draft === undefined ? null : opts.draft),
    establishCreateDraftEvidence: vi
      .fn()
      .mockResolvedValue({ document_id: 'doc-new', edition_id: 'ed-new' }),
    markResumeExtractionDraftAccepted: vi.fn().mockResolvedValue(1),
    createResumeDocument: vi.fn().mockResolvedValue('doc-1'),
  };
  const svc = new TalentCreateFromDraftService(repo as never, talentExtraction as never, opts.port);
  const ctl = new TalentRecordController(
    repo as never, {} as never, {} as never, {} as never,
    talentExtraction as never, {} as never, {} as never,
    undefined, undefined, undefined,
    svc,
    opts.port,
  );
  return { ctl, svc, repo, talentExtraction };
}

// ATI-SEP-1 A2 — the intake Save (one path; the former decoupled branch is gone).
function makeSave(port?: RecruiterCreateConsentDefaultPort) {
  let reserved: string | null = null;
  const intake = () => ({
    id: 'intake-1',
    tenant_id: TENANT,
    created_by: AUTH.sub,
    storage_key: null,
    source_filename: null,
    mime_type: null,
    size_bytes: null,
    artifact_sha256: null,
    resume_extraction_draft_id: null,
    promoted_talent_record_id: null,
    save_reserved_talent_record_id: reserved,
    save_evidence_materialized_at: null,
    review_payload: {
      fields: Object.fromEntries(
        Object.entries(manualBody()).map(([k, v]) => [k, { value: v, origin: 'RECRUITER' }]),
      ),
    },
  });
  const repo = {
    findActiveDuplicate: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation(async (args: { id: string }) => ({ id: args.id })),
  };
  const talentExtraction = {
    findTalentIntakeDraftById: vi.fn(async () => intake()),
    reserveTalentIntakeDraftSave: vi.fn(async (i: { reserved_talent_record_id: string }) => {
      reserved = i.reserved_talent_record_id;
      return 1;
    }),
    materializeIntakeSaveEvidence: vi.fn().mockResolvedValue({ materialized: true, document_id: null, edition_id: null }),
    getDefaultResumeEdition: vi.fn().mockResolvedValue(null),
    recordDeclaredWorkAuthorization: vi.fn().mockResolvedValue(undefined),
    completeTalentIntakeDraftSave: vi.fn().mockResolvedValue(1),
  };
  const svc = new TalentIntakePromotionService(talentExtraction as never, repo as never, undefined, port);
  return { svc, repo, talentExtraction };
}

describe('CONSENT-RECRUITER-CREATE-DEFAULT-1 — recruiter create paths', () => {
  it('manual create (POST /v1/talent-records, non-draft) invokes the port once, after create', async () => {
    const port = makePort();
    const m = make({ port });
    const res = await m.ctl.create(AUTH, manualBody() as never, 'rq-1');
    expect(res.id).toBe('tal-generated');
    expect(port.recordDefault).toHaveBeenCalledTimes(1);
    expect(port.recordDefault).toHaveBeenCalledWith({
      talent_record_id: 'tal-generated',
      authContext: AUTH,
      requestId: 'rq-1',
    });
    expect(m.repo.create.mock.invocationCallOrder[0]).toBeLessThan(
      port.recordDefault.mock.invocationCallOrder[0] as number,
    );
  });

  it('résumé-first draft confirm via the same route invokes the port exactly once (no double-count)', async () => {
    const port = makePort();
    const m = make({ port, draft: draftRow() });
    const res = await m.ctl.create(
      AUTH,
      manualBody({ draft_id: 'draft-1', resume_document: RESUME_DOC }) as never,
      'rq-2',
    );
    const reserved = (m.repo.create.mock.calls[0]?.[0] as { id: string }).id;
    expect(res.id).toBe(reserved);
    expect(port.recordDefault).toHaveBeenCalledTimes(1);
    expect(port.recordDefault).toHaveBeenCalledWith({
      talent_record_id: reserved,
      authContext: AUTH,
      requestId: 'rq-2',
    });
    expect(m.repo.create.mock.invocationCallOrder[0]).toBeLessThan(
      port.recordDefault.mock.invocationCallOrder[0] as number,
    );
  });

  it('intake promotion — governed branch (confirmCreateFromDraftUpload) invokes the port once', async () => {
    const port = makePort();
    const m = make({ port, draft: draftRow() });
    const res = await m.svc.confirmCreateFromDraftUpload(
      AUTH,
      manualBody({ draft_id: 'draft-1', resume_document: RESUME_DOC }) as never,
      'ada@example.com',
      'rq-3',
    );
    expect(res).not.toBeNull();
    expect(port.recordDefault).toHaveBeenCalledTimes(1);
    expect(port.recordDefault.mock.calls[0]?.[0]).toMatchObject({ talent_record_id: res?.id });
  });

  it('intake Save invokes the port once, after create', async () => {
    const port = makePort();
    const m = makeSave(port);
    const res = await m.svc.promote(AUTH, 'intake-1', 'rq-4');
    expect(port.recordDefault).toHaveBeenCalledTimes(1);
    expect(port.recordDefault).toHaveBeenCalledWith({
      talent_record_id: res.id,
      authContext: AUTH,
      requestId: 'rq-4',
    });
    expect(m.repo.create.mock.invocationCallOrder[0]).toBeLessThan(
      port.recordDefault.mock.invocationCallOrder[0] as number,
    );
  });

  it('§5 — a port failure still returns the created talent on every path', async () => {
    const manual = make({ port: makePort(true) });
    await expect(manual.ctl.create(AUTH, manualBody() as never, 'rq-5')).resolves.toMatchObject({
      id: 'tal-generated',
    });

    const draft = make({ port: makePort(true), draft: draftRow() });
    const viaDraft = await draft.ctl.create(
      AUTH,
      manualBody({ draft_id: 'draft-1', resume_document: RESUME_DOC }) as never,
      'rq-6',
    );
    expect(viaDraft.id).toBeDefined();
    // The draft lifecycle still closes after a consent failure.
    expect(draft.talentExtraction.markResumeExtractionDraftAccepted).toHaveBeenCalledOnce();

    const saved = makeSave(makePort(true));
    const viaSave = await saved.svc.promote(AUTH, 'intake-1', 'rq-7');
    expect(viaSave.id).toBeDefined();
    // The Save still completes (draft PROMOTED) after a consent failure.
    expect(saved.talentExtraction.completeTalentIntakeDraftSave).toHaveBeenCalledOnce();
  });

  it('port absent → no-op; create still succeeds', async () => {
    const m = make();
    await expect(m.ctl.create(AUTH, manualBody() as never, 'rq-8')).resolves.toMatchObject({
      id: 'tal-generated',
    });
    await expect(makeSave().svc.promote(AUTH, 'intake-1', 'rq-9')).resolves.toBeDefined();
  });

  it('non-recruiter consumer → the port is not invoked', async () => {
    const port = makePort();
    await applyRecruiterCreateConsentDefault(port, {
      talent_record_id: 'tal-1',
      authContext: { ...AUTH, consumer_type: 'system' } as unknown as AuthContextType,
      requestId: 'rq-10',
    });
    expect(port.recordDefault).not.toHaveBeenCalled();
  });
});
