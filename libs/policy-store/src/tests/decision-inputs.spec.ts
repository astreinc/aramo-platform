import { describe, expect, it } from 'vitest';
import type { PolicyContext } from '@aramo/policy-engine';

import { snapshotPolicyInputs } from '../lib/decision-inputs.js';

// PII assertion for the §D17a `inputs` snapshot. The snapshot is a WHITELIST,
// so PII-carrying context fields (the open `attributes` map, environment,
// wall-clock time, request metadata) must never appear in it.

// A context whose non-whitelisted fields carry obvious PII.
const CONTEXT_WITH_PII: PolicyContext = {
  tenant_id: '11111111-1111-7111-8111-111111111111',
  resource: 'DOC',
  action: 'WRITE',
  resource_state: {
    declared: { status: 'active' },
    derived: { is_hot: true },
  },
  principal_capabilities: { 'pipeline:add': true },
  request_metadata: { correlation_id: 'corr-1', origin: 'ui' },
  environment: 'prod',
  time: '2026-07-30T12:00:00.000Z',
  attributes: {
    email: 'jane.doe@example.com',
    full_name: 'Jane Doe',
    phone: '+1-555-0100',
  },
};

describe('snapshotPolicyInputs — PII-free whitelist', () => {
  const snapshot = snapshotPolicyInputs(CONTEXT_WITH_PII);

  it('keeps ONLY the whitelisted keys', () => {
    expect(Object.keys(snapshot).sort()).toEqual(['action', 'capabilities', 'declared', 'derived', 'resource']);
  });

  it('carries the resource/action identifiers and the state buckets', () => {
    expect(snapshot.resource).toBe('DOC');
    expect(snapshot.action).toBe('WRITE');
    expect(snapshot.declared).toEqual({ status: 'active' });
    expect(snapshot.derived).toEqual({ is_hot: true });
    expect(snapshot.capabilities).toEqual({ 'pipeline:add': true });
  });

  it('drops every PII-bearing field (attributes / environment / time / request metadata / tenant)', () => {
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('jane.doe@example.com');
    expect(serialized).not.toContain('Jane Doe');
    expect(serialized).not.toContain('555-0100');
    // Whole non-whitelisted containers are absent, not merely their values.
    expect(snapshot).not.toHaveProperty('attributes');
    expect(snapshot).not.toHaveProperty('environment');
    expect(snapshot).not.toHaveProperty('time');
    expect(snapshot).not.toHaveProperty('request_metadata');
    expect(snapshot).not.toHaveProperty('tenant_id');
  });

  it('does not alias the source context (defensive copy)', () => {
    expect(snapshot.declared).not.toBe(CONTEXT_WITH_PII.resource_state.declared);
    expect(snapshot.capabilities).not.toBe(CONTEXT_WITH_PII.principal_capabilities);
  });
});
