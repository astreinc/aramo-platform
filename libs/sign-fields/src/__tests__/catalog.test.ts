// FIELD-PARITY-1 P1-1 / P1-0 / P1-6 — runs under vitest and mobile Jest (globals only).
// Phase 1 is a refactor: every surface projection equals the set that surface accepted before
// the catalog existed (recon of 2026-11-22, directive §1.1).
import {
  FIELD_CATALOG,
  FIELD_DEFAULTS,
  FIELD_SURFACES,
  FIELD_TYPE_KEYS,
  PROFILE_TEXT_FIELD_TYPES,
  fieldSettingsOf,
  fieldTypesFor,
  isFieldTypeKey,
  isFieldTypeOn,
  isPaymentsGatedOn,
  type FieldSurface,
} from '../index.js';

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

const SIX = ['SIGNATURE', 'INITIALS', 'SIGN_DATE', 'SIGNER_NAME', 'TEXT', 'CHECKBOX'];
const PROFILE = ['FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE'];
const SENDER = ['SIGNATURE', 'SIGN_DATE', 'INITIALS', 'TEXT', 'SIGNER_NAME', 'CHECKBOX', ...PROFILE];

// Today's accepted sets, per surface (gate off / gate on).
const TODAY: Record<FieldSurface, { readonly off: readonly string[]; readonly on: readonly string[] }> = {
  sign_store: { off: [...SENDER, 'ACKNOWLEDGEMENT', 'PAYMENT'], on: [...SENDER, 'ACKNOWLEDGEMENT', 'PAYMENT'] },
  send_web: { off: SENDER, on: [...SENDER, 'PAYMENT'] },
  send_mobile: { off: SENDER, on: [...SENDER, 'PAYMENT'] },
  sign_api_s2s: { off: [...SIX, 'ACKNOWLEDGEMENT'], on: [...SIX, 'ACKNOWLEDGEMENT'] },
  engine_passthrough: { off: [...SENDER, 'ACKNOWLEDGEMENT'], on: [...SENDER, 'ACKNOWLEDGEMENT'] },
  template_fixed_form: { off: SIX, on: SIX },
  template_editable: { off: SIX, on: SIX },
  template_documents_store: {
    off: ['TEXT', 'MULTILINE_TEXT', 'DATE', 'NUMBER', 'CURRENCY', 'CHECKBOX', 'IMAGE', 'SIGNATURE', 'INITIALS', 'SIGN_DATE', 'SIGNER_NAME', 'SIGNER_EMAIL'],
    on: ['TEXT', 'MULTILINE_TEXT', 'DATE', 'NUMBER', 'CURRENCY', 'CHECKBOX', 'IMAGE', 'SIGNATURE', 'INITIALS', 'SIGN_DATE', 'SIGNER_NAME', 'SIGNER_EMAIL'],
  },
  signature_block: { off: ['SIGNATURE', 'SIGNER_NAME', 'SIGN_DATE'], on: ['SIGNATURE', 'SIGNER_NAME', 'SIGN_DATE'] },
  suggestion: { off: ['SIGNATURE', 'SIGN_DATE'], on: ['SIGNATURE', 'SIGN_DATE'] },
};

describe('field catalog (P1-1)', () => {
  it('has one record per type: the Sign 13 plus the documents-only 6, each keyed by itself', () => {
    expect(FIELD_TYPE_KEYS).toHaveLength(19);
    for (const k of FIELD_TYPE_KEYS) expect(FIELD_CATALOG[k].key).toBe(k);
  });

  it.each(FIELD_SURFACES.map((s) => [s] as const))('%s: the projection equals what the surface accepts today', (s) => {
    expect(sorted(fieldTypesFor(s))).toEqual(sorted(TODAY[s].off));
    expect(sorted(fieldTypesFor(s, { payments_available: false }))).toEqual(sorted(TODAY[s].off));
    expect(sorted(fieldTypesFor(s, { payments_available: true }))).toEqual(sorted(TODAY[s].on));
  });

  it('keeps the Sign authoring order (SENDER_FIELD_TYPES, then ACKNOWLEDGEMENT, PAYMENT)', () => {
    expect(fieldTypesFor('send_web')).toEqual(SENDER);
    expect(fieldTypesFor('send_web', { payments_available: true })).toEqual([...SENDER, 'PAYMENT']);
    expect(fieldTypesFor('sign_store')).toEqual([...SENDER, 'ACKNOWLEDGEMENT', 'PAYMENT']);
  });

  it('sign-web and the app author the same set', () => {
    expect(fieldTypesFor('send_mobile')).toEqual(fieldTypesFor('send_web'));
    expect(fieldTypesFor('send_mobile', { payments_available: true })).toEqual(fieldTypesFor('send_web', { payments_available: true }));
  });

  it('isFieldTypeOn matches the projection', () => {
    expect(isFieldTypeOn('sign_api_s2s', 'ACKNOWLEDGEMENT')).toBe(true);
    expect(isFieldTypeOn('sign_api_s2s', 'FIRST_NAME')).toBe(false);
    expect(isFieldTypeOn('send_web', 'PAYMENT')).toBe(false);
    expect(isFieldTypeOn('send_web', 'PAYMENT', { payments_available: true })).toBe(true);
    expect(isFieldTypeOn('suggestion', 'toString')).toBe(false);
    expect(isFieldTypeOn('suggestion', 7)).toBe(false);
    expect(isFieldTypeKey('IMAGE')).toBe(true);
    expect(isFieldTypeKey('constructor')).toBe(false);
  });

  it('the profile text types and the settings each type accepts today', () => {
    expect([...PROFILE_TEXT_FIELD_TYPES]).toEqual(PROFILE);
    expect(fieldSettingsOf('CHECKBOX')).toEqual(['label', 'group_key', 'group_rule', 'min_selected']);
    expect(fieldSettingsOf('SIGNER_NAME')).toEqual(['name_mode']);
    expect(fieldSettingsOf('PAYMENT')).toEqual(['payment_amount_minor', 'payment_currency']);
    for (const k of FIELD_TYPE_KEYS) if (!['CHECKBOX', 'SIGNER_NAME', 'PAYMENT'].includes(k)) expect(fieldSettingsOf(k)).toEqual([]);
  });

  it('who fills a value today: the server stamps SIGN_DATE, fills a SIGNER_PROFILE name and a paid PAYMENT', () => {
    expect(FIELD_CATALOG.SIGN_DATE.filled_by).toBe('server');
    expect(FIELD_CATALOG.PAYMENT.filled_by).toBe('server');
    expect(FIELD_CATALOG.SIGNER_NAME.filled_by_name_mode).toEqual({ SIGNER_PROFILE: 'server', SIGNER_ENTERED: 'signer' });
    for (const k of ['SIGNATURE', 'INITIALS', 'TEXT', 'CHECKBOX', 'ACKNOWLEDGEMENT', ...PROFILE] as const) expect(FIELD_CATALOG[k].filled_by).toBe('signer');
  });
});

describe('default sizes and required defaults (P1-0)', () => {
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
  ] as const)('%s: %d × %d, required %s (mobile table, Appendix A rows 36–37)', (type, w, h, required) => {
    expect(FIELD_DEFAULTS[type]).toEqual({ width: w, height: h, required });
  });

  it('every type has a positive default size', () => {
    for (const k of FIELD_TYPE_KEYS) {
      expect(FIELD_DEFAULTS[k].width).toBeGreaterThan(0);
      expect(FIELD_DEFAULTS[k].height).toBeGreaterThan(0);
    }
  });
});

describe('PAYMENT is send-only (P1-6)', () => {
  const TEMPLATE_SURFACES: readonly FieldSurface[] = FIELD_SURFACES.filter((s) => s.startsWith('template_') || s === 'signature_block');

  it('no template surface projection contains PAYMENT, with or without payments available', () => {
    expect(TEMPLATE_SURFACES).toEqual(['template_fixed_form', 'template_editable', 'template_documents_store', 'signature_block']);
    for (const s of TEMPLATE_SURFACES) {
      expect(fieldTypesFor(s)).not.toContain('PAYMENT');
      expect(fieldTypesFor(s, { payments_available: true })).not.toContain('PAYMENT');
    }
  });

  it('PAYMENT is gated on exactly the two send surfaces, and on no other surface', () => {
    const gated = FIELD_SURFACES.filter((s) => isPaymentsGatedOn('PAYMENT', s));
    expect(gated).toEqual(['send_web', 'send_mobile']);
    for (const s of FIELD_SURFACES.filter((x) => x !== 'sign_store' && !gated.includes(x))) expect(fieldTypesFor(s, { payments_available: true })).not.toContain('PAYMENT');
  });

  it('PAYMENT is the only gated type', () => {
    for (const k of FIELD_TYPE_KEYS) if (k !== 'PAYMENT') for (const s of FIELD_SURFACES) expect(isPaymentsGatedOn(k, s)).toBe(false);
  });
});
