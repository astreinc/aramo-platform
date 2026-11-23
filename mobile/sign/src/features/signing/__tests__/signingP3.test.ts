// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §6 — the
// signing state machine with the Phase 3 types (DATE, DROPDOWN, RADIO, NUMBER, MULTILINE_TEXT,
// ACKNOWLEDGEMENT) and settings (label, tooltip, placeholder, read_only + sender_filled,
// validation presets), and the server refusals the app words.
import { errorFromBody } from '../../../api/errors';
import { classifySigningError, fieldRefusalOf, incompleteCopy, SIGNING_COPY } from '../signingApi';
import {
  attemptFinish,
  blockedMessage,
  canFinish,
  checkEditorValue,
  defaultBox,
  displayOf,
  emptyCaption,
  fieldAnnouncement,
  fieldCaption,
  fillsToSubmit,
  initialState,
  isChecked,
  isEditorField,
  requiredRemaining,
  setText,
  tapField,
  type SigningField,
} from '../signingMachine';
import { sheetTitle } from '../SigningFlow';

jest.mock('react-native-pdf', () => 'Pdf');
jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn() }));

function field(id: string, type: string, over: Partial<SigningField> = {}): SigningField {
  return { field_id: id, document_id: 'd1', field_type: type, page_number: 0, x: 50, y: 700 - Number(id.replace(/\D/g, '') || 0) * 40, width: 120, height: 24, required: true, ...over };
}
const ctx = { signerName: 'Jo Signer', today: new Date(2026, 9, 24) };

describe('T-3..T-7 — the editor types', () => {
  it('DATE / DROPDOWN / NUMBER / MULTILINE_TEXT open the editor with the current value; a tap never clears them', () => {
    for (const t of ['DATE', 'DROPDOWN', 'NUMBER', 'MULTILINE_TEXT']) {
      const f = field('f1', t);
      expect(isEditorField(f)).toBe(true);
      let s = initialState([f]);
      let r = tapField(s, 'f1', ctx);
      expect(r.effect).toEqual({ kind: 'text', fieldId: 'f1', initial: '' });
      s = setText(r.state, 'f1', 'v');
      r = tapField(s, 'f1', ctx);
      expect(r.effect).toEqual({ kind: 'text', fieldId: 'f1', initial: 'v' });
      expect(r.state.values['f1']?.value).toBe('v');
    }
  });

  it('checkEditorValue: the server’s rule before a value is kept', () => {
    const money = field('f1', 'NUMBER', { validation: 'number_range', options: { format: 'money', decimals: 2, min: 1, max: 100 } });
    expect(checkEditorValue(money, '$1,0.5')).toEqual({ value: '10.5', problem: null });
    expect(checkEditorValue(money, '200')).toEqual({ value: '200', problem: 'validation_number_range_failed' });
    expect(checkEditorValue(money, '1.234').problem).toBe('number_decimals_exceeded');
    const date = field('f2', 'DATE', { validation: 'date_range', options: { min_date: '2026-01-01' } });
    expect(checkEditorValue(date, '2025-12-31').problem).toBe('validation_date_range_failed');
    expect(checkEditorValue(date, '').problem).toBeNull();
    const dd = field('f3', 'DROPDOWN', { options: { choices: [{ value: 'a', label: 'A' }] } });
    expect(checkEditorValue(dd, 'z').problem).toBe('dropdown_value_invalid');
    expect(checkEditorValue(field('f4', 'TEXT', { validation: 'us_zip' }), '9021').problem).toBe('validation_us_zip_failed');
    expect(checkEditorValue(field('f5', 'MULTILINE_TEXT'), ' a\nb ').value).toBe('a\nb');
  });

  it('values show as the executed PDF prints them', () => {
    expect(displayOf(field('f1', 'DATE'), { value: '2026-03-04' }, 'DD/MM/YYYY')).toEqual({ kind: 'text', text: '04/03/2026' });
    expect(displayOf(field('f1', 'DATE'), { value: '2026-03-04' })).toEqual({ kind: 'text', text: '03/04/2026' });
    expect(displayOf(field('f1', 'NUMBER', { options: { format: 'money', currency: 'EUR', decimals: 2 } }), { value: '1250.5' })).toEqual({ kind: 'text', text: '€1,250.50' });
    expect(displayOf(field('f1', 'DROPDOWN', { options: { choices: [{ value: 'nyc', label: 'New York' }] } }), { value: 'nyc' })).toEqual({ kind: 'text', text: 'New York' });
    expect(displayOf(field('f1', 'MULTILINE_TEXT'), { value: 'a\nb' })).toEqual({ kind: 'text', text: 'a\nb' });
    expect(displayOf(field('f1', 'RADIO'), { value: 'true' })).toEqual({ kind: 'mark', text: '●' });
    expect(displayOf(field('f1', 'RADIO'), { value: 'false' })).toBeNull();
  });

  it('the sheet title and the catalog default box', () => {
    expect(sheetTitle(field('f1', 'DATE'))).toBe('Choose a date');
    expect(sheetTitle(field('f1', 'DROPDOWN'))).toBe('Choose an option');
    expect(sheetTitle(field('f1', 'MULTILINE_TEXT'))).toBe('Enter text');
    expect(sheetTitle(field('f1', 'NUMBER'))).toBe('Enter number');
    expect(sheetTitle(field('f1', 'SIGNER_NAME'))).toBe('Enter your name');
    expect(defaultBox('MULTILINE_TEXT')).toEqual([230, 66]);
    expect(defaultBox('RADIO')).toEqual([18, 18]);
    expect(defaultBox('UNKNOWN')).toEqual([160, 24]);
  });
});

describe('T-5 RADIO', () => {
  const opt = (id: string, over: Partial<SigningField> = {}) => field(id, 'RADIO', { group_key: 'g', group_rule: 'SELECT_ONE', ...over });

  it('choosing one clears the others; a chosen option stays chosen; a required group needs one', () => {
    let s = initialState([opt('r1', { label: 'Full time' }), opt('r2', { label: 'Part time' })]);
    expect(canFinish(s)).toBe(false);
    expect(requiredRemaining(s)).toBe(1);
    expect(blockedMessage(s)).toBe('Choose one option in each required set of choices.');
    s = tapField(s, 'r1', ctx).state;
    expect(isChecked(s, 'r1')).toBe(true);
    expect(canFinish(s)).toBe(true);
    s = tapField(s, 'r2', ctx).state;
    expect(isChecked(s, 'r2')).toBe(true);
    expect(isChecked(s, 'r1')).toBe(false);
    // Tapping the chosen option again keeps it chosen.
    s = tapField(s, 'r2', ctx).state;
    expect(isChecked(s, 'r2')).toBe(true);
    expect(fillsToSubmit(s)).toEqual([{ fieldId: 'r2', value: 'true' }]);
  });

  it('FIELD-PARITY-2 A-2: tapping the chosen option of an optional set clears it', () => {
    let s = initialState([opt('r1', { required: false }), opt('r2', { required: false })]);
    s = tapField(s, 'r1', ctx).state;
    expect(isChecked(s, 'r1')).toBe(true);
    s = tapField(s, 'r1', ctx).state;
    expect(isChecked(s, 'r1')).toBe(false);
    expect(fillsToSubmit(s)).toEqual([]);
    expect(canFinish(s)).toBe(true);
    // A choice the server holds is cleared with an explicit 'false'.
    let stored = initialState([opt('r1', { required: false, filled: true, value: 'true' }), opt('r2', { required: false })]);
    stored = tapField(stored, 'r1', ctx).state;
    expect(fillsToSubmit(stored)).toEqual([{ fieldId: 'r1', value: 'false' }]);
  });

  it('a stored choice is cleared with an explicit false when another is chosen', () => {
    let s = initialState([opt('r1', { filled: true, value: 'true' }), opt('r2')]);
    s = tapField(s, 'r2', ctx).state;
    expect(fillsToSubmit(s)).toEqual([
      { fieldId: 'r1', value: 'false' },
      { fieldId: 'r2', value: 'true' },
    ]);
  });

  it('an optional group may stay empty; the announcement names the option', () => {
    const s = initialState([opt('r1', { required: false, label: 'Yes' })]);
    expect(canFinish(s)).toBe(true);
    expect(fieldAnnouncement(s, s.fields[0] as SigningField, 'Jo')).toBe('Radio button "Yes", for Jo, optional, not chosen');
  });
});

describe('T-2 ACKNOWLEDGEMENT (now authorable)', () => {
  it('a required acknowledgement is checked by the signer', () => {
    let s = initialState([field('a1', 'ACKNOWLEDGEMENT', { label: 'I have read the handbook' })]);
    expect(canFinish(s)).toBe(false);
    s = tapField(s, 'a1', ctx).state;
    expect(canFinish(s)).toBe(true);
    expect(fillsToSubmit(s)).toEqual([{ fieldId: 'a1', value: 'true' }]);
    expect(fieldCaption(s.fields[0] as SigningField)).toBe('I have read the handbook');
  });
});

describe('S-1 / S-2 label, placeholder', () => {
  it('the label names any field; the placeholder is the empty caption', () => {
    const f = field('f1', 'TEXT', { label: 'Employee ID', placeholder: 'e.g. A-123' });
    const s = initialState([f]);
    expect(fieldCaption(f)).toBe('Employee ID');
    expect(emptyCaption(f)).toBe('e.g. A-123');
    expect(emptyCaption({ ...f, placeholder: null, required: false })).toBe('Employee ID · optional');
    expect(fieldAnnouncement(s, f, 'Jo')).toBe('Text "Employee ID", for Jo, required, empty');
  });
});

describe('S-4 / S-5 read-only sender values', () => {
  const sender = (id: string, type: string, value: string, over: Partial<SigningField> = {}) =>
    field(id, type, { read_only: true, sender_filled: true, value, filled: true, ...over });

  it('shown, never tapped, never submitted, never required', () => {
    const s = initialState([sender('s1', 'TEXT', 'ACME-42', { label: 'Reference' }), sender('s2', 'DATE', '2026-05-01'), sender('s3', 'CHECKBOX', 'true'), field('f4', 'SIGNATURE', { required: false })], [], 'DD/MM/YYYY');
    expect(s.values['s1']?.value).toBe('ACME-42');
    expect(canFinish(s)).toBe(true);
    expect(attemptFinish(s)).toEqual({ blocked: false });
    for (const id of ['s1', 's2', 's3']) {
      const r = tapField(s, id, ctx);
      expect(r.effect).toEqual({ kind: 'none' });
      expect(r.state.values).toEqual(s.values);
    }
    expect(fillsToSubmit(s)).toEqual([]);
    expect(fieldAnnouncement(s, s.fields[0] as SigningField, 'Jo')).toBe('Text "Reference", ACME-42, filled in by the sender');
    expect(fieldAnnouncement(s, s.fields[1] as SigningField, 'Jo')).toBe('Date, 01/05/2026, filled in by the sender');
  });

  it('a sender value is shown even when the server did not mark it filled', () => {
    const s = initialState([sender('s1', 'TEXT', 'X', { filled: false })]);
    expect(s.values['s1']).toEqual({ value: 'X', fromServer: true });
  });
});

describe('server refusals', () => {
  it('a value refusal names its field and reason', () => {
    const e = errorFromBody(400, { error: { code: 'VALIDATION_ERROR', message: 'internal', details: { reason: 'validation_number_range_failed', field_id: 'f1' } } });
    expect(classifySigningError(e)).toBe('value_refused');
    expect(fieldRefusalOf(e)).toEqual({ fieldId: 'f1', reason: 'validation_number_range_failed' });
    expect(fieldRefusalOf(errorFromBody(400, { error: { code: 'VALIDATION_ERROR', details: { reason: 'other' } } }))).toBeNull();
  });

  it('a refused Finish names a radio group; anything else keeps the general words', () => {
    expect(incompleteCopy(errorFromBody(409, { error: { code: 'SIGNATURE_FIELD_INCOMPLETE', details: { reason: 'radio_group_select_one' } } }))).toBe(
      'Choose exactly one option in each set of choices.',
    );
    expect(incompleteCopy(errorFromBody(409, { error: { code: 'SIGNATURE_FIELD_INCOMPLETE' } }))).toBe(SIGNING_COPY.incomplete);
  });
});
