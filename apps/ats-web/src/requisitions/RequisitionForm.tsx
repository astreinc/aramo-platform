import type { ReactNode } from 'react';
import { Input, Select, Switch, TextArea } from '@aramo/fe-foundation';

import { formatDate } from '../format/date';
import { Card, CardHead, Icons } from '../ui';

import { canViewFinancials } from './FinancialPlanningSection';
import {
  HEADCOUNT_REASON_VALUES,
  JOB_TYPE_VALUES,
  ROLE_FAMILY_VALUES,
  SENIORITY_LEVEL_VALUES,
  SOURCE_SYSTEM_VALUES,
  WORK_ARRANGEMENT_VALUES,
  WORK_AUTHORIZATION_VALUES,
  DURATION_UNIT_VALUES,
  enterpriseLabel,
} from './enterprise-fields';
import {
  ReqProvenanceChip,
  isPrefilled,
  type ReqProvenance,
  type ReqProvenanceMap,
} from './req-provenance';
import { RATE_TYPE_VALUES } from './types';

// G2.5 — the ONE shared requisition form (Aramo-UI-HotFix Requisitions §5).
//
// The New requisition page (mode="create") and the Requisition Detail Overview
// (mode="view" | "edit") render THIS component, so the two are the same form —
// identical section order, labels, and field grid — never two layouts.
//
// It is deliberately domain-specific and readable, NOT a generic form engine:
// the eight sections are written out explicitly; only the per-field row wrapper
// and the mode→control switch are shared. Values flow through a normalized
// string map (`values`): '' for empty, 'true'/'false' for switches, enum tokens
// for selects, and 'YYYY-MM-DD' for dates. `present(key)` carries the server's
// masked-by-absence discipline — a scope-masked field is simply not rendered
// (never an empty input), in BOTH view and edit.

export type RequisitionFormMode = 'create' | 'view' | 'edit';

export type RequisitionFormValues = Readonly<Record<string, string>>;

export interface RequisitionFormProps {
  readonly mode: RequisitionFormMode;
  readonly values: RequisitionFormValues;
  /** Masked-by-absence: false → the field is omitted entirely (never blanked). */
  readonly present: (key: string) => boolean;
  readonly scopes: readonly string[];
  /** Edit/create write-back. Omitted in view mode. */
  readonly onChange?: (key: string, value: string) => void;
  readonly disabled?: boolean;
  /** Client + Hiring-manager display (names) for view mode. */
  readonly clientDisplay: string;
  readonly contactDisplay: string | null;
  /** Client + Hiring-manager editors (create/edit) — the domain picker widgets. */
  readonly clientSlot?: ReactNode;
  readonly contactSlot?: ReactNode;
  /** Status is display-only here (changes flow through the governed actions). */
  readonly statusDisplay: string;
  /** Requirement-skills widget (Detail: ProfileWorkbenchPanel; New-req: SkillEditors). */
  readonly skillsSlot: ReactNode;
  /** Per-field provenance (New-req create lane): AI-draft / Parsed / edited tags. */
  readonly provenance?: ReqProvenanceMap;
  /** Address-search helper above City/State/ZIP (New-req create lane). */
  readonly addressSlot?: ReactNode;
}

const YES_NO = 'Yes';

function isEditable(mode: RequisitionFormMode): boolean {
  return mode === 'create' || mode === 'edit';
}

function selectLabel(value: string): string {
  return value === '' ? '—' : enterpriseLabel(value);
}

// ── field-row primitives (the only shared mechanism) ──────────────────────────

function Row({
  label,
  required,
  full,
  prov,
  children,
}: {
  readonly label: string;
  readonly required?: boolean;
  readonly full?: boolean;
  readonly prov?: ReqProvenance;
  readonly children: ReactNode;
}) {
  return (
    <div className={`rc-ifield${full ? ' rc-ifield--full' : ''}`}>
      <label className="rc-ifield__lb">
        <span>
          {label}
          {required ? <span className="rc-ifield__req"> *</span> : null}
        </span>
        <ReqProvenanceChip prov={prov} />
      </label>
      {children}
    </div>
  );
}

// A read-only value box, sized to match its input so nothing shifts view↔edit.
function ViewBox({ value }: { readonly value: string }) {
  const empty = value === '' || value === '—';
  return (
    <div className={`rc-vbox${empty ? ' rc-vbox--empty' : ''}`}>
      {empty ? '—' : value}
    </div>
  );
}

// A multi-line read-only value (JD, notes) — preserves line breaks.
function ViewText({ value }: { readonly value: string }) {
  const empty = value.trim() === '';
  return (
    <div className={`rc-vbox rc-vbox--text${empty ? ' rc-vbox--empty' : ''}`}>
      {empty ? '—' : value}
    </div>
  );
}

// ── the form ──────────────────────────────────────────────────────────────────

export function RequisitionForm(props: RequisitionFormProps): JSX.Element {
  const {
    mode,
    values,
    present,
    scopes,
    onChange,
    disabled,
    clientDisplay,
    contactDisplay,
    clientSlot,
    contactSlot,
    statusDisplay,
    skillsSlot,
    provenance,
    addressSlot,
  } = props;

  const editable = isEditable(mode);
  const set = (key: string) => (value: string) => onChange?.(key, value);
  const prov = (key: string): ReqProvenance | undefined => provenance?.[key];
  const inputClass = (key: string): string =>
    `rc-input${isPrefilled(prov(key)) ? ' rc-input--prov' : ''}`;

  // A scalar text/number field.
  const textField = (
    key: string,
    label: string,
    opts: { required?: boolean; full?: boolean; type?: string } = {},
  ): JSX.Element | null => {
    if (!present(key)) return null;
    const value = values[key] ?? '';
    return (
      <Row key={key} label={label} required={opts.required} full={opts.full} prov={prov(key)}>
        {editable ? (
          <Input
            unstyled
            className={inputClass(key)}
            type={opts.type ?? 'text'}
            value={value}
            aria-label={label}
            disabled={disabled}
            onChange={(e) => set(key)(e.target.value)}
          />
        ) : (
          <ViewBox value={opts.type === 'date' ? formatDate(value) : value} />
        )}
      </Row>
    );
  };

  // A closed-vocabulary select.
  const selectField = (
    key: string,
    label: string,
    vocabulary: readonly string[],
    opts: { full?: boolean; placeholder?: string } = {},
  ): JSX.Element | null => {
    if (!present(key)) return null;
    const value = values[key] ?? '';
    return (
      <Row key={key} label={label} full={opts.full} prov={prov(key)}>
        {editable ? (
          <Select
            unstyled
            className={inputClass(key)}
            value={value}
            aria-label={label}
            disabled={disabled}
            onChange={(e) => set(key)(e.target.value)}
          >
            <option value="">{opts.placeholder ?? 'Select…'}</option>
            {vocabulary.map((v) => (
              <option key={v} value={v}>
                {enterpriseLabel(v)}
              </option>
            ))}
          </Select>
        ) : (
          <ViewBox value={selectLabel(value)} />
        )}
      </Row>
    );
  };

  // A derived / read-only value — rendered as a value box in BOTH view and edit
  // (Margin, Markup % are computed downstream, never hand-entered here).
  const readonlyField = (
    key: string,
    label: string,
    opts: { suffix?: string } = {},
  ): JSX.Element | null => {
    if (!present(key)) return null;
    const raw = values[key] ?? '';
    const value = raw === '' ? '—' : `${raw}${opts.suffix ?? ''}`;
    return (
      <Row key={key} label={label}>
        <ViewBox value={value} />
      </Row>
    );
  };

  // A Yes/No switch.
  const switchField = (
    key: string,
    label: string,
    onLabel: string,
  ): JSX.Element | null => {
    if (!present(key)) return null;
    const on = values[key] === 'true';
    return (
      <Row key={key} label={label}>
        {editable ? (
          <label className="rc-switchrow">
            <Switch
              checked={on}
              disabled={disabled}
              onCheckedChange={(c) => set(key)(c ? 'true' : 'false')}
              aria-label={label}
            />
            <span>{onLabel}</span>
          </label>
        ) : (
          <ViewBox value={on ? YES_NO : 'No'} />
        )}
      </Row>
    );
  };

  // Financial planning is RESTRICTED. On create the actor's own scope gates it;
  // on view/edit it rides masked-by-absence — the server omits the financial
  // keys an actor can't read, so their presence IS the authorization signal
  // (never a separate FE guess that could diverge from the payload).
  const financialFields = [
    'target_margin_percent',
    'markup_percent_target',
    'rate_card_id',
    'min_bill_rate',
    'max_bill_rate',
    'min_pay_rate',
    'max_pay_rate',
  ];
  const financialsVisible =
    mode === 'create'
      ? canViewFinancials(scopes)
      : financialFields.some((k) => present(k));
  const jd = values['description'] ?? '';
  const notes = values['notes'] ?? '';

  return (
    <div className="rc-reqform">
      {/* ── 1. Role & client ── */}
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
          {textField('title', 'Job title', { required: true, full: true })}
          <Row label="Client" required>
            {editable && clientSlot !== undefined ? (
              clientSlot
            ) : (
              <ViewBox value={clientDisplay} />
            )}
          </Row>
          <Row label="Hiring manager">
            {editable && contactSlot !== undefined ? (
              contactSlot
            ) : (
              <ViewBox value={contactDisplay ?? '—'} />
            )}
          </Row>
          {selectField('job_type', 'Requisition type', JOB_TYPE_VALUES)}
          {textField('openings', 'Openings', { type: 'number' })}
          {/* Status is display-only — it changes through the governed header
              actions, never a free enum edit. */}
          <Row label="Status">
            <ViewBox value={statusDisplay} />
          </Row>
          {switchField('is_hot', 'Priority', 'Mark as hot')}
        </div>
      </Card>

      {/* ── 2. Hiring-manager notes (second panel — the call-context capture) ── */}
      <Card>
        <CardHead
          title={
            <>
              <span className="rc-card__hnowrap">
                <Icons.IconMessage className="rc-card__hic" />
                Hiring-manager notes
              </span>
              {/* The "internal — never shared" caption is dropped on the New
                  requisition page (mode=create) per PO; kept on the Detail
                  Overview where the note may be read alongside talent-facing data. */}
              {mode !== 'create' ? (
                <span className="rc-card__hnote">Internal — never shared with talent</span>
              ) : null}
            </>
          }
        />
        <div className="rc-fgrid">
          <div className="rc-ifield rc-ifield--full">
            {editable ? (
              <TextArea
                unstyled
                className="rc-input rc-notesbox"
                rows={10}
                value={notes}
                aria-label="Hiring-manager notes"
                placeholder="Call notes and context from the hiring manager — must-haves, team setup, interview process, red flags…"
                disabled={disabled}
                onChange={(e) => set('notes')(e.target.value)}
              />
            ) : (
              <ViewText value={notes} />
            )}
          </div>
        </div>
      </Card>

      {/* ── 3. Location & work arrangement ── */}
      <Card>
        <CardHead
          title={
            <>
              <Icons.IconPin className="rc-card__hic" />
              Location &amp; work arrangement
            </>
          }
        />
        {/* Address-search helper (create lane) — fills City/State/ZIP. */}
        {editable && addressSlot !== undefined ? addressSlot : null}
        <div className="rc-fgrid">
          {textField('city', 'City')}
          {textField('state', 'State')}
          {textField('postal_code', 'ZIP / Postal code')}
          {selectField('work_arrangement', 'Work arrangement', WORK_ARRANGEMENT_VALUES)}
          {textField('onsite_days_per_week', 'Onsite days / week', { type: 'number' })}
          {/* Contract duration — value + unit. */}
          {present('duration_value') ? (
            <Row label="Contract duration">
              {editable ? (
                <div className="rc-inpgrp">
                  <Input
                    unstyled
                    className="rc-input"
                    type="number"
                    min={0}
                    value={values['duration_value'] ?? ''}
                    aria-label="Contract duration value"
                    disabled={disabled}
                    onChange={(e) => set('duration_value')(e.target.value)}
                  />
                  <Select
                    unstyled
                    className="rc-input"
                    value={values['duration_unit'] ?? ''}
                    aria-label="Contract duration unit"
                    disabled={disabled}
                    onChange={(e) => set('duration_unit')(e.target.value)}
                  >
                    <option value="">unit…</option>
                    {DURATION_UNIT_VALUES.map((u) => (
                      <option key={u} value={u}>
                        {enterpriseLabel(u)}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : (
                <ViewBox
                  value={(() => {
                    const dv = values['duration_value'] ?? '';
                    const du = values['duration_unit'] ?? '';
                    if (dv === '') return '—';
                    // Append the unit only when set — never a dangling "12 —".
                    return du === '' ? dv : `${dv} ${enterpriseLabel(du)}`;
                  })()}
                />
              )}
            </Row>
          ) : null}
          {textField('start_date', 'Start date', { type: 'date' })}
          {textField('end_date', 'End date', { type: 'date' })}
        </div>
      </Card>

      {/* ── 4. Commercials (scope-masked by absence) ── */}
      <Card>
        <CardHead
          title={
            <>
              <span className="rc-card__hnowrap">
                <Icons.IconTag className="rc-card__hic" />
                Commercials
              </span>
              <span className="rc-card__hnote">
                Shown per your scopes — masked fields are absent, never null.
              </span>
            </>
          }
        />
        <div className="rc-fgrid">
          {textField('bill_rate_amount', 'Bill rate (max)')}
          {textField('pay_rate_amount', 'Pay rate')}
          {present('rate_type') ? (
            <Row label="Rate type">
              {editable ? (
                <Select
                  unstyled
                  className="rc-input"
                  value={values['rate_type'] ?? ''}
                  aria-label="Rate type"
                  disabled={disabled}
                  onChange={(e) => set('rate_type')(e.target.value)}
                >
                  <option value="">Not stated</option>
                  {RATE_TYPE_VALUES.map((rt) => (
                    <option key={rt} value={rt}>
                      {rt}
                    </option>
                  ))}
                </Select>
              ) : (
                <ViewBox value={values['rate_type'] === '' ? '—' : (values['rate_type'] ?? '—')} />
              )}
            </Row>
          ) : null}
          {/* Margin & Markup % are derived downstream — read-only here. */}
          {readonlyField('margin_percent', 'Margin', { suffix: '%' })}
          {readonlyField('markup_percent', 'Markup %', { suffix: '%' })}
          {switchField('allow_subcontractors', 'Allow subcontractors', 'C2C / non-W2 OK')}
        </div>
      </Card>

      {/* ── 5. Job description ── */}
      <Card>
        <CardHead
          title={
            <>
              <Icons.IconFile className="rc-card__hic" />
              Job description
              <ReqProvenanceChip prov={prov('description')} />
            </>
          }
        />
        <div className="rc-fgrid">
          <div className="rc-ifield rc-ifield--full">
            {editable ? (
              <TextArea
                unstyled
                className={`rc-jd ${inputClass('description')}`}
                rows={10}
                value={jd}
                aria-label="Job description"
                placeholder="Paste or write the job description…"
                disabled={disabled}
                onChange={(e) => set('description')(e.target.value)}
              />
            ) : (
              <ViewText value={jd} />
            )}
          </div>
        </div>
      </Card>

      {/* ── 6. Requirement skills (domain widget via the slot) ── */}
      <Card>
        <CardHead
          title={
            <>
              <Icons.IconTag className="rc-card__hic" />
              Requirement skills
            </>
          }
        />
        {skillsSlot}
      </Card>

      {/* ── 7. Work authorization (sensitive) ── */}
      <Card>
        <CardHead
          title={
            <>
              <span className="rc-card__hnowrap">
                <Icons.IconShield className="rc-card__hic" />
                Work authorization
              </span>
              <span className="rc-card__sens">sensitive</span>
            </>
          }
        />
        <div className="rc-fgrid">
          {selectField('work_authorization', 'Authorization required', WORK_AUTHORIZATION_VALUES, {
            full: true,
          })}
        </div>
      </Card>

      {/* ── 8. Additional fields (collapsible; Financial planning restricted) ── */}
      <Card>
        <details className="rc-addl" open={mode !== 'view'}>
          <summary className="rc-addl__summary">
            <Icons.IconColumns className="rc-card__hic" />
            Additional fields
            <span className="rc-addl__hint">classification · schedule · source</span>
          </summary>
          <div className="rc-addl__body">
            <div className="rc-fgrid">
              {textField('labor_category', 'Labor category')}
              {selectField('role_family', 'Role family', ROLE_FAMILY_VALUES)}
              {selectField('seniority_level', 'Seniority level', SENIORITY_LEVEL_VALUES)}
              {selectField('headcount_reason', 'Headcount reason', HEADCOUNT_REASON_VALUES)}
              {textField('travel_percent', 'Travel percent', { type: 'number' })}
              {switchField('relocation_offered', 'Relocation offered', 'Yes')}
              {textField('hours_per_week', 'Hours per week', { type: 'number' })}
              {switchField('extension_possible', 'Extension possible', 'Yes')}
              {selectField('source_system', 'Source system', SOURCE_SYSTEM_VALUES)}
              {textField('external_req_id', 'External req ID')}
            </div>

            {financialsVisible ? (
              <div className="rc-addl__fin">
                <div className="rc-addl__finh">
                  <Icons.IconShield />
                  Financial planning
                  <span className="rc-card__sens">restricted</span>
                </div>
                <div className="rc-fgrid">
                  {textField('target_margin_percent', 'Target margin %')}
                  {textField('markup_percent_target', 'Markup % target')}
                  {textField('rate_card_id', 'Rate card ID')}
                  {textField('min_bill_rate', 'Min bill rate')}
                  {textField('max_bill_rate', 'Max bill rate')}
                  {textField('min_pay_rate', 'Min pay rate')}
                  {textField('max_pay_rate', 'Max pay rate')}
                </div>
              </div>
            ) : null}
          </div>
        </details>
      </Card>
    </div>
  );
}
