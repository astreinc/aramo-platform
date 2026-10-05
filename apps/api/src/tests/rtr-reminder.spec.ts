import { describe, it, expect, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import type { SignatureProviderPort, EnvelopeSummary } from '@aramo/documents-contracts';

import { RtrOrchestratorService } from '../rtr/rtr-orchestrator.service.js';
import { RIGHT_TO_REPRESENT_TYPE_ID } from '../rtr/rtr-constants.js';

// COMM-RECRUITER-W1 (W1-C) — RTR duplicate-send guard + same-envelope reminder
// ORCHESTRATION (fast, provider-faked). The same-envelope session revoke/reissue
// + token security are proven on real Postgres in
// libs/esign/src/tests/esign-reminder.integration.spec.ts.

const TENANT = 't1';
const DOC = 'doc-1';
const REV = 'rev-1';

function envelope(over: Partial<EnvelopeSummary> = {}): EnvelopeSummary {
  return { envelope_id: 'E1', status: 'SENT', signers: [], ...over };
}

function makeOrchestrator(opts: {
  docStatus?: string;
  docType?: string;
  revision?: { id: string; content_sha256: string | null; template_version_id?: string | null } | null;
  findEnvelope?: SignatureProviderPort['findEnvelopeForDocument'];
}) {
  const createEnvelope = vi.fn(async () => envelope({ envelope_id: 'E-new' }));
  const sendEnvelope = vi.fn(async () => envelope({ envelope_id: 'E-new', status: 'SENT' }));
  const remindEnvelopeSigner = vi.fn(async () => envelope());
  const findEnvelopeForDocument = vi.fn(
    opts.findEnvelope ?? (async () => null),
  ) as unknown as SignatureProviderPort['findEnvelopeForDocument'];

  const signature = {
    createEnvelope,
    sendEnvelope,
    remindEnvelopeSigner,
    findEnvelopeForDocument,
    getEnvelope: vi.fn(),
    voidEnvelope: vi.fn(),
    getEvidence: vi.fn(),
  } as unknown as SignatureProviderPort;

  const documents = {
    getDocument: vi.fn(async () => ({
      document_type_id: opts.docType ?? RIGHT_TO_REPRESENT_TYPE_ID,
      status: opts.docStatus ?? 'PREPARED',
    })),
    getCurrentRevision: vi.fn(async () =>
      opts.revision === undefined ? { id: REV, content_sha256: 'AAA', template_version_id: 'tv1' } : opts.revision,
    ),
    prepareDocument: vi.fn(async () => undefined),
    createDocument: vi.fn(),
    ensureRequirement: vi.fn(),
  };
  const talent = {
    findById: async () => ({ email1: 'j@x.test', first_name: 'J', last_name: 'D' }),
  };
  const orch = new RtrOrchestratorService(
    documents as never,
    {} as never, // render — unused on these paths
    signature,
    talent as never,
    {} as never, // resolver
    {} as never, // binding
    {} as never, // templates
    {} as never, // storage
  );
  return { orch, createEnvelope, sendEnvelope, remindEnvelopeSigner, findEnvelopeForDocument, documents };
}

describe('W1-C1 — RTR duplicate-send guard', () => {
  it('does NOT create a second envelope when a non-terminal one already exists for the exact revision', async () => {
    const { orch, createEnvelope, sendEnvelope } = makeOrchestrator({
      findEnvelope: async () => envelope({ envelope_id: 'E1', status: 'SENT' }),
    });
    const res = await orch.send({ tenant_id: TENANT, document_id: DOC, talent_id: 'tal', created_by: 'u', requestId: 'r' });
    expect(res.envelope_id).toBe('E1'); // existing envelope returned
    expect(createEnvelope).not.toHaveBeenCalled();
    expect(sendEnvelope).not.toHaveBeenCalled();
  });

  it('creates+sends a new envelope when none exists for the revision', async () => {
    const { orch, createEnvelope, sendEnvelope, findEnvelopeForDocument } = makeOrchestrator({ findEnvelope: async () => null });
    const res = await orch.send({ tenant_id: TENANT, document_id: DOC, talent_id: 'tal', created_by: 'u', requestId: 'r' });
    expect(findEnvelopeForDocument).toHaveBeenCalledWith(TENANT, DOC, REV);
    expect(createEnvelope).toHaveBeenCalledTimes(1);
    expect(sendEnvelope).toHaveBeenCalledTimes(1);
    expect(res.envelope_id).toBe('E-new');
  });
});

describe('W1-C3 — RTR reminder orchestration', () => {
  it('reverse-resolves the envelope from the EXACT frozen revision and reminds it (same doc/revision/envelope)', async () => {
    const { orch, remindEnvelopeSigner, findEnvelopeForDocument, createEnvelope } = makeOrchestrator({
      docStatus: 'PREPARED',
      findEnvelope: async () => envelope({ envelope_id: 'E1', status: 'SENT' }),
    });
    const res = await orch.remind({ tenant_id: TENANT, document_id: DOC, requestId: 'r' });
    expect(findEnvelopeForDocument).toHaveBeenCalledWith(TENANT, DOC, REV); // same frozen revision
    expect(remindEnvelopeSigner).toHaveBeenCalledWith(TENANT, 'E1'); // same envelope
    expect(createEnvelope).not.toHaveBeenCalled(); // never a new RTR/envelope
    expect(res).toEqual({ document_id: DOC, status: 'AWAITING_SIGNATURE', reminder_sent: true });
  });

  it('is denied when the RTR is not AWAITING_SIGNATURE (ESIGN_REMINDER_NOT_ALLOWED)', async () => {
    const { orch, remindEnvelopeSigner } = makeOrchestrator({ docStatus: 'DRAFT' }); // REQUESTED
    await expect(orch.remind({ tenant_id: TENANT, document_id: DOC, requestId: 'r' })).rejects.toMatchObject({
      code: 'ESIGN_REMINDER_NOT_ALLOWED',
      statusCode: 409,
    });
    expect(remindEnvelopeSigner).not.toHaveBeenCalled();
  });

  it('is denied when no active envelope exists for the RTR (ESIGN_ENVELOPE_NOT_FOUND_FOR_DOCUMENT)', async () => {
    const { orch } = makeOrchestrator({ docStatus: 'PREPARED', findEnvelope: async () => null });
    await expect(orch.remind({ tenant_id: TENANT, document_id: DOC, requestId: 'r' })).rejects.toMatchObject({
      code: 'ESIGN_ENVELOPE_NOT_FOUND_FOR_DOCUMENT',
      statusCode: 404,
    });
  });

  it('rejects a non-RTR document (DOCUMENT_NOT_FOUND)', async () => {
    const { orch } = makeOrchestrator({ docType: 'some-other-type' });
    await expect(orch.remind({ tenant_id: TENANT, document_id: DOC, requestId: 'r' })).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
    });
  });

  it('propagates ESIGN_ENVELOPE_AMBIGUOUS from the provider lookup (fail-closed)', async () => {
    const { orch } = makeOrchestrator({
      docStatus: 'PREPARED',
      findEnvelope: async () => {
        throw new AramoError('ESIGN_ENVELOPE_AMBIGUOUS', 'ambiguous', 409, { requestId: 'r' });
      },
    });
    await expect(orch.remind({ tenant_id: TENANT, document_id: DOC, requestId: 'r' })).rejects.toMatchObject({
      code: 'ESIGN_ENVELOPE_AMBIGUOUS',
    });
  });
});
