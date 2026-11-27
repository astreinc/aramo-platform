// Runs under vitest and mobile Jest (globals only).
import { listSignRoute } from '../index.js';

// LIST-SELF-SIGN-1 — a self-sign envelope resumes by a self-sign session, never the inbox.
describe('listSignRoute', () => {
  it('self-sign comes first, even when the server also names an inbox item', () => {
    expect(listSignRoute({ status: 'SENT', can_self_sign_now: true, my_inbox_item_id: 'handle-1' })).toBe('self');
    expect(listSignRoute({ status: 'IN_PROGRESS', can_self_sign_now: true, my_inbox_item_id: null })).toBe('self');
  });

  it('an emailed envelope waiting for the user signs through the inbox', () => {
    expect(listSignRoute({ status: 'SENT', can_self_sign_now: false, my_inbox_item_id: 'b-1' })).toBe('inbox');
  });

  it('nothing for a finished envelope or a row with neither', () => {
    expect(listSignRoute({ status: 'COMPLETED', can_self_sign_now: true, my_inbox_item_id: 'b-1' })).toBeNull();
    expect(listSignRoute({ status: 'SENT' })).toBeNull();
    expect(listSignRoute({ status: 'SENT', my_inbox_item_id: '' })).toBeNull();
  });
});
