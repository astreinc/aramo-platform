import { Injectable } from '@nestjs/common';
import { CompanyRepository } from '@aramo/company';
import { InterviewSessionRepository } from '@aramo/client-selection';
import { CommunicationsRepository } from '@aramo/communications';
import { ActivityRepository } from '@aramo/activity';
import { ConsentRepository } from '@aramo/consent';
import { DocumentsRepository } from '@aramo/documents';
import { IdentityService } from '@aramo/identity';
import { PipelineRepository } from '@aramo/pipeline';
import { RequisitionRepository } from '@aramo/requisition';
import { TalentExtractionService } from '@aramo/talent-extraction';
import { TalentRecordRepository } from '@aramo/talent-record';
import { TaskRepository } from '@aramo/task';

import { DossierService } from '../talent-identity/dossier.service.js';
import { TalentJourneyReadService } from '../talent-journey/talent-journey-read.service.js';

import type {
  ActivityRow,
  CommunicationRow,
  ConsentSummaryValue,
  DocumentRow,
  EpisodeRow,
  IdentityOutcomeRow,
  InterviewScheduleRow,
  LastContactRow,
  RequisitionSummaryRow,
  Talent360ActorContext,
  Talent360ReadPort,
  TalentCoreRow,
  TaskRow,
  WorkHistoryRow,
} from './talent-360.ports.js';
import type { TalentRequisitionJourney } from '../talent-journey/dto/talent-journey.view.js';

// The concrete Talent360ReadPort — the ONLY layer that touches the real domain
// repositories/services. It maps each aggregate's view down to the narrow
// Talent-360 row shape and does no derivation (that lives in Talent360Service).
// Every list is bounded; the visibility set is passed through untouched
// (server-resolved, never client-supplied — directive §24). Name resolution is
// best-effort reference data (missing ids fall back to null downstream).
const EPISODE_LIMIT = 200;
const RECENT_ACTIVITY_LIMIT = 40;

// The fixed recruiter-facing advisory copy (directive §14 — an OUTCOME, never
// the internal advisory model). One pending duplicate advisory is surfaced.
const DUPLICATE_ADVISORY_LABEL = 'Possible duplicate needs review';

@Injectable()
export class Talent360ReadAdapter implements Talent360ReadPort {
  constructor(
    private readonly talent: TalentRecordRepository,
    private readonly pipelines: PipelineRepository,
    private readonly journey: TalentJourneyReadService,
    private readonly requisitions: RequisitionRepository,
    private readonly companies: CompanyRepository,
    private readonly identity: IdentityService,
    private readonly interviews: InterviewSessionRepository,
    private readonly communications: CommunicationsRepository,
    private readonly activities: ActivityRepository,
    private readonly tasks: TaskRepository,
    private readonly documents: DocumentsRepository,
    private readonly consent: ConsentRepository,
    private readonly dossier: DossierService,
    private readonly extraction: TalentExtractionService,
  ) {}

  async loadTalent(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<TalentCoreRow | null> {
    const v = await this.talent.findById({ tenant_id: ctx.tenant_id, id: talent_id });
    if (v === null) return null;
    return {
      id: v.id,
      first_name: v.first_name,
      last_name: v.last_name,
      title: v.title,
      city: v.city,
      state: v.state,
      email1: v.email1,
      phone_cell: v.phone_cell,
      work_authorization: v.work_authorization ?? null,
      desired_pay: v.desired_pay,
      current_pay: v.current_pay,
      engagement_type: v.engagement_type ?? null,
      availability_status: v.availability_status ?? null,
      date_available: v.date_available,
      key_skills: v.key_skills,
      source: v.source,
      owner_id: v.owner_id,
      created_at: v.created_at,
      recruiting_ready: v.recruiting_ready ?? false,
      record_status: v.record_status === 'superseded' ? 'superseded' : 'live',
      superseded_by_record_id: v.superseded_by_record_id ?? null,
    };
  }

  async listEpisodes(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<readonly EpisodeRow[]> {
    const rows = await this.pipelines.listForActor({
      tenant_id: ctx.tenant_id,
      visible_requisition_ids: ctx.visible_requisition_ids,
      talent_record_id: talent_id,
      limit: EPISODE_LIMIT,
    });
    return rows.map((p) => ({
      id: p.id,
      requisition_id: p.requisition_id,
      status: p.status,
      created_at: p.created_at,
      updated_at: p.updated_at,
    }));
  }

  async composeJourney(
    ctx: Talent360ActorContext,
    pipeline_id: string,
  ): Promise<TalentRequisitionJourney> {
    return this.journey.getJourney({
      tenant_id: ctx.tenant_id,
      pipeline_id,
      visible_requisition_ids: ctx.visible_requisition_ids,
      requestId: ctx.request_id,
    });
  }

  async resolveRequisitions(
    ctx: Talent360ActorContext,
    requisition_ids: readonly string[],
  ): Promise<ReadonlyMap<string, RequisitionSummaryRow>> {
    if (requisition_ids.length === 0) return new Map();
    const rows = await this.requisitions.findSummariesByIds({
      tenant_id: ctx.tenant_id,
      ids: requisition_ids,
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  async resolveCompanyNames(
    ctx: Talent360ActorContext,
    company_ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (company_ids.length === 0) return new Map();
    return this.companies.findNamesByIds({ tenant_id: ctx.tenant_id, ids: company_ids });
  }

  async resolveUserNames(
    ctx: Talent360ActorContext,
    user_ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Set(user_ids.filter((id) => id.length > 0))];
    if (unique.length === 0) return new Map();
    // Best-effort low-sensitivity directory resolution (id → display_name),
    // including departed users so ownership/authorship history still renders.
    // Name resolution NEVER blocks the page — on any failure the map is empty
    // and the caller falls back to null (mirrors the FE resolveUserNames
    // graceful degrade + My Desk's section-level resilience, directive §28).
    try {
      const items = await this.identity.listTenantUserDirectory({
        tenant_id: ctx.tenant_id,
        user_ids: unique,
      });
      const out = new Map<string, string>();
      for (const u of items) {
        if (u.display_name !== null) out.set(u.user_id, u.display_name);
      }
      return out;
    } catch {
      return new Map();
    }
  }

  async findLatestInterview(
    ctx: Talent360ActorContext,
    client_selection_process_id: string,
  ): Promise<InterviewScheduleRow | null> {
    const iv = await this.interviews.findLatestByProcess({
      tenant_id: ctx.tenant_id,
      client_selection_process_id,
    });
    if (iv === null) return null;
    return {
      scheduled_at: iv.scheduled_at,
      state: iv.state,
      interview_type: iv.interview_type,
      round: iv.round,
    };
  }

  async lastContact(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<LastContactRow | null> {
    const rows = await this.communications.listInteractionsForTalentKeyset(
      ctx.tenant_id,
      talent_id,
      1,
    );
    const top = rows[0];
    if (top === undefined) return null;
    return { at: toIso(top.created_at), channel: top.channel };
  }

  async listRecentCommunications(
    ctx: Talent360ActorContext,
    talent_id: string,
    limit: number,
  ): Promise<readonly CommunicationRow[]> {
    const rows = await this.communications.listInteractionsForTalentKeyset(
      ctx.tenant_id,
      talent_id,
      limit,
    );
    return rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      direction: r.direction,
      created_at: toIso(r.created_at),
    }));
  }

  async listRecentActivity(
    ctx: Talent360ActorContext,
    talent_id: string,
    limit: number,
  ): Promise<readonly ActivityRow[]> {
    const rows = await this.activities.listForActor({
      tenant_id: ctx.tenant_id,
      actor_user_id: ctx.user_id,
      visibility: ctx.visibility,
      visible_requisition_ids: ctx.visible_requisition_ids,
      // talent_record subject reads are pool-open (buildActivityVisibilityWhere);
      // the subject filter below constrains to THIS talent, so pipeline
      // visibility does not further narrow a talent-subject read.
      visible_pipeline_ids: null,
      subject_type: 'talent_record',
      subject_id: talent_id,
      limit,
    });
    return rows.map((a) => ({
      id: a.id,
      type: a.type,
      notes: a.notes,
      created_by_id: a.created_by_id,
      created_at: a.created_at,
    }));
  }

  async listTasks(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<readonly TaskRow[]> {
    const rows = await this.tasks.listForOwner({
      tenant_id: ctx.tenant_id,
      owner_type: 'talent_record',
      owner_id: talent_id,
      vis: {
        visibility: ctx.visibility,
        visible_requisition_ids: ctx.visible_requisition_ids,
        visible_contact_ids: ctx.visible_contact_ids,
      },
    });
    return rows.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      due_date: t.due_date,
    }));
  }

  async listDocuments(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<readonly DocumentRow[]> {
    return this.documents.listForTalent({
      tenant_id: ctx.tenant_id,
      talent_record_id: talent_id,
    });
  }

  async loadConsentSummary(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<ConsentSummaryValue> {
    const map = await this.consent.findContactingConsentSummaryForTalentIds({
      tenant_id: ctx.tenant_id,
      talent_record_ids: [talent_id],
    });
    // No grant means no permission — the consent authority's fail-closed default.
    return map.get(talent_id) ?? 'do_not_contact';
  }

  async loadIdentityOutcomes(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<IdentityOutcomeRow> {
    const head = await this.dossier.getDossier(ctx.tenant_id, talent_id);
    const confirmed = (kind: string): boolean =>
      head.verifications.some((v) => v.anchor_kind === kind && v.status === 'CONFIRMED');
    const advisoryId = head.advisory_pointers[0] ?? null;
    return {
      primary_email_confirmed: confirmed('EMAIL'),
      mobile_confirmed: confirmed('PHONE'),
      advisory:
        advisoryId === null
          ? null
          : { advisory_id: advisoryId, label: DUPLICATE_ADVISORY_LABEL },
    };
  }

  async listWorkHistory(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<readonly WorkHistoryRow[]> {
    let rows: Awaited<ReturnType<TalentExtractionService['listDeclaredWorkHistory']>>;
    try {
      rows = await this.extraction.listDeclaredWorkHistory({
        talent_id,
        tenant_id: ctx.tenant_id,
      });
    } catch {
      // Work history is a profile DETAIL — a declared-history read hiccup must
      // not blank the whole page; degrade to none (directive §28 resilience).
      return [];
    }
    return rows.map((w) => ({
      employer_name: w.employer_name,
      role_title: w.role_title,
      start_date: w.start_date,
      end_date: w.end_date,
      employment_type: w.employment_type,
      source: w.source,
    }));
  }
}

// The communications keyset read returns raw rows whose created_at is a Date;
// every other adapter surface already emits ISO strings.
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

// Expose the recent-activity default so the service and adapter agree on the
// bounded window (directive §18 — the Overview shows a recent window, not the
// full history).
export const TALENT_360_RECENT_ACTIVITY_LIMIT = RECENT_ACTIVITY_LIMIT;
