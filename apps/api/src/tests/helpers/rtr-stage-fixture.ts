import type { PipelineRepository } from '@aramo/pipeline';

// Pipeline & RTR Recon Remediation Directive v1.0 §2 R2 (DEF-7; RTR-1 AC-21) — the RTR orchestrator
// requires the Talent's live episode on the requisition to be at Talent responded or later. The ONE
// shared stand-in for hand-wired `new RtrOrchestratorService(…, pipelines)` specs that are not ABOUT
// the stage rule: the episode is at the given stage (default talent_responded); null = not on the
// requisition. The real stage rule is proven in r2-rtr-integrity.integration.spec.ts.
export function episodeReaderAt(status: string | null = 'talent_responded'): PipelineRepository {
  return {
    findLiveEpisode: async () => (status === null ? null : { id: 'episode', status, version: 0 }),
  } as unknown as PipelineRepository;
}
