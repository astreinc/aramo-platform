import { useCallback, useEffect, useMemo, useState } from 'react';

import { skillsApi, type Skill } from './skills-api';

// PLATFORM-UX-1 F-7 — the registry list (active AND inactive), loaded once per
// screen, so every surface shows skill NAMES and never ids (handoff §9 "Always
// show skill names"). Relationship ends, merge winners, proposal targets and
// the "Add as alias" picker all resolve through it.

export interface SkillDirectory {
  readonly skills: readonly Skill[];
  readonly loaded: boolean;
  /** The canonical name; while loading, or for an id the registry doesn't hold, null. */
  readonly nameOf: (id: string) => string | null;
  readonly byId: (id: string) => Skill | undefined;
  /** Active, non-merged skills (merge winners, alias destinations, relationship targets). */
  readonly live: (excludeId?: string) => readonly Skill[];
  readonly reload: () => void;
}

export function buildDirectory(skills: readonly Skill[], loaded: boolean, reload: () => void): SkillDirectory {
  const map = new Map(skills.map((s) => [s.id, s]));
  return {
    skills,
    loaded,
    nameOf: (id) => map.get(id)?.canonical_name ?? null,
    byId: (id) => map.get(id),
    live: (excludeId) =>
      skills
        .filter((s) => s.id !== excludeId && s.status === 'active' && s.merged_into_skill_id === null)
        .slice()
        .sort((a, b) => a.canonical_name.localeCompare(b.canonical_name)),
    reload,
  };
}

export function useSkillDirectory(): SkillDirectory {
  const [skills, setSkills] = useState<readonly Skill[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    skillsApi
      .listSkills({ includeInactive: true })
      .then((res) => {
        if (!live) return;
        setSkills(res.skills);
        setLoaded(true);
      })
      .catch(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return useMemo(() => buildDirectory(skills, loaded, reload), [skills, loaded, reload]);
}
