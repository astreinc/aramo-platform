import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Dialog, Input } from '@aramo/fe-foundation';

import { Pill, tenantStatusPill, type PillSpec } from '../components/Pill';
import { PLATFORM_PERMISSIONS as P } from '../components/permissions';
import { platformApi } from '../platform-api';
import { skillsApi } from '../skills/skills-api';
import { documentTemplatesApi } from '../document-templates/document-templates-api';
import { useReturnFocus } from '../components/use-return-focus';

import { NAV_GROUPS } from './nav';
import { SearchIcon } from './nav-icons';

// PLATFORM-UX-1 F-2 — the ⌘K command palette (handoff §3.4): results grouped by
// kind — Tenant (slug + status pill) · Skill · Template · Page. Enter opens the
// first result; Esc closes (Radix Dialog: focus trap + focus return).
//
// Data comes from the existing list endpoints, read once per shell when the
// palette first opens and filtered client-side. Each source is read only with
// its section's read permission, and a failed read just leaves that group out
// (graceful degradation): Pages always work.

export type PaletteKind = 'Tenant' | 'Skill' | 'Template' | 'Page';

export interface PaletteResult {
  readonly id: string;
  readonly kind: PaletteKind;
  readonly label: string;
  readonly sub: string;
  readonly pill?: PillSpec;
  readonly to: string;
}

interface PaletteData {
  readonly tenants: readonly { id: string; name: string; slug: string | null; status: string }[];
  readonly skills: readonly { id: string; name: string; normalized: string }[];
  readonly templates: readonly { id: string; name: string; type: string }[];
}

const EMPTY: PaletteData = { tenants: [], skills: [], templates: [] };

export interface PaletteSources {
  readonly loadTenants: () => Promise<PaletteData['tenants']>;
  readonly loadSkills: () => Promise<PaletteData['skills']>;
  readonly loadTemplates: () => Promise<PaletteData['templates']>;
}

export const DEFAULT_PALETTE_SOURCES: PaletteSources = {
  loadTenants: async () =>
    (await platformApi.listTenants()).tenants.map((t) => ({ id: t.id, name: t.name, slug: t.slug, status: t.status })),
  loadSkills: async () =>
    (await skillsApi.listSkills()).skills.map((s) => ({ id: s.id, name: s.canonical_name, normalized: s.normalized_name })),
  loadTemplates: async () => {
    const [{ templates }, types] = await Promise.all([
      documentTemplatesApi.listTemplates(),
      documentTemplatesApi.listDocumentTypes().catch(() => ({ document_types: [] })),
    ]);
    const typeName = new Map(types.document_types.map((d) => [d.id, d.name]));
    return templates.map((t) => ({ id: t.id, name: t.name, type: typeName.get(t.document_type_id) ?? '' }));
  },
};

/** Builds the grouped result list (design order and caps; first 12 shown). */
export function paletteResults(query: string, data: PaletteData, can: (scope: string) => boolean): PaletteResult[] {
  const q = query.trim().toLowerCase();
  const out: PaletteResult[] = [];
  if (can(P.tenantRead)) {
    data.tenants
      .filter((t) => !q || t.name.toLowerCase().includes(q) || (t.slug ?? '').toLowerCase().includes(q))
      .slice(0, q ? 6 : 4)
      .forEach((t) =>
        out.push({ id: `t:${t.id}`, kind: 'Tenant', label: t.name, sub: t.slug ?? '', pill: tenantStatusPill(t.status), to: `/tenants/${t.id}` }),
      );
  }
  if (q && can(P.skillRead)) {
    data.skills
      .filter((s) => s.name.toLowerCase().includes(q))
      .slice(0, 4)
      .forEach((s) => out.push({ id: `s:${s.id}`, kind: 'Skill', label: s.name, sub: s.normalized, to: `/skills/${s.id}` }));
  }
  if (q && can(P.documentTemplateRead)) {
    data.templates
      .filter((t) => t.name.toLowerCase().includes(q))
      .slice(0, 4)
      .forEach((t) =>
        out.push({ id: `d:${t.id}`, kind: 'Template', label: t.name, sub: t.type, to: `/document-templates/${t.id}` }),
      );
  }
  NAV_GROUPS.forEach((g) =>
    g.items
      .filter((i) => can(i.scope) && (!q || i.label.toLowerCase().includes(q)))
      .forEach((i) => out.push({ id: `p:${i.key}`, kind: 'Page', label: i.label, sub: g.label, to: i.to })),
  );
  return out.slice(0, 12);
}

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly can: (scope: string) => boolean;
  readonly onNavigate: (to: string) => void;
  readonly sources?: PaletteSources;
}

export function CommandPalette({ open, onOpenChange, can, onNavigate, sources = DEFAULT_PALETTE_SOURCES }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [data, setData] = useState<PaletteData>(EMPTY);
  const loaded = useRef(false);
  useReturnFocus(open);

  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  // Read the lists once, the first time the palette opens.
  useEffect(() => {
    if (!open || loaded.current) return;
    loaded.current = true;
    const read = <T,>(allowed: boolean, load: () => Promise<readonly T[]>): Promise<readonly T[]> =>
      allowed ? load().catch(() => []) : Promise.resolve([]);
    void Promise.all([
      read(can(P.tenantRead), sources.loadTenants),
      read(can(P.skillRead), sources.loadSkills),
      read(can(P.documentTemplateRead), sources.loadTemplates),
    ]).then(([tenants, skills, templates]) => setData({ tenants, skills, templates }));
  }, [open, can, sources]);

  const results = useMemo(() => paletteResults(query, data, can), [query, data, can]);

  const go = (r: PaletteResult): void => {
    onOpenChange(false);
    onNavigate(r.to);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && results[0]) {
      e.preventDefault();
      go(results[0]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Search">
      <div className="pw-cmdk">
        <div className="pw-cmdk__bar">
          <SearchIcon size={16} />
          <Input
            unstyled
            className="pw-cmdk__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search tenants by name or slug, skills, templates…"
            aria-label="Search"
            autoFocus
          />
          <span className="pw-cmdk__key" aria-hidden="true">
            esc
          </span>
        </div>
        <div role="listbox" aria-label="Results" className="pw-cmdk__list">
          {results.map((r) => (
            <Button key={r.id} unstyled role="option" aria-selected={false} className="pw-cmdk__opt" onClick={() => go(r)}>
              <span className="pw-cmdk__kind">{r.kind}</span>
              <span className="pw-cmdk__label">{r.label}</span>
              <span className="pw-cmdk__sub">{r.sub}</span>
              {r.pill ? (
                <span className="pw-cmdk__pill">
                  <Pill tone={r.pill.tone} dot={false}>
                    {r.pill.label}
                  </Pill>
                </span>
              ) : null}
            </Button>
          ))}
          {results.length === 0 ? <div className="pw-cmdk__none">No matches.</div> : null}
        </div>
        <div className="pw-cmdk__foot">↵ opens the first result · ⌘\ toggles the sidebar</div>
      </div>
    </Dialog>
  );
}
