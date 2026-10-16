import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { TalentIntakeConsumerModule } from '../talent-intake-consumer/talent-intake-consumer.module.js';
import { TalentIntakeWorkerModule } from '../talent-intake-consumer/talent-intake-worker.module.js';
import { LlmProviderResolutionModule } from '../tenant-llm/llm-provider-resolution.module.js';

// TENANT-LLM-2 §2.1/§4.1 — the background intake contexts (worker, redrive, Lambda)
// are built WITHOUT AppModule, so they must import the tenant provider resolver
// themselves; otherwise résumé extraction ignores llm.active_provider.
function importsOf(mod: unknown): unknown[] {
  return (Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod as object) as unknown[] | undefined) ?? [];
}

function reaches(root: unknown, target: unknown, seen = new Set<unknown>()): boolean {
  if (root === target) return true;
  if (seen.has(root)) return false;
  seen.add(root);
  return importsOf(root).some((m) => reaches(m, target, seen));
}

describe('talent intake contexts route to the tenant-selected LLM provider', () => {
  it('the consumer module (Lambda handler root) imports LlmProviderResolutionModule', () => {
    expect(importsOf(TalentIntakeConsumerModule)).toContain(LlmProviderResolutionModule);
  });

  it('the singlebox worker / redrive root reaches it too', () => {
    expect(reaches(TalentIntakeWorkerModule, LlmProviderResolutionModule)).toBe(true);
  });
});
