import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { CommunicationsRepository, VoiceProviderRegistry } from '@aramo/communications';

import type {
  CommunicationCapabilitiesDto,
  CommunicationInteractionViewDto,
  CommunicationProviderIdentityDto,
} from './dto/communications.dto.js';

// COMM-B2 — apps/api orchestration for the Communications/Voice read skeleton.
// Lives at the composition root (NOT libs/communications) so no
// communications→consent/identity nx edge is created; the B5 call orchestration
// will invoke ConsentService.check here too. Reads are tenant-safe: a cross-tenant
// id is a NOT-FOUND, never an info leak.
@Injectable()
export class CommunicationsApiService {
  constructor(
    private readonly repo: CommunicationsRepository,
    private readonly providers: VoiceProviderRegistry,
  ) {}

  /**
   * Provider-neutral capability descriptor. B2 resolves the single configured
   * provider from the registry (the fake in composition/tests); COMM-B3 replaces
   * this with per-tenant IntegrationConnection resolution. No provider is
   * configured -> COMMUNICATION_PROVIDER_NOT_CONFIGURED (409).
   */
  async getCapabilities(tenantId: string, requestId: string): Promise<CommunicationCapabilitiesDto> {
    void tenantId; // per-tenant connection resolution lands in COMM-B3
    const provider = this.providers.list()[0];
    if (provider === undefined) {
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
