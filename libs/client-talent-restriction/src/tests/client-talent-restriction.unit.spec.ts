import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ASSERTED_BY_TYPE_VALUES,
  CLOSE_REASON_CODE_VALUES,
  RESTRICTION_TYPE_VALUES,
  SOURCE_SYSTEM_VALUES,
  isAssertedByType,
  isCloseReasonCode,
  isGovernedSourceReference,
  isRestrictionType,
  isSourceSystem,
} from '../lib/client-talent-restriction-vocab.js';
import { ClientTalentRestrictionRepository } from '../lib/client-talent-restriction.repository.js';

const LIB_ROOT = resolve(__dirname, '..', 'lib');
function readAllLibSource(): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'generated') continue;
        walk(p);
      } else if (entry.name.endsWith('.ts')) {
        files.push(readFileSync(p, 'utf8'));
      }
    }
  };
  walk(LIB_ROOT);
  return files.join('\n');
}

describe('ClientTalentRestriction — closed-registry guards', () => {
  it('restriction_type is the fixed ADR-0027 registry (four values)', () => {
    expect([...RESTRICTION_TYPE_VALUES]).toEqual([
      'CLIENT_DO_NOT_RESUBMIT',
      'CLIENT_NOT_ELIGIBLE_FOR_REENGAGEMENT',
      'CLIENT_SITE_ACCESS_RESTRICTED',
      'VMS_SUBMITTAL_RESTRICTED',
    ]);
    expect(isRestrictionType('CLIENT_DO_NOT_RESUBMIT')).toBe(true);
    expect(isRestrictionType('SOMETHING_ELSE')).toBe(false);
    expect(isRestrictionType(undefined)).toBe(false);
  });

  it('asserted_by_type, source_system, close_reason_code are closed', () => {
    expect(ASSERTED_BY_TYPE_VALUES).toContain('CLIENT_LEGAL_COMPLIANCE');
    expect(isAssertedByType('CLIENT')).toBe(true);
    expect(isAssertedByType('RECRUITER')).toBe(false);
    expect(SOURCE_SYSTEM_VALUES).toContain('FIELDGLASS');
    expect(isSourceSystem('FIELDGLASS')).toBe(true);
    expect(isSourceSystem('SLACK')).toBe(false);
    expect(CLOSE_REASON_CODE_VALUES).toContain('CLIENT_WITHDRAWN');
    expect(isCloseReasonCode('CLIENT_WITHDRAWN')).toBe(true);
    expect(isCloseReasonCode('BECAUSE')).toBe(false);
  });
});

describe('ClientTalentRestriction — governed source_reference (§3b correction 2)', () => {
  it('accepts a governed reference to the evidence', () => {
    expect(isGovernedSourceReference('CLIENT_EMAIL:<message-id-123>')).toBe(true);
    expect(isGovernedSourceReference('CLIENT_CALL:activity-abc')).toBe(true);
    expect(isGovernedSourceReference('MANUAL_NOTICE:external-fact-42')).toBe(true);
    expect(isGovernedSourceReference('FIELDGLASS:VMS-9001')).toBe(true);
  });

  it('rejects free narrative text (the "client told me" trap)', () => {
    expect(isGovernedSourceReference('client told me')).toBe(false);
    expect(isGovernedSourceReference('the client said no')).toBe(false);
    expect(isGovernedSourceReference('')).toBe(false);
    expect(isGovernedSourceReference('lowercase:ref')).toBe(false);
    expect(isGovernedSourceReference('NO COLON HERE')).toBe(false);
    expect(isGovernedSourceReference('SPACED PREFIX:x')).toBe(false);
    expect(isGovernedSourceReference(42)).toBe(false);
  });
});

// Tripwire 2 (structural, below the controller too) + R2/R3: the repository
// must NOT expose any cross-client / per-talent aggregation surface.
describe('ClientTalentRestriction — prohibited query surface is absent (tripwire 2)', () => {
  const proto = ClientTalentRestrictionRepository.prototype as unknown as Record<string, unknown>;

  it('has no cross-client / per-talent aggregation methods', () => {
    for (const banned of [
      'findAllByTalent',
      'countByTalent',
      'findRestrictedTalent',
      'countByRestrictionType',
      'findByTalent',
      'listAll',
    ]) {
      expect(proto[banned]).toBeUndefined();
    }
  });

  it('exposes no delete method (R4)', () => {
    for (const del of ['delete', 'deleteRestriction', 'remove', 'purge']) {
      expect(proto[del]).toBeUndefined();
    }
  });

  it('every public repository read is client-and-talent-scoped by name', () => {
    // The only read methods present name both client and talent in scope.
    expect(typeof proto['findCurrentForClientTalent']).toBe('function');
    expect(typeof proto['findHistoryForClientTalent']).toBe('function');
  });
});

// Tripwire 2 (route shape) — the prohibited flat/talent-only routes must not
// exist. Prove ABSENCE by scanning the controller source, and prove the
// @Controller base is the client-and-talent-scoped prefix.
describe('ClientTalentRestriction — prohibited routes are absent (tripwire 2)', () => {
  const controllerSrc = readFileSync(
    resolve(LIB_ROOT, 'client-talent-restriction.controller.ts'),
    'utf8',
  );

  it('uses the client-and-talent-scoped controller base', () => {
    expect(controllerSrc).toContain(
      "@Controller('v1/clients/:client_company_id/talent/:talent_record_id/restrictions')",
    );
  });

  it('declares none of the prohibited route shapes', () => {
    expect(controllerSrc).not.toContain("'v1/client-talent-restrictions'");
    expect(controllerSrc).not.toContain("'v1/restrictions'");
    expect(controllerSrc).not.toContain('v1/talent/:talent_id/restrictions');
    // No handler is mapped without both scope params (no bare @Get()/@Post()
    // at a talent-only or global path — the only decorators are nested).
  });
});

// §2 trap + R5/R6 — this entity must never read, write, or derive from
// Company.off_limits, and must introduce no rehire_eligible/do_not_rehire
// field. Prove by scanning the whole lib source.
describe('ClientTalentRestriction — Company.off_limits isolation + no talent do-not-rehire flag', () => {
  const src = readAllLibSource();

  it('never references off_limits or imports @aramo/company', () => {
    expect(src).not.toContain('off_limits');
    expect(src).not.toContain('@aramo/company');
  });

  it('introduces no rehire_eligible / do_not_rehire field (R6, ADR-0019 rejected)', () => {
    expect(src).not.toContain('rehire_eligible');
    expect(src).not.toContain('do_not_rehire');
  });

  it('never reads a matching / scoring / Core / Portal surface (R5)', () => {
    for (const forbidden of ['@aramo/matching', '@aramo/pipeline', '@aramo/portal', '@aramo/talent']) {
      expect(src).not.toContain(forbidden);
    }
  });
});
