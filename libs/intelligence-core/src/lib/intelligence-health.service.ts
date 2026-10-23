import { Injectable } from '@nestjs/common';
import { INTELLIGENCE_SERVICE_NAME, type IntelligenceHealthResponse } from '@aramo/intelligence-contracts';

import { IntelligencePrismaService } from './prisma/intelligence-prisma.service.js';

@Injectable()
export class IntelligenceHealthService {
  constructor(private readonly prisma: IntelligencePrismaService) {}

  async check(): Promise<IntelligenceHealthResponse> {
    const ok = await this.prisma.ping();
    return {
      service: INTELLIGENCE_SERVICE_NAME,
      status: ok ? 'ok' : 'degraded',
      database: ok ? 'ok' : 'unavailable',
    };
  }
}
