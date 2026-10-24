import type { SkillDirectory } from './skill-directory';

// PLATFORM-UX-1 F-7 — a skill reference rendered by NAME. An id the loaded
// registry doesn't hold (never expected: the list includes inactive skills)
// renders a plain "Unknown skill" with the full id in mono — never a
// truncated id.
export function SkillName({ id, directory }: { readonly id: string; readonly directory: SkillDirectory }) {
  const name = directory.nameOf(id);
  if (name !== null) return <>{name}</>;
  if (!directory.loaded) return <span className="pw-sk-faint">Loading…</span>;
  return (
    <>
      Unknown skill <span className="pw-sk-code">{id}</span>
    </>
  );
}

/** The name as plain text (summaries, dialog titles, toasts). */
export function skillNameText(id: string, directory: SkillDirectory): string {
  return directory.nameOf(id) ?? (directory.loaded ? `Unknown skill (${id})` : 'Loading…');
}
