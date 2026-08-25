import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { CreateRequisitionRequestDto } from '../lib/dto/create-requisition-request.dto.js';

// Requisition Lane 1-A — proof 8. CreateRequisitionRequestDto is now a
// decorated CLASS imported as a VALUE by the controller, so the global
// ValidationPipe (whitelist + forbidNonWhitelisted + transform) enforces it.
// An enum-invalid `status` surfaces as VALIDATION_ERROR (400) — distinct from
// the establishment gate's REQUISITION_INITIAL_STATE_FORBIDDEN (403). These
// assertions drive class-validator with the SAME options the pipe uses.
const PIPE_OPTS = { whitelist: true, forbidNonWhitelisted: true } as const;

describe('CreateRequisitionRequestDto — validated class DTO (L1-A P8)', () => {
  it('P8: an enum-invalid status fails @IsIn (the pipe maps this to VALIDATION_ERROR 400)', () => {
    const dto = plainToInstance(CreateRequisitionRequestDto, {
      title: 'x',
      company_id: 'c',
      status: 'totally_bogus',
    });
    const errors = validateSync(dto, PIPE_OPTS);
    const statusErr = errors.find((e) => e.property === 'status');
    expect(statusErr).toBeDefined();
    expect(Object.keys(statusErr!.constraints ?? {})).toContain('isIn');
  });

  it('accepts a valid enum status AND an omitted status (optional)', () => {
    expect(
      validateSync(
        plainToInstance(CreateRequisitionRequestDto, { title: 'x', company_id: 'c', status: 'open' }),
        PIPE_OPTS,
      ),
    ).toHaveLength(0);
    expect(
      validateSync(
        plainToInstance(CreateRequisitionRequestDto, { title: 'x', company_id: 'c' }),
        PIPE_OPTS,
      ),
    ).toHaveLength(0);
  });

  it('rejects unknown props under forbidNonWhitelisted (the additionalProperties:false contract)', () => {
    const errors = validateSync(
      plainToInstance(CreateRequisitionRequestDto, {
        title: 'x',
        company_id: 'c',
        not_a_real_field: 1,
      }),
      PIPE_OPTS,
    );
    expect(errors.some((e) => e.property === 'not_a_real_field')).toBe(true);
  });

  it('requires title + company_id (the two @IsString required fields)', () => {
    const errors = validateSync(plainToInstance(CreateRequisitionRequestDto, {}), PIPE_OPTS);
    const props = errors.map((e) => e.property).sort();
    expect(props).toContain('title');
    expect(props).toContain('company_id');
  });
});
