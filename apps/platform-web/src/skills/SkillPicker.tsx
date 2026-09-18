import { useEffect, useMemo, useState } from 'react';
import { Combobox, type ComboboxItem } from '@aramo/fe-foundation';

import { skillsApi, type Skill } from './skills-api';

// SKILL-TAX-1F-C1 — a governance skill picker (merge winner, relationship target).
// Loads the active canonical registry once and lets the operator CHOOSE — there is
// no fuzzy auto-selection of a destination. Excludes a given id (never merge/relate
// a skill to itself).
export function SkillPicker({
  value,
  onSelect,
  excludeId,
  ariaLabel,
  placeholder = 'Choose a skill…',
  disabled,
}: {
  readonly value: string | null;
  readonly onSelect: (id: string) => void;
  readonly excludeId?: string;
  readonly ariaLabel: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
}) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let live = true;
    skillsApi
      .listSkills()
      .then((res) => {
        if (live) setSkills(res.skills);
      })
      .catch(() => {
        if (live) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const items = useMemo<ComboboxItem[]>(
    () =>
      skills
        .filter((s) => s.id !== excludeId)
        .map((s) => ({ value: s.id, label: s.canonical_name, description: s.normalized_name })),
    [skills, excludeId],
  );

  return (
    <Combobox
      items={items}
      value={value}
      onSelect={(item) => onSelect(item.value)}
      placeholder={placeholder}
      emptyMessage={loadError ? 'Could not load skills.' : 'No skills.'}
      ariaLabel={ariaLabel}
      disabled={disabled}
    />
  );
}
