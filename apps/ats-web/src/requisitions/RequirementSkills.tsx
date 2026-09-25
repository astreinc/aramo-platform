import { useEffect, useState } from 'react';
import { Button, Input } from '@aramo/fe-foundation';

import {
  profileViewToContent,
  type RequisitionProfileView,
} from './golden-profile';
import {
  confirmRequisitionProfile,
  getRequisitionProfile,
} from './requisitions-api';

// G2.5 §5 — the Requisition Overview "Requirement skills" section: the prototype
// shows only Required + Nice-to-have chips (no Profile/Manual tabs, no
// Regenerate/Match, no JD/role-family duplication). This replaces the heavier
// ProfileWorkbenchPanel in the shared form's skills slot.
//
// Skills live on the requisition's GoldenProfile (a SEPARATE entity from the
// requisition record), so this section owns its own read + write: view renders
// read-only chips; edit (requisition:profile:edit) adds "×" + an add input and
// persists each change immediately via the existing confirm endpoint — the
// requisition whole-form Save is unaffected.

interface RequirementSkillsProps {
  readonly requisitionId: string;
  readonly mode: 'create' | 'view' | 'edit';
  readonly scopes: readonly string[];
}

// Defensive: the profile payload may omit a skill group entirely (no profile
// yet, or a partial shape) — treat a missing/!array group as empty rather than
// throwing (an uncaught render error here blanks the whole Overview).
function names(list: readonly { readonly name: string }[] | undefined | null): string[] {
  return Array.isArray(list) ? list.map((s) => s.name) : [];
}

export function RequirementSkills({
  requisitionId,
  mode,
  scopes,
}: RequirementSkillsProps): JSX.Element {
  const [profile, setProfile] = useState<RequisitionProfileView | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = mode === 'edit' && scopes.includes('requisition:profile:edit');

  useEffect(() => {
    let cancelled = false;
    getRequisitionProfile(requisitionId)
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch(() => {
        /* skills stay empty ("None stated") on a read error */
      });
    return () => {
      cancelled = true;
    };
  }, [requisitionId]);

  const required = profile ? names(profile.required_skills) : [];
  const nice = profile ? names(profile.preferred_skills) : [];

  // Persist a skill-group change through the existing confirm endpoint (whole
  // content re-confirmed, marked manual). Reloads the authoritative profile.
  async function save(next: {
    required?: string[];
    nice?: string[];
  }): Promise<void> {
    if (profile === null) return;
    setBusy(true);
    try {
      const content = profileViewToContent(profile);
      await confirmRequisitionProfile(requisitionId, {
        draft_event_id: '',
        jd_text: content.jd_text,
        golden_profile: {
          ...content,
          required_skills: (next.required ?? required).map((name) => ({ name })),
          preferred_skills: (next.nice ?? nice).map((name) => ({ name })),
        },
      });
      setProfile(await getRequisitionProfile(requisitionId));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rc-skillsblock">
      <SkillGroup
        label="Required"
        tone="must"
        skills={required}
        editable={editable}
        busy={busy}
        onAdd={(s) => void save({ required: [...required, s] })}
        onRemove={(i) => void save({ required: required.filter((_, j) => j !== i) })}
      />
      <SkillGroup
        label="Nice to have"
        tone="nice"
        skills={nice}
        editable={editable}
        busy={busy}
        onAdd={(s) => void save({ nice: [...nice, s] })}
        onRemove={(i) => void save({ nice: nice.filter((_, j) => j !== i) })}
      />
    </div>
  );
}

function SkillGroup({
  label,
  tone,
  skills,
  editable,
  busy,
  onAdd,
  onRemove,
}: {
  readonly label: string;
  readonly tone: 'must' | 'nice';
  readonly skills: readonly string[];
  readonly editable: boolean;
  readonly busy: boolean;
  readonly onAdd: (s: string) => void;
  readonly onRemove: (i: number) => void;
}) {
  const [draft, setDraft] = useState('');
  function commit(): void {
    const v = draft.trim();
    if (v !== '' && !skills.includes(v)) onAdd(v);
    setDraft('');
  }
  return (
    <div className="rc-skillgroup">
      <div className="rc-skillgroup__lb">{label}</div>
      <div className="rc-skills">
        {skills.map((s, i) => (
          <span key={`${s}-${i}`} className={`rc-skillchip rc-skillchip--${tone}`}>
            {s}
            {editable ? (
              <Button
                type="button"
                aria-label={`Remove ${s}`}
                disabled={busy}
                onClick={() => onRemove(i)}
              >
                ×
              </Button>
            ) : null}
          </span>
        ))}
        {skills.length === 0 && !editable ? (
          <span className="rc-skills__empty">None stated</span>
        ) : null}
      </div>
      {editable ? (
        <div className="rc-skilladd">
          <Input
            unstyled
            className="rc-input"
            value={draft}
            aria-label={`Add ${label.toLowerCase()} skill`}
            placeholder="Add a skill…"
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              }
            }}
          />
          <Button
            unstyled
            type="button"
            className="rc-btn rc-btn--sm"
            disabled={busy}
            onClick={commit}
          >
            + Add
          </Button>
        </div>
      ) : null}
    </div>
  );
}
