import type { ConnectionStatus } from '../domain/integration-connection.js';

// T8-CONNECTOR-A — governed connection lifecycle legality (directive §14,
// Architect check #1). Status is NEVER an arbitrary writable field: every
// transition is an explicit INTENT with an allowed source set. Health
// (degraded/active-recovery) is EXECUTION-driven only; `disabled` is
// administrative and preserves history.

export type ConnectionIntent =
  | 'configure' // credential/config set → re-`configured`, requires explicit re-enable
  | 'enable' // admin activation → `active`
  | 'disable' // admin deactivation → `disabled` (history preserved)
  | 'execution_success' // execution path → `active` (recovers `degraded`)
  | 'execution_failure'; // execution path → `degraded`

interface IntentRule {
  readonly from: ReadonlySet<ConnectionStatus>;
  readonly to: ConnectionStatus;
  /** Only the connector execution path may drive this intent (not admin writes). */
  readonly executionOnly: boolean;
}

const RULES: Record<ConnectionIntent, IntentRule> = {
  configure: {
    from: new Set<ConnectionStatus>(['disconnected', 'configured', 'active', 'degraded', 'disabled']),
    to: 'configured',
    executionOnly: false,
  },
  enable: {
    from: new Set<ConnectionStatus>(['configured', 'degraded', 'disabled']),
    to: 'active',
    executionOnly: false,
  },
  disable: {
    from: new Set<ConnectionStatus>(['configured', 'active', 'degraded', 'disabled']),
    to: 'disabled',
    executionOnly: false,
  },
  execution_success: {
    from: new Set<ConnectionStatus>(['active', 'degraded']),
    to: 'active',
    executionOnly: true,
  },
  execution_failure: {
    from: new Set<ConnectionStatus>(['active', 'degraded']),
    to: 'degraded',
    executionOnly: true,
  },
};

export class IllegalConnectionTransitionError extends Error {
  constructor(
    readonly from: ConnectionStatus,
    readonly intent: ConnectionIntent,
  ) {
    super(`illegal connection transition: ${intent} from ${from}`);
    this.name = 'IllegalConnectionTransitionError';
  }
}

/** Whether an intent is legal from the given status. */
export function canTransition(from: ConnectionStatus, intent: ConnectionIntent): boolean {
  return RULES[intent].from.has(from);
}

/** Whether an intent may be driven only by the execution path (not admin writes). */
export function isExecutionOnly(intent: ConnectionIntent): boolean {
  return RULES[intent].executionOnly;
}

/**
 * Resolve the target status for a legal intent; throw
 * IllegalConnectionTransitionError otherwise. This is the single legality gate
 * the connection service routes every status change through.
 */
export function resolveTransition(
  from: ConnectionStatus,
  intent: ConnectionIntent,
): ConnectionStatus {
  if (!canTransition(from, intent)) {
    throw new IllegalConnectionTransitionError(from, intent);
  }
  return RULES[intent].to;
}
