import { describe, expect, it, vi } from 'vitest';
import { AramoError, type VisibilityContextShape } from '@aramo/common';
import type { ContactRepository } from '@aramo/contact';

import { ContactActivitySubjectAdapter } from '../contact-activity/contact-activity-subject.adapter.js';

// CONTACTS-1 §8 — the apps/api adapter behind the activity lib's
// ACTIVITY_CONTACT_SUBJECT port: visibility (404), deleted (CONTACT_DELETED,
// H-4) and the recency touch (H-2), all through ContactRepository.

const vis: VisibilityContextShape = {
  tenant_id: 'T',
  actor_user_id: 'U',
  see_all_company: false,
  see_all_requisition: false,
  visible_client_ids: new Set(['C1']),
};

function contacts(over: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    findByIdForActor: vi.fn().mockResolvedValue({ id: 'K1', company_id: 'C1' }),
    assertLinkable: vi.fn().mockResolvedValue(undefined),
    touchLastActivity: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function adapter(c: ReturnType<typeof contacts>) {
  return new ContactActivitySubjectAdapter(c as unknown as ContactRepository);
}

describe('ContactActivitySubjectAdapter (CONTACTS-1 §8)', () => {
  it('a visible, live contact passes: visibility read then assertLinkable on subject_id', async () => {
    const c = contacts();
    await adapter(c).assertRecordable({
      tenant_id: 'T',
      contact_id: 'K1',
      visibility: vis,
      requestId: 'rid',
    });
    expect(c.findByIdForActor).toHaveBeenCalledWith({ tenant_id: 'T', id: 'K1', visibility: vis, include_deleted: true });
    expect(c.assertLinkable).toHaveBeenCalledWith({
      tenant_id: 'T',
      id: 'K1',
      requestId: 'rid',
      field: 'subject_id',
    });
  });

  it('an invisible contact answers 404 and never reaches the deleted check', async () => {
    const c = contacts({ findByIdForActor: vi.fn().mockResolvedValue(null) });
    const err = await adapter(c)
      .assertRecordable({ tenant_id: 'T', contact_id: 'K1', visibility: vis, requestId: 'rid' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AramoError);
    expect(err).toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(c.assertLinkable).not.toHaveBeenCalled();
  });

  it('a deleted contact is refused by assertLinkable (H-4)', async () => {
    const refusal = new AramoError('VALIDATION_ERROR', 'stand-in for CONTACT_DELETED', 422, {
      requestId: 'rid',
      details: { field: 'subject_id', contact_id: 'K1' },
    });
    const c = contacts({ assertLinkable: vi.fn().mockRejectedValue(refusal) });
    await expect(
      adapter(c).assertRecordable({ tenant_id: 'T', contact_id: 'K1', visibility: vis, requestId: 'rid' }),
    ).rejects.toBe(refusal);
  });

  it('isVisible mirrors the visibility-scoped contact read', async () => {
    expect(await adapter(contacts()).isVisible({ tenant_id: 'T', contact_id: 'K1', visibility: vis })).toBe(true);
    expect(
      await adapter(contacts({ findByIdForActor: vi.fn().mockResolvedValue(null) })).isVisible({
        tenant_id: 'T',
        contact_id: 'K1',
        visibility: vis,
      }),
    ).toBe(false);
  });

  it('touchLastActivity forwards tenant, contact id and the recorded instant (H-2)', async () => {
    const c = contacts();
    const at = new Date('2026-11-02T10:00:00.000Z');
    await adapter(c).touchLastActivity({ tenant_id: 'T', contact_id: 'K1', at });
    expect(c.touchLastActivity).toHaveBeenCalledWith({ tenant_id: 'T', id: 'K1', at });
  });
});
