import { Injectable } from '@nestjs/common';

import type {
  JourneyStageView,
} from './dto/journey-stage.view.js';
import { PrismaService } from './prisma/prisma.service.js';

// Lane 2 / L2-F (F3) — the owner-sourced journey-stage projection. Derives the
// interview + client-decision stages the Pipeline formerly approximated,
// reading ONLY the ClientSelectionProcess/InterviewSession owner (NO Pipeline import —
// I15/SB-7; both same ATS cluster). A stage is emitted ONLY when the owner substrate
// exists, so it is provably owner-sourced: delete the process/session and the stage
// disappears (F3.3 neg-control). This is the primitive the L2-H unified journey
// read-model consumes; F3 lands + proves it, it exposes no HTTP route of its own.
@Injectable()
export class JourneyProjectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Derive the owner-attributed journey stages for one ClientSelectionProcess:
  //   INTERVIEW       — emitted iff ≥1 InterviewSession exists (occurred_at = earliest
  //                     scheduled_at; the interview truth is the session).
  //   CLIENT_DECLINED — emitted iff the process is in the DECLINED terminal state
  //                     (occurred_at = updated_at; the client-decline truth is the owner).
  // Returns [] when the process does not exist in-tenant (owner-sourced: no owner → no
  // stage), regardless of any legacy Pipeline row.
  async deriveJourneyStages(args: {
    tenant_id: string;
    client_selection_process_id: string;
  }): Promise<JourneyStageView[]> {
    const process = await this.prisma.clientSelectionProcess.findFirst({
      where: { tenant_id: args.tenant_id, id: args.client_selection_process_id },
    });
    if (process === null) {
      return [];
    }

    const stages: JourneyStageView[] = [];

    const firstSession = await this.prisma.interviewSession.findFirst({
      where: {
        tenant_id: args.tenant_id,
        client_selection_process_id: args.client_selection_process_id,
      },
      orderBy: { scheduled_at: 'asc' },
    });
    if (firstSession !== null) {
      stages.push({
        stage: 'INTERVIEW',
        source: 'client-selection',
        client_selection_process_id: args.client_selection_process_id,
        occurred_at: (firstSession as { scheduled_at: Date }).scheduled_at.toISOString(),
      });
    }

    if ((process as { state: string }).state === 'DECLINED') {
      stages.push({
        stage: 'CLIENT_DECLINED',
        source: 'client-selection',
        client_selection_process_id: args.client_selection_process_id,
        occurred_at: (process as { updated_at: Date }).updated_at.toISOString(),
      });
    }

    return stages;
  }
}
