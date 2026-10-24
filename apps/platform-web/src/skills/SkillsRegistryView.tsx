import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, Button, Checkbox, Input, hasScope, useOptionalToast, type Session } from '@aramo/fe-foundation';

import { Pill, PLATFORM_PERMISSIONS as P, SkeletonPanel, formatDate } from '../components';

import { skillsApi, type Skill } from './skills-api';
import { statusPill } from './skill-labels';
import { CreateSkillDialog } from './skill-dialogs';
import { SkillsPageHead, SkillsViewOnly } from './skills-chrome';

export const SKILL_READ_SCOPE = P.skillRead;
export const SKILL_MANAGE_SCOPE = P.skillManage;

/**
 * Client-side registry search. The list response carries no aliases (R-9), so
 * the search covers the canonical and normalized NAMES only — the placeholder
 * and the footer say so.
 */
export function filterSkills(skills: readonly Skill[], query: string): Skill[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...skills];
  return skills.filter((s) => s.canonical_name.toLowerCase().includes(q) || s.normalized_name.includes(q));
}

export function skillCountLabel(n: number): string {
  return `${n} ${n === 1 ? 'skill' : 'skills'}`;
}

// PLATFORM-UX-1 F-7 — Skills registry (handoff §9; directive R-9). GET
// /platform/skills is unpaginated, so search is client-side; "Include
// inactive" re-reads with include_inactive=true. + Create skill needs
// platform:skill:manage; without it the view-only note says why.
export function SkillsRegistryView({ session }: { readonly session: Session }) {
  const navigate = useNavigate();
  const toast = useOptionalToast();
  const canManage = hasScope(session, SKILL_MANAGE_SCOPE);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(async (inactive: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await skillsApi.listSkills({ includeInactive: inactive });
      setSkills(res.skills);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The skills could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(includeInactive);
  }, [includeInactive, load, tick]);

  const rows = useMemo(
    () => filterSkills(skills, q).sort((a, b) => a.canonical_name.localeCompare(b.canonical_name)),
    [skills, q],
  );

  return (
    <div className="pw-sk">
      <SkillsPageHead
        title="Skills registry"
        lede="The global skills taxonomy shared by every tenant."
        action={
          canManage ? (
            <Button unstyled className="pw-btn pw-btn--normal" onClick={() => setCreating(true)}>
              + Create skill
            </Button>
          ) : undefined
        }
      />
      {!canManage ? <SkillsViewOnly className="pw-sk-viewonly-below" /> : null}

      <div className="pw-sk-toolbar">
        <Input
          unstyled
          className="pw-input pw-sk-search"
          aria-label="Search skill names"
          placeholder="Search skill names"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="pw-sk-check">
          <Checkbox
            unstyled
            className="pw-sk-check__box"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Include inactive
        </label>
        <span className="pw-sk-count" role="status">
          {loading ? '' : skillCountLabel(rows.length)}
        </span>
      </div>

      {error ? (
        <div role="alert" className="pw-alert pw-alert--error pw-sk-alert">
          {error}
        </div>
      ) : null}

      <div className="pw-sk-card">
        {loading ? (
          <div className="pw-sk-loading">
            <SkeletonPanel lines={['100%', '92%', '96%', '88%', '94%']} label="Loading skills…" />
          </div>
        ) : (
          <>
            <div className="pw-sk-scroll">
              <table className="pw-sk-table">
                <thead>
                  <tr>
                    <th scope="col">Canonical name</th>
                    <th scope="col">Normalized</th>
                    <th scope="col">Status</th>
                    <th scope="col">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => {
                    const p = statusPill(s.status);
                    return (
                      <tr
                        key={s.id}
                        className={s.status === 'active' ? 'pw-sk-row' : 'pw-sk-row pw-sk-row--muted'}
                        onClick={() => navigate(`/skills/${s.id}`)}
                      >
                        <td className="pw-sk-cell-name">
                          <Link className="pw-sk-rowlink" to={`/skills/${s.id}`} onClick={(e) => e.stopPropagation()}>
                            {s.canonical_name}
                          </Link>
                        </td>
                        <td className="pw-sk-cell-mono">{s.normalized_name}</td>
                        <td>
                          <Pill tone={p.tone}>{p.label}</Pill>
                        </td>
                        <td>{formatDate(s.updated_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.length === 0 ? <div className="pw-sk-empty">No skills match.</div> : null}
          </>
        )}
        <div className="pw-sk-foot pw-sk-foot--registry">Unpaginated today. Search covers skill names only.</div>
      </div>

      {creating ? (
        <CreateSkillDialog
          open
          onOpenChange={(o) => {
            if (!o) setCreating(false);
          }}
          onCreated={(created) => {
            toast.show(`Skill “${created.canonical_name}” created.`);
            setTick((t) => t + 1);
          }}
        />
      ) : null}
    </div>
  );
}
