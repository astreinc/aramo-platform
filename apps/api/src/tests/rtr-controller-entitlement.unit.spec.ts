import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '@aramo/auth';
import { REQUIRED_SCOPES_KEY, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, REQUIRED_CAPABILITIES_KEY, type EntitlementRepository } from '@aramo/entitlement';

import { RtrController } from '../rtr/rtr.controller.js';

// PO ruling 2026-10-18 — executing an RTR needs the tenant's Aramo Sign
// subscription (`sign`) in addition to the user's permissions; every RTR route
// needs the ATS capability. Reads stay ATS-only (RTR history stays visible).
const EXECUTION = ['request', 'send', 'remind'] as const;
const READS = ['current', 'compose', 'preview', 'status'] as const;
type Handler = (typeof EXECUTION)[number] | (typeof READS)[number];

const handler = (name: Handler) => RtrController.prototype[name] as (...a: unknown[]) => unknown;

describe('RtrController — tenant capability metadata', () => {
  it('guard chain is JwtAuthGuard → EntitlementGuard → RolesGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, RtrController)).toEqual([JwtAuthGuard, EntitlementGuard, RolesGuard]);
  });

  it('class requires the ATS capability', () => {
    expect(Reflect.getMetadata(REQUIRED_CAPABILITIES_KEY, RtrController)).toEqual(['ats']);
  });

  it.each(EXECUTION)('%s requires ats + esign', (name) => {
    expect(Reflect.getMetadata(REQUIRED_CAPABILITIES_KEY, handler(name))).toEqual(['ats', 'sign']);
  });

  it('request needs document:create; send + remind need document:execute (unchanged)', () => {
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler('request'))).toEqual(['document:create']);
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler('send'))).toEqual(['document:execute']);
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler('remind'))).toEqual(['document:execute']);
  });

  it.each(READS)('%s carries no handler override (class ATS applies)', (name) => {
    expect(Reflect.getMetadata(REQUIRED_CAPABILITIES_KEY, handler(name))).toBeUndefined();
  });
});

describe('RtrController — EntitlementGuard decision', () => {
  const ctx = (name: Handler): ExecutionContext =>
    ({
      getHandler: () => handler(name),
      getClass: () => RtrController,
      switchToHttp: () => ({ getRequest: () => ({ requestId: 'req-1', authContext: { tenant_id: 't-1' } }) }),
    }) as unknown as ExecutionContext;
  const guardFor = (caps: string[]) =>
    new EntitlementGuard(new Reflector(), { getCapabilities: async () => new Set(caps) } as unknown as EntitlementRepository);
  const ATS_ONLY = ['core', 'ats', 'portal'];

  it.each(EXECUTION)('%s: an ATS tenant without Sign is refused (403 TENANT_CAPABILITY_NOT_ENTITLED)', async (name) => {
    await expect(guardFor(ATS_ONLY).canActivate(ctx(name))).rejects.toMatchObject({ code: 'TENANT_CAPABILITY_NOT_ENTITLED' });
  });

  it.each(EXECUTION)('%s: an ATS tenant with Sign passes the tenant gate', async (name) => {
    await expect(guardFor([...ATS_ONLY, 'sign']).canActivate(ctx(name))).resolves.toBe(true);
  });

  it.each(READS)('%s: an ATS tenant without Sign can still read', async (name) => {
    await expect(guardFor(ATS_ONLY).canActivate(ctx(name))).resolves.toBe(true);
  });

  it('a Sign-only tenant (no ATS) is refused even on reads', async () => {
    await expect(guardFor(['core', 'sign']).canActivate(ctx('status'))).rejects.toMatchObject({ code: 'TENANT_CAPABILITY_NOT_ENTITLED' });
  });
});
