import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';

// Closed sets per directive §6. Unknown value at write time → halt-and-surface
// (AramoError INTERNAL_ERROR). Used by both seed and integration tests.
export const ACTOR_TYPES = ['system', 'service_account', 'user'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const EVENT_TYPES = [
  'identity.user.created',
  'identity.tenant.created',
  'identity.membership.created',
  'identity.role.created',
  'identity.scope.created',
  'identity.service_account.created',
  'identity.external_identity.linked',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// event_type → index-category mapping (directive §6, locked). Each event_type
// targets exactly one index; mapping is exhaustive and disjoint. The seed (and
// any future writer) uses this to decide whether tenant_id is set or null.
export const TENANT_SCOPED_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  'identity.tenant.created',
  'identity.membership.created',
]);

export interface WriteAuditEventInput {
  tenant_id: string | null;
  actor_id: string | null;
  actor_type: ActorType;
  event_type: EventType;
  subject_id: string;
  event_payload: Record<string, unknown>;
  // Optional explicit id (seed uses fixed IDs for determinism). When absent,
  // a UUID v7 is generated app-side.
  id?: string;
  // Request correlation for halt-and-report errors. When absent (e.g., seed/
  // bootstrap path), a system sentinel is used.
  requestId?: string;
}

const SYSTEM_REQUEST_ID = 'system-internal';

@Injectable()
export class IdentityAuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  async writeEvent(input: WriteAuditEventInput): Promise<{ id: string }> {
    const requestId = input.requestId ?? SYSTEM_REQUEST_ID;
    assertActorType(input.actor_type, requestId);
    assertEventType(input.event_type, requestId);
    assertMappingObeyed(input.event_type, input.tenant_id, requestId);

    const id = input.id ?? uuidv7();
    await this.prisma.identityAuditEvent.create({
      data: {
        id,
        tenant_id: input.tenant_id,
        actor_id: input.actor_id,
        actor_type: input.actor_type,
        event_type: input.event_type,
        subject_id: input.subject_id,
        event_payload: input.event_payload as never,
      },
    });
    return { id };
  }
}

function assertActorType(value: string, requestId: string): asserts value is ActorType {
  if (!(ACTOR_TYPES as readonly string[]).includes(value)) {
    throw new AramoError(
      'INTERNAL_ERROR',
      `IdentityAuditEvent.actor_type outside closed set: ${value}`,
      500,
      { requestId, details: { received_actor_type: value, allowed: [...ACTOR_TYPES] } },
    );
  }
}

function assertEventType(value: string, requestId: string): asserts value is EventType {
  if (!(EVENT_TYPES as readonly string[]).includes(value)) {
    throw new AramoError(
      'INTERNAL_ERROR',
      `IdentityAuditEvent.event_type outside closed set: ${value}`,
      500,
      { requestId, details: { received_event_type: value, allowed: [...EVENT_TYPES] } },
    );
  }
}

// Enforces directive §6 event_type → index-category mapping.
// tenant-scoped events require tenant_id set; global events require tenant_id null.
function assertMappingObeyed(
  event_type: EventType,
  tenant_id: string | null,
  requestId: string,
): void {
  const requiresTenant = TENANT_SCOPED_EVENT_TYPES.has(event_type);
  if (requiresTenant && tenant_id === null) {
    throw new AramoError(
      'INTERNAL_ERROR',
      `event_type ${event_type} is tenant-scoped per directive §6 mapping but tenant_id is null`,
      500,
      { requestId, details: { event_type, expected: 'tenant_id set' } },
    );
  }
  if (!requiresTenant && tenant_id !== null) {
    throw new AramoError(
      'INTERNAL_ERROR',
      `event_type ${event_type} is global per directive §6 mapping but tenant_id was set`,
      500,
      { requestId, details: { event_type, expected: 'tenant_id null' } },
    );
  }
}
