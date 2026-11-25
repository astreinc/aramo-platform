// Save as you go (web / app consistency, PO 2026-11-25): the app sends each changed answer to the
// server as the signer goes (like the web signing page's Apply), so leaving and reopening the
// link shows what was saved; offline, answers stay on the device and go with the next save or
// at Finish. Android field test 5: save an answer, reopen, erase it, reopen.
import { createGuestSigningClient } from '../../../api/guestSigningClient';
import { recordingFetch, SIGNING_TOKEN } from '../../../testing/fakes';
import { saveAnswers } from '../signingApi';
import { fillsToSubmit, initialState, markSaved, setText, type SigningField } from '../signingMachine';

const BASE = 'https://sign.aramo.ai';

function field(id: string, type: string, over: Partial<SigningField> = {}): SigningField {
  return { field_id: id, document_id: 'd1', field_type: type, page_number: 0, x: 50, y: 600, width: 120, height: 24, required: false, ...over };
}

const note = field('f1', 'TEXT', { label: 'Note' });

function session(net: ReturnType<typeof recordingFetch>) {
  return createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(SIGNING_TOKEN);
}

describe('save as you go', () => {
  it('a typed answer is sent at once (no completion), and once saved is not sent again', async () => {
    const net = recordingFetch(() => ({ status: 200, body: { filled: true } }));
    const s0 = setText(initialState([note]), 'f1', 'Test answer');
    let s = s0;
    const sent = await saveAnswers(session(net), s, (f) => (s = markSaved(s, f)));
    expect(sent).toBe(1);
    expect(net.calls.map((c) => c.url.replace(BASE, ''))).toEqual(['/v1/sign/signing/fields/f1/fill']);
    expect(net.calls[0]!.body).toMatchObject({ value: 'Test answer' });
    expect(fillsToSubmit(s)).toEqual([]);
    net.calls.length = 0;
    expect(await saveAnswers(session(net), s, (f) => (s = markSaved(s, f)))).toBe(0);
    expect(net.calls).toEqual([]);
  });

  it('reopening shows the saved answer; erasing it sends a clear (value null)', async () => {
    // The server returns the saved answer when the link is reopened.
    let s = initialState([{ ...note, filled: true, value: 'Test answer' } as SigningField]);
    expect(s.values['f1']?.value).toBe('Test answer');
    expect(fillsToSubmit(s)).toEqual([]);
    s = setText(s, 'f1', '');
    const net = recordingFetch(() => ({ status: 200, body: { filled: true } }));
    await saveAnswers(session(net), s, (f) => (s = markSaved(s, f)));
    expect(net.calls.map((c) => c.body)).toEqual([expect.objectContaining({ value: null })]);
    // Recorded as cleared: nothing more to send.
    expect(fillsToSubmit(s)).toEqual([]);
  });

  it('an answer changed while it was being sent stays pending (never overwritten)', () => {
    let s = setText(initialState([note]), 'f1', 'First');
    const [sent] = fillsToSubmit(s);
    s = setText(s, 'f1', 'Second');
    s = markSaved(s, sent!);
    expect(fillsToSubmit(s)).toEqual([{ fieldId: 'f1', value: 'Second' }]);
  });

  it('offline: the send fails, the answer stays on the device and is still pending', async () => {
    const net = recordingFetch(() => {
      throw new TypeError('Network request failed');
    });
    let s = setText(initialState([note]), 'f1', 'Test answer');
    await expect(saveAnswers(session(net), s, (f) => (s = markSaved(s, f)))).rejects.toBeTruthy();
    expect(s.values['f1']?.value).toBe('Test answer');
    expect(fillsToSubmit(s)).toEqual([{ fieldId: 'f1', value: 'Test answer' }]);
  });
});
