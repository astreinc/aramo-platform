import { StatChip } from '../settings/components';

import type { IntegrationConnectionStatus } from './types';

// T8-CONNECTOR-A — connection lifecycle status pill.

const TONE: Record<IntegrationConnectionStatus, 'ok' | 'warn' | 'info' | 'muted'> = {
  disconnected: 'muted',
  configured: 'info',
  active: 'ok',
  degraded: 'warn',
  disabled: 'muted',
};

const LABEL: Record<IntegrationConnectionStatus, string> = {
  disconnected: 'Disconnected',
  configured: 'Configured',
  active: 'Active',
  degraded: 'Degraded',
  disabled: 'Disabled',
};

export function IntegrationConnectionStatusPill({
  status,
}: {
  readonly status: IntegrationConnectionStatus;
}) {
  const tone = TONE[status] ?? 'muted';
  return (
    <StatChip tone={tone} dot>
      {LABEL[status] ?? status}
    </StatChip>
  );
}
