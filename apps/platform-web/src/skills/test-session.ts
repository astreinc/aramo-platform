import type { Session } from '@aramo/fe-foundation';

// SKILL-TAX-1F-C1 test helper — a platform session carrying the given scopes.
export function platformSession(scopes: string[]): Session {
  return {
    sub: '01900000-0000-7000-8000-0000000ac001',
    consumer_type: 'platform',
    tenant_id: '01900000-0000-7000-8000-000000000100',
    scopes,
    iat: 0,
    exp: 0,
  };
}

export const READ_ONLY = ['platform:skill:read'];
export const MANAGE = ['platform:skill:read', 'platform:skill:manage'];
