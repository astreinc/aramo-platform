import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  FormField,
  InlineAlert,
  useToast,
} from '@aramo/fe-foundation';

import {
  InlineChipInput,
  InlineEditField,
  InlineSelectField,
} from '../components/InlineEditField';

import {
  ROLE_FAMILY_VALUES,
  SENIORITY_LEVEL_VALUES,
  enterpriseLabel,
} from './enterprise-fields';
import {
  emptyGoldenProfile,
  parsePreferredSkillList,
  parseSkillList,
  profileViewToContent,
  skillListToText,
  type GoldenProfileContent,
  type RequisitionProfileView,
} from './golden-profile';
import {
  confirmRequisitionProfile,
  draftRequisitionProfile,
  getRequisitionProfile,
} from './requisitions-api';

// PR-A2 P3 — the persistent GoldenProfile WORKBENCH panel (supersedes the
// transient GenerateProfileDialog, retired in P4). Three affordances, each
// scope-gated:
//   - READ (any requisition:read holder, which the cockpit already requires):
//     the profile renders read-only.
//   - GENERATE (requisition:profile:generate — the 5-role mgmt tier): the
//     "Generate from brief" / "Regenerate" flow (draft → review → confirm),
//     reusing A1's re-gated endpoints.
//   - EDIT (requisition:profile:edit): inline-edit the profile fields via the
//     P2 primitive. A hand-edit re-confirms with generated_by:'manual'.
//   - MATCH-TALENT: present but DISABLED until PR-C (R7) — no matching call,
//     no false promise.
//
// A recruiter (no profile:generate/:edit) sees the profile READ-ONLY and a
// disabled generate affordance — the backend write endpoints 403 regardless.

const ROLE_OPTIONS = ROLE_FAMILY_VALUES.map((v) => ({
  value: v,
  label: enterpriseLabel(v),
}));
const SENIORITY_OPTIONS = SENIORITY_LEVEL_VALUES.map((v) => ({
  value: v,
  label: enterpriseLabel(v),
}));

interface ProfileWorkbenchPanelProps {
  readonly requisitionId: string;
  readonly scopes: readonly string[];
  readonly onProfileLinked?: () => void;
}

type GenPhase = 'idle' | 'brief' | 'review';

export function ProfileWorkbenchPanel({
  requisitionId,
  scopes,
  onProfileLinked,
}: ProfileWorkbenchPanelProps) {
  const [profile, setProfile] = useState<RequisitionProfileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const toast = useToast();

  const canGenerate = scopes.includes('requisition:profile:generate');
  const canEditProfile = scopes.includes('requisition:profile:edit');

  // Generate flow state.
  const [phase, setPhase] = useState<GenPhase>('idle');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [draftEventId, setDraftEventId] = useState<string | null>(null);
  const [reviewProfile, setReviewProfile] = useState<GoldenProfileContent>(() =>
    emptyGoldenProfile(),
  );
  const [reviewJd, setReviewJd] = useState('');
  const [requiredText, setRequiredText] = useState('');
  const [preferredText, setPreferredText] = useState('');
  const [criticalText, setCriticalText] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    getRequisitionProfile(requisitionId)
      .then((res) => {
        if (cancelled) return;
        setProfile(res);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError('The profile could not be loaded.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [requisitionId]);

  async function reload(): Promise<void> {
    const res = await getRequisitionProfile(requisitionId);
    setProfile(res);
    onProfileLinked?.();
  }

  // --- Inline-edit save (PROFILE bucket → requisition:profile:edit). A
  //     single-field edit re-confirms the whole content (the only write
  //     path), marked manual so no draft_event_id is required. ---
  async function saveProfilePatch(
    patch: Partial<GoldenProfileContent>,
  ): Promise<void> {
    if (profile === null) return;
    const content: GoldenProfileContent = {
      ...profileViewToContent(profile),
      ...patch,
    };
    await confirmRequisitionProfile(requisitionId, {
      draft_event_id: '',
      jd_text: content.jd_text,
      golden_profile: content,
    });
    await reload();
  }

  // --- Generate flow (requisition:profile:generate) ---
  function openBrief(): void {
    setPhase('brief');
    setBrief('');
    setGenError(null);
  }

  function loadDraftIntoReview(
    next: GoldenProfileContent,
    jd: string,
    eventId: string | null,
  ): void {
    setReviewProfile(next);
    setReviewJd(jd);
    setDraftEventId(eventId);
    setRequiredText(skillListToText(next.required_skills));
    setPreferredText(skillListToText(next.preferred_skills));
    setCriticalText(skillListToText(next.critical_skills));
    setPhase('review');
  }

  async function onGenerate(): Promise<void> {
    if (brief.trim() === '') {
      setGenError('Please enter a brief before generating.');
      return;
    }
    setBusy(true);
    setGenError(null);
    try {
      const res = await draftRequisitionProfile(requisitionId, {
        brief: brief.trim(),
      });
      loadDraftIntoReview(
        res.golden_profile_draft,
        res.jd_text,
        res.draft_event_id,
      );
    } catch {
      setGenError(
        'Could not generate a profile from this brief. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm(): Promise<void> {
    setBusy(true);
    setGenError(null);
    const composed: GoldenProfileContent = {
      ...reviewProfile,
      jd_text: reviewJd,
      required_skills: parseSkillList(requiredText),
      preferred_skills: parsePreferredSkillList(preferredText),
      critical_skills: parseSkillList(criticalText),
      experience: {
        ...reviewProfile.experience,
        industries: reviewProfile.experience.industries,
      },
      generated_by: draftEventId !== null ? 'ai_draft' : 'manual',
    };
    try {
      await confirmRequisitionProfile(requisitionId, {
        draft_event_id: draftEventId ?? '',
        jd_text: reviewJd,
        golden_profile: composed,
      });
      toast.show('Profile linked.');
      setPhase('idle');
      await reload();
    } catch {
      setGenError('Could not link the profile. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="req-profile__header">
        <h2 className="req-profile__title">Profile</h2>
        {profile !== null && profile.generated_by !== null ? (
          <span className="req-profile__provenance">
            {profile.generated_by === 'ai_draft'
              ? 'AI-generated'
              : 'Manual'}
          </span>
        ) : null}
        {/* Match-talent — DISABLED until PR-C (R7). No endpoint call. */}
        <Button
          type="button"
          variant="secondary"
          disabled
          title="Matching is not available yet."
        >
          Match talent (coming soon)
        </Button>
      </div>

      {loading ? <p>Loading profile…</p> : null}
      {loadError !== null ? (
        <InlineAlert variant="error">{loadError}</InlineAlert>
      ) : null}

      {profile !== null && !loading ? (
        <>
          {!profile.has_profile ? (
            <p className="req-profile__empty">
              No profile has been generated for this requisition yet.
              {canGenerate
                ? ' Use “Generate from brief” to create one.'
                : ''}
            </p>
          ) : (
            <div className="req-profile__fields">
              <InlineEditField
                label="JD text"
                value={profile.jd_text === '' ? null : profile.jd_text}
                canEdit={canEditProfile}
                multiline
                testId="profile-jd-text"
                onSave={(next) =>
                  saveProfilePatch({ jd_text: next ?? '' })
                }
              />
              <InlineSelectField
                label="Role family"
                value={profile.role_family}
                canEdit={canEditProfile}
                options={ROLE_OPTIONS}
                testId="profile-role-family"
                onSave={(next) =>
                  saveProfilePatch({ role_family: next ?? undefined })
                }
              />
              <InlineSelectField
                label="Seniority level"
                value={profile.seniority_level}
                canEdit={canEditProfile}
                options={SENIORITY_OPTIONS}
                testId="profile-seniority"
                onSave={(next) =>
                  saveProfilePatch({ seniority_level: next ?? undefined })
                }
              />
              <InlineChipInput
                label="Required skills"
                values={profile.required_skills.map((s) => s.name)}
                canEdit={canEditProfile}
                testId="profile-required-skills"
                onSave={(next) =>
                  saveProfilePatch({
                    required_skills: next.map((name) => ({ name })),
                  })
                }
              />
              <InlineChipInput
                label="Preferred skills"
                values={profile.preferred_skills.map((s) => s.name)}
                canEdit={canEditProfile}
                testId="profile-preferred-skills"
                onSave={(next) =>
                  saveProfilePatch({
                    preferred_skills: next.map((name) => ({ name })),
                  })
                }
              />
              <InlineChipInput
                label="Critical skills"
                values={profile.critical_skills.map((s) => s.name)}
                canEdit={canEditProfile}
                testId="profile-critical-skills"
                onSave={(next) =>
                  saveProfilePatch({
                    critical_skills: next.map((name) => ({ name })),
                  })
                }
              />
            </div>
          )}

          {/* Generate / Regenerate — gated on requisition:profile:generate. */}
          {canGenerate ? (
            <div className="req-profile__generate">
              {phase === 'idle' ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={openBrief}
                  data-testid="profile-generate-open"
                >
                  {profile.has_profile
                    ? 'Regenerate from brief'
                    : 'Generate from brief'}
                </Button>
              ) : null}

              {phase === 'brief' ? (
                <div className="req-profile__brief">
                  <FormField
                    label="Brief"
                    helper="Describe the role in plain language. The AI drafts a JD and a structured profile you can review."
                  >
                    <textarea
                      value={brief}
                      onChange={(ev) => setBrief(ev.target.value)}
                      rows={5}
                      aria-label="Brief"
                      disabled={busy}
                    />
                  </FormField>
                  <div className="req-profile__actions">
                    <Button
                      type="button"
                      variant="primary"
                      onClick={() => void onGenerate()}
                      disabled={busy}
                    >
                      {busy ? 'Generating…' : 'Generate'}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setPhase('idle')}
                      disabled={busy}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}

              {phase === 'review' ? (
                <div className="req-profile__review">
                  <FormField label="JD text">
                    <textarea
                      value={reviewJd}
                      onChange={(ev) => setReviewJd(ev.target.value)}
                      rows={8}
                      aria-label="Draft JD text"
                      disabled={busy}
                    />
                  </FormField>
                  <FormField label="Role family">
                    <select
                      value={reviewProfile.role_family ?? ''}
                      aria-label="Draft role family"
                      disabled={busy}
                      onChange={(ev) =>
                        setReviewProfile((p) => ({
                          ...p,
                          role_family:
                            ev.target.value === '' ? undefined : ev.target.value,
                        }))
                      }
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
                      value={reviewProfile.seniority_level ?? ''}
                      aria-label="Draft seniority level"
                      disabled={busy}
                      onChange={(ev) =>
                        setReviewProfile((p) => ({
                          ...p,
                          seniority_level:
                            ev.target.value === '' ? undefined : ev.target.value,
                        }))
                      }
                    >
                      <option value="">— Not specified —</option>
                      {SENIORITY_LEVEL_VALUES.map((sl) => (
                        <option key={sl} value={sl}>
                          {enterpriseLabel(sl)}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="Required skills" helper="Comma or newline separated.">
                    <textarea
                      value={requiredText}
                      onChange={(ev) => setRequiredText(ev.target.value)}
                      rows={2}
                      aria-label="Draft required skills"
                      disabled={busy}
                    />
                  </FormField>
                  <FormField label="Preferred skills" helper="Comma or newline separated.">
                    <textarea
                      value={preferredText}
                      onChange={(ev) => setPreferredText(ev.target.value)}
                      rows={2}
                      aria-label="Draft preferred skills"
                      disabled={busy}
                    />
                  </FormField>
                  <FormField label="Critical skills" helper="Comma or newline separated.">
                    <textarea
                      value={criticalText}
                      onChange={(ev) => setCriticalText(ev.target.value)}
                      rows={2}
                      aria-label="Draft critical skills"
                      disabled={busy}
                    />
                  </FormField>
                  <div className="req-profile__actions">
                    <Button
                      type="button"
                      variant="primary"
                      onClick={() => void onConfirm()}
                      disabled={busy}
                    >
                      {busy ? 'Linking…' : 'Confirm'}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setPhase('brief')}
                      disabled={busy}
                    >
                      Back
                    </Button>
                  </div>
                </div>
              ) : null}

              {genError !== null ? (
                <InlineAlert variant="error">{genError}</InlineAlert>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
