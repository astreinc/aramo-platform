import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { REQUIRED_SCOPES_KEY } from '@aramo/authorization';

import { ReportingController } from '../lib/reporting.controller.js';

// Lane 2 / L2-I (D5) — controller-guard proof for the three L2-I reporting routes. Each carries the
// report:read scope gate (the same guard chain as every other reporting route); source-effectiveness
// additionally rejects a date-only / zone-less / inverted period 400 (VALIDATION_ERROR — no new
// ErrorCode). No DB — the folds are proven in the unit reader specs + the PG17 integration paths.
const controller = new ReportingController({} as never);
const AUTH = { tenant_id: 't', sub: 'u', scopes: ['report:read'] } as never;
const REQ = {} as never; // never reached — validation throws first

describe('L2-I D5 — funnel + source-effectiveness route guards', () => {
  it('recruiting-funnel requires the report:read scope', () => {
    const scopes = Reflect.getMetadata(REQUIRED_SCOPES_KEY, controller.recruitingFunnel) as string[] | undefined;
    expect(scopes).toEqual(['report:read']);
  });

  it('hiring-funnel requires the report:read scope', () => {
    const scopes = Reflect.getMetadata(REQUIRED_SCOPES_KEY, controller.hiringFunnel) as string[] | undefined;
    expect(scopes).toEqual(['report:read']);
  });

  it('source-effectiveness requires the report:read scope', () => {
    const scopes = Reflect.getMetadata(REQUIRED_SCOPES_KEY, controller.sourceEffectiveness) as string[] | undefined;
    expect(scopes).toEqual(['report:read']);
  });

  it('source-effectiveness rejects a date-only `from` 400 (VALIDATION_ERROR)', async () => {
    await expect(
      controller.sourceEffectiveness(AUTH, 'r', '2026-01-01', '2026-02-01T00:00:00.000Z', undefined, REQ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });

  it('source-effectiveness rejects a zone-less `to` 400', async () => {
    await expect(
      controller.sourceEffectiveness(AUTH, 'r', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00', undefined, REQ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });

  it('source-effectiveness rejects an inverted period (from >= to) 400', async () => {
    await expect(
      controller.sourceEffectiveness(AUTH, 'r', '2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', undefined, REQ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });
});
