import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { AuthContextType } from '@aramo/auth';
import { AramoError, type VisibilityContextShape } from '@aramo/common';

import { ActivityController } from '../lib/activity.controller.js';
import { ActivityRepository } from '../lib/activity.repository.js';
import type { ActivityContactSubjectPort } from '../lib/contact-subject.port.js';
import type { CreateActivityRequestDto } from '../lib/dto/create-activity-request.dto.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// CONTACTS-1 §8 (H-1..H-4) — recording activity against a contact through the
// manual activity route, the contact seam, and the contact visibility branch.

const CONTACT_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = '2026-11-02T10:00:00.000Z';

const auth = {
  tenant_id: 'T',
  sub: 'U',
  scopes: ['activity:create', 'activity:read'],
} as unknown as AuthContextType;

function visibility(over: Partial<VisibilityContextShape> = {}): VisibilityContextShape {
  return {
    tenant_id: 'T',
    actor_user_id: 'U',
    see_all_company: false,
    see_all_requisition: false,
    visible_client_ids: new Set(['C1']),
    ...over,
  };
}

function req(vis: VisibilityContextShape = visibility()): Request {
  return {
    resolveVisibility: vi.fn().mockResolvedValue(vis),
    resolveVisibleRequisitionIds: vi.fn().mockResolvedValue(new Set()),
    resolveVisiblePipelineIds: vi.fn().mockResolvedValue(new Set()),
  } as unknown as Request;
}

function view(over: Record<string, unknown> = {}) {
  return {
    id: 'A1',
    tenant_id: 'T',
    subject_type: 'contact',
    subject_id: CONTACT_ID,
    type: 'note',
    created_at: CREATED_AT,
    ...over,
  };
}

function port(
  over: Partial<Record<keyof ActivityContactSubjectPort, ReturnType<typeof vi.fn>>> = {},
) {
  return {
    assertRecordable: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(true),
    touchLastActivity: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function repo() {
  return {
    create: vi.fn().mockResolvedValue(view()),
    listForActor: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(view()),
    findByIdForActor: vi.fn().mockResolvedValue(view()),
  };
}

const noteBody = {
  type: 'note',
  subject_type: 'contact',
  subject_id: CONTACT_ID,
  notes: 'Spoke about Q1 hiring',
} as CreateActivityRequestDto;

function controller(r: ReturnType<typeof repo>, p?: ReturnType<typeof port>) {
  return new ActivityController(
    r as unknown as ActivityRepository,
    p as unknown as ActivityContactSubjectPort | undefined,
  );
}

describe('POST /v1/activities — subject_type=contact (CONTACTS-1 H-1/H-2/H-4)', () => {
  it('checks the contact, records the row, then touches last_activity_at with the row time', async () => {
    const r = repo();
    const p = port();
    const out = await controller(r, p).create(auth, noteBody, 'rid', req());
    expect(out.id).toBe('A1');
    expect(p.assertRecordable).toHaveBeenCalledWith({
      tenant_id: 'T',
      contact_id: CONTACT_ID,
      visibility: expect.objectContaining({ see_all_company: false }),
      requestId: 'rid',
    });
    expect(r.create).toHaveBeenCalledTimes(1);
    expect(p.touchLastActivity).toHaveBeenCalledWith({
      tenant_id: 'T',
      contact_id: CONTACT_ID,
      at: new Date(CREATED_AT),
    });
    // Order: check → write → touch.
    expect(p.assertRecordable.mock.invocationCallOrder[0]!).toBeLessThan(
      r.create.mock.invocationCallOrder[0]!,
    );
    expect(r.create.mock.invocationCallOrder[0]!).toBeLessThan(
      p.touchLastActivity.mock.invocationCallOrder[0]!,
    );
  });

  it.each(['call', 'email_logged'] as const)('touches recency for a logged %s too', async (type) => {
    const r = repo();
    r.create.mockResolvedValue(view({ type }));
    const p = port();
    await controller(r, p).create(auth, { ...noteBody, type } as CreateActivityRequestDto, 'rid', req());
    expect(p.touchLastActivity).toHaveBeenCalledTimes(1);
  });

  it('a deleted contact is refused with CONTACT_DELETED and nothing is recorded (H-4)', async () => {
    const r = repo();
    const p = port({
      assertRecordable: vi.fn().mockRejectedValue(
        new AramoError('CONTACT_DELETED', 'Contact is deleted', 422, {
          requestId: 'rid',
          details: { contact_id: CONTACT_ID, field: 'subject_id' },
        }),
      ),
    });
    await expect(controller(r, p).create(auth, noteBody, 'rid', req())).rejects.toMatchObject({
      code: 'CONTACT_DELETED',
    });
    expect(r.create).not.toHaveBeenCalled();
    expect(p.touchLastActivity).not.toHaveBeenCalled();
  });

  it('an invisible contact is refused with 404 and nothing is recorded', async () => {
    const r = repo();
    const p = port({
      assertRecordable: vi.fn().mockRejectedValue(
        new AramoError('NOT_FOUND', 'Contact not found', 404, { requestId: 'rid' }),
      ),
    });
    await expect(controller(r, p).create(auth, noteBody, 'rid', req())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(r.create).not.toHaveBeenCalled();
  });

  it('subject_id is required for a contact subject', async () => {
    const r = repo();
    const p = port();
    const body = { type: 'note', subject_type: 'contact', notes: 'x' } as CreateActivityRequestDto;
    await expect(controller(r, p).create(auth, body, 'rid', req())).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(p.assertRecordable).not.toHaveBeenCalled();
    expect(r.create).not.toHaveBeenCalled();
  });

  it('fails closed when the contact seam is not bound', async () => {
    const r = repo();
    await expect(controller(r).create(auth, noteBody, 'rid', req())).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(r.create).not.toHaveBeenCalled();
  });

  it('a recency failure after the row is recorded does not fail the request', async () => {
    const r = repo();
    const p = port({ touchLastActivity: vi.fn().mockRejectedValue(new Error('db down')) });
    const out = await controller(r, p).create(auth, noteBody, 'rid', req());
    expect(out.id).toBe('A1');
  });

  it('other subject types never reach the contact seam', async () => {
    const r = repo();
    const p = port();
    const body = { ...noteBody, subject_type: 'requisition' } as CreateActivityRequestDto;
    await controller(r, p).create(auth, body, 'rid', req());
    expect(p.assertRecordable).not.toHaveBeenCalled();
    expect(p.touchLastActivity).not.toHaveBeenCalled();
    expect(r.create).toHaveBeenCalledTimes(1);
  });
});

describe('GET /v1/activities — contact history visibility (CONTACTS-1 H-3)', () => {
  it('passes the contact as visible when the seam says so', async () => {
    const r = repo();
    const p = port();
    await controller(r, p).list(auth, 'contact', CONTACT_ID, req());
    expect(p.isVisible).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'T', contact_id: CONTACT_ID }),
    );
    expect(r.listForActor.mock.calls[0]![0].visible_contact_ids).toEqual(new Set([CONTACT_ID]));
  });

  it('passes no visible contact ids when the contact is not visible', async () => {
    const r = repo();
    const p = port({ isVisible: vi.fn().mockResolvedValue(false) });
    await controller(r, p).list(auth, 'contact', CONTACT_ID, req());
    expect(r.listForActor.mock.calls[0]![0].visible_contact_ids).toBeUndefined();
  });

  it('GET :id resolves the contact of a contact-subject row before the scoped read', async () => {
    const r = repo();
    const p = port();
    await controller(r, p).get(auth, 'A1', 'rid', req());
    expect(p.isVisible).toHaveBeenCalledTimes(1);
    expect(r.findByIdForActor.mock.calls[0]![0].visible_contact_ids).toEqual(new Set([CONTACT_ID]));
  });
});

describe('ActivityRepository — contact visibility branch (CONTACTS-1 H-3)', () => {
  function captureWhere(vis: VisibilityContextShape, contactIds?: ReadonlySet<string>) {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new ActivityRepository({
      activity: { findMany },
    } as unknown as PrismaService);
    return repository
      .listForActor({
        tenant_id: 'T',
        actor_user_id: 'U',
        visibility: vis,
        visible_requisition_ids: new Set(),
        visible_pipeline_ids: new Set(),
        subject_type: 'contact',
        subject_id: CONTACT_ID,
        ...(contactIds === undefined ? {} : { visible_contact_ids: contactIds }),
      })
      .then(() => findMany.mock.calls[0]![0].where);
  }

  function contactBranch(where: { AND: Array<{ OR?: Array<Record<string, unknown>> }> }) {
    return where.AND[0]!.OR!.find((b) => b['subject_type'] === 'contact');
  }

  it('restricts contact rows to the resolved visible contact ids', async () => {
    const where = await captureWhere(visibility(), new Set([CONTACT_ID]));
    expect(contactBranch(where)).toEqual({
      subject_type: 'contact',
      subject_id: { in: [CONTACT_ID] },
    });
  });

  it('fails closed (no contact ids) when none were resolved', async () => {
    const where = await captureWhere(visibility());
    expect(contactBranch(where)).toEqual({ subject_type: 'contact', subject_id: { in: [] } });
  });

  it('a see_all_company actor sees contact rows without an id list', async () => {
    const where = await captureWhere(visibility({ see_all_company: true }));
    expect(contactBranch(where)).toEqual({ subject_type: 'contact' });
  });
});
