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
  ): Promise<Array<{ id: string; disposition: CommunicationDispositionOutcome; notes: string | null }>> {
    return (await this.prisma.communicationDisposition.findMany({
      where: { tenant_id: tenantId, interaction_id: interactionId },
      select: { id: true, disposition: true, notes: true },
      orderBy: { dispositioned_at: 'desc' },
    })) as Array<{ id: string; disposition: CommunicationDispositionOutcome; notes: string | null }>;
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
