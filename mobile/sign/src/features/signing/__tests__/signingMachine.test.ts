// Signing state machine (handoff §4.4; directive §6, §9): all 7 field types, required
// fields, Finish blocking, Next field, local-only clear, values retained on failure.
import { createGuestSigningClient } from '../../../api/guestSigningClient';
import { recordingFetch, SIGNING_TOKEN } from '../../../testing/fakes';
import { classifySigningError, submitSigning, waitingForCopy } from '../signingApi';
import { errorFromBody, clientError } from '../../../api/errors';
import {
  adopt,
  advance,
  attemptFinish,
  canFinish,
  displayOf,
  fieldAnnouncement,
  fillsToSubmit,
  initialState,
  isFilled,
  nextEmptyRequired,
  primaryAction,
  requiredDone,
  requiredRemaining,
  setText,
  tapField,
  type SigningField,
} from '../signingMachine';

const BASE = 'https://sign.aramo.ai';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function field(id: string, type: string, over: Partial<SigningField> = {}): SigningField {
  return {
    field_id: id,
    document_id: 'd1',
    field_type: type,
    page_number: 0,
    x: 50,
    y: 700 - Number(id.replace(/\D/g, '')) * 40,
    width: 120,
    height: 24,
    required: true,
    ...over,
  };
}

const ALL = [
  field('f1', 'SIGNATURE'),
  field('f2', 'INITIALS'),
  field('f3', 'SIGN_DATE'),
  field('f4', 'SIGNER_NAME'),
  field('f5', 'TEXT'),
  field('f6', 'CHECKBOX'),
  field('f7', 'ACKNOWLEDGEMENT'),
  field('f8', 'TEXT', { required: false }),
];
const ctx = { signerName: 'Jo Signer', today: new Date(2026, 9, 24) };

describe('signing state machine', () => {
  it('orders fields top-to-bottom and counts only required ones', () => {
    const s = initialState([...ALL].reverse());
    expect(s.fields.map((f) => f.field_id)).toEqual([
      'f1',
      'f2',
      'f3',
      'f4',
      'f5',
      'f6',
      'f7',
      'f8',
    ]);
    expect(requiredRemaining(s)).toBe(7);
    expect(primaryAction(s)).toBe('start');
  });

  it('completes all 7 engine field types with the right values', () => {
    let s = initialState(ALL);
    // SIGNATURE without an adopted mark opens the adopt sheet.
    let r = tapField(s, 'f1', ctx);
    expect(r.effect).toEqual({ kind: 'adopt', fieldId: 'f1', target: 'SIGNATURE' });
    s = adopt(r.state, 'SIGNATURE', { dataUrl: PNG, method: 'DRAWN' }, 'f1');
    expect(s.values['f1']).toEqual({ value: PNG, method: 'DRAWN' });
    r = tapField(s, 'f2', ctx);
    expect(r.effect.kind).toBe('adopt');
    s = adopt(r.state, 'INITIALS', { dataUrl: PNG, method: 'TYPED' }, 'f2');
    s = tapField(s, 'f3', ctx).state;
    expect(s.values['f3']?.value).toBe('2026-10-24');
    // M-A6 §2.2 — a signer-typed name opens the text sheet, never prefilled from the
    // signed-in account's name.
    r = tapField(s, 'f4', ctx);
    expect(r.effect).toEqual({ kind: 'text', fieldId: 'f4', initial: '' });
    s = setText(r.state, 'f4', 'Jo Q. Signer');
    expect(s.values['f4']?.value).toBe('Jo Q. Signer');
    r = tapField(s, 'f5', ctx);
    expect(r.effect).toEqual({ kind: 'text', fieldId: 'f5', initial: '' });
    s = setText(r.state, 'f5', ' Acme Corp ');
    expect(s.values['f5']?.value).toBe('Acme Corp');
    s = tapField(s, 'f6', ctx).state;
    s = tapField(s, 'f7', ctx).state;
    expect(s.values['f6']?.value).toBe('true');
    expect(s.values['f7']?.value).toBe('true');
    expect(canFinish(s)).toBe(true);
    expect(primaryAction(s)).toBe('finish');
    // The optional text field is not required for Finish.
    expect(s.values['f8']).toBeUndefined();
  });

  it('an adopted signature is reused for the rest of the session', () => {
    const fields = [field('f1', 'SIGNATURE'), field('f2', 'SIGNATURE')];
    let s = initialState(fields);
    s = adopt(s, 'SIGNATURE', { dataUrl: PNG, method: 'TYPED' }, 'f1');
    const r = tapField(s, 'f2', ctx);
    expect(r.effect.kind).toBe('none');
    expect(r.state.values['f2']?.value).toBe(PNG);
  });

  it('after each fill the current field moves to the next empty required field', () => {
    let s = initialState(ALL);
    s = tapField(s, 'f3', ctx).state;
    expect(s.currentId).toBe('f4');
  });

  it('tapping a filled field clears it locally; saving empty text clears too', () => {
    let s = tapField(initialState(ALL), 'f3', ctx).state;
    expect(s.values['f3']).toBeDefined();
    s = tapField(s, 'f3', ctx).state;
    expect(s.values['f3']).toBeUndefined();
    // A never-stored check box unchecks back to empty (nothing to send).
    s = tapField(s, 'f6', ctx).state;
    expect(s.values['f6']?.value).toBe('true');
    s = tapField(s, 'f6', ctx).state;
    expect(s.values['f6']).toBeUndefined();
    s = setText(s, 'f5', 'x');
    s = setText(s, 'f5', '   ');
    expect(s.values['f5']).toBeUndefined();
  });

  it('Start → Next field visit the empty required fields in order', () => {
    let s = initialState(ALL);
    s = advance(s);
    expect(s.currentId).toBe('f1');
    expect(primaryAction(s)).toBe('next');
    s = tapField(s, 'f3', ctx).state; // fill out of order
    s = { ...s, currentId: 'f2' };
    s = advance(s);
    expect(s.currentId).toBe('f4');
  });

  it('Finish is blocked while required fields remain, and jumps to the next one', () => {
    const s = tapField(initialState(ALL), 'f6', ctx).state;
    const r = attemptFinish({ ...s, currentId: null });
    expect(r.blocked).toBe(true);
    if (r.blocked) expect(r.state.currentId).toBe('f1');
  });

  it('announces "{Type}, for {signer}, {required|optional}, {empty|filled}"', () => {
    const s = initialState(ALL);
    expect(fieldAnnouncement(s, s.fields[0]!, 'Jo Signer')).toBe(
      'Signature, for Jo Signer, required, empty',
    );
    const t = tapField(s, 'f8', ctx).state;
    expect(fieldAnnouncement(setText(t, 'f8', 'hi'), s.fields[7]!, 'Jo')).toBe(
      'Text, for Jo, optional, filled',
    );
  });

  it('restores the signer’s own server-held values and does not resubmit them unchanged', () => {
    const s = initialState([
      field('f1', 'TEXT', { filled: true, value: 'kept' }),
      field('f2', 'CHECKBOX'),
    ]);
    expect(requiredDone(s)).toBe(1);
    const t = tapField(s, 'f2', ctx).state;
    expect(fillsToSubmit(t)).toEqual([{ fieldId: 'f2', value: 'true' }]);
  });
});

describe('Name and Checkbox (M-A6 §2)', () => {
  const box = (id: string, over: Partial<SigningField> = {}) =>
    field(id, 'CHECKBOX', { required: false, width: 18, height: 18, ...over });

  it('a SIGNER_PROFILE name is the server’s: read-only, already done, never sent', () => {
    const s = initialState([
      field('f1', 'SIGNER_NAME', {
        name_mode: 'SIGNER_PROFILE',
        server_filled: true,
        filled: true,
        value: 'Jordan Profile',
      }),
      field('f2', 'TEXT'),
    ]);
    expect(requiredRemaining(s)).toBe(1);
    const r = tapField(s, 'f1', ctx);
    expect(r.effect).toEqual({ kind: 'none' });
    expect(r.state.values['f1']?.value).toBe('Jordan Profile');
    expect(displayOf(s.fields[0]!, s.values['f1'])).toEqual({
      kind: 'text',
      text: 'Jordan Profile',
    });
    expect(fieldAnnouncement(s, s.fields[0]!, 'Jo')).toBe('Name, for Jo, required, filled for you');
    const t = setText(tapField(s, 'f2', ctx).state, 'f2', 'x');
    expect(fillsToSubmit(t)).toEqual([{ fieldId: 'f2', value: 'x' }]);
    // Even a stale local value for a profile name is never submitted.
    const forced = { ...t, values: { ...t.values, f1: { value: 'Mallory' } } };
    expect(fillsToSubmit(forced).map((f) => f.fieldId)).toEqual(['f2']);
  });

  it('a legacy name (name_mode null) is typed by the signer', () => {
    const s = initialState([field('f1', 'SIGNER_NAME', { name_mode: null })]);
    expect(tapField(s, 'f1', ctx).effect).toEqual({ kind: 'text', fieldId: 'f1', initial: '' });
  });

  it('a server-held check box unchecks as an explicit false, which is sent', () => {
    let s = initialState([box('f1', { filled: true, value: 'true' })]);
    expect(isFilled(s, 'f1')).toBe(true);
    s = tapField(s, 'f1', ctx).state;
    expect(s.values['f1']).toEqual({ value: 'false' });
    expect(isFilled(s, 'f1')).toBe(false);
    expect(displayOf(s.fields[0]!, s.values['f1'])).toBeNull();
    expect(fillsToSubmit(s)).toEqual([{ fieldId: 'f1', value: 'false' }]);
    expect(fieldAnnouncement(s, s.fields[0]!, 'Jo')).toBe(
      'Checkbox, for Jo, optional, not checked',
    );
  });

  it('a required ungrouped box must be checked; a stored false does not count', () => {
    const s = initialState([box('f1', { required: true, filled: true, value: 'false' })]);
    expect(canFinish(s)).toBe(false);
    expect(canFinish(tapField(s, 'f1', ctx).state)).toBe(true);
  });

  it('SELECT_ONE: checking one unchecks the others; a required group needs exactly one', () => {
    const one = { group_key: 'g', group_rule: 'SELECT_ONE', required: true };
    let s = initialState([box('f1', one), box('f2', one), box('f3', one)]);
    expect(requiredRemaining(s)).toBe(1);
    expect(nextEmptyRequired(s)?.field_id).toBe('f1');
    s = tapField(s, 'f1', ctx).state;
    expect(canFinish(s)).toBe(true);
    s = tapField(s, 'f2', ctx).state;
    expect(s.values['f1']).toBeUndefined();
    expect(s.values['f2']?.value).toBe('true');
    expect(canFinish(s)).toBe(true);
    // Two checked (e.g. both restored from the server) blocks Finish.
    const restored = initialState([
      box('f1', { ...one, required: false, filled: true, value: 'true' }),
      box('f2', { ...one, required: false, filled: true, value: 'true' }),
    ]);
    expect(canFinish(restored)).toBe(false);
    const fixed = tapField(restored, 'f2', ctx).state;
    expect(fixed.values['f2']).toEqual({ value: 'false' });
    expect(canFinish(fixed)).toBe(true);
  });

  it('SELECT_ANY: a required group needs min_selected boxes (default 1); an optional one needs none', () => {
    const any = { group_key: 'g', group_rule: 'SELECT_ANY', required: true, min_selected: 2 };
    let s = initialState([box('f1', any), box('f2', any), box('f3', any)]);
    expect(requiredRemaining(s)).toBe(1);
    s = tapField(s, 'f1', ctx).state;
    expect(canFinish(s)).toBe(false);
    s = tapField(s, 'f3', ctx).state;
    expect(canFinish(s)).toBe(true);
    expect(requiredDone(s)).toBe(1);
    const dflt = initialState([
      box('f1', { ...any, min_selected: null }),
      box('f2', { ...any, min_selected: null }),
    ]);
    expect(canFinish(tapField(dflt, 'f2', ctx).state)).toBe(true);
    const optional = initialState([box('f1', { group_key: 'h', group_rule: 'SELECT_ANY' })]);
    expect(canFinish(optional)).toBe(true);
  });

  it('shows the label on an empty box', () => {
    const s = initialState([box('f1', { label: 'I agree' })]);
    expect(fieldAnnouncement(s, s.fields[0]!, 'Jo')).toBe(
      'Checkbox "I agree", for Jo, optional, not checked',
    );
  });
});

describe('Finish submit: fill then complete, on the guest transport', () => {
  function filledState() {
    let s = initialState([field('f1', 'SIGNATURE'), field('f2', 'CHECKBOX')]);
    s = adopt(s, 'SIGNATURE', { dataUrl: PNG, method: 'DRAWN' }, 'f1');
    return tapField(s, 'f2', ctx).state;
  }

  it('fills every final value, then completes', async () => {
    const net = recordingFetch((req) => ({
      status: 200,
      body: req.url.endsWith('/complete') ? { envelope_status: 'COMPLETED' } : { filled: true },
    }));
    const session = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(
      SIGNING_TOKEN,
    );
    const r = await submitSigning(session, filledState(), () => undefined);
    expect(r.envelopeStatus).toBe('COMPLETED');
    expect(net.calls.map((c) => c.url.replace(BASE, ''))).toEqual([
      '/v1/sign/signing/fields/f1/fill',
      '/v1/sign/signing/fields/f2/fill',
      '/v1/sign/signing/complete',
    ]);
    expect(net.calls[0]!.body).toEqual({
      value: PNG,
      signature_method: 'DRAWN',
      token: SIGNING_TOKEN,
    });
    for (const c of net.calls)
      expect(Object.keys(c.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('a dropped connection keeps every value; the retry resends only what is missing', async () => {
    let online = true;
    const net = recordingFetch((req) => {
      if (!online) throw new TypeError('Network request failed');
      if (req.url.endsWith('/f2/fill')) online = false;
      return { status: 200, body: {} };
    });
    // recordingFetch awaits the responder: a thrown error surfaces like a fetch failure.
    const session = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(
      SIGNING_TOKEN,
    );
    let latest = filledState();
    await expect(submitSigning(session, latest, (s) => (latest = s))).rejects.toMatchObject({
      reason: 'network_unavailable',
    });
    expect(classifySigningError(clientError('network_unavailable'))).toBe('network');
    // Values are all still on the device.
    expect(latest.values['f1']?.value).toBe(PNG);
    expect(latest.values['f2']?.value).toBe('true');
    expect(session.active).toBe(true);
    online = true;
    net.calls.length = 0;
    await submitSigning(session, latest, (s) => (latest = s));
    expect(net.calls.map((c) => c.url.replace(BASE, ''))).toEqual(['/v1/sign/signing/complete']);
  });

  it('a revoked / expired token ends the session: classified "ended", never retried', async () => {
    const net = recordingFetch(() => ({
      status: 401,
      body: { error: { code: 'SIGNING_SESSION_EXPIRED' } },
    }));
    const session = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(
      SIGNING_TOKEN,
    );
    const err = await submitSigning(session, filledState(), () => undefined).catch(
      (e: unknown) => e,
    );
    expect(classifySigningError(err)).toBe('ended');
    expect(session.active).toBe(false);
    const again = await submitSigning(session, filledState(), () => undefined).catch(
      (e: unknown) => e,
    );
    expect(classifySigningError(again)).toBe('ended');
    expect(net.calls).toHaveLength(1);
  });

  it('an out-of-turn refusal shows "Waiting for …"', () => {
    const e = errorFromBody(409, { error: { code: 'SIGNER_NOT_YET_ELIGIBLE' } });
    expect(classifySigningError(e)).toBe('not_your_turn');
    expect(waitingForCopy(e)).toBe('Waiting for an earlier signer');
    const named = errorFromBody(409, {
      error: { code: 'SIGNER_NOT_YET_ELIGIBLE', details: { waiting_for: 'Alex Morgan' } },
    });
    expect(waitingForCopy(named)).toBe('Waiting for Alex Morgan');
  });
});
