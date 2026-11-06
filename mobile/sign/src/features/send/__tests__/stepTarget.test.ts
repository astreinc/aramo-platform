// M-A13 #12 (R-6) — a step label goes forward only as far as Next would.
import { emptyPayload, type DraftDocument, type DraftRecipient, type SendDraftPayload } from '../draftModel';
import { stepBlocker, stepTarget } from '../sendFlowController';

const doc = { key: 'd1', title: 'Lease' } as unknown as DraftDocument;
const signer = { key: 'r1', name: 'Jo', email: 'jo@example.com' } as unknown as DraftRecipient;
const payload = (over: Partial<SendDraftPayload> = {}): SendDraftPayload => ({
  ...emptyPayload(),
  ...over,
});

describe('stepTarget', () => {
  it('back is always allowed', () => {
    expect(stepTarget('review', 'documents', payload())).toEqual({ step: 'documents', message: null });
  });

  it('forward stops at the first step Next would refuse, with its message', () => {
    expect(stepTarget('documents', 'review', payload())).toEqual({
      step: 'documents',
      message: 'Add a document first.',
    });
    expect(stepTarget('documents', 'fields', payload({ documents: [doc] }))).toEqual({
      step: 'recipients',
      message: 'Add at least one recipient first.',
    });
  });

  it('forward goes all the way when every earlier step passes', () => {
    const p = payload({ documents: [doc], recipients: [signer] });
    expect(stepTarget('documents', 'review', p)).toEqual({ step: 'review', message: null });
    expect(stepTarget('recipients', 'fields', p)).toEqual({ step: 'fields', message: null });
  });

  it('nothing moves forward while a save is running', () => {
    const p = payload({ documents: [doc], recipients: [signer] });
    expect(stepTarget('documents', 'review', p, true)).toEqual({ step: 'documents', message: null });
  });

  it('Next and the labels share one check', () => {
    expect(stepBlocker('documents', payload())).toBe('Add a document first.');
    expect(stepBlocker('fields', payload())).toBeNull();
  });
});
