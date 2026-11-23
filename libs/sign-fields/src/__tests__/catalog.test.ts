// FIELD-PARITY-1 P1-1 / P1-0 / P1-6 — runs under vitest and mobile Jest (globals only).
// Phase 1 was a refactor: every surface projection equalled the set that surface accepted before
// the catalog existed (recon of 2026-11-22, directive §1.1). Phase 3 (§6, R-1, R-2, R-9) widens
// the send and template surfaces deliberately; the table below is the widened set.
import {
  FIELD_CATALOG,
  FIELD_DEFAULTS,
  FIELD_SURFACES,
  FIELD_TYPE_KEYS,
  PROFILE_TEXT_FIELD_TYPES,
  editableFieldSettings,
  fieldSettingsOf,
  fieldTypesFor,
  senderEditorSettings,
  isFieldTypeKey,
  isFieldTypeOn,
  isPaymentsGatedOn,
  isCircleMark,
  TEMPLATE_TYPE_MAPPING,
  RETIRED_FIELD_TYPES,
  type FieldSurface,
} from '../index.js';

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

const SIX = ['SIGNATURE', 'INITIALS', 'SIGN_DATE', 'SIGNER_NAME', 'TEXT', 'CHECKBOX'];
const PROFILE = ['FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE'];
const SENDER = ['SIGNATURE', 'SIGN_DATE', 'INITIALS', 'TEXT', 'SIGNER_NAME', 'CHECKBOX', ...PROFILE];
// FIELD-PARITY-1 P3 T-3..T-7, in catalog order.
const NEW = ['DATE', 'DROPDOWN', 'RADIO', 'NUMBER', 'MULTILINE_TEXT'];
// Every send / template surface: the Sign authoring types + ACKNOWLEDGEMENT (R-2) + the new types.
const AUTHORED = [...SENDER, 'ACKNOWLEDGEMENT', ...NEW];

// The accepted sets, per surface (gate off / gate on).
const TODAY: Record<FieldSurface, { readonly off: readonly string[]; readonly on: readonly string[] }> = {
  sign_store: { off: [...AUTHORED, 'PAYMENT'], on: [...AUTHORED, 'PAYMENT'] },
  send_web: { off: AUTHORED, on: [...AUTHORED, 'PAYMENT'] },
  send_mobile: { off: AUTHORED, on: [...AUTHORED, 'PAYMENT'] },
  // Not widened in P3: the S2S contract carries no settings.
  sign_api_s2s: { off: [...SIX, 'ACKNOWLEDGEMENT'], on: [...SIX, 'ACKNOWLEDGEMENT'] },
  engine_passthrough: { off: AUTHORED, on: AUTHORED },
  template_fixed_form: { off: AUTHORED, on: AUTHORED },
  template_editable: { off: AUTHORED, on: AUTHORED },
  template_documents_store: { off: [...AUTHORED, 'CURRENCY', 'IMAGE', 'SIGNER_EMAIL'], on: [...AUTHORED, 'CURRENCY', 'IMAGE', 'SIGNER_EMAIL'] },
  // R-9 — IMAGE retired from authoring.
  template_documents_authoring: { off: [...AUTHORED, 'CURRENCY', 'SIGNER_EMAIL'], on: [...AUTHORED, 'CURRENCY', 'SIGNER_EMAIL'] },
  signature_block: { off: ['SIGNATURE', 'SIGNER_NAME', 'SIGN_DATE'], on: ['SIGNATURE', 'SIGNER_NAME', 'SIGN_DATE'] },
  // FIELD-PARITY-1 P2-4 — deliberately widened: the detector proposes labels, lines, boxes and glyphs.
  suggestion: {
    off: ['SIGNATURE', 'SIGN_DATE', 'INITIALS', 'TEXT', 'SIGNER_NAME', 'CHECKBOX', 'EMAIL', 'COMPANY', 'TITLE'],
    on: ['SIGNATURE', 'SIGN_DATE', 'INITIALS', 'TEXT', 'SIGNER_NAME', 'CHECKBOX', 'EMAIL', 'COMPANY', 'TITLE'],
  },
};

describe('field catalog (P1-1)', () => {
  it('has one record per type: the Sign 18 plus the documents-only 3, each keyed by itself', () => {
    expect(FIELD_TYPE_KEYS).toHaveLength(21);
    for (const k of FIELD_TYPE_KEYS) expect(FIELD_CATALOG[k].key).toBe(k);
  });

  it.each(FIELD_SURFACES.map((s) => [s] as const))('%s: the projection equals what the surface accepts today', (s) => {
    expect(sorted(fieldTypesFor(s))).toEqual(sorted(TODAY[s].off));
    expect(sorted(fieldTypesFor(s, { payments_available: false }))).toEqual(sorted(TODAY[s].off));
    expect(sorted(fieldTypesFor(s, { payments_available: true }))).toEqual(sorted(TODAY[s].on));
  });

  it('keeps the Sign authoring order (SENDER_FIELD_TYPES, then ACKNOWLEDGEMENT, PAYMENT, then the P3 types)', () => {
    expect(fieldTypesFor('send_web')).toEqual(AUTHORED);
    expect(fieldTypesFor('send_web', { payments_available: true })).toEqual([...SENDER, 'ACKNOWLEDGEMENT', 'PAYMENT', ...NEW]);
    expect(fieldTypesFor('sign_store')).toEqual([...SENDER, 'ACKNOWLEDGEMENT', 'PAYMENT', ...NEW]);
  });

  it('sign-web and the app author the same set', () => {
    expect(fieldTypesFor('send_mobile')).toEqual(fieldTypesFor('send_web'));
    expect(fieldTypesFor('send_mobile', { payments_available: true })).toEqual(fieldTypesFor('send_web', { payments_available: true }));
  });

  it('isFieldTypeOn matches the projection', () => {
    expect(isFieldTypeOn('sign_api_s2s', 'ACKNOWLEDGEMENT')).toBe(true);
    expect(isFieldTypeOn('sign_api_s2s', 'FIRST_NAME')).toBe(false);
    expect(isFieldTypeOn('sign_api_s2s', 'DROPDOWN')).toBe(false);
    expect(isFieldTypeOn('template_documents_authoring', 'IMAGE')).toBe(false);
    expect(isFieldTypeOn('template_documents_store', 'IMAGE')).toBe(true);
    expect(isFieldTypeOn('send_web', 'PAYMENT')).toBe(false);
    expect(isFieldTypeOn('send_web', 'PAYMENT', { payments_available: true })).toBe(true);
    expect(isFieldTypeOn('suggestion', 'toString')).toBe(false);
    expect(isFieldTypeOn('suggestion', 7)).toBe(false);
    expect(isFieldTypeKey('IMAGE')).toBe(true);
    expect(isFieldTypeKey('constructor')).toBe(false);
  });

  it('the profile text types and the settings each type accepts (P3 §6.2)', () => {
    expect([...PROFILE_TEXT_FIELD_TYPES]).toEqual(PROFILE);
    expect(fieldSettingsOf('CHECKBOX')).toEqual(['label', 'group_key', 'group_rule', 'min_selected', 'tooltip', 'data_name', 'read_only', 'sender_filled']);
    expect(fieldSettingsOf('SIGNER_NAME')).toEqual(['name_mode', 'label', 'tooltip', 'data_name', 'placeholder', 'font_size']);
    expect(fieldSettingsOf('PAYMENT')).toEqual(['payment_amount_minor', 'payment_currency']);
    // S-1 / S-9 — label, tooltip and data_name on every type but PAYMENT and the documents-only types.
    for (const k of FIELD_TYPE_KEYS) {
      const named = !['PAYMENT', 'CURRENCY', 'IMAGE', 'SIGNER_EMAIL'].includes(k);
      for (const s of ['label', 'tooltip', 'data_name'] as const) expect(fieldSettingsOf(k).includes(s)).toBe(named);
    }
    // S-4 / S-5 — only types whose value a sender can supply.
    const senderFillable = FIELD_TYPE_KEYS.filter((k) => fieldSettingsOf(k).includes('sender_filled'));
    expect(senderFillable).toEqual(['TEXT', 'CHECKBOX', 'DATE', 'DROPDOWN', 'RADIO', 'NUMBER', 'MULTILINE_TEXT']);
    expect(FIELD_TYPE_KEYS.filter((k) => fieldSettingsOf(k).includes('read_only'))).toEqual(senderFillable);
    expect(FIELD_TYPE_KEYS.filter((k) => fieldSettingsOf(k).includes('validation'))).toEqual(['TEXT', 'DATE', 'NUMBER', 'MULTILINE_TEXT']);
    expect(FIELD_TYPE_KEYS.filter((k) => fieldSettingsOf(k).includes('options'))).toEqual(['TEXT', 'DATE', 'DROPDOWN', 'NUMBER', 'MULTILINE_TEXT']);
  });

  it('P3 — RADIO is a boolean drawn as a circle; R-9 maps CURRENCY and SIGNER_EMAIL and retires IMAGE', () => {
    expect(FIELD_CATALOG.RADIO.value_kind).toBe('boolean');
    expect(isCircleMark('RADIO')).toBe(true);
    expect(isCircleMark('CHECKBOX')).toBe(false);
    expect(TEMPLATE_TYPE_MAPPING['CURRENCY']).toEqual({ field_type: 'NUMBER', options: { format: 'money', currency: 'USD', decimals: 2 } });
    expect(TEMPLATE_TYPE_MAPPING['SIGNER_EMAIL']).toEqual({ field_type: 'EMAIL' });
    expect([...RETIRED_FIELD_TYPES]).toEqual(['IMAGE']);
  });

  it('who fills a value today: the server stamps SIGN_DATE, fills a SIGNER_PROFILE name and a paid PAYMENT', () => {
    expect(FIELD_CATALOG.SIGN_DATE.filled_by).toBe('server');
    expect(FIELD_CATALOG.PAYMENT.filled_by).toBe('server');
    expect(FIELD_CATALOG.SIGNER_NAME.filled_by_name_mode).toEqual({ SIGNER_PROFILE: 'server', SIGNER_ENTERED: 'signer' });
    for (const k of ['SIGNATURE', 'INITIALS', 'TEXT', 'CHECKBOX', 'ACKNOWLEDGEMENT', ...PROFILE, 'DATE', 'DROPDOWN', 'RADIO', 'NUMBER', 'MULTILINE_TEXT'] as const) expect(FIELD_CATALOG[k].filled_by).toBe('signer');
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
    ['DATE', 150, 22, false],
    ['DROPDOWN', 180, 22, false],
    ['RADIO', 18, 18, false],
    ['NUMBER', 120, 22, false],
    ['MULTILINE_TEXT', 230, 66, false],
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
    expect(TEMPLATE_SURFACES).toEqual(['template_fixed_form', 'template_editable', 'template_documents_store', 'template_documents_authoring', 'signature_block']);
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

describe('FIELD-PARITY-2 A-7 — the editors\' settings projection (one copy for web and app)', () => {
  it('a field shows its catalog settings the host authors, in the catalog\'s order', () => {
    expect(editableFieldSettings('CHECKBOX', ['min_selected', 'label', 'group_rule', 'group_key'])).toEqual(['label', 'group_key', 'group_rule', 'min_selected']);
    expect(editableFieldSettings('CHECKBOX', [])).toEqual([]);
    expect(editableFieldSettings('NOT_A_TYPE', ['label'])).toEqual([]);
  });

  it('an envelope sender edits every setting but a payment\'s; sender-filled and read-only only when on', () => {
    for (const type of FIELD_TYPE_KEYS) {
      const all = fieldSettingsOf(type).filter((x) => x !== 'payment_amount_minor' && x !== 'payment_currency');
      expect(editableFieldSettings(type, senderEditorSettings(true))).toEqual(all);
      expect(editableFieldSettings(type, senderEditorSettings(false))).toEqual(all.filter((x) => x !== 'sender_filled' && x !== 'read_only'));
    }
  });
});
