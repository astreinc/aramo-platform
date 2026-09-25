import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Combobox,
  type ComboboxItem,
  type Session,
  useSession, Button, Input, TextArea,
} from '@aramo/fe-foundation';

import {
  Card,
  CardHead,
  Icons,
  InlineAlert,
  PageHeader,
} from '../ui';
import { listCompanies, listContactsForCompany } from '../companies/companies-api';
import type { CompanyView, ContactView } from '../companies/types';
import { AddressTypeahead } from '../companies/AddressTypeahead';
import type { AddressDetails } from '../companies/types';

import {
  emptyCompensationFormState,
  type CompensationFormState,
} from './CompensationSection';
import { canViewFinancials } from './FinancialPlanningSection';
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
import { parseRequisitionIntake } from './parse-intake';
import { RequisitionForm } from './RequisitionForm';
import {
  provenanceAfterEdit,
  type ReqProvenance,
  type ReqProvenanceMap,
} from './req-provenance';
import {
  RATE_TYPE_VALUES,
  type CompensationModel,
  type CreateRequisitionRequest,
  type RecruitingStatus,
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
  status: RecruitingStatus;
  description: string; // the Job description (JD) — persists on create
  notes: string;
  is_hot: boolean;
  openings: number;
  start_date: string;
  city: string;
  state: string;
  // WL-B1 — canonical postal code (UI label "ZIP / Postal code").
  postal_code: string;
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
    // A MANUAL (human) create can only ESTABLISH a `draft` — establishing `open`
    // requires requisition:create:establish, which is catalog-only and granted to
    // no human role (establishment-authorization-gate.ts). Open is reached via the
    // governed lifecycle (Submit for approval → Approve), never at create. So the
    // form defaults to and only offers `draft`; anything else 403s server-side.
    status: 'draft',
    description: '',
    notes: '',
    is_hot: false,
    openings: 1,
    start_date: '',
    city: '',
    state: '',
    postal_code: '',
    rate_type: '',
    allow_subcontractors: false,
    ...emptyCompensationFormState(),
    ...emptyEnterpriseFormState(),
    ...emptyFinancialFormState(),
  };
}

// G2.5c — thin adapter between New-Req's typed FormState (the source of truth,
// which buildCreateBody still reads) and the shared RequisitionForm's string
// value map. FormState stays authoritative; the map is derived each render and
// writes coerce straight back through setField.
const FORM_BOOLEAN_KEYS = new Set([
  'is_hot',
  'allow_subcontractors',
  'relocation_offered',
  'extension_possible',
]);
const FORM_NUMBER_KEYS = new Set(['openings']);
// Fields the shared RequisitionForm renders only in the Detail Overview, never at
// intake: onsite cadence (set once an arrangement is confirmed), pay rate, and the
// derived margin/markup actuals. present()=false keeps them out of the create form.
const DETAIL_ONLY_FORM_KEYS = new Set([
  'onsite_days_per_week',
  'pay_rate_amount',
  'margin_percent',
  'markup_percent',
]);

function stateToFormValues(state: FormState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(state)) {
    if (typeof v === 'boolean') out[k] = v ? 'true' : 'false';
    else out[k] = v === null || v === undefined ? '' : String(v);
  }
  return out;
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
  if (state.postal_code !== '') body['postal_code'] = state.postal_code;

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

// How the form was reached: a blank manual form ('none'), the AI draft lane
// ('ai'), or the deterministic non-AI parse lane ('parsed'). Drives the review
// banner, JD sizing, additional-fields expansion and the Source rail — the AI
// lane's rendered strings stay byte-identical to before.
type DraftSource = 'none' | 'ai' | 'parsed';

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
  const [draftSource, setDraftSource] = useState<DraftSource>('none');
  const [sourceText, setSourceText] = useState('');
  const [companyHint, setCompanyHint] = useState<string | null>(null);
  const [contactHint, setContactHint] = useState<string | null>(null);
  // "View pasted source" drawer (prototype) — read-only; the form stays editable.
  const [sourceOpen, setSourceOpen] = useState(false);

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

  // Company Party/Role (ADR-0032, R7 / CLIENT-workflow invariant) — a
  // requisition's company is the CLIENT, so the picker exposes ONLY companies
  // that hold a CLIENT relationship (a Vendor/Partner-only company is not a
  // valid requisition client). The BE service guard is authoritative; this
  // narrows the UI so an invalid pick isn't offered.
  const companyItems: readonly ComboboxItem[] = useMemo(
    () =>
      companies
        .filter((c) => (c.relationships ?? []).some((r) => r.type === 'CLIENT'))
        .map((c) => ({
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

  // WL-B3 — a selected address suggestion fills the STRUCTURED location fields
  // (city / state / postal_code). Autocomplete is non-authoritative assistance
  // (R3): the search text is never persisted, no provider place-id / geo is
  // stored (R4), and the recruiter remains free to edit the filled values (R12).
  function populateWorkLocation(details: AddressDetails): void {
    if (details.city != null) setField('city', details.city);
    if (details.state != null) setField('state', details.state);
    if (details.zip != null) setField('postal_code', details.zip);
  }

  function onCompanyChange(companyId: string): void {
    setState((s) => ({ ...s, company_id: companyId, contact_id: '' }));
  }

  // Bill rate (CONTRACT comp) — entering an amount sets the discriminator so
  // buildCreateBody sends it; provenance flips 'ai' → 'edited' on edit.
  function setBillRate(v: string): void {
    setState((s) => ({
      ...s,
      bill_rate_amount: v,
      compensation_model: v.trim() !== '' ? 'CONTRACT' : s.compensation_model,
    }));
    setProvenance((p) => {
      const next = provenanceAfterEdit(p['bill_rate_amount'] as ReqProvenance | undefined);
      if (next === p['bill_rate_amount']) return p;
      const u = { ...p };
      if (next === undefined) delete u['bill_rate_amount'];
      else u['bill_rate_amount'] = next;
      return u;
    });
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
      applyDraft(res.fields, res.jd_text, res.required_skills, res.nice_to_have_skills, 'ai');
      setSourceText(intakeText);
      setDraftSource('ai');
      setPhase('form');
    } catch (err) {
      // Honest failure — never fabricate a draft. The intake message is
      // draft-specific (an AI outage is NOT a create failure) and steers to
      // the always-available manual lane.
      setIntakeError(intakeErrorMessage(err));
      setPhase('intake');
    }
  }

  // ── The deterministic (non-AI) import lane ────────────────────────────────
  // The recruiter pastes the client's well-defined requirement; we parse it
  // locally (no AI, no network) and prefill the SAME manual form for review.
  // We author nothing and alter nothing — the full paste is preserved in the
  // job description. Fields carry the honest 'parsed' tag, never 'ai'.
  function onImport(): void {
    if (intakeText.trim() === '') {
      setIntakeError('Paste the client requirement first.');
      return;
    }
    setIntakeError(null);
    const parsed = parseRequisitionIntake(intakeText);
    applyDraft(
      parsed.fields,
      parsed.jd_text,
      parsed.required_skills,
      parsed.nice_to_have_skills,
      'parsed',
    );
    setSourceText(intakeText);
    setDraftSource('parsed');
    setPhase('form');
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
    source: ReqProvenance = 'ai',
  ): void {
    const next = emptyState();
    const prov: ReqProvenanceMap = {};
    const tag = (key: string): void => {
      prov[key] = source;
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
    setDraftSource('none');
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
    const flag = withMatch;

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

  // G2.5c — adapt New-Req's typed state to the shared RequisitionForm contract.
  const formValues = stateToFormValues(state);
  const writeField = setField as unknown as (k: string, v: unknown) => void;
  const onFormChange = (key: string, val: string): void => {
    // Bill rate keeps its discriminator behavior (sets compensation_model =
    // CONTRACT so buildCreateBody sends it) — preserved from setBillRate.
    if (key === 'bill_rate_amount') {
      setBillRate(val);
      return;
    }
    if (FORM_BOOLEAN_KEYS.has(key)) writeField(key, val === 'true');
    else if (FORM_NUMBER_KEYS.has(key)) writeField(key, Math.max(0, Number(val) || 0));
    else writeField(key, val);
  };
  // Detail-only fields — the create form doesn't collect them (no onsite cadence
  // until an arrangement is confirmed; pay rate + derived margin/markup surface
  // on the requisition record, not at intake). They render only in the Overview.
  const formPresent = (key: string): boolean => {
    if (DETAIL_ONLY_FORM_KEYS.has(key)) return false;
    if (key === 'bill_rate_amount') return visibleComp.has('bill_rate_amount');
    return true;
  };

  // Domain widgets fed to the shared form via explicit slots (create lane).
  const clientSlot = (
    <>
      <Combobox
        ariaLabel="Company"
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
    </>
  );
  const contactSlot = (
    <>
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
        <span className="rc-ifield__hint">From your notes: “{contactHint}”.</span>
      ) : null}
    </>
  );
  const addressSlot = (
    <div className="rc-ifield">
      <label className="rc-ifield__lb">Search work location</label>
      <AddressTypeahead
        onSelectAddress={populateWorkLocation}
        disabled={submitting}
        testId="req-worklocation-search"
      />
      <span style={{ display: 'block', fontSize: 12, color: '#5C6770', marginTop: 4 }}>
        Optional — fills City, State and ZIP / Postal code; you can edit them after.
      </span>
    </div>
  );
  const skillsSlot = (
    <div className="rc-skillsblock">
      <SkillEditor
        label="Required"
        tone="must"
        skills={required}
        disabled={submitting}
        onAdd={(s) => setRequired((p) => (p.includes(s) ? p : [...p, s]))}
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
        These are the requirements the role needs. No person is judged here —
        matching surfaces which requirements each person meets, and arrives with
        Aramo Core.
      </p>
    </div>
  );

  return (
    <section className="rc-newreq">
      <PageHeader
        title="New requisition"
        description="Paste a client email or a few lines and Aramo drafts the requisition — review, edit and create."
      />

      {phase === 'intake' ? (
        <IntakeLane
          text={intakeText}
          error={intakeError}
          onText={setIntakeText}
          onDraft={() => void onDraft()}
          onImport={onImport}
        />
      ) : null}

      {phase === 'loading' ? <DraftingCard /> : null}

      {phase === 'form' ? (
        <div className="rc-newreqform">
            {draftSource === 'ai' ? (
              <div className="rc-aibanner">
                <span className="rc-aibanner__ic" aria-hidden="true">
                  <Icons.IconBolt />
                </span>
                <span>
                  <b>AI drafted this requisition from your notes.</b> Review and
                  edit anything before saving — you decide. Add the client and
                  anything the notes didn’t state.
                  {sourceText !== '' ? <ViewSourceLink onOpen={() => setSourceOpen(true)} /> : null}
                </span>
                <Button unstyled
                  type="button"
                  className="rc-btn rc-btn--sm"
                  onClick={() => void onDraft()}
                  disabled={submitting}
                >
                  <Icons.IconBolt />
                  Regenerate
                </Button>
              </div>
            ) : draftSource === 'parsed' ? (
              <div className="rc-aibanner rc-aibanner--parsed">
                <span className="rc-aibanner__ic" aria-hidden="true">
                  <Icons.IconFile />
                </span>
                <span>
                  <b>Imported from the pasted client requirement.</b> Nothing was
                  drafted or invented — the full text is kept in the job
                  description. Review and edit every field, then create; nothing
                  is created until you do. Pick the matching client.
                  {sourceText !== '' ? <ViewSourceLink onOpen={() => setSourceOpen(true)} /> : null}
                </span>
                <Button unstyled
                  type="button"
                  className="rc-btn rc-btn--sm"
                  onClick={onImport}
                  disabled={submitting}
                >
                  <Icons.IconFile />
                  Re-import
                </Button>
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

            {/* G2.5c — the SAME shared form the Detail Overview uses (create
                mode). New-Req keeps its rail, banner, and create-body building;
                only the duplicate section JSX is gone. */}
            <RequisitionForm
              mode="create"
              values={formValues}
              present={formPresent}
              scopes={scopes}
              onChange={onFormChange}
              disabled={submitting}
              provenance={provenance}
              clientDisplay=""
              contactDisplay={null}
              clientSlot={clientSlot}
              contactSlot={contactSlot}
              addressSlot={addressSlot}
              skillsSlot={skillsSlot}
              statusDisplay="Draft"
            />

          {/* ── Sticky action bar (prototype) — required-field gates on the
              left; Cancel + Create on the right. The old right rail (Source /
              Duplicate / Matching cards) is gone; the pasted source moved to the
              "View pasted source" drawer opened from the banner. */}
          <div className="rc-createbar">
            <ul className="rc-createbar__gates">
              <li className="rc-createbar__req">REQUIRED</li>
              <GateRow ok={titleValid} label="Job title" />
              <GateRow ok={companyValid} label="Client" />
            </ul>
            <div className="rc-createbar__actions">
              <Button
                unstyled
                type="button"
                className="rc-btn rc-btn--ghost"
                disabled={submitting}
                onClick={() => navigate('/requisitions')}
              >
                Cancel
              </Button>
              <Button
                unstyled
                type="button"
                className="rc-btn rc-btn--primary"
                disabled={!canCreate}
                onClick={() => void onCreate(false)}
              >
                <Icons.IconCheck />
                {submitting ? 'Creating…' : 'Create requisition'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Read-only pasted-source drawer (prototype) — the form stays editable. */}
      {sourceOpen && sourceText !== '' ? (
        <PastedSourceDrawer text={sourceText} onClose={() => setSourceOpen(false)} />
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
  onImport,
}: {
  readonly text: string;
  readonly error: string | null;
  readonly onText: (v: string) => void;
  readonly onDraft: () => void;
  readonly onImport: () => void;
}) {
  return (
    <div className="rc-reqintake">
      <Card>
        <CardHead
          title={
            <>
              <Icons.IconBolt className="rc-card__hic" />
              Start from a client email or a few lines
            </>
          }
        />
        <div className="rc-reqintake__body">
          <p className="rc-reqintake__lead">
            Paste the client’s email or a few lines from the hiring manager.
            Draft it with AI, or — if the client already sent a complete
            requirement — import it as-is. Either way you review, edit and
            create.
          </p>
          <TextArea unstyled
            className="rc-input rc-reqintake__ta"
            rows={8}
            value={text}
            aria-label="Requisition intake"
            placeholder="e.g. Need a senior backend engineer for the payments team. Strong Go + distributed systems, comfortable on AWS/Kubernetes. Contract, Austin or mostly remote. Bill rate up to $85/hr C2C. USC or GC only."
            onChange={(ev) => onText(ev.target.value)}
          />
          {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
          <div className="rc-reqintake__actions">
            <Button unstyled type="button" className="rc-btn rc-btn--primary" onClick={onDraft}>
              <Icons.IconBolt />
              Draft with AI
            </Button>
            <Button unstyled type="button" className="rc-btn" onClick={onImport}>
              <Icons.IconFile />
              Import client requisition
            </Button>
            <span className="rc-reqintake__hint">
              Import parses a ready requirement into the form — no AI. You review,
              edit and create.
            </span>
          </div>
        </div>
      </Card>
      {/* §4 — no manual-entry path: the requisition is always drafted or
          imported, then reviewed. The "Enter the requisition manually" link is
          removed. */}
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
            <Button
              type="button"
              aria-label={`Remove ${s}`}
              disabled={disabled}
              onClick={() => onRemove(i)}
            >
              ×
            </Button>
          </span>
        ))}
      </div>
      <div className="rc-skilladd">
        <Input unstyled
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
        <Button unstyled type="button" className="rc-btn rc-btn--sm" disabled={disabled} onClick={commit}>
          <Icons.IconPlus />
          Add
        </Button>
      </div>
    </div>
  );
}

// The "View pasted source" affordance in the import/draft banner — a link that
// opens the read-only source drawer (prototype).
function ViewSourceLink({ onOpen }: { readonly onOpen: () => void }) {
  return (
    <>
      {' '}
      <Button unstyled type="button" className="rc-viewsrc" onClick={onOpen}>
        <Icons.IconFile />
        View pasted source
      </Button>
    </>
  );
}

// Read-only right-side drawer showing the pasted requirement verbatim. It does
// NOT modal-block the form (the form stays editable while open); Esc closes it.
function PastedSourceDrawer({
  text,
  onClose,
}: {
  readonly text: string;
  readonly onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside className="rc-srcdrawer" role="dialog" aria-label="Pasted source">
      <header className="rc-srcdrawer__head">
        <Icons.IconFile />
        <span className="rc-srcdrawer__ttl">
          <span className="rc-srcdrawer__t">Pasted source</span>
          <span className="rc-srcdrawer__s">
            Read-only · the form stays editable while this is open
          </span>
        </span>
        <Button
          unstyled
          type="button"
          className="rc-srcdrawer__x"
          title="Close (Esc)"
          aria-label="Close pasted source"
          onClick={onClose}
        >
          <Icons.IconX />
        </Button>
      </header>
      <pre className="rc-srcdrawer__body">{text}</pre>
    </aside>
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
        <Button unstyled type="button" className="rc-btn rc-btn--primary" onClick={onOpen}>
          Open requisition
        </Button>
        <Button unstyled type="button" className="rc-btn" onClick={onAnother}>
          Add another
        </Button>
      </div>
    </section>
  );
}
