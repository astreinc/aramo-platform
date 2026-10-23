import { Controller, Get, HttpCode, HttpException, HttpStatus } from '@nestjs/common';
import { IntelligenceHealthService } from '@aramo/intelligence-core';
import type { IntelligenceHealthResponse } from '@aramo/intelligence-contracts';

// GET /health — liveness + TI database reachability. 200 when the database
// answers, 503 (same body shape) when it does not, so the container healthcheck
// and the boot smoke see a degraded database as unhealthy.
@Controller('health')
export class HealthController {
  constructor(private readonly health: IntelligenceHealthService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async get(): Promise<IntelligenceHealthResponse> {
    const result = await this.health.check();
    if (result.status !== 'ok') throw new HttpException(result, HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
