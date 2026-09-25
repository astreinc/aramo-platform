import { useState } from 'react';
import { Button, Dialog, FormField, InlineAlert, Input, Select } from '@aramo/fe-foundation';

import { skillsApi, ALIAS_TYPES, type SkillAliasType } from './skills-api';
import { skillErrorMessage } from './skill-errors';
import { SkillPicker } from './SkillPicker';

// SKILL-TAX-1F-C2 — add a reviewed unresolved surface as an alias of an EXISTING
// canonical skill. The operator CHOOSES the destination skill (SkillPicker) — there
// is no fuzzy auto-selection of a canonical destination. The alias surface is the
// reviewed surface_form verbatim (read-only here).
export function AliasFromSurfaceDialog({
  surface,
  open,
  onOpenChange,
  onDone,
}: {
  readonly surface: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDone: () => void;
}) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [aliasType, setAliasType] = useState<SkillAliasType>('COMMON_NAME');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (targetId === null) return;
    setBusy(true);
    setError(null);
    try {
      await skillsApi.addAlias(targetId, { alias: surface, alias_type: aliasType });
      onOpenChange(false);
      onDone();
    } catch (e) {
      setError(skillErrorMessage(e, 'Add alias failed.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add reviewed surface as alias"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || targetId === null}>
            {busy ? 'Working…' : 'Add alias'}
          </Button>
        </>
      }
    >
      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <FormField label="Alias surface">
        <Input unstyled className="tc-input" value={surface} readOnly />
      </FormField>
      <FormField label="Destination skill" helper="Choose the canonical skill this surface should resolve to.">
        <SkillPicker
          value={targetId}
          onSelect={setTargetId}
          ariaLabel="Destination skill"
          placeholder="Choose the canonical skill…"
        />
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
