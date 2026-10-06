import { Fragment, type ReactNode } from 'react';

// Enterprise Search GS-1 — SAFE highlighting. Both helpers render only text nodes and <mark>
// elements — never dangerouslySetInnerHTML — so resume-/user-derived content can never inject
// markup (no XSS surface).

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Highlight each case-insensitive occurrence of the query terms within a plain label.
export function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const terms = query.trim().split(/\s+/).map(escapeRegExp).filter((t) => t.length > 0);
  if (terms.length === 0) return <>{text}</>;
  // One capturing group → split interleaves matched substrings at odd indices.
  const re = new RegExp(`(${terms.join('|')})`, 'gi');
  const parts = text.split(re);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>,
      )}
    </>
  );
}

// Render a server snippet that already carries <mark>…</mark> markers (resume ts_headline) as
// safe <mark> elements — the markers are parsed, never interpreted as HTML.
export function SnippetText({ snippet }: { snippet: string }): ReactNode {
  const parts = snippet.split(/(<mark>|<\/mark>)/g);
  const out: ReactNode[] = [];
  let marked = false;
  parts.forEach((part, i) => {
    if (part === '<mark>') {
      marked = true;
      return;
    }
    if (part === '</mark>') {
      marked = false;
      return;
    }
    if (part === '') return;
    out.push(marked ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>);
  });
  return <>{out}</>;
}
