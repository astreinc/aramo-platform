// M-A12 W1-A — Templates as a source in "Sign a document": the create-from-template call
// carries `mode: "self"` and never a signer, recipients, cc or routing mode; the
// template's documents and fields become placed fields for the self recipient. Server
// refusals are shown (the app itself never blocks the flow, D-1).
import { ApiError } from '../../../api/errors';
import { workspaceWith } from '../../inbox/__tests__/fixtures';
import { createSelfFromTemplate, selfSignRefusalCopy, startFromTemplate } from '../selfSignFlow';
import { SELF_COPY, SELF_KEY } from '../selfSignModel';

const PDF = new Uint8Array(
  Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
    'latin1',
  ),
);

const ENVELOPE = {
  id: 'env-t',
  revision: 2,
  status: 'DRAFT',
  documents: [{ id: 'doc-t', title: 'Lease' }],
  recipients: [{ id: 'r-self', name: 'Priya', email: 'p@example.com', recipient_kind: 'SIGNER' }],
  fields: [
    { id: 'f1', envelope_document_id: 'doc-t', signer_id: 'r-self', field_type: 'SIGNATURE', page_number: 0, x: 100, y: 642, width: 230, height: 50, required: true },
    { id: 'f2', envelope_document_id: 'doc-t', signer_id: 'r-self', field_type: 'COMPANY', page_number: 0, x: 100, y: 400, width: 200, height: 22, required: false },
    { id: 'f3', envelope_document_id: 'doc-t', signer_id: 'r-self', field_type: 'ACKNOWLEDGEMENT', page_number: 0, x: 10, y: 10, width: 20, height: 20, required: true },
  ],
};

describe('Templates as a source (self-sign)', () => {
  it('POST …/from-template with mode "self" and no recipient, then the template fields for the caller', async () => {
    const { net, workspace } = workspaceWith(() => ({ status: 201, body: { envelope: ENVELOPE } }));
    const fetchSource = jest.fn(async () => PDF);
    const r = await startFromTemplate(
      { createFromTemplate: createSelfFromTemplate(workspace), fetchSource },
      { templateId: 'tpl-1', values: { 'talent.full_name': 'Dana' }, idempotencyKey: 'key-12345678' },
    );
    expect(net.calls[0]?.url).toMatch(/\/v1\/sign\/sender\/envelopes\/from-template$/);
    expect(net.calls[0]?.body).toEqual({
      template_id: 'tpl-1',
      values: { 'talent.full_name': 'Dana' },
      idempotency_key: 'key-12345678',
      mode: 'self',
    });
    expect(fetchSource).toHaveBeenCalledWith('env-t', 'doc-t');
    expect(r.progress).toMatchObject({ envelopeId: 'env-t', signerId: 'r-self', sent: false, etag: '"env-t.2"' });
    expect(r.docs).toEqual([expect.objectContaining({ serverId: 'doc-t', title: 'Lease', pages: [{ width: 612, height: 792 }] })]);
    // Authoring types only (engine-only ACKNOWLEDGEMENT is not editable); boxes in the editor frame.
    expect(r.fields.map((f) => [f.type, f.recipientKey, f.y, f.required])).toEqual([
      ['SIGNATURE', SELF_KEY, 792 - 642 - 50, true],
      ['COMPANY', SELF_KEY, 792 - 400 - 22, false],
    ]);
  });

  it('shows the server refusal; network problems keep the generic copy', () => {
    const multi = new ApiError({ status: 422, code: 'VALIDATION_ERROR', reason: 'self_sign_single_recipient' });
    expect(selfSignRefusalCopy(multi, SELF_COPY.uploadFailed)).toMatch(/more than one signer/);
    const unverified = new ApiError({ status: 403, code: 'self_sign_email_unverified', reason: 'self_sign_email_unverified' });
    expect(selfSignRefusalCopy(unverified, SELF_COPY.uploadFailed)).toMatch(/Verify your account email/);
    const offline = new ApiError({ status: 0, code: 'network_unavailable', reason: 'network_unavailable' });
    expect(selfSignRefusalCopy(offline, SELF_COPY.uploadFailed)).toBe(SELF_COPY.uploadFailed);
  });
});
