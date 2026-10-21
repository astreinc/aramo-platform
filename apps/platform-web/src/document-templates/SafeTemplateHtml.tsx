import { createElement, type ReactNode } from 'react';

// DOC-TEMPLATE-LIB-1 T-2 — a minimal SAFE renderer for template html (the server's
// sample-preview html or stored rtr-html-v1 content). The html is parsed inertly
// (DOMParser, never inserted) and converted node-by-node into React elements over a
// fixed allowlist — there is no dangerouslySetInnerHTML. Field placeholders render as
// labelled chips; preview samples render as highlighted values; anything outside the
// allowlist is dropped (its text kept). T-4 replaces this with the shared
// libs/document-templates-web renderer (directive §8.3).

const PASS: Record<string, string> = { P: 'p', H2: 'h2', UL: 'ul', OL: 'ol', LI: 'li', B: 'b', I: 'i', U: 'u', BR: 'br', STRONG: 'b', EM: 'i' };

export function SafeTemplateHtml({
  html,
  labels,
  testId,
}: {
  readonly html: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly testId?: string;
}) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  let k = 0;
  const conv = (n: Node): ReactNode => {
    k += 1;
    if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? '';
    if (n.nodeType !== Node.ELEMENT_NODE) return null;
    const e = n as Element;
    const field = e.getAttribute('data-field');
    if (field !== null) {
      return (
        <span key={k} className="pw-dt-chip" data-field={field}>
          {labels[field] ?? `${field} (not in catalog)`}
        </span>
      );
    }
    const sample = e.getAttribute('data-sample');
    if (sample !== null) {
      return (
        <span key={k} className="pw-dt-sample" data-sample={sample}>
          {e.textContent ?? ''}
        </span>
      );
    }
    if (e.getAttribute('data-asset') !== null) {
      return (
        <span key={k} className="pw-dt-chip">
          Organization logo
        </span>
      );
    }
    const tag = PASS[e.tagName];
    if (tag === undefined) return Array.from(e.childNodes).map(conv);
    if (tag === 'br') return <br key={k} />;
    return createElement(tag, { key: k }, ...Array.from(e.childNodes).map(conv));
  };
  return (
    <div className="pw-dt-doc" data-testid={testId}>
      {Array.from(doc.body.childNodes).map(conv)}
    </div>
  );
}
