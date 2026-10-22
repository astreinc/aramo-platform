import { Inject, Injectable } from '@nestjs/common';
import { CompanyRepository } from '@aramo/company';
import { InterviewSessionRepository } from '@aramo/client-selection';
import { CommunicationsRepository } from '@aramo/communications';
import { ActivityRepository } from '@aramo/activity';
import { ConsentRepository } from '@aramo/consent';
import { DocumentsRepository, type DocumentStoragePort } from '@aramo/documents';
import { IdentityService } from '@aramo/identity';
import { PipelineRepository } from '@aramo/pipeline';
import { TalentEducationRepository } from '@aramo/talent-evidence';
import { TalentExtractionService } from '@aramo/talent-extraction';
import { TaskRepository } from '@aramo/task';
import {
  AUTHORIZED_TALENT_RETRIEVAL_READ_PORT,
  REQUISITION_CONTEXT_READ_PORT,
  TALENT_DOSSIER_READ_PORT,
  type AuthorizedTalentRetrievalReadPort,
  type RequisitionContextReadPort,
  type TalentDossierReadPort,
} from '@aramo/talent-intelligence';

import { TalentJourneyReadService } from '../talent-journey/talent-journey-read.service.js';
import type { TalentRequisitionJourney } from '../talent-journey/dto/talent-journey.view.js';

import type {
  ActivityRow,
  CommunicationPreviewRow,
  CommunicationRow,
  ConsentSummaryValue,
  DocumentContentRow,
  DocumentRow,
  EpisodeRow,
  IdentityOutcomeRow,
  InterviewScheduleRow,
  LastContactRow,
  PipelineActivityRow,
  RequisitionSummaryRow,
  Talent360ActorContext,
  Talent360ReadPort,
  TalentCoreRow,
  TaskRow,
  WorkHistoryRow,
  EducationRow,
} from './talent-360.ports.js';
import { TALENT_360_DOCUMENT_STORAGE } from './talent-360.ports.js';
import { toEducationRow } from './education-view.js';

// The concrete Talent360ReadPort — the ONLY layer that touches the real domain
// repositories/services. It maps each aggregate's view down to the narrow
// Talent-360 row shape and does no derivation (that lives in Talent360Service).
// Every list is bounded; the visibility set is passed through untouched
// (server-resolved, never client-supplied — directive §24). Name resolution is
// best-effort reference data (missing ids fall back to null downstream).
const EPISODE_LIMIT = 200;
const RECENT_ACTIVITY_LIMIT = 40;
// The Activity type PipelineRepository writes for every stage change.
const PIPELINE_STATUS_CHANGE = 'pipeline_status_change';

// The fixed recruiter-facing advisory copy (directive §14 — an OUTCOME, never
// the internal advisory model). One pending duplicate advisory is surfaced.
const DUPLICATE_ADVISORY_LABEL = 'Possible duplicate needs review';

@Injectable()
export class Talent360ReadAdapter implements Talent360ReadPort {
  constructor(
    @Inject(AUTHORIZED_TALENT_RETRIEVAL_READ_PORT)
    private readonly talentPort: AuthorizedTalentRetrievalReadPort,
    private readonly pipelines: PipelineRepository,
    private readonly journey: TalentJourneyReadService,
    @Inject(REQUISITION_CONTEXT_READ_PORT)
    private readonly requisitionContextPort: RequisitionContextReadPort,
    private readonly companies: CompanyRepository,
    private readonly identity: IdentityService,
    private readonly interviews: InterviewSessionRepository,
    private readonly communications: CommunicationsRepository,
    private readonly activities: ActivityRepository,
    private readonly tasks: TaskRepository,
    private readonly documents: DocumentsRepository,
    private readonly consent: ConsentRepository,
    @Inject(TALENT_DOSSIER_READ_PORT)
    private readonly dossierPort: TalentDossierReadPort,
    private readonly extraction: TalentExtractionService,
    @Inject(TALENT_360_DOCUMENT_STORAGE)
    private readonly documentStorage: DocumentStoragePort,
    private readonly education: TalentEducationRepository,
  ) {}

  async loadTalent(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<TalentCoreRow | null> {
    // INC-2 — re-pointed onto the AuthorizedTalentRetrieval read port, which applies
    // adapter-enforced do_not_contact suppression (contact channels null iff
    // do_not_contact). Non-contact fields + missing-record (null) behavior preserved.
    const r = await this.talentPort.getTalent({ tenant_id: ctx.tenant_id, talent_id });
    if (r === null) return null;
    return {
      id: r.id,
      first_name: r.first_name,
      last_name: r.last_name,
      title: r.title,
      city: r.city,
      state: r.state,
      email1: r.email1,
      phone_cell: r.phone_cell,
      work_authorization: r.work_authorization,
      desired_pay: r.desired_pay,
      current_pay: r.current_pay,
      engagement_type: r.engagement_type,
      availability_status: r.availability_status,
      date_available: r.date_available,
      key_skills: r.key_skills,
      source: r.source,
      owner_id: r.owner_id,
      created_at: r.created_at,
      recruiting_ready: r.recruiting_ready,
      record_status: r.record_status,
      superseded_by_record_id: r.superseded_by_record_id,
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
    // INC-2 — re-pointed onto the RequisitionContext read port's batch method,
    // which applies the AUTHORITATIVE requisition visibility predicate itself
    // (Option-A ruling): hidden / cross-tenant / nonexistent ids are dropped; a
    // different-site-but-actor-visible requisition is included. The port does NOT
    // assume these pipeline-derived ids are pre-authorized.
    const map = await this.requisitionContextPort.resolveContexts({
      tenant_id: ctx.tenant_id,
      actor: ctx.visibility,
      requisition_ids,
    });
    const out = new Map<string, RequisitionSummaryRow>();
    for (const [id, s] of map) {
      out.set(id, {
        id: s.id,
        requisition_number: s.requisition_number,
        title: s.title,
        company_id: s.company_id,
        status: s.status,
        is_hot: s.is_hot,
        owner_id: s.owner_id,
        recruiter_id: s.recruiter_id,
      });
    }
    return out;
  }

  async resolveCompanyNames(
    ctx: Talent360ActorContext,
    company_ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (company_ids.length === 0) return new Map();
    return this.companies.findNamesByIds({ tenant_id: ctx.tenant_id, ids: company_ids });
  }

  // CRM-5 §9.5 — authoritative terminal reason per closed pipeline id (reason
  // only; never the free-text note). Visibility is already enforced upstream:
  // the pipeline ids come from listEpisodes (actor-visible requisitions only).
  async resolveDispositionReasons(
    ctx: Talent360ActorContext,
    pipeline_ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Set(pipeline_ids.filter((id) => id.length > 0))];
    if (unique.length === 0) return new Map();
    return this.pipelines.findDispositionReasons({
      tenant_id: ctx.tenant_id,
      pipeline_ids: unique,
    });
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
    const reqIds = await this.communications.findRequisitionIdsForInteractions(
      ctx.tenant_id,
      rows.map((r) => r.id),
    );
    return rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      direction: r.direction,
      status: r.status,
      subject: r.subject,
      started_at: r.started_at === null ? null : toIso(r.started_at),
      ended_at: r.ended_at === null ? null : toIso(r.ended_at),
      initiated_by_id: r.initiated_by_id,
      requisition_ids: reqIds.get(r.id) ?? [],
      created_at: toIso(r.created_at),
    }));
  }

  async loadCommunicationPreview(
    ctx: Talent360ActorContext,
    talent_id: string,
    interaction_id: string,
  ): Promise<CommunicationPreviewRow | null> {
    const row = await this.communications.findInteractionForTenant(ctx.tenant_id, interaction_id);
    if (row === null) return null;
    const [talentIds, requisition_ids] = await Promise.all([
      this.communications.findTalentSubjectIdsForInteraction(ctx.tenant_id, interaction_id),
      this.communications.findRequisitionIdsForInteraction(ctx.tenant_id, interaction_id),
    ]);
    if (!talentIds.includes(talent_id)) return null;
    return {
      id: row.id,
      channel: row.channel,
      direction: row.direction,
      status: row.status,
      subject: row.subject,
      body: row.body,
      from_address: row.from_address,
      to_address: row.to_address,
      initiated_by_id: row.initiated_by_id,
      requisition_ids,
      created_at: toIso(row.created_at),
    };
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

  // ATS-QA-1 D1/D2 — pipeline milestones written by PipelineRepository
  // (transition + VOID correction) as Activity{type:'pipeline_status_change',
  // subject_type:'pipeline', subject_id:<episode id>}. One bounded subject read per
  // visible episode (the episodes are already visibility-scoped by the caller);
  // visible_pipeline_ids is pinned to exactly those episode ids so the repository's
  // own pipeline-visibility branch can never widen the read.
  async listPipelineActivity(
    ctx: Talent360ActorContext,
    episodes: readonly EpisodeRow[],
    limit: number,
  ): Promise<readonly PipelineActivityRow[]> {
    if (episodes.length === 0) return [];
    const visiblePipelineIds: ReadonlySet<string> = new Set(episodes.map((e) => e.id));
    const perEpisode = await Promise.all(
      episodes.map(async (e) => {
        const rows = await this.activities.listForActor({
          tenant_id: ctx.tenant_id,
          actor_user_id: ctx.user_id,
          visibility: ctx.visibility,
          visible_requisition_ids: ctx.visible_requisition_ids,
          visible_pipeline_ids: visiblePipelineIds,
          subject_type: 'pipeline',
          subject_id: e.id,
          limit,
        });
        return rows
          .filter((a) => a.type === PIPELINE_STATUS_CHANGE)
          .map(
            (a): PipelineActivityRow => ({
              id: a.id,
              pipeline_id: e.id,
              requisition_id: e.requisition_id,
              notes: a.notes,
              created_by_id: a.created_by_id,
              created_at: a.created_at,
            }),
          );
      }),
    );
    return perEpisode.flat();
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

  async loadDocumentContent(
    ctx: Talent360ActorContext,
    talent_id: string,
    document_id: string,
  ): Promise<DocumentContentRow | null> {
    const found = await this.documents.findContentArtifactForSubject({
      tenant_id: ctx.tenant_id,
      document_id,
      resource_type: 'TALENT',
      resource_id: talent_id,
    });
    if (found === null) return null;
    return {
      document_id: found.document_id,
      title: found.title,
      mime_type: found.mime_type,
      byte_size: found.byte_size,
      regarding_requisition_ids: found.regarding_requisition_ids,
      readBytes: () =>
        this.documentStorage.getArtifact({
          storage_key: found.storage_locator,
          requestId: ctx.request_id,
          maxBytes: TALENT_360_DOCUMENT_PREVIEW_MAX_BYTES,
        }),
    };
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
    // INC-2 — re-pointed onto the TalentDossier read port (delegates to the existing
    // DossierService; presents recruiter-facing outcomes, never the trust machinery).
    const head = await this.dossierPort.getDossierHead({
      tenant_id: ctx.tenant_id,
      talent_record_id: talent_id,
    });
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

  // ATS-QA-1 I-4 — current declared education from its only authority
  // (talent_evidence.TalentEducationEntry, retired entries excluded). Tenant +
  // Talent keyed. A read hiccup degrades to none, like work history (§28).
  async listEducation(
    ctx: Talent360ActorContext,
    talent_id: string,
  ): Promise<readonly EducationRow[]> {
    try {
      const rows = await this.education.listActiveForTalent({
        tenant_id: ctx.tenant_id,
        talent_id,
      });
      return rows.map(toEducationRow);
    } catch {
      return [];
    }
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
// Read-only document preview cap: the bytes travel base64 inside JSON, so a larger
// file is refused (422 too_large_for_preview) rather than streamed.
export const TALENT_360_DOCUMENT_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
