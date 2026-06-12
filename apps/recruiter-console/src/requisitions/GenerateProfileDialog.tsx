import { useState } from 'react';
import {
  Button,
  Dialog,
  FormField,
  InlineAlert,
  useToast,
} from '@aramo/fe-foundation';

import {
  confirmRequisitionProfile,
  draftRequisitionProfile,
} from './requisitions-api';
import {
  ROLE_FAMILY_VALUES,
  SENIORITY_LEVEL_VALUES,
  enterpriseLabel,
} from './enterprise-fields';
import {
  emptyGoldenProfile,
  parseIndustryList,
  parsePreferredSkillList,
  parseSkillList,
  skillListToText,
  type GoldenProfileContent,
} from './golden-profile';
import type { RequisitionView } from './types';

// Job-Module — the AI "Generate profile from brief" surface (draft →
// review → confirm). Three phases:
//   1. BRIEF: a textarea for the recruiter's free-text brief + Generate.
//   2. REVIEW: the returned jd_text (editable) + the structured profile
//      (editable: role_family / seniority / skills / experience /
//      constraints). Manual entry is always possible — "Edit manually"
//      skips the AI and opens a blank draft.
//   3. CONFIRM: persists the (possibly hand-edited) profile; on success
//      surfaces "Profile linked" + the golden_profile_id.
//
// The AI is assistive, never required: the recruiter can open the dialog,
// click "Edit manually", fill the profile by hand, and confirm.

type Phase = 'brief' | 'review';

interface GenerateProfileDialogProps {
  readonly requisitionId: string;
  // Set by /profile/confirm; surfaced after a successful link.
  readonly onConfirmed?: (req: RequisitionView) => void;
}

export function GenerateProfileDialog({
  requisitionId,
  onConfirmed,
}: GenerateProfileDialogProps) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('brief');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  // Review-phase state. draftEventId threads the draft through confirm.
  const [draftEventId, setDraftEventId] = useState<string | null>(null);
  const [jdText, setJdText] = useState('');
  const [profile, setProfile] = useState<GoldenProfileContent>(() =>
    emptyGoldenProfile(),
  );
  // Skill lists are edited as comma/newline text; mapped to objects at
  // confirm time.
  const [requiredText, setRequiredText] = useState('');
  const [preferredText, setPreferredText] = useState('');
  const [criticalText, setCriticalText] = useState('');
  const [industriesText, setIndustriesText] = useState('');

  function reset(): void {
    setPhase('brief');
    setBrief('');
    setBusy(false);
    setError(null);
    setDraftEventId(null);
    setJdText('');
    setProfile(emptyGoldenProfile());
    setRequiredText('');
    setPreferredText('');
    setCriticalText('');
    setIndustriesText('');
  }

  function loadProfileIntoReview(
    next: GoldenProfileContent,
    nextJd: string,
    eventId: string | null,
  ): void {
    setProfile(next);
    setJdText(nextJd);
    setDraftEventId(eventId);
    setRequiredText(skillListToText(next.required_skills));
    setPreferredText(skillListToText(next.preferred_skills));
    setCriticalText(skillListToText(next.critical_skills));
    setIndustriesText(next.experience.industries.join(', '));
    setPhase('review');
  }

  async function onGenerate(): Promise<void> {
    if (brief.trim() === '') {
      setError('Please enter a brief before generating.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await draftRequisitionProfile(requisitionId, {
        brief: brief.trim(),
      });
      loadProfileIntoReview(
        res.golden_profile_draft,
        res.jd_text,
        res.draft_event_id,
      );
    } catch {
      setError('Could not generate a profile from this brief. Please try again or edit manually.');
    } finally {
      setBusy(false);
    }
  }

  function onEditManually(): void {
    // Skip the AI: open a blank manual draft in the review phase.
    loadProfileIntoReview(emptyGoldenProfile(), '', null);
  }

  async function onConfirm(): Promise<void> {
    setBusy(true);
    setError(null);
    const composed: GoldenProfileContent = {
      ...profile,
      jd_text: jdText,
      required_skills: parseSkillList(requiredText),
      preferred_skills: parsePreferredSkillList(preferredText),
      critical_skills: parseSkillList(criticalText),
      experience: {
        ...profile.experience,
        industries: parseIndustryList(industriesText),
      },
    };
    try {
      const updated = await confirmRequisitionProfile(requisitionId, {
        draft_event_id: draftEventId ?? '',
        jd_text: jdText,
        golden_profile: composed,
      });
      toast.show(
        updated.golden_profile_id !== null
          ? `Profile linked (${updated.golden_profile_id}).`
          : 'Profile linked.',
      );
      setOpen(false);
      reset();
      onConfirmed?.(updated);
    } catch {
      setError('Could not link the profile. Please try again.');
      setBusy(false);
    }
  }

  function setExperience<K extends keyof GoldenProfileContent['experience']>(
    key: K,
    value: GoldenProfileContent['experience'][K],
  ): void {
    setProfile((p) => ({ ...p, experience: { ...p.experience, [key]: value } }));
  }

  function setConstraint<K extends keyof GoldenProfileContent['constraints']>(
    key: K,
    value: GoldenProfileContent['constraints'][K],
  ): void {
    setProfile((p) => ({ ...p, constraints: { ...p.constraints, [key]: value } }));
  }

  return (
    <>
      <Button
        variant="secondary"
        type="button"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        Generate profile from brief
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title="Generate profile from brief"
        description="Draft a golden profile from a free-text brief, then review and confirm. You can also edit manually — the AI is optional."
        size="lg"
        footer={
          phase === 'brief' ? (
            <>
              <Button
                variant="secondary"
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="secondary"
                type="button"
                onClick={onEditManually}
                disabled={busy}
              >
                Edit manually
              </Button>
              <Button
                variant="primary"
                type="button"
                onClick={() => void onGenerate()}
                disabled={busy}
              >
                {busy ? 'Generating…' : 'Generate'}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                type="button"
                onClick={() => setPhase('brief')}
                disabled={busy}
              >
                Back
              </Button>
              <Button
                variant="primary"
                type="button"
                onClick={() => void onConfirm()}
                disabled={busy}
              >
                {busy ? 'Linking…' : 'Confirm'}
              </Button>
            </>
          )
        }
      >
        {phase === 'brief' ? (
          <FormField
            label="Brief"
            helper="Describe the role in plain language. The AI will draft a JD and a structured profile you can edit."
          >
            <textarea
              value={brief}
              onChange={(ev) => setBrief(ev.target.value)}
              rows={6}
              aria-label="Brief"
              disabled={busy}
            />
          </FormField>
        ) : (
          <div className="req-profile-review">
            <FormField label="JD text">
              <textarea
                value={jdText}
                onChange={(ev) => setJdText(ev.target.value)}
                rows={8}
                aria-label="JD text"
                disabled={busy}
              />
            </FormField>

            <FormField label="Role family">
              <select
                value={profile.role_family ?? ''}
                onChange={(ev) =>
                  setProfile((p) => ({
                    ...p,
                    role_family: ev.target.value === '' ? undefined : ev.target.value,
                  }))
                }
                aria-label="Profile role family"
              >
                <option value="">— Not specified —</option>
                {ROLE_FAMILY_VALUES.map((rf) => (
                  <option key={rf} value={rf}>
                    {enterpriseLabel(rf)}
                  </option>
                ))}
              </select>
            </FormField>

            <FormField label="Seniority level">
              <select
                value={profile.seniority_level ?? ''}
                onChange={(ev) =>
                  setProfile((p) => ({
                    ...p,
                    seniority_level:
                      ev.target.value === '' ? undefined : ev.target.value,
                  }))
                }
                aria-label="Profile seniority level"
              >
                <option value="">— Not specified —</option>
                {SENIORITY_LEVEL_VALUES.map((sl) => (
                  <option key={sl} value={sl}>
                    {enterpriseLabel(sl)}
                  </option>
                ))}
              </select>
            </FormField>

            <FormField
              label="Required skills"
              helper="Comma or newline separated."
            >
              <textarea
                value={requiredText}
                onChange={(ev) => setRequiredText(ev.target.value)}
                rows={2}
                aria-label="Required skills"
                disabled={busy}
              />
            </FormField>

            <FormField
              label="Preferred skills"
              helper="Comma or newline separated."
            >
              <textarea
                value={preferredText}
                onChange={(ev) => setPreferredText(ev.target.value)}
                rows={2}
                aria-label="Preferred skills"
                disabled={busy}
              />
            </FormField>

            <FormField
              label="Critical skills"
              helper="Comma or newline separated."
            >
              <textarea
                value={criticalText}
                onChange={(ev) => setCriticalText(ev.target.value)}
                rows={2}
                aria-label="Critical skills"
                disabled={busy}
              />
            </FormField>

            <fieldset className="req-profile-review__group">
              <legend>Experience</legend>
              <FormField label="Total years">
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={profile.experience.total_years ?? ''}
                  onChange={(ev) =>
                    setExperience(
                      'total_years',
                      ev.target.value === ''
                        ? undefined
                        : Number(ev.target.value),
                    )
                  }
                  aria-label="Total years"
                />
              </FormField>
              <FormField label="Domain">
                <input
                  type="text"
                  value={profile.experience.domain ?? ''}
                  onChange={(ev) =>
                    setExperience(
                      'domain',
                      ev.target.value === '' ? undefined : ev.target.value,
                    )
                  }
                  aria-label="Domain"
                />
              </FormField>
              <FormField
                label="Industries"
                helper="Comma or newline separated."
              >
                <textarea
                  value={industriesText}
                  onChange={(ev) => setIndustriesText(ev.target.value)}
                  rows={2}
                  aria-label="Industries"
                />
              </FormField>
            </fieldset>

            <fieldset className="req-profile-review__group">
              <legend>Constraints</legend>
              <FormField label="Location">
                <input
                  type="text"
                  value={profile.constraints.location ?? ''}
                  onChange={(ev) =>
                    setConstraint(
                      'location',
                      ev.target.value === '' ? undefined : ev.target.value,
                    )
                  }
                  aria-label="Constraint location"
                />
              </FormField>
              <FormField label="Work mode">
                <input
                  type="text"
                  value={profile.constraints.work_mode ?? ''}
                  onChange={(ev) =>
                    setConstraint(
                      'work_mode',
                      ev.target.value === '' ? undefined : ev.target.value,
                    )
                  }
                  aria-label="Constraint work mode"
                />
              </FormField>
              <FormField label="Rate">
                <input
                  type="text"
                  value={profile.constraints.rate ?? ''}
                  onChange={(ev) =>
                    setConstraint(
                      'rate',
                      ev.target.value === '' ? undefined : ev.target.value,
                    )
                  }
                  aria-label="Constraint rate"
                />
              </FormField>
              <FormField label="Work authorization">
                <input
                  type="text"
                  value={profile.constraints.work_authorization ?? ''}
                  onChange={(ev) =>
                    setConstraint(
                      'work_authorization',
                      ev.target.value === '' ? undefined : ev.target.value,
                    )
                  }
                  aria-label="Constraint work authorization"
                />
              </FormField>
            </fieldset>
          </div>
        )}
        {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      </Dialog>
    </>
  );
}
