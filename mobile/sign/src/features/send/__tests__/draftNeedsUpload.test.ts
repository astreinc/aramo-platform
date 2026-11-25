// Android field test 2026-11-25 — entering the Fields step saves the draft when its documents
// are not on the server yet, so Find and "Find fields" can read them.
import { draftNeedsUpload } from '../draftModel';

describe('draftNeedsUpload', () => {
  it('a new envelope, or a document still waiting to upload, needs the draft saved', () => {
    expect(draftNeedsUpload(null, [{ serverId: null, pendingUpload: { uri: 'file://a.pdf' } }])).toBe(true);
    expect(draftNeedsUpload('env-1', [{ serverId: 'doc-1', pendingUpload: null }, { serverId: null, pendingUpload: {} }])).toBe(true);
  });
  it('every document on the server, or no document at all: nothing to upload', () => {
    expect(draftNeedsUpload('env-1', [{ serverId: 'doc-1', pendingUpload: null }])).toBe(false);
    expect(draftNeedsUpload(null, [])).toBe(false);
  });
});
