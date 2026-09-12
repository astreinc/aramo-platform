import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { TalentRecordController } from '../lib/talent-record.controller.js';
import type { TalentRecordRepository } from '../lib/talent-record.repository.js';
import type { TalentLinkService } from '../lib/talent-link.service.js';

// Proactive duplicate-check — GET /v1/talent-records/duplicate-check?email=.
// The Add-Talent "Possible existing Talent" card is driven by this read; the
// create-time 409 TALENT_RECORD_DUPLICATE remains the hard backstop. Scope gate
// (talent:read) + no @RequireSiteMatch (tenant-wide, mirroring the 409) are
// decorator concerns verified at integration level; here we prove the HANDLER
// contract: blank email short-circuits without a DB hit, a present email is
// trimmed + delegated to the tenant-wide email lookup, and the match/no-match
// projection is passed through verbatim.

const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const ACTOR_ID = '01900000-0000-7000-8000-0000000000aa';

function makeAuthContext(scopes: string[]): AuthContextType {
  return {
    sub: ACTOR_ID,
    tenant_id: TENANT_ID,
    scopes,
    consumer_type: 'tenant_user',
    capabilities: ['ats'],
  } as unknown as AuthContextType;
}

function makeController(): {
  ctl: TalentRecordController;
  repo: { findDuplicateByEmail: ReturnType<typeof vi.fn> };
} {
  const repo = { findDuplicateByEmail: vi.fn().mockResolvedValue(null) };
  const ctl = new TalentRecordController(
    repo as unknown as TalentRecordRepository,
    {} as unknown as TalentLinkService,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // tenantSetting + talentExtraction — unused by the duplicate-check path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
  );
  return { ctl, repo };
}

describe('Duplicate-check — handler contract', () => {
  it('blank email → { match: null } WITHOUT a DB lookup', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:read']);
    await expect(ctl.duplicateCheck(auth, '')).resolves.toEqual({ match: null });
    expect(repo.findDuplicateByEmail).not.toHaveBeenCalled();
  });

  it('whitespace-only email → { match: null } WITHOUT a DB lookup', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:read']);
    await expect(ctl.duplicateCheck(auth, '   ')).resolves.toEqual({ match: null });
    expect(repo.findDuplicateByEmail).not.toHaveBeenCalled();
  });

  it('undefined email → { match: null } WITHOUT a DB lookup', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:read']);
    await expect(ctl.duplicateCheck(auth, undefined)).resolves.toEqual({ match: null });
    expect(repo.findDuplicateByEmail).not.toHaveBeenCalled();
  });

  it('present email → tenant-scoped lookup with the TRIMMED email', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:read']);
    await ctl.duplicateCheck(auth, '  Sarah.Nolan@Example.com  ');
    expect(repo.findDuplicateByEmail).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      email: 'Sarah.Nolan@Example.com',
    });
  });

  it('a match → the projection is returned verbatim under { match }', async () => {
    const { ctl, repo } = makeController();
    const existing = {
      id: '01900000-0000-7000-8000-0000000000ee',
      first_name: 'Sarah',
      last_name: 'Nolan',
      title: 'Cloud Engineer',
      city: 'Austin',
      state: 'TX',
    };
    repo.findDuplicateByEmail.mockResolvedValueOnce(existing);
    const auth = makeAuthContext(['talent:read']);
    await expect(
      ctl.duplicateCheck(auth, 'sarah.nolan@example.com'),
    ).resolves.toEqual({ match: existing });
  });

  it('no match → { match: null }', async () => {
    const { ctl } = makeController();
    const auth = makeAuthContext(['talent:read']);
    await expect(
      ctl.duplicateCheck(auth, 'nobody@example.com'),
    ).resolves.toEqual({ match: null });
  });
});
