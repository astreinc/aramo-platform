import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Combobox,
  type ComboboxItem,
  type Session,
  useSession,
} from '@aramo/fe-foundation';

import {
  Card,
  CardHead,
  Icons,
  InlineAlert,
  PageHeader,
  ReservedSeam,
  Switch,
} from '../ui';
import { listCompanies, listContactsForCompany } from '../companies/companies-api';
import type { CompanyView, ContactView } from '../companies/types';

import {
  CompensationSection,
  emptyCompensationFormState,
  type CompensationFormState,
} from './CompensationSection';
import { EnterpriseFieldsSection } from './EnterpriseFieldsSection';
import {
  FinancialPlanningSection,
  canViewFinancials,
} from './FinancialPlanningSection';
import {
  ENTERPRISE_BOOLEAN_KEYS,
  ENTERPRISE_NUMBER_KEYS,
  ENTERPRISE_STRING_KEYS,
  FINANCIAL_STRING_KEYS,
  WORK_ARRANGEMENT_VALUES,
  WORK_AUTHORIZATION_VALUES,
  JOB_TYPE_VALUES,
  ROLE_FAMILY_VALUES,
  SENIORITY_LEVEL_VALUES,
  DURATION_UNIT_VALUES,
  emptyEnterpriseFormState,
  emptyFinancialFormState,
  type EnterpriseFormState,
  type FinancialFormState,
} from './enterprise-fields';
import {
  visibleWritableCompensationFields,
  type CompensationFieldKey,
} from './compensation-visibility';
import { emptyGoldenProfile } from './golden-profile';
import {
  createRequisition,
  confirmRequisitionProfile,
  draftRequisitionFromIntake,
} from './requisitions-api';
import { createErrorMessage, intakeErrorMessage } from './error-messages';
import {
  ReqProvenanceChip,
  provenanceAfterEdit,
  type ReqProvenance,
  type ReqProvenanceMap,
} from './req-provenance';
import {
  RATE_TYPE_VALUES,
  REQUISITION_STATUS_VALUES,
  type CompensationModel,
  type CreateRequisitionRequest,
  type RequisitionStatus,
  type RequisitionView,
} from './types';

// New Requisition — rebuilt to mockup parity (charter §7.3 + the two ruling
// updates).
//
// LANE 1 (AI intake, Lead ruling Tab 1): ONE intake box — a pasted client
//   email OR a few hiring-manager lines → POST /v1/requisitions/intake → the
//   model EXTRACTS stated facts + DRAFTS a JD + must/nice requirement skills.
//   Everything lands in EDITABLE fields tagged 'ai'; the recruiter reviews,
//   edits and commits every field. The AI never saves (R8/R12). Honest
//   failure state on a provider outage — never a fabricated draft.
// LANE 2: manual entry (blank form).
//
// RUN-MATCH (Lead ruling Tab 2 of the prior pass): the rail toggle marks the
//   req for matching — a STORED INTENT FLAG (run_match_on_create) only. The
//   match RESULT is a disabled "coming soon" SEAM (ReservedSeam). No scores,
//   no ranked list, nothing fabricated. "Create & run match" stores the flag
//   + creates; "Create requisition" (plain) is the primary action.
// SKILLS (Lead ruling Tab 3): the JD + must/nice requirement skills persist
//   via the existing /profile/confirm endpoint (generated_by 'manual') — the
//   role's REQUIREMENT profile, not a judgment on any person. Persisting it
//   triggers NO matching.

const CONTRACT_BRANCH_KEYS: readonly CompensationFieldKey[] = [
  'pay_rate_amount',
  'pay_rate_currency',
  'pay_rate_period',
  'bill_rate_amount',
  'bill_rate_currency',
  'bill_rate_period',
];
const PERMANENT_BRANCH_KEYS: readonly CompensationFieldKey[] = [
  'salary_amount',
  'salary_currency',
  'placement_fee_percent',
  'placement_fee_amount',
];
function onBranchKeys(model: CompensationModel | ''): readonly CompensationFieldKey[] {
  if (model === 'CONTRACT') return CONTRACT_BRANCH_KEYS;
  if (model === 'PERMANENT') return PERMANENT_BRANCH_KEYS;
  return [];
}

interface BasicsFormState {
  title: string;
  company_id: string;
  contact_id: string;
  status: RequisitionStatus;
  description: string; // the Job description (JD) — persists on create
  notes: string;
  is_hot: boolean;
  openings: number;
  start_date: string;
  city: string;
  state: string;
  // Requisition Record Spec Amendment v1.0 (ungated commercial facts).
  rate_type: string;
  allow_subcontractors: boolean;
}

interface FormState
  extends BasicsFormState,
    CompensationFormState,
    EnterpriseFormState,
    FinancialFormState {}

function emptyState(): FormState {
  return {
    title: '',
    company_id: '',
    contact_id: '',
    status: 'active',
    description: '',
    notes: '',
    is_hot: false,
    openings: 1,
    start_date: '',
    city: '',
    state: '',
    rate_type: '',
    allow_subcontractors: false,
    ...emptyCompensationFormState(),
    ...emptyEnterpriseFormState(),
    ...emptyFinancialFormState(),
  };
}

// The D5-defensive CREATE-body construction (preserved from the prior
// RequisitionForm): compensation is sent only when the discriminator is set
// AND the field is visible to the actor AND it is on the chosen branch.
// Financial-planning fields go only when the section is visible.
function buildCreateBody(
  state: FormState,
  visibleComp: ReadonlySet<CompensationFieldKey>,
  financialsVisible: boolean,
  runMatch: boolean,
): CreateRequisitionRequest {
  const body: Record<string, unknown> = {
    title: state.title.trim(),
    company_id: state.company_id,
  };
  if (state.contact_id !== '') body['contact_id'] = state.contact_id;
  body['status'] = state.status;
  if (state.description.trim() !== '') body['description'] = state.description;
  if (state.notes.trim() !== '') body['notes'] = state.notes;
  if (state.is_hot) body['is_hot'] = true;
  if (state.openings > 0) body['openings'] = state.openings;
  if (state.start_date !== '') body['start_date'] = state.start_date;
  if (state.city !== '') body['city'] = state.city;
  if (state.state !== '') body['state'] = state.state;

  // Requisition Record Spec Amendment v1.0 — ungated, omit-empty.
  if (state.rate_type !== '') body['rate_type'] = state.rate_type;
  if (state.allow_subcontractors) body['allow_subcontractors'] = true;
  // The run-match INTENT flag (stored only; triggers nothing at create).
  if (runMatch) body['run_match_on_create'] = true;

  if (state.compensation_model !== '' && visibleComp.size > 0) {
    body['compensation_model'] = state.compensation_model;
    for (const k of onBranchKeys(state.compensation_model)) {
      if (!visibleComp.has(k)) continue;
      const val = state[k];
      if (val !== '') body[k] = val;
    }
  }

  for (const k of ENTERPRISE_STRING_KEYS) {
    const val = state[k];
    if (val !== '') body[k] = val;
  }
  for (const k of ENTERPRISE_NUMBER_KEYS) {
    const val = state[k];
    if (val !== '') body[k] = Number(val);
  }
  for (const k of ENTERPRISE_BOOLEAN_KEYS) {
    if (state[k]) body[k] = true;
  }
  if (financialsVisible) {
    for (const k of FINANCIAL_STRING_KEYS) {
      const val = state[k];
      if (val !== '') body[k] = val;
    }
  }
  return body as unknown as CreateRequisitionRequest;
}

type Phase = 'intake' | 'loading' | 'form' | 'success';

interface NewRequisitionViewProps {
  // Test seam (mirrors the RouteGuard / DetailView pattern).
  readonly sessionOverride?: Session;
}

export function NewRequisitionView({ sessionOverride }: NewRequisitionViewProps) {
  const navigate = useNavigate();
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);

  const [phase, setPhase] = useState<Phase>('intake');

  // The single AI intake box.
  const [intakeText, setIntakeText] = useState('');
  const [intakeError, setIntakeError] = useState<string | null>(null);

  // The form.
  const [state, setState] = useState<FormState>(() => emptyState());
  const [provenance, setProvenance] = useState<ReqProvenanceMap>({});
  const [required, setRequired] = useState<string[]>([]);
  const [nice, setNice] = useState<string[]>([]);
  const [aiUsed, setAiUsed] = useState(false);
  const [sourceText, setSourceText] = useState('');
  const [companyHint, setCompanyHint] = useState<string | null>(null);
  const [contactHint, setContactHint] = useState<string | null>(null);
  const [runMatch, setRunMatch] = useState(false);

  const [companies, setCompanies] = useState<readonly CompanyView[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(true);
  const [contacts, setContacts] = useState<readonly ContactView[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [profileWarning, setProfileWarning] = useState<string | null>(null);
  const [created, setCreated] = useState<RequisitionView | null>(null);
  const [createdRunMatch, setCreatedRunMatch] = useState(false);

  const scopes = session?.scopes ?? [];
  const visibleComp = useMemo(
    () => visibleWritableCompensationFields(scopes),
    [scopes],
  );
  const financialsVisible = useMemo(() => canViewFinancials(scopes), [scopes]);
  const canGenerateProfile = scopes.includes('requisition:profile:generate');

  // Load visible companies (D4b — same source as the companies LIST).
  useEffect(() => {
    let cancelled = false;
    listCompanies()
      .then((res) => {
        if (cancelled) return;
        setCompanies(res.items);
        setCompaniesLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setCompaniesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load contacts when the company changes.
  useEffect(() => {
    if (state.company_id === '') {
      setContacts([]);
      return;
    }
    let cancelled = false;
    listContactsForCompany(state.company_id)
      .then((res) => {
        if (cancelled) return;
        setContacts(res.items);
      })
      .catch(() => {
        if (cancelled) return;
        setContacts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [state.company_id]);

  const companyItems: readonly ComboboxItem[] = useMemo(
    () =>
      companies.map((c) => ({
        value: c.id,
        label: c.name,
        description:
          [c.city, c.state].filter((v) => v !== null && v !== '').join(', ') ||
          undefined,
      })),
    [companies],
  );
  const contactItems: readonly ComboboxItem[] = useMemo(
    () =>
      contacts.map((c) => ({
        value: c.id,
        label: `${c.first_name} ${c.last_name}`.trim() || '—',
        description: c.title ?? undefined,
      })),
    [contacts],
  );

  if (session === null) return null;

  // ── Field editing (provenance flips 'ai' → 'edited' on a recruiter edit) ──
  function setField<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setState((s) => ({ ...s, [key]: value }));
    setProvenance((p) => {
      const next = provenanceAfterEdit(p[key as string] as ReqProvenance | undefined);
      if (next === p[key as string]) return p;
      const updated = { ...p };
      if (next === undefined) delete updated[key as string];
      else updated[key as string] = next;
      return updated;
    });
  }

  function onCompanyChange(companyId: string): void {
    setState((s) => ({ ...s, company_id: companyId, contact_id: '' }));
  }

  // ── The AI intake lane ──────────────────────────────────────────────────
  async function onDraft(): Promise<void> {
    if (intakeText.trim() === '') {
      setIntakeError('Paste an email or a few lines first.');
      return;
    }
    setIntakeError(null);
    setPhase('loading');
    try {
      const res = await draftRequisitionFromIntake({ intake_text: intakeText });
      applyDraft(res.fields, res.jd_text, res.required_skills, res.nice_to_have_skills);
      setSourceText(intakeText);
      setAiUsed(true);
      setPhase('form');
    } catch (err) {
      // Honest failure — never fabricate a draft. The intake message is
      // draft-specific (an AI outage is NOT a create failure) and steers to
      // the always-available manual lane.
      setIntakeError(intakeErrorMessage(err));
      setPhase('intake');
    }
  }

  function applyDraft(
    fields: {
      title?: string;
      company_name?: string;
      hiring_manager?: string;
      job_type?: string;
      seniority_level?: string;
      role_family?: string;
      openings?: number;
      city?: string;
      state?: string;
      work_arrangement?: string;
      work_authorization?: string;
      bill_rate?: string;
      rate_type?: string;
      allow_subcontractors?: boolean;
      duration_value?: number;
      duration_unit?: string;
    },
    jd: string,
    req: { name: string }[],
    niceList: { name: string }[],
  ): void {
    const next = emptyState();
    const prov: ReqProvenanceMap = {};
    const tag = (key: string): void => {
      prov[key] = 'ai';
    };
    if (fields.title) {
      next.title = fields.title;
      tag('title');
    }
    if (typeof fields.openings === 'number' && fields.openings > 0) {
      next.openings = fields.openings;
      tag('openings');
    }
    if (fields.city) {
      next.city = fields.city;
      tag('city');
    }
    if (fields.state) {
      next.state = fields.state;
      tag('state');
    }
    if (fields.rate_type && (RATE_TYPE_VALUES as readonly string[]).includes(fields.rate_type)) {
      next.rate_type = fields.rate_type;
      tag('rate_type');
    }
    if (fields.allow_subcontractors === true) next.allow_subcontractors = true;
    if (jd.trim() !== '') {
      next.description = jd;
      tag('description');
    }
    // Enterprise selects — only set when the stated value is in the closed set.
    if (fields.job_type && (JOB_TYPE_VALUES as readonly string[]).includes(fields.job_type)) {
      next.job_type = fields.job_type as EnterpriseFormState['job_type'];
      tag('job_type');
    }
    if (
      fields.seniority_level &&
      (SENIORITY_LEVEL_VALUES as readonly string[]).includes(fields.seniority_level)
    ) {
      next.seniority_level = fields.seniority_level as EnterpriseFormState['seniority_level'];
      tag('seniority_level');
    }
    if (fields.role_family && (ROLE_FAMILY_VALUES as readonly string[]).includes(fields.role_family)) {
      next.role_family = fields.role_family as EnterpriseFormState['role_family'];
      tag('role_family');
    }
    if (
      fields.work_arrangement &&
      (WORK_ARRANGEMENT_VALUES as readonly string[]).includes(fields.work_arrangement)
    ) {
      next.work_arrangement = fields.work_arrangement as EnterpriseFormState['work_arrangement'];
      tag('work_arrangement');
    }
    if (
      fields.work_authorization &&
      (WORK_AUTHORIZATION_VALUES as readonly string[]).includes(fields.work_authorization)
    ) {
      next.work_authorization =
        fields.work_authorization as EnterpriseFormState['work_authorization'];
      tag('work_authorization');
    }
    if (typeof fields.duration_value === 'number' && fields.duration_value > 0) {
      next.duration_value = String(fields.duration_value);
      tag('duration_value');
    }
    if (fields.duration_unit && (DURATION_UNIT_VALUES as readonly string[]).includes(fields.duration_unit)) {
      next.duration_unit = fields.duration_unit as EnterpriseFormState['duration_unit'];
    }
    // Bill rate — only land it when the actor can author bill rate (D5). Set
    // the CONTRACT discriminator + an hourly default period.
    if (fields.bill_rate && visibleComp.has('bill_rate_amount')) {
      next.compensation_model = 'CONTRACT';
      next.bill_rate_amount = fields.bill_rate.replace(/[^0-9.]/g, '');
      next.bill_rate_period = 'HOURLY';
      tag('bill_rate_amount');
    }

    setState(next);
    setProvenance(prov);
    setRequired(req.map((s) => s.name).filter((n) => n.trim() !== ''));
    setNice(niceList.map((s) => s.name).filter((n) => n.trim() !== ''));
    setCompanyHint(fields.company_name ?? null);
    setContactHint(fields.hiring_manager ?? null);
  }

  function startManual(): void {
    setState(emptyState());
    setProvenance({});
    setRequired([]);
    setNice([]);
    setAiUsed(false);
    setSourceText('');
    setCompanyHint(null);
    setContactHint(null);
    setPhase('form');
  }

  // ── Create ──────────────────────────────────────────────────────────────
  const titleValid = state.title.trim() !== '';
  const companyValid = state.company_id !== '';
  const canCreate = titleValid && companyValid && !submitting;

  async function onCreate(withMatch: boolean): Promise<void> {
    if (!canCreate) return;
    setSubmitting(true);
    setSubmitError(null);
    setProfileWarning(null);
    const flag = withMatch || runMatch;

    let createdReq: RequisitionView;
    try {
      const body = buildCreateBody(state, visibleComp, financialsVisible, flag);
      createdReq = await createRequisition(body);
    } catch (err) {
      setSubmitError(createErrorMessage(err));
      setSubmitting(false);
      return;
    }

    // Persist the JD + requirement skills as the role's GoldenProfile (Lead
    // ruling Tab 3) — the requirement profile, generated_by 'manual'. Gated
    // on requisition:profile:generate; soft-fail (the requisition IS created).
    // This stores what the ROLE requires — it triggers NO matching.
    const hasProfileContent =
      required.length > 0 || nice.length > 0 || state.description.trim() !== '';
    if (canGenerateProfile && hasProfileContent) {
      try {
        await confirmRequisitionProfile(createdReq.id, {
          draft_event_id: '',
          jd_text: state.description,
          golden_profile: {
            ...emptyGoldenProfile(),
            jd_text: state.description,
            generated_by: 'manual',
            role_family: state.role_family === '' ? undefined : state.role_family,
            seniority_level:
              state.seniority_level === '' ? undefined : state.seniority_level,
            required_skills: required.map((name) => ({ name })),
            preferred_skills: nice.map((name) => ({ name })),
          },
        });
      } catch {
        setProfileWarning(
          'The requisition was created, but its requirement skills could not be saved to the profile. Add them from the requisition’s Profile panel.',
        );
      }
    }

    setCreated(createdReq);
    setCreatedRunMatch(flag);
    setSubmitting(false);
    setPhase('success');
  }

  // ── Render ────────────────────────────────────────────────────────────
  if (phase === 'success' && created !== null) {
    return (
      <SuccessScreen
        req={created}
        runMatch={createdRunMatch}
        profileWarning={profileWarning}
        onOpen={() => navigate(`/requisitions/${created.id}`)}
        onAnother={() => {
          startManual();
          setPhase('intake');
          setIntakeText('');
          setCreated(null);
        }}
      />
    );
  }

  return (
    <section className="rc-newreq">
      <PageHeader
        title="New requisition"
        description="Paste a client email or a few lines and Aramo drafts the requisition — review, edit and create. Or enter it manually."
      />

      {phase === 'intake' ? (
        <IntakeLane
          text={intakeText}
          error={intakeError}
          onText={setIntakeText}
          onDraft={() => void onDraft()}
          onManual={startManual}
        />
      ) : null}

      {phase === 'loading' ? <DraftingCard /> : null}

      {phase === 'form' ? (
        <div className="rc-editgrid">
          <div className="rc-editgrid__main">
            {aiUsed ? (
              <div className="rc-aibanner">
                <span className="rc-aibanner__ic" aria-hidden="true">
                  <Icons.IconBolt />
                </span>
                <span>
                  <b>AI drafted this requisition from your notes.</b> Review and
                  edit anything before saving — you decide. Add the client and
                  anything the notes didn’t state.
                </span>
                <button
                  type="button"
                  className="rc-btn rc-btn--sm"
                  onClick={() => void onDraft()}
                  disabled={submitting}
                >
                  <Icons.IconBolt />
                  Regenerate
                </button>
              </div>
            ) : (
              <p className="rc-newreq__hint">
                <Icons.IconInfo />
                Manual entry. Tip: paste the client’s email on the previous step
                to auto-fill the fields.
              </p>
            )}

            {submitError !== null ? (
              <InlineAlert variant="error">{submitError}</InlineAlert>
            ) : null}
            {profileWarning !== null ? (
              <InlineAlert variant="error">{profileWarning}</InlineAlert>
            ) : null}

            {/* Role & client */}
            <Card>
              <CardHead
                title={
                  <>
                    <Icons.IconBriefcase className="rc-card__hic" />
                    Role &amp; client
                  </>
                }
              />
              <div className="rc-fgrid">
                <Field
                  label="Job title"
                  required
                  full
                  prov={provenance['title']}
                  value={state.title}
                  onChange={(v) => setField('title', v)}
                />
                <div className="rc-ifield">
                  <label className="rc-ifield__lb">
                    <span>
                      Client<span className="rc-ifield__req"> *</span>
                    </span>
                  </label>
                  <Combobox
                    ariaLabel="Client"
                    items={companyItems}
                    value={state.company_id === '' ? null : state.company_id}
                    onSelect={(item) => onCompanyChange(item.value)}
                    placeholder={companiesLoading ? 'Loading…' : 'Select client…'}
                    disabled={companiesLoading || submitting}
                    testId="company-picker"
                  />
                  {companyHint !== null ? (
                    <span className="rc-ifield__hint">
                      From your notes: “{companyHint}” — pick the matching client.
                    </span>
                  ) : null}
                </div>
                <div className="rc-ifield">
                  <label className="rc-ifield__lb">
                    <span>Hiring manager</span>
                  </label>
                  <Combobox
                    ariaLabel="Hiring manager"
                    items={contactItems}
                    value={state.contact_id === '' ? null : state.contact_id}
                    onSelect={(item) => setField('contact_id', item.value)}
                    placeholder={
                      state.company_id === '' ? 'Select a client first…' : 'Select contact…'
                    }
                    disabled={state.company_id === '' || submitting}
                    testId="contact-picker"
                  />
                  {contactHint !== null ? (
                    <span className="rc-ifield__hint">
                      From your notes: “{contactHint}”.
                    </span>
                  ) : null}
                </div>
                <NumberField
                  label="Openings"
                  prov={provenance['openings']}
                  value={state.openings}
                  onChange={(v) => setField('openings', v)}
                />
                <SelectField
                  label="Status"
                  value={state.status}
                  options={REQUISITION_STATUS_VALUES}
                  onChange={(v) => setField('status', v as RequisitionStatus)}
                />
                <div className="rc-ifield">
                  <label className="rc-ifield__lb">
                    <span>Priority</span>
                  </label>
                  <label className="rc-switchrow">
                    <Switch
                      checked={state.is_hot}
                      onCheckedChange={(c) => setField('is_hot', c)}
                      aria-label="Mark as hot"
                    />
                    <span>Mark as hot</span>
                  </label>
                </div>
              </div>
            </Card>

            {/* Classification / work arrangement / duration / source */}
            <EnterpriseFieldsSection
              value={state}
              onChange={(ent) => setState((s) => ({ ...s, ...ent }))}
              disabled={submitting}
            />

            {/* Location */}
            <Card>
              <CardHead
                title={
                  <>
                    <Icons.IconPin className="rc-card__hic" />
                    Location
                  </>
                }
              />
              <div className="rc-fgrid">
                <Field
                  label="City"
                  prov={provenance['city']}
                  value={state.city}
                  onChange={(v) => setField('city', v)}
                />
                <Field
                  label="State"
                  prov={provenance['state']}
                  value={state.state}
                  onChange={(v) => setField('state', v)}
                />
                <Field
                  label="Start date"
                  type="date"
                  value={state.start_date}
                  onChange={(v) => setField('start_date', v)}
                />
              </div>
            </Card>

            {/* Commercials — bill/pay (D5-gated) + rate type + subcontractors */}
            <CompensationSection
              value={state}
              onChange={(comp) => setState((s) => ({ ...s, ...comp }))}
              scopes={scopes}
              disabled={submitting}
            />
            <Card>
              <CardHead
                title={
                  <>
                    <Icons.IconTag className="rc-card__hic" />
                    Rate type &amp; subcontractors
                  </>
                }
              />
              <div className="rc-fgrid">
                <div className="rc-ifield">
                  <label className="rc-ifield__lb">
                    <span>Rate type</span>
                    <ReqProvenanceChip prov={provenance['rate_type']} />
                  </label>
                  <select
                    className="rc-input"
                    value={state.rate_type}
                    aria-label="Rate type"
                    disabled={submitting}
                    onChange={(ev) => setField('rate_type', ev.target.value)}
                  >
                    <option value="">Not stated</option>
                    {RATE_TYPE_VALUES.map((rt) => (
                      <option key={rt} value={rt}>
                        {rt}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="rc-ifield">
                  <label className="rc-ifield__lb">
                    <span>Allow subcontractors</span>
                  </label>
                  <label className="rc-switchrow">
                    <Switch
                      checked={state.allow_subcontractors}
                      onCheckedChange={(c) => setField('allow_subcontractors', c)}
                      aria-label="Allow subcontractors"
                    />
                    <span>C2C / non-W2 OK</span>
                  </label>
                </div>
              </div>
              <p className="rc-newreq__note">
                <Icons.IconInfo />
                Bill rate is the client max; pay / markup is set on placement.
              </p>
            </Card>

            {financialsVisible ? (
              <FinancialPlanningSection
                value={state}
                onChange={(fin) => setState((s) => ({ ...s, ...fin }))}
                scopes={scopes}
                disabled={submitting}
              />
            ) : null}

            {/* Job description */}
            <Card>
              <CardHead
                title={
                  <>
                    <Icons.IconFile className="rc-card__hic" />
                    Job description
                    <ReqProvenanceChip prov={provenance['description']} />
                  </>
                }
              />
              <div className="rc-fgrid">
                <div className="rc-ifield rc-ifield--full">
                  <textarea
                    className="rc-input"
                    rows={aiUsed ? 9 : 5}
                    value={state.description}
                    aria-label="Job description"
                    placeholder="Describe the role…"
                    disabled={submitting}
                    onChange={(ev) => setField('description', ev.target.value)}
                  />
                </div>
              </div>
            </Card>

            {/* Skills — requirement skills (must / nice). Persist via the
                GoldenProfile (requirements, not a person-verdict). */}
            <Card>
              <CardHead
                title={
                  <>
                    <Icons.IconTag className="rc-card__hic" />
                    Requirement skills
                  </>
                }
              />
              <div className="rc-skillsblock">
                <SkillEditor
                  label="Required"
                  tone="must"
                  skills={required}
                  disabled={submitting}
                  onAdd={(s) =>
                    setRequired((p) => (p.includes(s) ? p : [...p, s]))
                  }
                  onRemove={(i) => setRequired((p) => p.filter((_, j) => j !== i))}
                />
                <SkillEditor
                  label="Nice to have"
                  tone="nice"
                  skills={nice}
                  disabled={submitting}
                  onAdd={(s) => setNice((p) => (p.includes(s) ? p : [...p, s]))}
                  onRemove={(i) => setNice((p) => p.filter((_, j) => j !== i))}
                />
                <p className="rc-newreq__note">
                  <Icons.IconInfo />
                  These are the requirements the role needs. No person is judged
                  here — matching surfaces which requirements each person meets,
                  and arrives with Aramo Core.
                </p>
              </div>
            </Card>
          </div>

          {/* ── Right rail ── */}
          <aside className="rc-editgrid__rail">
            {aiUsed && sourceText !== '' ? (
              <section className="rc-sidecard" aria-label="Source">
                <h3 className="rc-sidecard__h">
                  <Icons.IconFile />
                  Source
                </h3>
                <pre className="rc-newreq__source">{sourceText}</pre>
              </section>
            ) : null}

            <ReservedSeam title="Duplicate check" tag="Coming soon">
              Aramo surfaces likely-duplicate requisitions for you to decide — it
              never merges silently. Duplicate detection arrives soon.
            </ReservedSeam>

            <section className="rc-sidecard" aria-label="Matching">
              <h3 className="rc-sidecard__h">
                <Icons.IconSearch />
                Matching
              </h3>
              <label className="rc-switchrow">
                <Switch
                  checked={runMatch}
                  onCheckedChange={setRunMatch}
                  aria-label="Run match when created"
                />
                <span>
                  Mark this requisition for matching when it’s created.
                </span>
              </label>
              <ReservedSeam title="Match results" tag="Coming with Aramo Core">
                When matching ships, it surfaces which stated requirements each
                consented person meets — evidence only, never an ordered list or
                a number on a person.
              </ReservedSeam>
            </section>

            <section className="rc-sidecard" aria-label="Owner">
              <h3 className="rc-sidecard__h">
                <Icons.IconUser />
                Owner
              </h3>
              <p className="rc-newreq__owner">
                Assigned to you. Reassigning to a teammate arrives with the
                shared assignment roster.
              </p>
            </section>

            <section className="rc-savebar">
              <ul className="rc-savebar__gates">
                <GateRow ok={titleValid} label="Job title" />
                <GateRow ok={companyValid} label="Client" />
              </ul>
              <button
                type="button"
                className="rc-btn rc-btn--primary"
                disabled={!canCreate}
                onClick={() => void onCreate(false)}
              >
                <Icons.IconCheck />
                {submitting ? 'Creating…' : 'Create requisition'}
              </button>
              {runMatch ? (
                <button
                  type="button"
                  className="rc-btn"
                  disabled={!canCreate}
                  onClick={() => void onCreate(true)}
                >
                  <Icons.IconBolt />
                  Create &amp; run match
                </button>
              ) : null}
              <button
                type="button"
                className="rc-btn rc-btn--ghost"
                disabled={submitting}
                onClick={() => navigate('/requisitions')}
              >
                Cancel
              </button>
            </section>
          </aside>
        </div>
      ) : null}
    </section>
  );
}

// ── Phase-1 intake lane (one AI box + manual link) ──────────────────────────
function IntakeLane({
  text,
  error,
  onText,
  onDraft,
  onManual,
}: {
  readonly text: string;
  readonly error: string | null;
  readonly onText: (v: string) => void;
  readonly onDraft: () => void;
  readonly onManual: () => void;
}) {
  return (
    <div className="rc-reqintake">
      <Card>
        <CardHead
          title={
            <>
              <Icons.IconBolt className="rc-card__hic" />
              Draft from an email or a few lines
            </>
          }
        />
        <div className="rc-reqintake__body">
          <p className="rc-reqintake__lead">
            Paste the client’s email, or just a few lines from the hiring
            manager. Aramo drafts the requisition — you review, edit and save.
          </p>
          <textarea
            className="rc-input rc-reqintake__ta"
            rows={8}
            value={text}
            aria-label="Requisition intake"
            placeholder="e.g. Need a senior backend engineer for the payments team. Strong Go + distributed systems, comfortable on AWS/Kubernetes. Contract, Austin or mostly remote. Bill rate up to $85/hr C2C. USC or GC only."
            onChange={(ev) => onText(ev.target.value)}
          />
          {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
          <div className="rc-reqintake__actions">
            <button type="button" className="rc-btn rc-btn--primary" onClick={onDraft}>
              <Icons.IconBolt />
              Draft with AI
            </button>
            <span className="rc-reqintake__hint">
              AI drafts — you review, edit and save.
            </span>
          </div>
        </div>
      </Card>
      <p className="rc-reqintake__manual">
        Prefer to type it?{' '}
        <button type="button" className="rc-linkbtn" onClick={onManual}>
          Enter the requisition manually
        </button>
      </p>
    </div>
  );
}

function DraftingCard() {
  return (
    <div className="rc-reqintake">
      <Card>
        <div className="rc-drafting">
          <span className="rc-drafting__spin" aria-hidden="true" />
          <div>
            <div className="rc-drafting__t">Drafting the requisition…</div>
            <div className="rc-drafting__s">
              Reading your notes, extracting the stated fields and drafting the
              description and requirement skills.
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ── Small field helpers (provenance-aware) ──────────────────────────────────
function Field({
  label,
  value,
  onChange,
  prov,
  required,
  full,
  type,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly prov?: ReqProvenance;
  readonly required?: boolean;
  readonly full?: boolean;
  readonly type?: string;
}) {
  const flagged = prov === 'ai';
  return (
    <div className={`rc-ifield${full ? ' rc-ifield--full' : ''}`}>
      <label className="rc-ifield__lb">
        <span>
          {label}
          {required ? <span className="rc-ifield__req"> *</span> : null}
        </span>
        <ReqProvenanceChip prov={prov} />
      </label>
      <input
        className={`rc-input${flagged ? ' rc-input--prov' : ''}`}
        type={type ?? 'text'}
        value={value}
        aria-label={label}
        required={required}
        onChange={(ev) => onChange(ev.target.value)}
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  prov,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (v: number) => void;
  readonly prov?: ReqProvenance;
}) {
  return (
    <div className="rc-ifield">
      <label className="rc-ifield__lb">
        <span>{label}</span>
        <ReqProvenanceChip prov={prov} />
      </label>
      <input
        className={`rc-input${prov === 'ai' ? ' rc-input--prov' : ''}`}
        type="number"
        min={0}
        step={1}
        value={value}
        aria-label={label}
        onChange={(ev) => onChange(Math.max(0, Number(ev.target.value) || 0))}
      />
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly onChange: (v: string) => void;
}) {
  return (
    <div className="rc-ifield">
      <label className="rc-ifield__lb">
        <span>{label}</span>
      </label>
      <select
        className="rc-input"
        value={value}
        aria-label={label}
        onChange={(ev) => onChange(ev.target.value)}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

function SkillEditor({
  label,
  tone,
  skills,
  disabled,
  onAdd,
  onRemove,
}: {
  readonly label: string;
  readonly tone: 'must' | 'nice';
  readonly skills: readonly string[];
  readonly disabled?: boolean;
  readonly onAdd: (s: string) => void;
  readonly onRemove: (i: number) => void;
}) {
  const [draft, setDraft] = useState('');
  function commit(): void {
    const v = draft.trim();
    if (v !== '') onAdd(v);
    setDraft('');
  }
  return (
    <div className="rc-skillgroup">
      <div className="rc-skillgroup__lb">{label}</div>
      <div className="rc-skills">
        {skills.map((s, i) => (
          <span key={`${s}-${i}`} className={`rc-skillchip rc-skillchip--${tone}`}>
            {s}
            <button
              type="button"
              aria-label={`Remove ${s}`}
              disabled={disabled}
              onClick={() => onRemove(i)}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="rc-skilladd">
        <input
          className="rc-input"
          value={draft}
          aria-label={`Add ${label.toLowerCase()} skill`}
          placeholder="Add a skill…"
          disabled={disabled}
          onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              commit();
            }
          }}
        />
        <button type="button" className="rc-btn rc-btn--sm" disabled={disabled} onClick={commit}>
          <Icons.IconPlus />
          Add
        </button>
      </div>
    </div>
  );
}

function GateRow({ ok, label }: { readonly ok: boolean; readonly label: string }) {
  return (
    <li className={`rc-gate-row${ok ? ' rc-gate-row--ok' : ''}`}>
      {ok ? <Icons.IconCheck /> : <Icons.IconInfo />}
      {label}
    </li>
  );
}

function SuccessScreen({
  req,
  runMatch,
  profileWarning,
  onOpen,
  onAnother,
}: {
  readonly req: RequisitionView;
  readonly runMatch: boolean;
  readonly profileWarning: string | null;
  readonly onOpen: () => void;
  readonly onAnother: () => void;
}) {
  return (
    <section className="rc-success">
      <div className="rc-success__ic" aria-hidden="true">
        <Icons.IconCheck />
      </div>
      <h2>{req.title} created</h2>
      <p>The requisition is live. Open it to assign a pipeline and start sourcing.</p>
      {runMatch ? (
        <p className="rc-success__note">
          Marked for matching — it runs when Aramo Core matching ships
          (evidence of requirements met, not a number on a person).
        </p>
      ) : null}
      {profileWarning !== null ? (
        <InlineAlert variant="error">{profileWarning}</InlineAlert>
      ) : null}
      <div className="rc-success__btns">
        <button type="button" className="rc-btn rc-btn--primary" onClick={onOpen}>
          Open requisition
        </button>
        <button type="button" className="rc-btn" onClick={onAnother}>
          Add another
        </button>
      </div>
    </section>
  );
}
