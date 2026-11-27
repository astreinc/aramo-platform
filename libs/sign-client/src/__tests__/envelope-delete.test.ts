// Runs under vitest and mobile Jest (globals only).
import { ENVELOPE_DELETE_COPY, envelopeDeleteRoute, envelopeRestoreRoute } from '../index.js';

// APP-DELETED-1 — one copy for web and the app.
describe('envelope delete / restore', () => {
  it('keeps the web wording', () => {
    expect(ENVELOPE_DELETE_COPY.delete_title).toBe('Delete this envelope?');
    expect(ENVELOPE_DELETE_COPY.deleted).toBe('Moved to Deleted');
    expect(ENVELOPE_DELETE_COPY.restored).toBe('Envelope restored');
    expect(ENVELOPE_DELETE_COPY.delete_when_finished).toBe('Finish or void this envelope before deleting it.');
  });

  it('names the sender routes, encoding the id', () => {
    expect(envelopeDeleteRoute('e-1')).toBe('/v1/sign/sender/envelopes/e-1/delete');
    expect(envelopeRestoreRoute('a/b')).toBe('/v1/sign/sender/envelopes/a%2Fb/restore');
  });
});
