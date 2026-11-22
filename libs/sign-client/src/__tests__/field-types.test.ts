// Client Rule Consolidation C3 — runs under vitest and mobile Jest (globals only).
// Audit rows 35–37 (Appendix A): placeable types, default sizes (mobile's), required by default.
import { FIELD_DEFAULTS, SENDER_FIELD_TYPES, isSenderFieldType, placeableFieldTypes, sizeScale } from '../index.js';

describe('field types (rows 35–37)', () => {
  it('row 35: the server authoring list; PAYMENT only while payments are available', () => {
    expect([...SENDER_FIELD_TYPES]).toEqual(['SIGNATURE', 'SIGN_DATE', 'INITIALS', 'TEXT', 'SIGNER_NAME', 'CHECKBOX', 'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE']);
    expect(placeableFieldTypes({ payments_available: false })).not.toContain('PAYMENT');
    expect(placeableFieldTypes({ payments_available: true })).toEqual([...SENDER_FIELD_TYPES, 'PAYMENT']);
    expect(placeableFieldTypes({ payments_available: true })).not.toContain('ACKNOWLEDGEMENT');
  });

  it.each([
    ['SIGNATURE', 230, 50, true],
    ['INITIALS', 60, 30, true],
    ['SIGN_DATE', 150, 22, true],
    ['TEXT', 230, 22, false],
    ['SIGNER_NAME', 200, 22, true],
    ['CHECKBOX', 18, 18, false],
    ['FIRST_NAME', 150, 22, true],
    ['LAST_NAME', 150, 22, true],
    ['EMAIL', 200, 22, true],
    ['COMPANY', 200, 22, true],
    ['TITLE', 200, 22, true],
    ['ACKNOWLEDGEMENT', 400, 26, true],
    ['PAYMENT', 160, 26, true],
  ] as const)('%s: %d × %d, required %s', (type, w, h, required) => {
    expect(FIELD_DEFAULTS[type]).toEqual({ width: w, height: h, required });
  });

  it.each([
    ['SIGNATURE', true],
    ['PAYMENT', false],
    ['ACKNOWLEDGEMENT', false],
    [7, false],
  ])('isSenderFieldType(%j) → %s', (v, ok) => {
    expect(isSenderFieldType(v)).toBe(ok);
  });

  it.each([
    ['S', 0.85],
    ['M', 1],
    ['L', 1.2],
    [null, 1],
    ['XL', 1],
  ])('sizeScale(%j) → %d', (k, v) => {
    expect(sizeScale(k)).toBe(v);
  });
});
