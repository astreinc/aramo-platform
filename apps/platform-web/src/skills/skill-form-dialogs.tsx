import { useState } from 'react';
import { Button, Dialog, FormField, InlineAlert, Input, Select, TextArea } from '@aramo/fe-foundation';

import {
  skillsApi,
  ALIAS_TYPES,
  RELATIONSHIP_TYPES,
  RELATIONSHIP_SOURCES,
  type Skill,
  type SkillAlias,
  type SkillAliasType,
  type SkillRelationship,
  type SkillRelationshipSource,
  type SkillRelationshipType,
  type SkillVersion,
} from './skills-api';
import { skillErrorMessage } from './skill-errors';
import { SkillPicker } from './SkillPicker';

// SKILL-TAX-1F-C1 — the form-input governance dialogs (create/edit skill, add alias,
// add/update version, add relationship). Each reuses the LifecycleDialog posture:
// Dialog + FormField + a busy/disabled submit, with governed 4xx rendered honestly
// via skillErrorMessage. Mutations are only mounted for manage-scope operators.

// ---- Create / edit skill --------------------------------------------------
export function SkillFormDialog({
  mode,
  skill,
  initialName,
  open,
  onOpenChange,
  onDone,
}: {
  readonly mode: 'create' | 'edit';
  readonly skill?: Skill;
  // SKILL-TAX-1F-C2 — prefill the canonical name (create-a-skill-from-a-reviewed
  // surface, from the review queue). Ignored in edit mode (the skill supplies it).
  readonly initialName?: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDone: (result?: Skill) => void;
}) {
  const [canonicalName, setCanonicalName] = useState(skill?.canonical_name ?? initialName ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const desc = description.trim().length > 0 ? description.trim() : null;
      const result =
        mode === 'edit' && skill !== undefined
          ? await skillsApi.updateSkill(skill.id, { canonical_name: canonicalName.trim(), description: desc })
          : await skillsApi.createSkill({ canonical_name: canonicalName.trim(), description: desc });
      onOpenChange(false);
      onDone(result);
    } catch (e) {
      setError(skillErrorMessage(e, 'Save failed.'));
      setBusy(false);
    }
  };

  const disabled = busy || canonicalName.trim().length === 0;
  const title = mode === 'create' ? 'Create skill' : 'Edit skill';
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={disabled}>
            {busy ? 'Working…' : title}
          </Button>
        </>
      }
    >
      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <FormField label="Canonical name">
        <Input unstyled
          className="tc-input"
          value={canonicalName}
          onChange={(e) => setCanonicalName(e.target.value)}
          placeholder="e.g. Kubernetes"
        />
      </FormField>
      <FormField label="Description (optional)">
        <TextArea unstyled
          className="tc-input"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </FormField>
    </Dialog>
  );
}

// ---- Add alias ------------------------------------------------------------
export function AliasDialog({
  skillId,
  open,
  onOpenChange,
  onDone,
}: {
  readonly skillId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDone: (result?: SkillAlias) => void;
}) {
  const [alias, setAlias] = useState('');
  const [aliasType, setAliasType] = useState<SkillAliasType>('COMMON_NAME');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await skillsApi.addAlias(skillId, { alias: alias.trim(), alias_type: aliasType });
      onOpenChange(false);
      onDone(result);
    } catch (e) {
      setError(skillErrorMessage(e, 'Add alias failed.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add alias"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || alias.trim().length === 0}>
            {busy ? 'Working…' : 'Add alias'}
          </Button>
        </>
      }
    >
      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <FormField label="Alias surface">
        <Input unstyled className="tc-input" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="e.g. K8s" />
      </FormField>
      <FormField label="Alias type">
        <Select unstyled className="tc-input" value={aliasType} onChange={(e) => setAliasType(e.target.value as SkillAliasType)}>
          {ALIAS_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </FormField>
    </Dialog>
  );
}

// ---- Add / update version -------------------------------------------------
export function VersionDialog({
  skillId,
  version,
  open,
  onOpenChange,
  onDone,
}: {
  readonly skillId: string;
  readonly version?: SkillVersion;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDone: (result?: SkillVersion) => void;
}) {
  const editing = version !== undefined;
  const [versionStr, setVersionStr] = useState(version?.version ?? '');
  const [versionFamily, setVersionFamily] = useState(version?.version_family ?? '');
  const [status, setStatus] = useState<'active' | 'inactive'>(version?.status ?? 'active');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const family = versionFamily.trim().length > 0 ? versionFamily.trim() : null;
      const result =
        editing && version !== undefined
          ? await skillsApi.updateVersion(skillId, version.id, { version_family: family, status })
          : await skillsApi.addVersion(skillId, { version: versionStr.trim(), version_family: family });
      onOpenChange(false);
      onDone(result);
    } catch (e) {
      setError(skillErrorMessage(e, 'Save version failed.'));
      setBusy(false);
    }
  };

  const disabled = busy || (!editing && versionStr.trim().length === 0);
  const title = editing ? 'Update version' : 'Add version';
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={disabled}>
            {busy ? 'Working…' : title}
          </Button>
        </>
      }
    >
      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <FormField label="Version">
        <Input unstyled
          className="tc-input"
          value={versionStr}
          onChange={(e) => setVersionStr(e.target.value)}
          placeholder="e.g. 1.29"
          disabled={editing}
        />
      </FormField>
      <FormField label="Version family (optional)">
        <Input unstyled className="tc-input" value={versionFamily} onChange={(e) => setVersionFamily(e.target.value)} />
      </FormField>
      {editing ? (
        <FormField label="Status">
          <Select unstyled className="tc-input" value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'inactive')}>
            <option value="active">active</option>
            <option value="inactive">inactive</option>
          </Select>
        </FormField>
      ) : null}
    </Dialog>
  );
}

// ---- Add relationship -----------------------------------------------------
export function RelationshipDialog({
  skillId,
  open,
  onOpenChange,
  onDone,
}: {
  readonly skillId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDone: (result?: SkillRelationship) => void;
}) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [relationshipType, setRelationshipType] = useState<SkillRelationshipType>('RELATED_TO');
  const [source, setSource] = useState<SkillRelationshipSource>('ADMIN_CURATED');
  const [sourceRef, setSourceRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (targetId === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await skillsApi.addRelationship(skillId, {
        target_skill_id: targetId,
        relationship_type: relationshipType,
        source,
        source_ref: sourceRef.trim().length > 0 ? sourceRef.trim() : null,
      });
      onOpenChange(false);
      onDone(result);
    } catch (e) {
      setError(skillErrorMessage(e, 'Add relationship failed.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add relationship"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || targetId === null}>
            {busy ? 'Working…' : 'Add relationship'}
          </Button>
        </>
      }
    >
      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <FormField label="Target skill">
        <SkillPicker
          value={targetId}
          onSelect={setTargetId}
          excludeId={skillId}
          ariaLabel="Target skill"
          placeholder="Choose the related skill…"
        />
      </FormField>
      <FormField label="Relationship type">
        <Select unstyled
          className="tc-input"
          value={relationshipType}
          onChange={(e) => setRelationshipType(e.target.value as SkillRelationshipType)}
        >
          {RELATIONSHIP_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Source">
        <Select unstyled
          className="tc-input"
          value={source}
          onChange={(e) => setSource(e.target.value as SkillRelationshipSource)}
        >
          {RELATIONSHIP_SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Source reference (optional)">
        <Input unstyled className="tc-input" value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} />
      </FormField>
    </Dialog>
  );
}
