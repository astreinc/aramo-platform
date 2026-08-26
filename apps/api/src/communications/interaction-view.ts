import type { InteractionRow } from '@aramo/communications';

import type { CommunicationInteractionViewDto } from './dto/communications.dto.js';

// COMM-B7 — the single provider-neutral interaction projection (ISO timestamps,
// no provider raw payload, no correlation ids surfaced). Shared by the single
// interaction read and the Talent timeline so both stay byte-identical.
export function toInteractionView(row: InteractionRow): CommunicationInteractionViewDto {
  return {
    id: row.id,
    channel: row.channel,
    direction: row.direction,
    status: row.status,
    integration_connection_id: row.integration_connection_id,
    from_address: row.from_address,
    to_address: row.to_address,
    started_at: row.started_at === null ? null : row.started_at.toISOString(),
    ringing_at: row.ringing_at === null ? null : row.ringing_at.toISOString(),
    connected_at: row.connected_at === null ? null : row.connected_at.toISOString(),
    ended_at: row.ended_at === null ? null : row.ended_at.toISOString(),
    duration_seconds: row.duration_seconds,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
