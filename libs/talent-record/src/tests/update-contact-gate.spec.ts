import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { TalentRecordController } from '../lib/talent-record.controller.js';
import type { TalentRecordRepository } from '../lib/talent-record.repository.js';
import type { TalentLinkService } from '../lib/talent-link.service.js';
import type { TalentRecordView } from '../lib/dto/talent-record.view.js';
import type { UpdateTalentRecordRequestDto } from '../lib/dto/update-talent-record-request.dto.js';

// Contact-anchor edit gate — PATCH /v1/talent-records/:id handler contract.
//
// email1/phone_cell are the identity/dedup anchors: mandatory at create and, by
// default, immutable afterward. DATA-CORRECTION edits are authorized ONLY for
// tenant_admin + tenant_owner via the dedicated `talent:edit:contact` scope
// (never a role-name check); `talent:edit` alone (recruiter+) must NOT reach the
// repo when the PATCH touches a contact anchor. A correction may not blank an
// anchor (would violate the admission invariant the update() repo path does not
// itself re-assert).
//
// RED honesty: BEFORE this gate existed, the handler forwarded the whole PATCH
// body straight to repo.update — so case (2) below (a `talent:edit`-only actor
// PATCHing { email1 }) WOULD have called repo.update with the new email. The
// gate is precisely what turns that into a 403 with repo.update NOT called; the
// `expect(repo.update).not.toHaveBeenCalled()` assertion is the non-vacuous
// proof that the pre-gate behaviour is now blocked.
//
// Unit-level (mocked repo, no DB): the scope decorator (@RequireScopes) is an
// integration concern; here we prove the in-handler contact-anchor branch.

const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const ACTOR_ID = '01900000-0000-7000-8000-0000000000aa';
const TALENT_ID = '01900000-0000-7000-8000-0000000000ee';
const REQUEST_ID = 'rq-contact-gate';

function makeAuthContext(scopes: string[]): AuthContextType {
  return {
    sub: ACTOR_ID,
    tenant_id: TENANT_ID,
    scopes,
    consumer_type: 'tenant_user',
    capabilities: ['ats'],
  } as unknown as AuthContextType;
}

function makeView(overrides: Partial<TalentRecordView> = {}): TalentRecordView {
  return {
    id: TALENT_ID,
    tenant_id: TENANT_ID,
    first_name: 'Ada',
    last_name: 'Lovelace',
    email1: 'ada@example.com',
    phone_cell: '555-0100',
    ...overrides,
  } as unknown as TalentRecordView;
}

function makeController(): {
  ctl: TalentRecordController;
  repo: { update: ReturnType<typeof vi.fn> };
} {
  const repo = { update: vi.fn().mockResolvedValue(makeView()) };
  const ctl = new TalentRecordController(
    repo as unknown as TalentRecordRepository,
    {} as unknown as TalentLinkService,
    // objectStorage / resumeParser / tenantSetting / talentExtraction — unused
    // by the scalar contact-anchor PATCH path (no work_history in these bodies).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // TI-1B — resumeOrchestrator + resumeAuthorizer (unused on this path).
    {} as never,
    {} as never,
  );
  return { ctl, repo };
}

describe('Contact-anchor edit gate — PATCH handler contract', () => {
  it('WITH talent:edit:contact + { email1 } → repo.update IS called with email1 (no throw)', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:edit', 'talent:edit:contact']);
    const body: UpdateTalentRecordRequestDto = { email1: 'new@x.com' };
    await ctl.update(auth, TALENT_ID, body, REQUEST_ID);
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      id: TALENT_ID,
      input: { email1: 'new@x.com' },
      requestId: REQUEST_ID,
    });
  });

  it('WITHOUT talent:edit:contact + { email1 } → INSUFFICIENT_PERMISSIONS 403, repo.update NOT called', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:edit']); // recruiter-tier: lacks the contact scope
    const body: UpdateTalentRecordRequestDto = { email1: 'new@x.com' };
    // Pre-gate this call reached repo.update; the gate must now reject it.
    await expect(ctl.update(auth, TALENT_ID, body, REQUEST_ID)).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('WITHOUT talent:edit:contact + { phone_cell } → INSUFFICIENT_PERMISSIONS 403, repo.update NOT called', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:edit']);
    const body: UpdateTalentRecordRequestDto = { phone_cell: '555-9999' };
    await expect(ctl.update(auth, TALENT_ID, body, REQUEST_ID)).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('WITH the scope + { email1: "" } → VALIDATION_ERROR 400 (field email1), repo.update NOT called', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:edit', 'talent:edit:contact']);
    const body: UpdateTalentRecordRequestDto = { email1: '' };
    await expect(ctl.update(auth, TALENT_ID, body, REQUEST_ID)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      context: { details: { field: 'email1' } },
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('WITH the scope + { email1: null } → VALIDATION_ERROR 400, repo.update NOT called', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:edit', 'talent:edit:contact']);
    const body: UpdateTalentRecordRequestDto = { email1: null };
    await expect(ctl.update(auth, TALENT_ID, body, REQUEST_ID)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      context: { details: { field: 'email1' } },
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('WITH the scope + { phone_cell: "" } → VALIDATION_ERROR 400 (field phone_cell), repo.update NOT called', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:edit', 'talent:edit:contact']);
    const body: UpdateTalentRecordRequestDto = { phone_cell: '' };
    await expect(ctl.update(auth, TALENT_ID, body, REQUEST_ID)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      context: { details: { field: 'phone_cell' } },
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('a PATCH that does NOT touch email1/phone_cell succeeds for a talent:edit-only actor (gate not triggered)', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:edit']); // no contact scope — must still work
    const body: UpdateTalentRecordRequestDto = { first_name: 'X' };
    await ctl.update(auth, TALENT_ID, body, REQUEST_ID);
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      id: TALENT_ID,
      input: { first_name: 'X' },
      requestId: REQUEST_ID,
    });
  });
});
