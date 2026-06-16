// Pure, testable logic for the e2e visible-data seeder (Step 6).
//
// Holds NO Nest / DB imports — only the seed PLAN (generic, tagged staffing
// data — NOT the mockup's invented people) and the orchestration over thin
// repository ports. The CLI (seed-e2e-data.ts) boots the apps/api AppModule
// context, `get`s the real repositories, and adapts them to these ports — so
// seeding goes through the SAME create methods the controllers call (real
// domain path, all invariants), never raw SQL.
//
// LOCKED DDR holds: NO rating field, NO structured per-pipeline rate (R10,
// gap #1/#3). Talent `current_pay` is the talent-STATED freetext (gap #3 —
// allowed); pipelines carry no rate/rating (the create DTO has none).

export { assertNonProd } from './provision-e2e-recruiter.lib.js';

// 11-state pipeline status (mirror of the BE enum) — the stages the seeded
// pipeline spans so the funnel ribbon + table populate across buckets.
export type SeedPipelineStatus =
  | 'no_contact'
  | 'qualifying'
  | 'submitted'
  | 'interviewing'
  | 'placed'
  | 'not_in_consideration';

export interface SeedContext {
  readonly tenantId: string;
  readonly recruiterUserId: string;
  readonly tag: string;
}

// --- the plan (deterministic; generic; tagged for removal) ------------------

export interface CompanySpec {
  readonly key: string;
  readonly name: string;
}
export interface ContactSpec {
  readonly key: string;
  readonly companyKey: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly email: string;
}
export interface RequisitionSpec {
  readonly key: string;
  readonly title: string;
  readonly companyKey: string;
  readonly contactKey: string;
  readonly external_req_id: string;
  readonly type: string;
  readonly city: string;
  readonly state: string;
  readonly work_arrangement: string;
  readonly openings: number;
  readonly is_hot: boolean;
}
export interface TalentSpec {
  readonly key: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly city: string;
  readonly state: string;
  readonly key_skills: string;
  readonly current_pay: string;
  // Talent-stated fields (stated-fields amendment). Closed vocabularies;
  // null exercises the "not stated" path (Unknown bucket for availability).
  readonly availability_status:
    | 'available_now'
    | 'open_to_offers'
    | 'not_looking'
    | 'unknown'
    | null;
  readonly engagement_type:
    | 'contract_to_hire'
    | 'contract'
    | 'direct_hire'
    | null;
}
export interface PipelineSpec {
  readonly talentKey: string;
  readonly requisitionKey: string;
  readonly status: SeedPipelineStatus;
}
export interface TaskSpec {
  readonly title: string;
  readonly ownerType: 'requisition' | 'talent_record';
  readonly ownerKey: string;
}

export interface SeedPlan {
  readonly companies: readonly CompanySpec[];
  readonly contacts: readonly ContactSpec[];
  readonly requisitions: readonly RequisitionSpec[];
  readonly talent: readonly TalentSpec[];
  readonly pipelines: readonly PipelineSpec[];
  readonly tasks: readonly TaskSpec[];
  /** talentKey to surface an engagement for (examination_id stays null). */
  readonly engagementTalentKey: string;
  readonly engagementRequisitionKey: string;
}

// Generic staffing data — deliberately NOT the mockup's "Senior Rust Engineer /
// Marcus Adeyemi / Sofia Ramos". Everything is tag-prefixed so it can be found
// and removed later.
export function buildSeedPlan(tag: string): SeedPlan {
  const companies: CompanySpec[] = [
    { key: 'co-a', name: `${tag} Northstar Robotics` },
    { key: 'co-b', name: `${tag} Cobalt Health Systems` },
  ];
  const contacts: ContactSpec[] = [
    { key: 'ct-a', companyKey: 'co-a', first_name: 'Dana', last_name: 'Okonkwo', email: `${tag.toLowerCase().trim()}.dana@example.test` },
    { key: 'ct-b', companyKey: 'co-b', first_name: 'Reed', last_name: 'Halloran', email: `${tag.toLowerCase().trim()}.reed@example.test` },
  ];
  const requisitions: RequisitionSpec[] = [
    { key: 'rq-1', title: `${tag} Backend Platform Engineer`, companyKey: 'co-a', contactKey: 'ct-a', external_req_id: `${tag}REQ-9001`, type: 'Contract-to-hire', city: 'Denver', state: 'CO', work_arrangement: 'remote', openings: 3, is_hot: true },
    { key: 'rq-2', title: `${tag} Data Engineer`, companyKey: 'co-b', contactKey: 'ct-b', external_req_id: `${tag}REQ-9002`, type: 'Direct', city: 'Boston', state: 'MA', work_arrangement: 'hybrid', openings: 1, is_hot: false },
    { key: 'rq-3', title: `${tag} Site Reliability Engineer`, companyKey: 'co-a', contactKey: 'ct-a', external_req_id: `${tag}REQ-9003`, type: 'Contract', city: 'Austin', state: 'TX', work_arrangement: 'remote', openings: 2, is_hot: false },
  ];
  const FIRST = ['Jordan', 'Priya', 'Mateo', 'Lena', 'Wei', 'Amara', 'Tomas', 'Nadia'];
  const LAST = ['Reyes', 'Sharma', 'Alvarez', 'Berg', 'Chen', 'Diallo', 'Novak', 'Karim'];
  const SKILLS = [
    'Go, Postgres, gRPC, AWS', 'Python, Spark, Airflow', 'Rust, Tokio, Kafka',
    'Kubernetes, Terraform, observability', 'TypeScript, React, Node',
    'Java, Kafka, Cassandra', 'Scala, Flink, dbt', 'C++, embedded, RTOS',
  ];
  // Cycle the stated-field vocabularies (incl. the null "not stated" path) so
  // every Availability bucket — Available now / Open to offers / Not looking /
  // Unknown(null+unknown) — and every Engagement type populates for the walk.
  const AVAIL: TalentSpec['availability_status'][] = [
    'available_now', 'open_to_offers', 'not_looking', 'unknown',
    'available_now', 'open_to_offers', null, 'not_looking',
  ];
  const ENGAGE: TalentSpec['engagement_type'][] = [
    'contract_to_hire', 'contract', 'direct_hire', 'contract_to_hire',
    'contract', null, 'direct_hire', 'contract',
  ];
  const talent: TalentSpec[] = FIRST.map((first, i) => ({
    key: `tl-${i + 1}`,
    first_name: first,
    last_name: LAST[i] ?? 'Smith',
    city: ['Denver', 'Boston', 'Austin', 'Remote', 'Chicago', 'Seattle', 'Remote', 'Denver'][i] ?? 'Remote',
    state: ['CO', 'MA', 'TX', 'US', 'IL', 'WA', 'US', 'CO'][i] ?? 'US',
    key_skills: SKILLS[i] ?? 'Go, Postgres',
    current_pay: `$${70 + i * 2}/hr`,
    availability_status: AVAIL[i] ?? null,
    engagement_type: ENGAGE[i] ?? null,
  }));
  // Pipeline on rq-1 spanning every funnel bucket (Sourced→…→Placed + a
  // terminal) so the ribbon counts and the stage column populate.
  const pipelines: PipelineSpec[] = [
    { talentKey: 'tl-1', requisitionKey: 'rq-1', status: 'no_contact' },
    { talentKey: 'tl-2', requisitionKey: 'rq-1', status: 'qualifying' },
    { talentKey: 'tl-3', requisitionKey: 'rq-1', status: 'submitted' },
    { talentKey: 'tl-4', requisitionKey: 'rq-1', status: 'interviewing' },
    { talentKey: 'tl-5', requisitionKey: 'rq-1', status: 'placed' },
    { talentKey: 'tl-6', requisitionKey: 'rq-1', status: 'not_in_consideration' },
  ];
  const tasks: TaskSpec[] = [
    { title: `${tag} Send references to the client`, ownerType: 'requisition', ownerKey: 'rq-1' },
    { title: `${tag} Follow up after screen`, ownerType: 'talent_record', ownerKey: 'tl-2' },
  ];
  return {
    companies,
    contacts,
    requisitions,
    talent,
    pipelines,
    tasks,
    engagementTalentKey: 'tl-4',
    engagementRequisitionKey: 'rq-1',
  };
}

// --- ports (real repositories at the CLI; mocked in the spec) ---------------

export interface SeedPorts {
  // Idempotency probe — has a tagged requisition already been seeded?
  hasTaggedRequisition(tenantId: string, externalReqIdPrefix: string): Promise<boolean>;
  createCompany(args: { tenantId: string; enteredById: string; name: string }): Promise<{ id: string }>;
  createContact(args: { tenantId: string; enteredById: string; companyId: string; first_name: string; last_name: string; email: string }): Promise<{ id: string }>;
  createRequisition(args: { tenantId: string; enteredById: string; recruiterUserId: string; spec: RequisitionSpec; companyId: string; contactId: string }): Promise<{ id: string }>;
  assignRequisition(args: { tenantId: string; requisitionId: string; userId: string }): Promise<void>;
  createTalent(args: { tenantId: string; enteredById: string; ownerId: string; spec: TalentSpec }): Promise<{ id: string }>;
  // Pipelines ALWAYS start at no_contact (hard-coded in the repo); a stage is
  // reached by walking the legal state machine via real transitions.
  createPipeline(args: { tenantId: string; talentRecordId: string; requisitionId: string }): Promise<{ id: string }>;
  transitionPipeline(args: { tenantId: string; pipelineId: string; toStatus: string; changedById: string }): Promise<void>;
  createTask(args: { tenantId: string; createdByUserId: string; assigneeId: string; title: string; ownerType: 'requisition' | 'talent_record'; ownerId: string }): Promise<{ id: string }>;
  createActivity(args: { tenantId: string; createdById: string; subjectType: 'requisition' | 'talent_record'; subjectId: string; notes: string }): Promise<{ id: string }>;
  createEngagement(args: { tenantId: string; talentId: string; requisitionId: string }): Promise<{ id: string }>;
}

export interface SeedReport {
  readonly status: 'seeded' | 'already_seeded';
  readonly tenant_id: string;
  readonly company_ids: readonly string[];
  readonly contact_ids: readonly string[];
  readonly requisition_ids: readonly string[];
  readonly talent_ids: readonly string[];
  readonly pipeline_ids: readonly string[];
  readonly task_ids: readonly string[];
  readonly engagement_ids: readonly string[];
  /** Set when the engagement step was skipped (its precondition wasn't met). */
  readonly engagement_skipped?: string;
}

// Orchestrate the plan in dependency order. Idempotent: if a tagged requisition
// already exists, report and DO NOT re-seed.
export async function seed(
  ports: SeedPorts,
  ctx: SeedContext,
  plan: SeedPlan,
): Promise<SeedReport> {
  if (await ports.hasTaggedRequisition(ctx.tenantId, ctx.tag)) {
    return emptyReport('already_seeded', ctx.tenantId);
  }

  const companyId = new Map<string, string>();
  for (const c of plan.companies) {
    const { id } = await ports.createCompany({ tenantId: ctx.tenantId, enteredById: ctx.recruiterUserId, name: c.name });
    companyId.set(c.key, id);
  }

  const contactId = new Map<string, string>();
  for (const ct of plan.contacts) {
    const { id } = await ports.createContact({
      tenantId: ctx.tenantId,
      enteredById: ctx.recruiterUserId,
      companyId: required(companyId, ct.companyKey),
      first_name: ct.first_name,
      last_name: ct.last_name,
      email: ct.email,
    });
    contactId.set(ct.key, id);
  }

  const reqId = new Map<string, string>();
  for (const rq of plan.requisitions) {
    const { id } = await ports.createRequisition({
      tenantId: ctx.tenantId,
      enteredById: ctx.recruiterUserId,
      recruiterUserId: ctx.recruiterUserId,
      spec: rq,
      companyId: required(companyId, rq.companyKey),
      contactId: required(contactId, rq.contactKey),
    });
    reqId.set(rq.key, id);
    // Visibility: a requisition:read-only recruiter sees a req only via a
    // RequisitionAssignment(req, sub). Assign the test recruiter explicitly.
    await ports.assignRequisition({ tenantId: ctx.tenantId, requisitionId: id, userId: ctx.recruiterUserId });
  }

  const talentId = new Map<string, string>();
  for (const tl of plan.talent) {
    const { id } = await ports.createTalent({ tenantId: ctx.tenantId, enteredById: ctx.recruiterUserId, ownerId: ctx.recruiterUserId, spec: tl });
    talentId.set(tl.key, id);
  }

  const pipelineIds: string[] = [];
  for (const p of plan.pipelines) {
    const { id } = await ports.createPipeline({
      tenantId: ctx.tenantId,
      talentRecordId: required(talentId, p.talentKey),
      requisitionId: required(reqId, p.requisitionKey),
    });
    // Walk no_contact → target through the LEGAL transition path.
    for (const step of legalPathTo(p.status)) {
      await ports.transitionPipeline({
        tenantId: ctx.tenantId,
        pipelineId: id,
        toStatus: step,
        changedById: ctx.recruiterUserId,
      });
    }
    pipelineIds.push(id);
  }

  const taskIds: string[] = [];
  for (const t of plan.tasks) {
    const ownerId = t.ownerType === 'requisition' ? required(reqId, t.ownerKey) : required(talentId, t.ownerKey);
    const { id } = await ports.createTask({
      tenantId: ctx.tenantId,
      createdByUserId: ctx.recruiterUserId,
      assigneeId: ctx.recruiterUserId,
      title: t.title,
      ownerType: t.ownerType,
      ownerId,
    });
    taskIds.push(id);
  }

  // A couple of req-level activity notes so My Desk + the Activity tab populate.
  await ports.createActivity({ tenantId: ctx.tenantId, createdById: ctx.recruiterUserId, subjectType: 'requisition', subjectId: required(reqId, 'rq-1'), notes: `${ctx.tag} Kickoff call with the hiring manager` });
  await ports.createActivity({ tenantId: ctx.tenantId, createdById: ctx.recruiterUserId, subjectType: 'requisition', subjectId: required(reqId, 'rq-1'), notes: `${ctx.tag} Shared the intake brief` });

  // Talent-level activity notes so the Segment-3 last_activity_at enrichment +
  // the Last-activity column/facet populate (subject_type='talent_record').
  for (const key of ['tl-1', 'tl-2', 'tl-4'] as const) {
    await ports.createActivity({ tenantId: ctx.tenantId, createdById: ctx.recruiterUserId, subjectType: 'talent_record', subjectId: required(talentId, key), notes: `${ctx.tag} Logged a screening note` });
  }

  // Engagement is BEST-EFFORT: it requires a Core Talent OVERLAY
  // (findOverlayByTenant), which the ATS TalentRecord seed does not create.
  // A missing overlay must NOT fail the whole (core-complete) seed — skip + report.
  let engagementIds: string[] = [];
  let engagementSkipped: string | undefined;
  try {
    const engagement = await ports.createEngagement({
      tenantId: ctx.tenantId,
      talentId: required(talentId, plan.engagementTalentKey),
      requisitionId: required(reqId, plan.engagementRequisitionKey),
    });
    engagementIds = [engagement.id];
  } catch (err) {
    engagementSkipped = err instanceof Error ? err.message : String(err);
  }

  return {
    status: 'seeded',
    tenant_id: ctx.tenantId,
    company_ids: [...companyId.values()],
    contact_ids: [...contactId.values()],
    requisition_ids: [...reqId.values()],
    talent_ids: [...talentId.values()],
    pipeline_ids: pipelineIds,
    task_ids: taskIds,
    engagement_ids: engagementIds,
    ...(engagementSkipped !== undefined ? { engagement_skipped: engagementSkipped } : {}),
  };
}

// The legal forward progression (mirror of libs/pipeline state machine), used
// to walk a freshly-created (no_contact) pipeline to a target stage. Each step
// is a real, legal transition — no invariant is bypassed.
const FORWARD: readonly SeedPipelineStatus[] | readonly string[] = [
  'no_contact',
  'contacted',
  'talent_responded',
  'qualifying',
  'submitted',
  'interviewing',
  'offered',
  'placed',
];

export function legalPathTo(target: SeedPipelineStatus): readonly string[] {
  if (target === 'no_contact') return [];
  if (target === 'not_in_consideration') return ['not_in_consideration']; // 1 legal hop from no_contact
  const idx = (FORWARD as readonly string[]).indexOf(target);
  if (idx <= 0) return [];
  return (FORWARD as readonly string[]).slice(1, idx + 1);
}

function required(map: Map<string, string>, key: string): string {
  const v = map.get(key);
  if (v === undefined) throw new Error(`seed plan referenced unknown key '${key}'`);
  return v;
}

function emptyReport(status: SeedReport['status'], tenantId: string): SeedReport {
  return {
    status,
    tenant_id: tenantId,
    company_ids: [],
    contact_ids: [],
    requisition_ids: [],
    talent_ids: [],
    pipeline_ids: [],
    task_ids: [],
    engagement_ids: [],
  };
}
