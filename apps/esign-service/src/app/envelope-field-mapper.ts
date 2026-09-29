import { type AddFieldInput } from '@aramo/esign';
import { type ProviderFieldInput } from '@aramo/documents-contracts';

// PX-V1 F2 — resolve + validate positioned fields supplied on envelope creation,
// mapping the public ProviderFieldInput (ordinal / signing_order references) to
// the domain AddFieldInput (server-assigned ids). Fail-closed at define time:
// unknown field_type, out-of-range coordinates, or an unresolvable document /
// signer reference throw BEFORE any row is written. Page-SIZE bounds are enforced
// by the renderer at stamp time (pdf-lib adapter); define time enforces structure.

// Mirrors the SignatureField_type_check DB constraint so the API rejects unknown
// types with a clear error instead of a downstream CHECK violation.
const ALLOWED_FIELD_TYPES = new Set([
  'SIGNATURE',
  'INITIALS',
  'SIGN_DATE',
  'SIGNER_NAME',
  'TEXT',
  'CHECKBOX',
  'ACKNOWLEDGEMENT',
]);

export interface CreatedDocumentRef {
  id: string;
  ordinal: number;
}

export interface CreatedSignerRef {
  id: string;
  signing_order: number;
}

export function resolveAndValidateFields(
  tenant_id: string,
  fields: ProviderFieldInput[],
  documents: CreatedDocumentRef[],
  signers: CreatedSignerRef[],
): AddFieldInput[] {
  const docByOrdinal = new Map(documents.map((d) => [d.ordinal, d.id]));
  const signerByOrder = new Map(signers.map((s) => [s.signing_order, s.id]));

  return fields.map((f, i) => {
    if (!ALLOWED_FIELD_TYPES.has(f.field_type)) {
      throw new Error(`field[${i}]: unknown field_type "${f.field_type}"`);
    }
    if (!Number.isInteger(f.page_number) || f.page_number < 0) {
      throw new Error(`field[${i}]: page_number must be a non-negative integer`);
    }
    if (!Number.isFinite(f.x) || f.x < 0 || !Number.isFinite(f.y) || f.y < 0) {
      throw new Error(`field[${i}]: x and y must be finite and non-negative`);
    }
    if (f.width !== undefined && (!Number.isFinite(f.width) || f.width <= 0)) {
      throw new Error(`field[${i}]: width must be a positive number when supplied`);
    }
    if (f.height !== undefined && (!Number.isFinite(f.height) || f.height <= 0)) {
      throw new Error(`field[${i}]: height must be a positive number when supplied`);
    }
    const envelope_document_id = docByOrdinal.get(f.document_ordinal);
    if (envelope_document_id === undefined) {
      throw new Error(`field[${i}]: document_ordinal ${f.document_ordinal} does not match any document`);
    }
    let signer_id: string | undefined;
    if (f.signer_signing_order !== undefined) {
      signer_id = signerByOrder.get(f.signer_signing_order);
      if (signer_id === undefined) {
        throw new Error(`field[${i}]: signer_signing_order ${f.signer_signing_order} does not match any signer`);
      }
    }
    return {
      tenant_id,
      envelope_document_id,
      signer_id,
      field_type: f.field_type,
      page_number: f.page_number,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      required: f.required,
    };
  });
}
