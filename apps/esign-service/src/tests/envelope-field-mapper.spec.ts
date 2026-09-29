import { describe, expect, it } from 'vitest';
import { type ProviderFieldInput } from '@aramo/documents-contracts';

import { resolveAndValidateFields } from '../app/envelope-field-mapper.js';

// PX-V1 F2 — resolve + validate positioned fields at define time.
const DOCS = [{ id: 'doc-a', ordinal: 1 }];
const SIGNERS = [{ id: 'sg-1', signing_order: 1 }];

function field(over: Partial<ProviderFieldInput> = {}): ProviderFieldInput {
  return { document_ordinal: 1, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120, ...over };
}

describe('resolveAndValidateFields (PX-V1 F2)', () => {
  it('resolves document ordinal + signer signing_order to server ids', () => {
    const out = resolveAndValidateFields(
      't1',
      [field({ signer_signing_order: 1, field_type: 'SIGNATURE', x: 72, y: 120, required: true }), field({ field_type: 'SIGN_DATE', x: 72, y: 150 })],
      DOCS,
      SIGNERS,
    );
    expect(out).toEqual([
      { tenant_id: 't1', envelope_document_id: 'doc-a', signer_id: 'sg-1', field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120, width: undefined, height: undefined, required: true },
      { tenant_id: 't1', envelope_document_id: 'doc-a', signer_id: undefined, field_type: 'SIGN_DATE', page_number: 0, x: 72, y: 150, width: undefined, height: undefined, required: undefined },
    ]);
  });

  it('rejects an unknown field_type', () => {
    expect(() => resolveAndValidateFields('t1', [field({ field_type: 'NONSENSE' })], DOCS, SIGNERS)).toThrow(/unknown field_type/);
  });

  it('rejects negative or non-integer coordinates and page numbers', () => {
    expect(() => resolveAndValidateFields('t1', [field({ x: -1 })], DOCS, SIGNERS)).toThrow(/x and y/);
    expect(() => resolveAndValidateFields('t1', [field({ page_number: 1.5 })], DOCS, SIGNERS)).toThrow(/page_number/);
  });

  it('rejects a non-positive width/height when supplied', () => {
    expect(() => resolveAndValidateFields('t1', [field({ width: 0 })], DOCS, SIGNERS)).toThrow(/width/);
    expect(() => resolveAndValidateFields('t1', [field({ height: -3 })], DOCS, SIGNERS)).toThrow(/height/);
  });

  it('rejects an unresolvable document ordinal or signer signing_order', () => {
    expect(() => resolveAndValidateFields('t1', [field({ document_ordinal: 9 })], DOCS, SIGNERS)).toThrow(/document_ordinal 9/);
    expect(() => resolveAndValidateFields('t1', [field({ signer_signing_order: 9 })], DOCS, SIGNERS)).toThrow(/signer_signing_order 9/);
  });
});
