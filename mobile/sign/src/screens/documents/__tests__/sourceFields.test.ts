// M-A13 #10 — the sender's Documents view shows the placed fields in recipient colours.
import { recipientColor } from '../../../theme';
import { sourceFieldMarks } from '../sourceFields';

const detail = {
  id: 'env-1',
  documents: [
    { id: 'doc-1', title: 'Lease' },
    { id: 'doc-2', title: 'Annex' },
  ],
  recipients: [
    { id: 'copy', name: 'Copy Person', recipient_kind: 'RECEIVES_COPY' },
    { id: 's2', name: 'Second', recipient_kind: 'SIGNER', signing_order: 2 },
    { id: 's1', name: 'First', recipient_kind: 'SIGNER', signing_order: 1 },
  ],
  fields: [
    { id: 'f1', envelope_document_id: 'doc-1', signer_id: 's1', field_type: 'SIGNATURE', page_number: 0, x: 72, y: 100, width: 230, height: 50 },
    { id: 'f2', envelope_document_id: 'doc-1', signer_id: 's2', field_type: 'SIGN_DATE', page_number: 1, x: 72, y: 60, width: 150, height: 22 },
    { id: 'f3', envelope_document_id: 'doc-1', signer_id: 's2', field_type: 'CHECKBOX', label: 'I agree', page_number: 1, x: 10, y: 10, width: 14, height: 14 },
    { id: 'f4', envelope_document_id: 'doc-2', signer_id: 's1', field_type: 'INITIALS', page_number: 0, x: 1, y: 1, width: 60, height: 30 },
  ],
};

describe('sourceFieldMarks', () => {
  it('lists the fields of one document with signing-order colours and type labels', () => {
    const marks = sourceFieldMarks(detail, 'doc-1');
    expect(marks.map((m) => [m.key, m.page, m.label, m.recipientName, m.color])).toEqual([
      ['f1', 0, 'Signature', 'First', recipientColor(0)],
      ['f2', 1, 'Date signed', 'Second', recipientColor(1)],
      ['f3', 1, 'I agree', 'Second', recipientColor(1)],
    ]);
    expect(marks[0]).toMatchObject({ x: 72, y: 100, width: 230, height: 50 });
  });

  it('no fields on a document (or no detail fields at all): nothing to overlay', () => {
    expect(sourceFieldMarks({ ...detail, fields: [] }, 'doc-1')).toEqual([]);
    expect(sourceFieldMarks(detail, 'doc-9')).toEqual([]);
  });
});
