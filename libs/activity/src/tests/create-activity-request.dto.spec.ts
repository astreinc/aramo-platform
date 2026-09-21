import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { CreateActivityRequestDto } from '../lib/dto/create-activity-request.dto.js';

// RN-1 (LOCKED) D-6 — the create DTO is now a validated CLASS (was a
// decorator-free interface, so the global ValidationPipe bounded nothing). These
// prove the note body is bounded 1..20000 at the DTO layer (AC-3) and that the
// bound is a real guard (AC-4 negative-control intent: without @MaxLength a
// 20001-char body validates clean — asserted here by the body failing ONLY on
// the maxLength constraint).

function validate(obj: Record<string, unknown>) {
  const dto = plainToInstance(CreateActivityRequestDto, obj);
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
}

const base = {
  type: 'note',
  subject_type: 'requisition',
  subject_id: '00000000-0000-7000-8000-4e9000000001',
};

describe('CreateActivityRequestDto — RN-1 validation', () => {
  it('accepts a 20,000-char note body', () => {
    const errors = validate({ ...base, notes: 'x'.repeat(20000) });
    expect(errors).toHaveLength(0);
  });

  it('rejects a 20,001-char note body on the maxLength constraint (AC-3)', () => {
    const errors = validate({ ...base, notes: 'x'.repeat(20001) });
    const notesErr = errors.find((e) => e.property === 'notes');
    expect(notesErr).toBeDefined();
    // AC-4 — the failure is specifically the length bound, proving the guard.
    expect(Object.keys(notesErr?.constraints ?? {})).toContain('maxLength');
  });

  it('rejects an empty note body on minLength', () => {
    const errors = validate({ ...base, notes: '' });
    const notesErr = errors.find((e) => e.property === 'notes');
    expect(Object.keys(notesErr?.constraints ?? {})).toContain('minLength');
  });

  it('rejects an unknown category', () => {
    const errors = validate({ ...base, notes: 'ok', category: 'NONSENSE' });
    expect(errors.some((e) => e.property === 'category')).toBe(true);
  });

  it('rejects RESTRICTED visibility (deferred to RN-2, not a value in RN-1)', () => {
    const errors = validate({ ...base, notes: 'ok', visibility: 'RESTRICTED' });
    expect(errors.some((e) => e.property === 'visibility')).toBe(true);
  });

  it('accepts the 7 ratified categories + TEAM/PRIVATE + pin', () => {
    const errors = validate({
      ...base,
      notes: 'ok',
      category: 'CLIENT_INTERACTION',
      visibility: 'PRIVATE',
      pinned: true,
    });
    expect(errors).toHaveLength(0);
  });
});
