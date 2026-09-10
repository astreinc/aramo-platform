import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, InlineAlert } from '../ui';
import { formatPhone } from '../format/phone';

import {
  AVAILABILITY_LABELS,
  AVAILABILITY_STATUS_VALUES,
  ENGAGEMENT_LABELS,
  ENGAGEMENT_TYPE_VALUES,
  WORK_AUTHORIZATION_LABELS,
  WORK_AUTHORIZATION_VALUES,
  type AvailabilityStatus,
  type EngagementType,
  type WorkAuthorization,
} from './stated-fields';
import {
  createAttachment,
  putResumeToStorage,
  requestResumeUploadUrl,
  updateTalent,
} from './talent-api';
import type { TalentRecordView, UpdateTalentRecordRequest } from './types';

// Edit-profile slide-over (design-prototype "Edit talent details" drawer),
// the recruiter QUICK-edit for a promoted talent. Field authority is grounded
// against the TM-L4 Talent Profile directive + the talent-record PATCH DTO:
//
//   EDITABLE   first/last name, city, state, work authorization, engagement
//              type, availability, desired rate, available-from, and RÉSUMÉ
//              (replace — reuses the create-side résumé pipeline).
//   READ-ONLY  Primary email + phone — used for identity resolution / dedup;
//              displayed, never edited here (agreed with PO).
//   REQUIRED   names, city, state, work authorization (a choice — NOT_DISCLOSED
//              is a valid explicit selection), desired rate. FE validation only
//              (the DB stays nullable for staged/externally-sourced records).
//   OUT        Title + Country (no backing column yet — backend track), and
//              verified-identity / consent / trust-evidence (owned by their own
//              flows — never edited here, per the directive + prototype note).
//
// Save = PATCH /v1/talent-records/:id; the returned record is handed back so
// the detail view re-renders without a refetch. The footer keeps the
// "Edit full profile →" link to the full workspace route.

interface Props {
  readonly talent: TalentRecordView;
  readonly onClose: () => void;
  readonly onSaved: (updated: TalentRecordView) => void;
}

type ResumeStatus = 'idle' | 'uploading' | 'done' | 'error';

function initials(t: TalentRecordView): string {
  const s = `${t.first_name.charAt(0)}${t.last_name.charAt(0)}`.toUpperCase();
  return s === '' ? '—' : s;
}

export function TalentEditDrawer({ talent, onClose, onSaved }: Props) {
  const [firstName, setFirstName] = useState(talent.first_name);
  const [lastName, setLastName] = useState(talent.last_name);
  // Email + phone are identity/dedup anchors: READ-ONLY once set, but a genuine
  // record that is MISSING them (e.g. externally sourced) can be completed here.
  const [email1, setEmail1] = useState(talent.email1 ?? '');
  const [phoneCell, setPhoneCell] = useState(talent.phone_cell ?? '');
  const [city, setCity] = useState(talent.city ?? '');
  const [state, setState] = useState(talent.state ?? '');
  const [workAuth, setWorkAuth] = useState<string>(talent.work_authorization ?? '');
  const [engagement, setEngagement] = useState<string>(talent.engagement_type ?? '');
  const [availability, setAvailability] = useState<string>(talent.availability_status ?? '');
  const [desiredPay, setDesiredPay] = useState(talent.desired_pay ?? '');
  const [availableFrom, setAvailableFrom] = useState(talent.date_available ?? '');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  const [resumeStatus, setResumeStatus] = useState<ResumeStatus>('idle');
  const [resumeName, setResumeName] = useState<string | null>(null);

  const phone = talent.phone_cell ?? talent.phone_home ?? talent.phone_work;
  // "Present" = already on the record → locked. Missing → the recruiter may
  // enter it. Any stored phone slot counts as present.
  const emailPresent = (talent.email1 ?? '') !== '';
  const phonePresent =
    (talent.phone_cell ?? '') !== '' ||
    (talent.phone_home ?? '') !== '' ||
    (talent.phone_work ?? '') !== '';

  // FE-required set (manual-path parity). DB stays nullable.
  const emailFormatBad =
    !emailPresent && email1.trim() !== '' && !/\S+@\S+\.\S+/.test(email1.trim());
  const errors = {
    firstName: firstName.trim() === '',
    lastName: lastName.trim() === '',
    city: city.trim() === '',
    state: state.trim() === '',
    workAuth: workAuth === '',
    desiredPay: desiredPay.trim() === '',
    emailFormat: emailFormatBad,
  };
  const hasErrors = Object.values(errors).some(Boolean);

  const onSave = () => {
    if (hasErrors) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    setError(null);
    const patch: UpdateTalentRecordRequest = {
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      city: city.trim(),
      state: state.trim(),
      work_authorization: workAuth as WorkAuthorization,
      desired_pay: desiredPay.trim(),
      // Optional talent-stated selects — empty clears to "not stated".
      engagement_type: engagement === '' ? null : (engagement as EngagementType),
      availability_status:
        availability === '' ? null : (availability as AvailabilityStatus),
      date_available: availableFrom === '' ? null : availableFrom,
      // Email / phone are patched ONLY when they were missing and the recruiter
      // supplied one — a present (locked) value is never re-sent.
      ...(!emailPresent && email1.trim() !== '' ? { email1: email1.trim() } : {}),
      ...(!phonePresent && phoneCell.trim() !== ''
        ? { phone_cell: phoneCell.trim() }
        : {}),
    };
    updateTalent(talent.id, patch)
      .then((updated) => {
        setSaving(false);
        onSaved(updated);
      })
      .catch(() => {
        setSaving(false);
        setError('We couldn’t save the changes. Please try again.');
      });
  };

  const onReplaceResume = (file: File | undefined) => {
    if (file === undefined) return;
    setResumeStatus('uploading');
    setResumeName(file.name);
    const contentType = file.type === '' ? 'application/octet-stream' : file.type;
    requestResumeUploadUrl({ filename: file.name, content_type: contentType })
      .then((presign) =>
        putResumeToStorage(presign.presigned_url, file, contentType).then(() =>
          createAttachment({
            owner_type: 'talent',
            owner_id: talent.id,
            file_name: file.name,
            mime: contentType,
            size_bytes: file.size,
            storage_key: presign.storage_key,
            is_resume: true,
          }),
        ),
      )
      .then(() => setResumeStatus('done'))
      .catch(() => setResumeStatus('error'));
  };

  const err = (on: boolean) =>
    showErrors && on ? ' talent-detail__field--error' : '';

  return (
    <>
      <div className="talent-detail__scrim" onClick={onClose} aria-hidden="true" />
      <aside
        className="talent-detail__drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Edit talent details"
      >
        <header className="talent-detail__drawer-head">
          <span className="talent-detail__avatar talent-detail__avatar--sm" aria-hidden="true">
            {initials(talent)}
          </span>
          <div className="talent-detail__drawer-head-main">
            <div className="talent-detail__drawer-title">Edit talent details</div>
            <div className="talent-detail__drawer-sub">
              {talent.first_name} {talent.last_name} · changes are versioned and logged
            </div>
          </div>
          <button
            type="button"
            className="talent-detail__drawer-x"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="talent-detail__drawer-body">
          {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}

          <DrawerSection label="IDENTITY">
            <div className="talent-detail__refgrid">
              <label className={`talent-detail__field${err(errors.firstName)}`}>
                <span>First name *</span>
                <input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
              </label>
              <label className={`talent-detail__field${err(errors.lastName)}`}>
                <span>Last name *</span>
                <input value={lastName} onChange={(e) => setLastName(e.target.value)} />
              </label>
            </div>
          </DrawerSection>

          <DrawerSection label="CONTACT">
            <div className="talent-detail__refgrid">
              {emailPresent ? (
                <div className="talent-detail__field">
                  <span>Email <em className="talent-detail__ro">read-only</em></span>
                  <div className="talent-detail__ro-value">{talent.email1}</div>
                </div>
              ) : (
                <label className={`talent-detail__field${err(errors.emailFormat)}`}>
                  <span>Email</span>
                  <input
                    type="email"
                    value={email1}
                    placeholder="name@email.com"
                    onChange={(e) => setEmail1(e.target.value)}
                  />
                </label>
              )}
              {phonePresent ? (
                <div className="talent-detail__field">
                  <span>Phone <em className="talent-detail__ro">read-only</em></span>
                  <div className="talent-detail__ro-value">{formatPhone(phone)}</div>
                </div>
              ) : (
                <label className="talent-detail__field">
                  <span>Phone</span>
                  <input
                    type="tel"
                    value={phoneCell}
                    placeholder="(555) 555-5555"
                    onChange={(e) => setPhoneCell(e.target.value)}
                  />
                </label>
              )}
            </div>
            <p className="talent-detail__note" style={{ marginTop: 8 }}>
              Email and phone anchor identity resolution and de-duplication. They
              can be entered while unset; once saved they become read-only.
            </p>
          </DrawerSection>

          <DrawerSection label="LOCATION & WORK">
            <div className="talent-detail__refgrid">
              <label className={`talent-detail__field${err(errors.city)}`}>
                <span>City *</span>
                <input value={city} onChange={(e) => setCity(e.target.value)} />
              </label>
              <label className={`talent-detail__field${err(errors.state)}`}>
                <span>State *</span>
                <input value={state} onChange={(e) => setState(e.target.value)} />
              </label>
              <label className={`talent-detail__field${err(errors.workAuth)}`}>
                <span>Work authorization *</span>
                <select value={workAuth} onChange={(e) => setWorkAuth(e.target.value)}>
                  <option value="">Select…</option>
                  {WORK_AUTHORIZATION_VALUES.map((v) => (
                    <option key={v} value={v}>{WORK_AUTHORIZATION_LABELS[v]}</option>
                  ))}
                </select>
              </label>
              <label className="talent-detail__field">
                <span>Engagement type</span>
                <select value={engagement} onChange={(e) => setEngagement(e.target.value)}>
                  <option value="">Not stated</option>
                  {ENGAGEMENT_TYPE_VALUES.map((v) => (
                    <option key={v} value={v}>{ENGAGEMENT_LABELS[v]}</option>
                  ))}
                </select>
              </label>
            </div>
          </DrawerSection>

          <DrawerSection label="RATES & AVAILABILITY">
            <div className="talent-detail__refgrid">
              <label className={`talent-detail__field${err(errors.desiredPay)}`}>
                <span>Desired rate *</span>
                <input
                  value={desiredPay}
                  onChange={(e) => setDesiredPay(e.target.value)}
                  placeholder="e.g. $95/hr"
                />
              </label>
              <label className="talent-detail__field">
                <span>Availability</span>
                <select value={availability} onChange={(e) => setAvailability(e.target.value)}>
                  <option value="">Not stated</option>
                  {AVAILABILITY_STATUS_VALUES.map((v) => (
                    <option key={v} value={v}>{AVAILABILITY_LABELS[v]}</option>
                  ))}
                </select>
              </label>
              <label className="talent-detail__field">
                <span>Available from</span>
                <input
                  type="date"
                  value={availableFrom}
                  onChange={(e) => setAvailableFrom(e.target.value)}
                />
              </label>
            </div>
          </DrawerSection>

          <DrawerSection label="RÉSUMÉ">
            <div className="talent-detail__resume-row">
              <div className="talent-detail__resume-info">
                {resumeStatus === 'done'
                  ? `New résumé attached${resumeName !== null ? ` · ${resumeName}` : ''}`
                  : resumeStatus === 'uploading'
                    ? 'Uploading…'
                    : resumeStatus === 'error'
                      ? 'Upload failed — try again.'
                      : 'Replace the résumé on file. The previous version stays in Documents.'}
              </div>
              <label className="tc-button tc-button--secondary tc-button--sm talent-detail__resume-btn">
                Replace
                <input
                  type="file"
                  accept=".pdf,.doc,.docx"
                  aria-label="Replace résumé"
                  hidden
                  onChange={(e) => onReplaceResume(e.target.files?.[0])}
                />
              </label>
            </div>
          </DrawerSection>

          <div className="talent-detail__drawer-info">
            Fields shown are the ones you're authorized to edit. Verified identity
            and contact permissions are owned by their flows and can't be edited
            here. Evidence-backed work history, verified values, source provenance
            and identity-merge state are never silently overwritten from this
            panel. Skills and work history are edited from their own sections.
          </div>
        </div>

        <footer className="talent-detail__drawer-foot">
          <Button variant="primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Link
            to={`/talent/${talent.id}/edit`}
            className="talent-detail__drawer-full"
            title="Employment, education, certifications, provenance and evidence are edited in the full workspace"
          >
            Edit full profile →
          </Link>
        </footer>
      </aside>
    </>
  );
}

function DrawerSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="talent-detail__drawer-sec">
      <div className="talent-detail__drawer-sec-label">
        <span>{label}</span>
        <span className="talent-detail__drawer-sec-rule" />
      </div>
      {children}
    </section>
  );
}
