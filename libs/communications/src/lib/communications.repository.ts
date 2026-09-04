import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import type {
  CommunicationChannel,
  CommunicationDirection,
  CommunicationDispositionOutcome,
  CommunicationInteractionStatus,
  CommunicationProviderIdentityStatus,
  CommunicationRelationType,
  CommunicationSubjectType,
} from './domain/communication-enums.js';

// COMM-V1 — tenant-first persistence for the five communications tables
// (COMM-B1). Every query LEADS with tenant_id; a cross-tenant id is NOT FOUND
// (tenant-safe), never an info leak. No secret or raw provider payload is
// written by any method (R-COMM-CONNECTION / R-COMM-RAW-PAYLOAD).

export interface InteractionRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  channel: CommunicationChannel;
  direction: CommunicationDirection;
  status: CommunicationInteractionStatus;
  integration_connection_id: string;
  provider_interaction_id: string | null;
  provider_call_id: string | null;
  provider_call_history_uuid: string | null;
  provider_call_element_id: string | null;
  initiated_by_id: string | null;
  from_address: string;
  to_address: string;
  started_at: Date | null;
  ringing_at: Date | null;
  connected_at: Date | null;
  ended_at: Date | null;
  duration_seconds: number | null;
  created_at: Date;
  updated_at: Date;
}

// COMM-C2A — a minimal interaction row for the voice-evidence projection: the
// interaction id + status + created_at, plus its disposition outcomes (newest
// first). Deliberately narrow — the projection only needs status + outcomes.
export interface VoiceEvidenceInteractionRow {
  id: string;
  status: CommunicationInteractionStatus;
  created_at: Date;
  dispositions: { disposition: CommunicationDispositionOutcome; dispositioned_at: Date }[];
}

export interface InteractionStatusPatch {
  status: CommunicationInteractionStatus;
  started_at?: Date;
  ringing_at?: Date;
  connected_at?: Date;
  ended_at?: Date;
  duration_seconds?: number;
  provider_call_id?: string;
  provider_call_history_uuid?: string;
  provider_call_element_id?: string;
}

@Injectable()
export class CommunicationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- CommunicationInteraction (system of record) ----

  async createInteraction(args: {
    tenant_id: string;
    site_id?: string | null;
    channel: CommunicationChannel;
    direction: CommunicationDirection;
    integration_connection_id: string;
    from_address: string;
    to_address: string;
    initiated_by_id?: string | null;
  }): Promise<InteractionRow> {
    return (await this.prisma.communicationInteraction.create({
      data: {
        tenant_id: args.tenant_id,
        site_id: args.site_id ?? null,
        channel: args.channel,
        direction: args.direction,
        status: 'created',
        integration_connection_id: args.integration_connection_id,
        from_address: args.from_address,
        to_address: args.to_address,
        initiated_by_id: args.initiated_by_id ?? null,
      },
    })) as InteractionRow;
  }

  /** Tenant-safe read — null when the id belongs to another tenant. */
  async findInteractionForTenant(tenantId: string, id: string): Promise<InteractionRow | null> {
    return (await this.prisma.communicationInteraction.findFirst({
      where: { tenant_id: tenantId, id },
    })) as InteractionRow | null;
  }

  /** Correlation lookup (R-COMM-ZOOM-IDENTITY) — always scoped by tenant + connection. */
  async findInteractionByProviderCallElement(
    tenantId: string,
    connectionId: string,
    providerCallElementId: string,
  ): Promise<InteractionRow | null> {
    return (await this.prisma.communicationInteraction.findFirst({
      where: {
        tenant_id: tenantId,
        integration_connection_id: connectionId,
        provider_call_element_id: providerCallElementId,
      },
    })) as InteractionRow | null;
  }

  // COMM-B6 — tenant+connection-scoped webhook correlation. Tries the provider
  // ids in the LOCKED priority order (call_element_id → call_history_uuid →
  // call_id) and returns the first match, or null (unmatched → the caller records
  // the event and performs NO interaction mutation; it NEVER creates a row).
  async findInteractionByProviderCorrelation(
    tenantId: string,
    connectionId: string,
    ids: {
      call_element_id?: string | null;
      call_history_uuid?: string | null;
      call_id?: string | null;
    },
  ): Promise<InteractionRow | null> {
    if (ids.call_element_id != null && ids.call_element_id.length > 0) {
      const byElement = await this.findInteractionByProviderCallElement(
        tenantId,
        connectionId,
        ids.call_element_id,
      );
      if (byElement !== null) return byElement;
    }
    if (ids.call_history_uuid != null && ids.call_history_uuid.length > 0) {
      const byHistory = (await this.prisma.communicationInteraction.findFirst({
        where: {
          tenant_id: tenantId,
          integration_connection_id: connectionId,
          provider_call_history_uuid: ids.call_history_uuid,
        },
      })) as InteractionRow | null;
      if (byHistory !== null) return byHistory;
    }
    if (ids.call_id != null && ids.call_id.length > 0) {
      const byCallId = (await this.prisma.communicationInteraction.findFirst({
        where: {
          tenant_id: tenantId,
          integration_connection_id: connectionId,
          provider_call_id: ids.call_id,
        },
      })) as InteractionRow | null;
      if (byCallId !== null) return byCallId;
    }
    return null;
  }

  // COMM-B6 — record the terminal disposition of an inbox event after processing
  // (processed | ignored | failed). Stamps processed_at, bumps attempt_count, and
  // optionally links the correlated interaction / an error code. No raw payload.
  async markProviderEventProcessed(
    id: string,
    patch: {
      status: 'processed' | 'ignored' | 'failed';
      interaction_id?: string | null;
      error_code?: string | null;
    },
  ): Promise<void> {
    await this.prisma.communicationProviderEvent.update({
      where: { id },
      data: {
        status: patch.status,
        processed_at: new Date(),
        attempt_count: { increment: 1 },
        ...(patch.interaction_id === undefined ? {} : { interaction_id: patch.interaction_id }),
        ...(patch.error_code === undefined ? {} : { error_code: patch.error_code }),
      },
    });
  }

  /** Tenant-scoped status write. Returns rows updated (0 -> tenant-safe miss). */
  async updateInteractionStatus(
    tenantId: string,
    id: string,
    patch: InteractionStatusPatch,
  ): Promise<number> {
    const data: Record<string, unknown> = { status: patch.status };
    if (patch.started_at !== undefined) data['started_at'] = patch.started_at;
    if (patch.ringing_at !== undefined) data['ringing_at'] = patch.ringing_at;
    if (patch.connected_at !== undefined) data['connected_at'] = patch.connected_at;
    if (patch.ended_at !== undefined) data['ended_at'] = patch.ended_at;
    if (patch.duration_seconds !== undefined) data['duration_seconds'] = patch.duration_seconds;
    if (patch.provider_call_id !== undefined) data['provider_call_id'] = patch.provider_call_id;
    if (patch.provider_call_history_uuid !== undefined)
      data['provider_call_history_uuid'] = patch.provider_call_history_uuid;
    if (patch.provider_call_element_id !== undefined)
      data['provider_call_element_id'] = patch.provider_call_element_id;
    const res = await this.prisma.communicationInteraction.updateMany({
      where: { tenant_id: tenantId, id },
      data: data as never,
    });
    return res.count;
  }

  // COMM-B8 — set ONLY the provided provider correlation field(s) + updated_at,
  // tenant-scoped. NEVER touches status / lifecycle timestamps / disposition /
  // associations (the convergent conflict decision is the service's; this is the
  // pure write of already-decided fills). Returns rows updated.
  async setProviderReference(
    tenantId: string,
    id: string,
    fields: {
      provider_call_element_id?: string;
      provider_call_history_uuid?: string;
      provider_call_id?: string;
    },
  ): Promise<number> {
    const data: Record<string, unknown> = { updated_at: new Date() };
    if (fields.provider_call_element_id !== undefined)
      data['provider_call_element_id'] = fields.provider_call_element_id;
    if (fields.provider_call_history_uuid !== undefined)
      data['provider_call_history_uuid'] = fields.provider_call_history_uuid;
    if (fields.provider_call_id !== undefined) data['provider_call_id'] = fields.provider_call_id;
    const res = await this.prisma.communicationInteraction.updateMany({
      where: { tenant_id: tenantId, id },
      data: data as never,
    });
    return res.count;
  }

  // ---- CommunicationAssociation ----

  async addAssociation(args: {
    tenant_id: string;
    interaction_id: string;
    subject_type: CommunicationSubjectType;
    subject_id: string;
    relation_type: CommunicationRelationType;
  }): Promise<{ id: string }> {
    const row = await this.prisma.communicationAssociation.create({
      data: {
        tenant_id: args.tenant_id,
        interaction_id: args.interaction_id,
        subject_type: args.subject_type,
        subject_id: args.subject_id,
        relation_type: args.relation_type,
      },
      select: { id: true },
    });
    return row;
  }

  /** Timeline foundation — interactions linked to a subject, tenant-scoped. */
  async listInteractionIdsForSubject(
    tenantId: string,
    subjectType: CommunicationSubjectType,
    subjectId: string,
  ): Promise<string[]> {
    const rows = await this.prisma.communicationAssociation.findMany({
      where: { tenant_id: tenantId, subject_type: subjectType, subject_id: subjectId },
      select: { interaction_id: true },
      orderBy: { created_at: 'desc' },
    });
    return rows.map((r) => r.interaction_id);
  }

  // COMM-B7 — the Talent communication timeline read. Interactions linked to the
  // talent via a `subject` CommunicationAssociation (Communications associations
  // ONLY — no Requisition/Activity join), tenant-scoped, ordered (created_at DESC,
  // id DESC) for keyset stability. Fetches `limit + 1` so the caller can derive
  // the next cursor. An optional cursor pages strictly after (older than) the
  // (created_at, id) it carries.
  async listInteractionsForTalentKeyset(
    tenantId: string,
    talentId: string,
    limit: number,
    cursor?: { created_at: Date; interaction_id: string },
  ): Promise<InteractionRow[]> {
    const keyset =
      cursor === undefined
        ? {}
        : {
            OR: [
              { created_at: { lt: cursor.created_at } },
              { created_at: cursor.created_at, id: { lt: cursor.interaction_id } },
            ],
          };
    return (await this.prisma.communicationInteraction.findMany({
      where: {
        tenant_id: tenantId,
        associations: {
          some: {
            tenant_id: tenantId,
            subject_type: 'talent_record' satisfies CommunicationSubjectType,
            subject_id: talentId,
            relation_type: 'subject' satisfies CommunicationRelationType,
          },
        },
        ...keyset,
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    })) as InteractionRow[];
  }

  // COMM-C2A — the derived voice-evidence intersection read. Returns the voice
  // interactions associated to BOTH the Talent (subject) AND the Requisition
  // (regarding), newest-first, each with its disposition history (newest-first).
  // Reads Communications' OWN rows only (no cross-domain join). The composition
  // root derives the provider-neutral attempt/two-way/strength projection from
  // this; the repository stays vendor- and Lane-2-agnostic.
  async findVoiceEvidenceInteractions(
    tenantId: string,
    talentId: string,
    requisitionId: string,
  ): Promise<VoiceEvidenceInteractionRow[]> {
    const rows = await this.prisma.communicationInteraction.findMany({
      where: {
        tenant_id: tenantId,
        channel: 'voice' satisfies CommunicationChannel,
        AND: [
          {
            associations: {
              some: {
                tenant_id: tenantId,
                subject_type: 'talent_record' satisfies CommunicationSubjectType,
                subject_id: talentId,
                relation_type: 'subject' satisfies CommunicationRelationType,
              },
            },
          },
          {
            associations: {
              some: {
                tenant_id: tenantId,
                subject_type: 'requisition' satisfies CommunicationSubjectType,
                subject_id: requisitionId,
                relation_type: 'regarding' satisfies CommunicationRelationType,
              },
            },
          },
        ],
      },
      select: {
        id: true,
        status: true,
        created_at: true,
        dispositions: {
          select: { disposition: true, dispositioned_at: true },
          orderBy: { dispositioned_at: 'desc' },
        },
      },
      orderBy: { created_at: 'desc' },
    });
    return rows as VoiceEvidenceInteractionRow[];
  }

  // ---- CommunicationDisposition ----

  async recordDisposition(args: {
    tenant_id: string;
    interaction_id: string;
    disposition: CommunicationDispositionOutcome;
    notes?: string | null;
    dispositioned_by_id: string;
  }): Promise<{ id: string }> {
    return await this.prisma.communicationDisposition.create({
      data: {
        tenant_id: args.tenant_id,
        interaction_id: args.interaction_id,
        disposition: args.disposition,
        notes: args.notes ?? null,
        dispositioned_by_id: args.dispositioned_by_id,
      },
      select: { id: true },
    });
  }

  async listDispositions(
    tenantId: string,
    interactionId: string,
  ): Promise<
    Array<{
      id: string;
      disposition: CommunicationDispositionOutcome;
      notes: string | null;
      dispositioned_at: Date;
    }>
  > {
    return (await this.prisma.communicationDisposition.findMany({
      where: { tenant_id: tenantId, interaction_id: interactionId },
      select: { id: true, disposition: true, notes: true, dispositioned_at: true },
      // COMM-B7 — (dispositioned_at DESC, id DESC) for stable history ordering.
      orderBy: [{ dispositioned_at: 'desc' }, { id: 'desc' }],
    })) as Array<{
      id: string;
      disposition: CommunicationDispositionOutcome;
      notes: string | null;
      dispositioned_at: Date;
    }>;
  }

  // ---- CommunicationProviderEvent (idempotent inbox) ----

  /**
   * Idempotent-by-constraint record. Insert-or-noop against
   * UNIQUE(tenant_id, integration_connection_id, provider_event_key), then read
   * back. `reserved` is true only for the insert that won (R-COMM-WEBHOOK).
   */
  async recordProviderEvent(args: {
    tenant_id: string;
    integration_connection_id: string;
    provider_event_key: string;
    event_type: string;
    interaction_id?: string | null;
    payload_reference?: string | null;
  }): Promise<{ reserved: boolean; row: { id: string; status: string } }> {
    const res = await this.prisma.communicationProviderEvent.createMany({
      data: [
        {
          tenant_id: args.tenant_id,
          integration_connection_id: args.integration_connection_id,
          provider_event_key: args.provider_event_key,
          event_type: args.event_type,
          interaction_id: args.interaction_id ?? null,
          payload_reference: args.payload_reference ?? null,
        },
      ],
      skipDuplicates: true,
    });
    const row = (await this.prisma.communicationProviderEvent.findFirst({
      where: {
        tenant_id: args.tenant_id,
        integration_connection_id: args.integration_connection_id,
        provider_event_key: args.provider_event_key,
      },
      select: { id: true, status: true },
    })) as { id: string; status: string };
    return { reserved: res.count === 1, row };
  }

  async findProviderEventByKey(
    tenantId: string,
    connectionId: string,
    key: string,
  ): Promise<{ id: string; status: string } | null> {
    return (await this.prisma.communicationProviderEvent.findFirst({
      where: {
        tenant_id: tenantId,
        integration_connection_id: connectionId,
        provider_event_key: key,
      },
      select: { id: true, status: true },
    })) as { id: string; status: string } | null;
  }

  // ---- CommunicationProviderIdentity ----

  async mapProviderIdentity(args: {
    tenant_id: string;
    integration_connection_id: string;
    recruiter_id: string;
    provider_user_id: string;
    provider_extension_id?: string | null;
    display_phone_number?: string | null;
    extension?: string | null;
    voice_enabled?: boolean;
    status?: CommunicationProviderIdentityStatus;
  }): Promise<{ id: string }> {
    return await this.prisma.communicationProviderIdentity.create({
      data: {
        tenant_id: args.tenant_id,
        integration_connection_id: args.integration_connection_id,
        recruiter_id: args.recruiter_id,
        provider_user_id: args.provider_user_id,
        provider_extension_id: args.provider_extension_id ?? null,
        display_phone_number: args.display_phone_number ?? null,
        extension: args.extension ?? null,
        voice_enabled: args.voice_enabled ?? false,
        status: args.status ?? 'active',
      },
      select: { id: true },
    });
  }

  async findProviderIdentityForRecruiter(
    tenantId: string,
    connectionId: string,
    recruiterId: string,
  ): Promise<{ id: string; provider_user_id: string; status: CommunicationProviderIdentityStatus } | null> {
    return (await this.prisma.communicationProviderIdentity.findFirst({
      where: {
        tenant_id: tenantId,
        integration_connection_id: connectionId,
        recruiter_id: recruiterId,
      },
      select: { id: true, provider_user_id: true, status: true },
    })) as { id: string; provider_user_id: string; status: CommunicationProviderIdentityStatus } | null;
  }

  /**
   * Connection-agnostic provider-identity lookup for a recruiter (tenant-safe).
   * The connection is account-level; until a connection is bound (COMM-B3) the
   * `me/provider-identity` read resolves the recruiter mapping by (tenant,
   * recruiter) alone. Returns the most-recently-updated mapping, or null.
   */
  async findProviderIdentityByRecruiter(
    tenantId: string,
    recruiterId: string,
  ): Promise<ProviderIdentityView | null> {
    return (await this.prisma.communicationProviderIdentity.findFirst({
      where: { tenant_id: tenantId, recruiter_id: recruiterId },
      orderBy: { updated_at: 'desc' },
      select: {
        recruiter_id: true,
        provider_user_id: true,
        provider_extension_id: true,
        display_phone_number: true,
        extension: true,
        voice_enabled: true,
        sms_enabled: true,
        status: true,
      },
    })) as ProviderIdentityView | null;
  }

  /**
   * COMM-B3 — admin list of the provider-identity mappings on a connection
   * (tenant-safe). Used by GET /v1/communications/provider-identities.
   */
  async listProviderIdentitiesForConnection(
    tenantId: string,
    connectionId: string,
  ): Promise<ProviderIdentityView[]> {
    return (await this.prisma.communicationProviderIdentity.findMany({
      where: { tenant_id: tenantId, integration_connection_id: connectionId },
      orderBy: { updated_at: 'desc' },
      select: {
        recruiter_id: true,
        provider_user_id: true,
        provider_extension_id: true,
        display_phone_number: true,
        extension: true,
        voice_enabled: true,
        sms_enabled: true,
        status: true,
      },
    })) as ProviderIdentityView[];
  }

  /**
   * COMM-B3 — UPSERT a recruiter's provider-identity mapping on a connection
   * (intentional admin bind/rebind). Keyed on the @@unique(integration_connection_id,
   * recruiter_id); re-mapping a recruiter to a different provider user updates in
   * place. The @@unique(integration_connection_id, provider_user_id) still guards
   * against two recruiters claiming the same provider user (surfaces as a Prisma
   * P2002 the caller maps to COMMUNICATION_PROVIDER_USER_ALREADY_MAPPED).
   */
  async upsertProviderIdentity(args: {
    tenant_id: string;
    integration_connection_id: string;
    recruiter_id: string;
    provider_user_id: string;
    provider_extension_id?: string | null;
    display_phone_number?: string | null;
    extension?: string | null;
    voice_enabled?: boolean;
    sms_enabled?: boolean;
    status?: CommunicationProviderIdentityStatus;
  }): Promise<ProviderIdentityView> {
    const common = {
      provider_user_id: args.provider_user_id,
      provider_extension_id: args.provider_extension_id ?? null,
      display_phone_number: args.display_phone_number ?? null,
      extension: args.extension ?? null,
      voice_enabled: args.voice_enabled ?? false,
      sms_enabled: args.sms_enabled ?? false,
      status: args.status ?? 'active',
    };
    return (await this.prisma.communicationProviderIdentity.upsert({
      where: {
        integration_connection_id_recruiter_id: {
          integration_connection_id: args.integration_connection_id,
          recruiter_id: args.recruiter_id,
        },
      },
      create: {
        tenant_id: args.tenant_id,
        integration_connection_id: args.integration_connection_id,
        recruiter_id: args.recruiter_id,
        ...common,
      },
      update: common,
      select: {
        recruiter_id: true,
        provider_user_id: true,
        provider_extension_id: true,
        display_phone_number: true,
        extension: true,
        voice_enabled: true,
        sms_enabled: true,
        status: true,
      },
    })) as ProviderIdentityView;
  }
}

export interface ProviderIdentityView {
  recruiter_id: string;
  provider_user_id: string;
  provider_extension_id: string | null;
  display_phone_number: string | null;
  extension: string | null;
  voice_enabled: boolean;
  sms_enabled: boolean;
  status: CommunicationProviderIdentityStatus;
}
