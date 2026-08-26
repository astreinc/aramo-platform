import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { CommunicationsRepository, VoiceProviderRegistry } from '@aramo/communications';
import { IntegrationConnectionService } from '@aramo/integration';

import type {
  CommunicationCapabilitiesDto,
  CommunicationInteractionViewDto,
  CommunicationProviderIdentityDto,
} from './dto/communications.dto.js';

// COMM-B2/B3 — apps/api orchestration for the Communications/Voice read surface.
// Lives at the composition root (NOT libs/communications) so no
// communications→consent/integration/identity nx edge is created; the tenant→
// provider-connection resolution is a composition-root read into @aramo/integration.
// Reads are tenant-safe: a cross-tenant id is a NOT-FOUND, never an info leak.
//
// COMM-V1 canonical provider key (locked). Kept here (composition root), NOT in
// the neutral communications domain.
const ZOOM_PHONE_PROVIDER_KEY = 'zoom_phone';

@Injectable()
export class CommunicationsApiService {
  constructor(
    private readonly repo: CommunicationsRepository,
    private readonly providers: VoiceProviderRegistry,
    private readonly connections: IntegrationConnectionService,
  ) {}

  /**
   * COMM-B3 — per-tenant capability descriptor. Resolves the tenant's USABLE
   * (configured|active) `zoom_phone` IntegrationConnection, then the registered
   * adapter for that connection's provider_key, and returns THAT adapter's
   * capabilities. NEVER falls back to a default/fake provider. No usable
   * connection (or no registered adapter) -> COMMUNICATION_PROVIDER_NOT_CONFIGURED
   * (409).
   */
  async getCapabilities(tenantId: string, requestId: string): Promise<CommunicationCapabilitiesDto> {
    const connection = await this.connections.findConnectionByProviderKey(
      tenantId,
      ZOOM_PHONE_PROVIDER_KEY,
    );
    const provider =
      connection === null ? null : this.providers.resolve(connection.provider_key);
    if (provider === null) {
      throw new AramoError(
        'COMMUNICATION_PROVIDER_NOT_CONFIGURED',
        'No communications provider is configured for this tenant',
        409,
        { requestId },
      );
    }
    const caps = provider.getCapabilities();
    return {
      provider_key: provider.providerKey(),
      capabilities: {
        voice: caps.voice,
        ...(caps.sms === undefined ? {} : { sms: caps.sms }),
        ...(caps.recording === undefined ? {} : { recording: caps.recording }),
        ...(caps.transcript === undefined ? {} : { transcript: caps.transcript }),
      },
    };
  }

  /**
   * The caller's own provider-identity mapping (connection-agnostic in B2). No
   * mapping -> COMMUNICATION_USER_NOT_MAPPED (404).
   */
  async getMyProviderIdentity(
    tenantId: string,
    recruiterId: string,
    requestId: string,
  ): Promise<CommunicationProviderIdentityDto> {
    const row = await this.repo.findProviderIdentityByRecruiter(tenantId, recruiterId);
    if (row === null) {
      throw new AramoError(
        'COMMUNICATION_USER_NOT_MAPPED',
        'The caller has no communications provider identity mapping',
        404,
        { requestId },
      );
    }
    return row;
  }

  /**
   * COMM-B3 — admin list of the tenant's provider-identity mappings (on the
   * tenant's zoom_phone connection). Authorized by integration:read. No usable
   * connection -> COMMUNICATION_PROVIDER_NOT_CONFIGURED (409).
   */
  async listProviderIdentities(
    tenantId: string,
    requestId: string,
  ): Promise<CommunicationProviderIdentityDto[]> {
    const connection = await this.requireProviderConnection(tenantId, requestId);
    return this.repo.listProviderIdentitiesForConnection(tenantId, connection.id);
  }

  /**
   * COMM-B3 — admin UPSERT a recruiter's provider-identity mapping on the tenant's
   * zoom_phone connection (intentional bind/rebind). Authorized by integration:write.
   * No usable connection -> 409 COMMUNICATION_PROVIDER_NOT_CONFIGURED. A provider
   * user already claimed by a different recruiter -> 409
   * COMMUNICATION_PROVIDER_USER_ALREADY_MAPPED.
   */
  async upsertProviderIdentity(
    tenantId: string,
    recruiterId: string,
    body: {
      provider_user_id: string;
      provider_extension_id?: string | null;
      display_phone_number?: string | null;
      extension?: string | null;
      voice_enabled?: boolean;
      sms_enabled?: boolean;
      status?: CommunicationProviderIdentityDto['status'];
    },
    requestId: string,
  ): Promise<CommunicationProviderIdentityDto> {
    const connection = await this.requireProviderConnection(tenantId, requestId);
    try {
      return await this.repo.upsertProviderIdentity({
        tenant_id: tenantId,
        integration_connection_id: connection.id,
        recruiter_id: recruiterId,
        ...body,
      });
    } catch (err) {
      if (isProviderUserUniqueViolation(err)) {
        throw new AramoError(
          'COMMUNICATION_PROVIDER_USER_ALREADY_MAPPED',
          'That provider user is already mapped to a different recruiter on this connection',
          409,
          { requestId, details: { provider_user_id: body.provider_user_id } },
        );
      }
      throw err;
    }
  }

  /** Resolve the tenant's usable zoom_phone connection or 409 PROVIDER_NOT_CONFIGURED. */
  private async requireProviderConnection(
    tenantId: string,
    requestId: string,
  ): Promise<{ id: string; provider_key: string }> {
    const connection = await this.connections.findConnectionByProviderKey(
      tenantId,
      ZOOM_PHONE_PROVIDER_KEY,
    );
    if (connection === null) {
      throw new AramoError(
        'COMMUNICATION_PROVIDER_NOT_CONFIGURED',
        'No communications provider is configured for this tenant',
        409,
        { requestId },
      );
    }
    return connection;
  }

  /** A communication interaction by id, tenant-scoped. Null when absent/cross-tenant. */
  async getInteraction(
    tenantId: string,
    interactionId: string,
  ): Promise<CommunicationInteractionViewDto | null> {
    const row = await this.repo.findInteractionForTenant(tenantId, interactionId);
    if (row === null) return null;
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
}

/**
 * True iff `err` is a Prisma unique-constraint violation (P2002). On the mapping
 * upsert the (integration_connection_id, recruiter_id) unique is the upsert TARGET
 * (matched → update), so the only unique that can still fire is
 * (integration_connection_id, provider_user_id). Handles both the standard
 * P2002 code and the Prisma-7/PrismaPg driver-adapter shape (raw violation at
 * driverAdapterError.cause.originalMessage).
 */
function isProviderUserUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    code?: string;
    meta?: { driverAdapterError?: { cause?: { originalMessage?: string } } };
  };
  if (e.code === 'P2002') return true;
  const raw = e.meta?.driverAdapterError?.cause?.originalMessage ?? '';
  return raw.includes('provider_user_id');
}
