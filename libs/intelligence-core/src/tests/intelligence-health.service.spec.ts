import { describe, expect, it } from 'vitest';

import { IntelligenceHealthService, type IntelligencePrismaService } from '../index.js';

function serviceWith(ping: boolean): IntelligenceHealthService {
  const prisma = { ping: async () => ping } as unknown as IntelligencePrismaService;
  return new IntelligenceHealthService(prisma);
}

describe('IntelligenceHealthService', () => {
  it('reports ok when the TI database answers', async () => {
    await expect(serviceWith(true).check()).resolves.toEqual({
      service: 'talent-intelligence-service',
      status: 'ok',
      database: 'ok',
    });
  });

  it('reports degraded when the TI database does not answer', async () => {
    await expect(serviceWith(false).check()).resolves.toEqual({
      service: 'talent-intelligence-service',
      status: 'degraded',
      database: 'unavailable',
    });
  });
});
