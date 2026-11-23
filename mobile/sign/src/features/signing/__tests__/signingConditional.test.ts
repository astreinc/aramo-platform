// FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) §4.2 B-6 —
// the signing state machine with conditional fields ("show only when"): fields shown and hidden
// as the signer answers (the one visibility rule, @aramo/sign-client), progress and Next over
// the shown fields only, a hidden answer cleared as the server clears it (C-3), Finish sending
// triggers first and never a hidden field, and the field_hidden refusal worded.
import { fieldValueRefusalText } from '@aramo/sign-client';

import { errorFromBody } from '../../../api/errors';
import { createGuestSigningClient } from '../../../api/guestSigningClient';
import { recordingFetch, SIGNING_TOKEN } from '../../../testing/fakes';
import { classifySigningError, fieldRefusalOf, submitSigning } from '../signingApi';
import {
  advance,
  canFinish,
  fillsToSubmit,
  initialState,
  isShown,
  markCleared,
  markStored,
  nextEmptyRequired,
  requiredDone,
  requiredFields,
  setText,
  shownSigningFields,
  tapField,
  type SigningField,
} from '../signingMachine';

function field(id: string, type: string, over: Partial<SigningField> = {}): SigningField {
  return {
    field_id: id,
    document_id: 'd1',
    field_type: type,
    page_number: 0,
    x: 50,
    y: 700 - Number(id.replace(/\D/g, '') || 0) * 40,
    width: 120,
    height: 24,
    required: true,
    field_key: id,
    condition: null,
    ...over,
  };
}
const ctx = { signerName: 'Jo Signer', today: new Date(2026, 10, 23) };
const ids = (xs: readonly SigningField[]) => xs.map((x) => x.field_id);

// f1 "add a co-applicant" (optional box) shows f2 (required text), which shows f3 (required
// box) one level down; f4, a dropdown, shows f5 only for "b"; f6 is the signature.
const f1 = field('f1', 'CHECKBOX', { required: false, label: 'Add a co-applicant' });
const f2 = field('f2', 'TEXT', { condition: { trigger_key: 'f1', when: 'checked' } });
const f3 = field('f3', 'CHECKBOX', { condition: { trigger_key: 'f2', when: 'unchecked' } });
const f4 = field('f4', 'DROPDOWN', {
  required: false,
  options: { choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
});
const f5 = field('f5', 'TEXT', { condition: { trigger_key: 'f4', when: 'one_of', values: ['b'] } });
const f6 = field('f6', 'SIGN_DATE');

describe('B-6 — shown fields', () => {
  it('a dependent appears when its trigger is checked and disappears when it is unchecked, along a chain', () => {
    let s = initialState([f1, f2, f3, f6]);
    expect(ids(shownSigningFields(s))).toEqual(['f1', 'f6']);
    expect(isShown(s, 'f2')).toBe(false);
    s = tapField(s, 'f1', ctx).state;
    expect(ids(shownSigningFields(s))).toEqual(['f1', 'f2', 'f3', 'f6']);
    s = tapField(s, 'f1', ctx).state;
    expect(ids(shownSigningFields(s))).toEqual(['f1', 'f6']);
  });

  it('a dropdown trigger reads its value (one_of)', () => {
    let s = initialState([f4, f5]);
    s = setText(s, 'f4', 'a');
    expect(ids(shownSigningFields(s))).toEqual(['f4']);
    s = setText(s, 'f4', 'b');
    expect(ids(shownSigningFields(s))).toEqual(['f4', 'f5']);
  });

  it('a hidden field cannot be tapped', () => {
    const s = initialState([f1, f2, f6]);
    const r = tapField(s, 'f2', ctx);
    expect(r.state).toBe(s);
    expect(r.effect).toEqual({ kind: 'none' });
  });
});

describe('B-6 — progress and Next follow the shown fields', () => {
  it('"N of M required" counts only shown fields', () => {
    let s = initialState([f1, f2, f6]);
    expect(ids(requiredFields(s))).toEqual(['f6']);
    expect(requiredDone(s)).toBe(0);
    s = tapField(s, 'f1', ctx).state;
    expect(ids(requiredFields(s))).toEqual(['f2', 'f6']);
    s = setText(s, 'f2', 'Ada');
    expect(requiredDone(s)).toBe(1);
  });

  it('Next skips a hidden required field; Finish is not blocked by one', () => {
    let s = initialState([f1, f2, f6]);
    expect(nextEmptyRequired(s)?.field_id).toBe('f6');
    expect(advance(s).currentId).toBe('f6');
    s = tapField(s, 'f6', ctx).state;
    expect(canFinish(s)).toBe(true);
    s = tapField(s, 'f1', ctx).state;
    expect(canFinish(s)).toBe(false);
    expect(nextEmptyRequired(s)?.field_id).toBe('f2');
  });
});

describe('B-6 / C-3 — an answer that hides fields clears them', () => {
  it('unchecking the trigger clears the dependents along the chain; shown again, they start empty', () => {
    let s = initialState([f1, f2, f3, f6]);
    s = tapField(s, 'f1', ctx).state;
    s = tapField(s, 'f3', ctx).state;
    expect(s.values['f3']?.value).toBe('true');
    s = setText(s, 'f2', 'Ada');
    expect(s.values['f2']?.value).toBe('Ada');
    s = tapField(s, 'f1', ctx).state;
    expect(s.values['f2']).toBeUndefined();
    expect(s.values['f3']).toBeUndefined();
    s = tapField(s, 'f1', ctx).state;
    expect(s.values['f2']).toBeUndefined();
  });

  it('a value the server held is cleared locally too (the trigger change clears it on the server)', () => {
    const stored = [
      { ...f1, filled: true, value: 'true' },
      { ...f2, filled: true, value: 'Ada' },
      f6,
    ];
    let s = initialState(stored);
    expect(s.values['f2']?.fromServer).toBe(true);
    s = tapField(s, 'f1', ctx).state;
    expect(s.values['f1']).toEqual({ value: 'false' });
    expect(s.values['f2']).toBeUndefined();
    expect(fillsToSubmit(s)).toEqual([{ fieldId: 'f1', value: 'false' }]);
  });
});

describe('B-6 — Finish sends triggers first and never a hidden field', () => {
  it('a dependent placed above its trigger is sent after it', () => {
    // f2's box sits above f1's on the page (reading order puts it first).
    const dep = field('f2', 'TEXT', { y: 760, condition: { trigger_key: 'f1', when: 'checked' } });
    let s = initialState([f1, dep, f6]);
    expect(ids(s.fields)).toEqual(['f2', 'f1', 'f6']);
    s = tapField(s, 'f1', ctx).state;
    s = setText(s, 'f2', 'Ada');
    s = tapField(s, 'f6', ctx).state;
    expect(fillsToSubmit(s).map((x) => x.fieldId)).toEqual(['f1', 'f6', 'f2']);
  });
});

describe('B-6 — field_hidden', () => {
  it('a fill refused because the answers hide the field is worded', () => {
    const e = errorFromBody(400, {
      error: { code: 'VALIDATION_ERROR', message: 'This field is not shown for your answers', details: { reason: 'field_hidden', field_id: 'f2' } },
    });
    expect(classifySigningError(e)).toBe('value_refused');
    expect(fieldRefusalOf(e)).toEqual({ fieldId: 'f2', reason: 'field_hidden' });
    expect(fieldValueRefusalText('field_hidden')).toBe('This field isn’t needed for your answers, so it’s hidden now.');
  });
});

// FIELD-PARITY-2 B-6 follow-up — a value the server holds that the signer empties is sent as a
// clear (value null), trigger first, so the server hides (and clears) what the app hides.
describe('B-6 follow-up — emptying a stored value sends a clear', () => {
  const stored = [
    { ...f4, filled: true, value: 'b' },
    { ...f5, filled: true, value: 'Details' },
    { ...f6, filled: true, value: '11/22/2026' },
  ];

  it('emptying a stored dropdown trigger sends its clear; the hidden dependent is not sent (the server clears it)', () => {
    let s = initialState(stored);
    s = setText(s, 'f4', '');
    expect(isShown(s, 'f5')).toBe(false);
    expect(s.values['f5']).toBeUndefined();
    expect(fillsToSubmit(s)).toEqual([{ fieldId: 'f4', value: null }]);
  });

  it('clears are ordered like fills: a trigger before the fields it shows', () => {
    // The dependent sits above its trigger (reading order puts it first).
    const dep = field('f5', 'TEXT', { y: 760, required: false, filled: true, value: 'Details', condition: { trigger_key: 'f4', when: 'one_of', values: ['b'] } });
    let s = initialState([dep, { ...f4, filled: true, value: 'b' }, stored[2]!]);
    expect(ids(s.fields)).toEqual(['f5', 'f4', 'f6']);
    s = setText(s, 'f4', 'a');
    s = setText(s, 'f4', 'b');
    s = setText(s, 'f5', '');
    expect(fillsToSubmit(s)).toEqual([
      { fieldId: 'f4', value: 'b' },
      { fieldId: 'f5', value: null },
    ]);
  });

  it('a value never stored is not cleared; a cleared value is not sent again', () => {
    let s = initialState([f4, f5, f6]);
    s = setText(s, 'f4', 'a');
    s = setText(s, 'f4', '');
    expect(fillsToSubmit(s)).toEqual([]);
    s = initialState(stored);
    s = setText(s, 'f4', '');
    s = markCleared(s, 'f4');
    expect(fillsToSubmit(s)).toEqual([]);
    // A value stored during this Finish, then emptied before a retry, is cleared.
    s = markStored(setText(s, 'f4', 'a'), 'f4');
    s = setText(s, 'f4', '');
    expect(fillsToSubmit(s)).toEqual([{ fieldId: 'f4', value: null }]);
  });

  it('a field the shared rule does not clear is never sent as a clear (a date signed, a signature)', () => {
    const sig = field('f7', 'SIGNATURE', { filled: true, value: 'Jo Signer' });
    let s = initialState([stored[2]!, sig]);
    s = tapField(s, 'f6', ctx).state;
    s = tapField(s, 'f7', ctx).state;
    expect(s.values['f6']).toBeUndefined();
    expect(s.values['f7']).toBeUndefined();
    expect(fillsToSubmit(s)).toEqual([]);
  });

  it('Finish sends the clear as value null, then completes; a retry does not resend it', async () => {
    const net = recordingFetch(() => ({ status: 200, body: {} }));
    const session = createGuestSigningClient({ baseUrl: 'https://sign.aramo.ai', fetch: net.fetch }).open(SIGNING_TOKEN);
    let latest = setText(initialState(stored), 'f4', '');
    await submitSigning(session, latest, (next) => (latest = next));
    expect(net.calls.map((c) => c.url.replace('https://sign.aramo.ai', ''))).toEqual(['/v1/sign/signing/fields/f4/fill', '/v1/sign/signing/complete']);
    expect(net.calls[0]!.body).toMatchObject({ token: SIGNING_TOKEN, value: null });
    expect(fillsToSubmit(latest)).toEqual([]);
  });
});
