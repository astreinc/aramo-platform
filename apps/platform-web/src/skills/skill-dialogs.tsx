import { useState } from 'react';

import {
  ConfirmDialog,
  FieldAck,
  FieldSelect,
  FieldText,
  FieldTextArea,
  type FieldSelectOption,
} from '../components';

import {
  skillsApi,
  ALIAS_TYPES,
  RELATIONSHIP_SOURCES,
  RELATIONSHIP_TYPES,
  type Skill,
  type SkillAliasType,
  type SkillRelationshipSource,
  type SkillRelationshipType,
} from './skills-api';
import {
  ALIAS_TYPE_LABEL,
  RELATIONSHIP_SOURCE_LABEL,
  RELATIONSHIP_TYPE_LABEL,
  SYMMETRIC_RELATIONSHIP_TYPES,
  statusPill,
} from './skill-labels';
import { skillErrorMessage } from './skill-errors';
import type { SkillDirectory } from './skill-directory';

// PLATFORM-UX-1 F-7 — the Skills dialogs, on the platform ConfirmDialog
// (handoff §3.8): title, Change box where the design has one, consequence line,
// fields, the error (role="alert"), and a commit that stays at 45% until the
// required fields are valid. Copy and tones are Platform Admin.dc.html's
// openDlg calls; field options use the real enums (directive R-9).

interface DialogBase {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** busy / error / run — the commit plumbing every dialog shares. */
function useCommit(fallback: string, onOpenChange: (open: boolean) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setBusy(false);
      onOpenChange(false);
    } catch (e) {
      setError(skillErrorMessage(e, fallback));
      setBusy(false);
    }
  };
  return { busy, error, run };
}

const ALIAS_TYPE_OPTIONS: readonly FieldSelectOption[] = ALIAS_TYPES.map((t) => ({
  value: t,
  label: ALIAS_TYPE_LABEL[t],
}));

/** "Choose a skill" + the live skills (active, not merged) by name. */
function skillOptions(skills: readonly Skill[], placeholder: string): FieldSelectOption[] {
  return [{ value: '', label: placeholder }, ...skills.map((s) => ({ value: s.id, label: s.canonical_name }))];
}

// ---- Create skill (registry + review queue) ---------------------------------
export function CreateSkillDialog({
  open,
  onOpenChange,
  initialName = '',
  onCreated,
}: DialogBase & { readonly initialName?: string; readonly onCreated: (skill: Skill) => void }) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState('');
  const { busy, error, run } = useCommit('The skill could not be created.', onOpenChange);
  const valid = name.trim().length > 0;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create skill"
      consequence="Creates a global skill available to every tenant."
      commitLabel="Create skill"
      canCommit={valid}
      busy={busy}
      error={error}
      onCommit={() =>
        void run(async () => {
          const desc = description.trim();
          const created = await skillsApi.createSkill({
            canonical_name: name.trim(),
            description: desc.length > 0 ? desc : null,
          });
          onCreated(created);
        })
      }
    >
      <FieldText label="Canonical name" required value={name} onChange={setName} />
      <FieldTextArea label="Description (optional)" value={description} onChange={setDescription} max={500} />
    </ConfirmDialog>
  );
}

// ---- Edit skill -------------------------------------------------------------
export function EditSkillDialog({
  open,
  onOpenChange,
  skill,
  onSaved,
}: DialogBase & { readonly skill: Skill; readonly onSaved: () => void }) {
  const [name, setName] = useState(skill.canonical_name);
  const [description, setDescription] = useState(skill.description ?? '');
  const { busy, error, run } = useCommit('The skill could not be saved.', onOpenChange);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit skill"
      commitLabel="Save"
      canCommit={name.trim().length > 0}
      busy={busy}
      error={error}
      onCommit={() =>
        void run(async () => {
          const desc = description.trim();
          await skillsApi.updateSkill(skill.id, {
            canonical_name: name.trim(),
            description: desc.length > 0 ? desc : null,
          });
          onSaved();
        })
      }
    >
      <FieldText label="Canonical name" required value={name} onChange={setName} />
      <FieldTextArea label="Description (optional)" value={description} onChange={setDescription} max={500} />
    </ConfirmDialog>
  );
}

// ---- Deactivate / Reactivate (from → to) -------------------------------------
export function ToggleSkillDialog({
  open,
  onOpenChange,
  skill,
  onDone,
}: DialogBase & { readonly skill: Skill; readonly onDone: (active: boolean) => void }) {
  const active = skill.status === 'active';
  const { busy, error, run } = useCommit(
    active ? 'The skill could not be deactivated.' : 'The skill could not be reactivated.',
    onOpenChange,
  );
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${active ? 'Deactivate' : 'Reactivate'} ${skill.canonical_name}`}
      from={statusPill(skill.status)}
      to={statusPill(active ? 'inactive' : 'active')}
      consequence={
        active
          ? 'The skill stops being suggested and matched in every tenant. Existing references are kept.'
          : 'The skill is suggested and matched again in every tenant.'
      }
      commitLabel={active ? 'Deactivate' : 'Reactivate'}
      tone="privileged"
      busy={busy}
      error={error}
      onCommit={() =>
        void run(async () => {
          if (active) await skillsApi.deactivateSkill(skill.id);
          else await skillsApi.reactivateSkill(skill.id);
          onDone(!active);
        })
      }
    />
  );
}

// ---- Merge into… (winner + acknowledgement) ----------------------------------
export function MergeSkillDialog({
  open,
  onOpenChange,
  skill,
  directory,
  onMerged,
}: DialogBase & {
  readonly skill: Skill;
  readonly directory: SkillDirectory;
  readonly onMerged: (winnerId: string) => void;
}) {
  const [winner, setWinner] = useState('');
  const [ack, setAck] = useState(false);
  const { busy, error, run } = useCommit('The skills could not be merged.', onOpenChange);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Merge ${skill.canonical_name} into…`}
      consequence={`${skill.canonical_name} becomes inactive and resolves to the winner everywhere. References are updated in the background; its aliases, versions and relationships stay on record.`}
      commitLabel="Merge skills"
      tone="privileged"
      canCommit={winner !== '' && ack}
      busy={busy}
      error={error}
      onCommit={() =>
        void run(async () => {
          await skillsApi.mergeSkill(skill.id, { winner_skill_id: winner });
          onMerged(winner);
        })
      }
    >
      <FieldSelect
        label="Winner"
        required
        value={winner}
        onChange={setWinner}
        options={skillOptions(directory.live(skill.id), 'Choose the skill to keep')}
      />
      <FieldAck label="I understand this merge can’t be undone from the console." checked={ack} onChange={setAck} />
    </ConfirmDialog>
  );
}

// ---- Override… -------------------------------------------------------------
export function OverrideSkillDialog({
  open,
  onOpenChange,
  skill,
  onSaved,
}: DialogBase & { readonly skill: Skill; readonly onSaved: () => void }) {
  const [surface, setSurface] = useState('');
  const [reason, setReason] = useState('');
  const { busy, error, run } = useCommit('The override could not be saved.', onOpenChange);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Override ${skill.canonical_name}`}
      consequence="Pins how a surface form resolves to this skill, ahead of automatic matching."
      commitLabel="Save override"
      canCommit={reason.trim().length > 0}
      busy={busy}
      error={error}
      onCommit={() =>
        void run(async () => {
          const s = surface.trim();
          await skillsApi.overrideSkill(skill.id, { surface_form: s.length > 0 ? s : null, reason: reason.trim() });
          onSaved();
        })
      }
    >
      <FieldText
        label="Surface form (optional)"
        helper="Leave empty to override the skill itself."
        value={surface}
        onChange={setSurface}
      />
      <FieldTextArea label="Reason" required value={reason} onChange={setReason} max={500} />
    </ConfirmDialog>
  );
}

// ---- Add relationship ---------------------------------------------------------
const RELATIONSHIP_TYPE_OPTIONS: readonly FieldSelectOption[] = RELATIONSHIP_TYPES.map((t) => ({
  value: t,
  label: `${RELATIONSHIP_TYPE_LABEL[t]} ${SYMMETRIC_RELATIONSHIP_TYPES.has(t) ? '(symmetric)' : '(directed)'}`,
}));
const RELATIONSHIP_SOURCE_OPTIONS: readonly FieldSelectOption[] = RELATIONSHIP_SOURCES.map((s) => ({
  value: s,
  label: RELATIONSHIP_SOURCE_LABEL[s],
}));

export function AddRelationshipDialog({
  open,
  onOpenChange,
  skill,
  directory,
  onAdded,
}: DialogBase & { readonly skill: Skill; readonly directory: SkillDirectory; readonly onAdded: () => void }) {
  const [target, setTarget] = useState('');
  const [type, setType] = useState<SkillRelationshipType>('RELATED_TO');
  const [source, setSource] = useState<SkillRelationshipSource>('ADMIN_CURATED');
  const [ref, setRef] = useState('');
  const { busy, error, run } = useCommit('The relationship could not be added.', onOpenChange);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Add relationship from ${skill.canonical_name}`}
      consequence={`Symmetric types apply in both directions; directed types read “${skill.canonical_name} → target”.`}
      commitLabel="Add relationship"
      canCommit={target !== ''}
      busy={busy}
      error={error}
      onCommit={() =>
        void run(async () => {
          const r = ref.trim();
          await skillsApi.addRelationship(skill.id, {
            target_skill_id: target,
            relationship_type: type,
            source,
            source_ref: r.length > 0 ? r : null,
          });
          onAdded();
        })
      }
    >
      <FieldSelect
        label="Target skill"
        required
        value={target}
        onChange={setTarget}
        options={skillOptions(directory.live(skill.id), 'Choose a skill')}
      />
      <FieldSelect
        label="Type"
        required
        value={type}
        onChange={(v) => setType(v as SkillRelationshipType)}
        options={RELATIONSHIP_TYPE_OPTIONS}
      />
      <FieldSelect
        label="Source"
        required
        value={source}
        onChange={(v) => setSource(v as SkillRelationshipSource)}
        options={RELATIONSHIP_SOURCE_OPTIONS}
      />
      <FieldText label="Source reference (optional)" value={ref} onChange={setRef} />
    </ConfirmDialog>
  );
}

// ---- Add as alias… (review queue) ---------------------------------------------
export function AliasFromSurfaceDialog({
  open,
  onOpenChange,
  surface,
  directory,
  onAdded,
}: DialogBase & {
  readonly surface: string;
  readonly directory: SkillDirectory;
  readonly onAdded: (skillId: string) => void;
}) {
  const [skillId, setSkillId] = useState('');
  const [type, setType] = useState<SkillAliasType>('COMMON_NAME');
  const { busy, error, run } = useCommit('The alias could not be added.', onOpenChange);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Add “${surface}” as an alias`}
      consequence="Future occurrences of this surface form resolve to the chosen skill in every tenant."
      commitLabel="Add alias"
      canCommit={skillId !== ''}
      busy={busy}
      error={error}
      onCommit={() =>
        void run(async () => {
          await skillsApi.addAlias(skillId, { alias: surface, alias_type: type });
          onAdded(skillId);
        })
      }
    >
      <FieldSelect
        label="Skill"
        required
        value={skillId}
        onChange={setSkillId}
        options={skillOptions(directory.live(), 'Choose a skill')}
      />
      <FieldSelect
        label="Alias type"
        required
        value={type}
        onChange={(v) => setType(v as SkillAliasType)}
        options={ALIAS_TYPE_OPTIONS}
      />
    </ConfirmDialog>
  );
}

// ---- Reject proposal ----------------------------------------------------------
export function RejectProposalDialog({
  open,
  onOpenChange,
  onReject,
}: DialogBase & { readonly onReject: (reason: string | null) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const { busy, error, run } = useCommit('The proposal could not be rejected.', onOpenChange);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Reject proposal"
      consequence="Nothing changes in the taxonomy. The proposal is kept as Rejected."
      commitLabel="Reject"
      busy={busy}
      error={error}
      onCommit={() =>
        void run(async () => {
          const r = reason.trim();
          await onReject(r.length > 0 ? r : null);
        })
      }
    >
      <FieldTextArea label="Reason (optional)" value={reason} onChange={setReason} max={500} />
    </ConfirmDialog>
  );
}

export { ALIAS_TYPE_OPTIONS };
