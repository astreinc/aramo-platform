import { describe, expect, it } from 'vitest';

import type { ConnectionStatus } from '../lib/domain/integration-connection.js';
import {
  IllegalConnectionTransitionError,
  canTransition,
  isExecutionOnly,
  resolveTransition,
} from '../lib/connection/connection-lifecycle.js';

// T8-CONNECTOR-A — lifecycle legality (directive §14, Architect check #1). Status
// is a governed state machine, not a writable field.

const ALL: ConnectionStatus[] = ['disconnected', 'configured', 'active', 'degraded', 'disabled'];

describe('connection lifecycle legality', () => {
  it('enable is legal ONLY from configured/degraded/disabled → active', () => {
    expect(resolveTransition('configured', 'enable')).toBe('active');
    expect(resolveTransition('degraded', 'enable')).toBe('active');
    expect(resolveTransition('disabled', 'enable')).toBe('active');
    expect(canTransition('disconnected', 'enable')).toBe(false);
    expect(() => resolveTransition('disconnected', 'enable')).toThrow(
      IllegalConnectionTransitionError,
    );
  });

  it('disable → disabled from any operational state (history preserved by the service, not a delete)', () => {
    for (const from of ['configured', 'active', 'degraded', 'disabled'] as ConnectionStatus[]) {
      expect(resolveTransition(from, 'disable')).toBe('disabled');
    }
  });

  it('degraded is EXECUTION-driven and recovers to active ONLY via execution_success', () => {
    expect(resolveTransition('active', 'execution_failure')).toBe('degraded');
    expect(resolveTransition('degraded', 'execution_success')).toBe('active');
    expect(isExecutionOnly('execution_success')).toBe(true);
    expect(isExecutionOnly('execution_failure')).toBe(true);
    expect(isExecutionOnly('enable')).toBe(false);
    // execution intents are illegal from non-running states (no admin backdoor)
    expect(canTransition('disconnected', 'execution_success')).toBe(false);
    expect(canTransition('configured', 'execution_success')).toBe(false);
    expect(canTransition('disabled', 'execution_failure')).toBe(false);
  });

  it('configure (credential/config set) is legal from every state and lands on configured', () => {
    for (const from of ALL) {
      expect(resolveTransition(from, 'configure')).toBe('configured');
    }
  });
});
