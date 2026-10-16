import { createElement, type ReactNode } from 'react';

import { parseFragment, sanitizeDocHtml } from './dt-html';
import { JOB_DESCRIPTION_KEY, SourceIcon, sourceOf, type BindingMap } from './dt-ui';

// DOC-TEMPLATE-ADMIN-RTR-1 Amendment A1 — the SAFE allowlist renderer for rtr-html-v1.
// Input (stored html, or the server's sample-preview html) is re-sanitised client-side and
// then converted node-by-node into React elements — there is no dangerouslySetInnerHTML
// anywhere. Chips render as field chips (content mode); `<span data-sample>` renders as a
// highlighted sample value (preview mode); the tenant-logo div renders as the letterhead.

export interface LetterheadInfo {
  readonly src: string | null; // GET …/versions/:id/logo/content, or null when no asset is known
  readonly tenantName: string;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p !== '');
  return parts.slice(0, 3).map((p) => p.charAt(0).toUpperCase()).join('') || '—';
}

export function Letterhead({ info, variant, testId }: {
  readonly info: LetterheadInfo;
  readonly variant: 'editor' | 'rendered';
  readonly testId?: string;
}) {
  return (
    <div className={`dt-letterhead dt-letterhead--${variant}`} data-testid={testId}>
      {info.src != null ? (
        <img className="dt-letterhead__img" src={info.src} alt={info.tenantName !== '' ? `${info.tenantName} logo` : 'Tenant logo'} />
      ) : (
        <span className="dt-letterhead__lg" aria-hidden="true">{initials(info.tenantName)}</span>
      )}
      {info.tenantName !== '' ? <span className="dt-letterhead__nm">{info.tenantName}</span> : null}
      {variant === 'editor' ? <span className="dt-letterhead__cap">Tenant logo · from Tenant profile</span> : null}
    </div>
  );
}

const PASS: Record<string, string> = { P: 'p', H2: 'h2', UL: 'ul', OL: 'ol', LI: 'li', B: 'b', I: 'i', U: 'u', BR: 'br' };

export function SafeDoc({ html, map, mode, letterhead, testId }: {
  readonly html: string;
  readonly map: BindingMap;
  readonly mode: 'content' | 'sample';
  readonly letterhead: LetterheadInfo | null;
  readonly testId?: string;
}) {
  const clean = sanitizeDocHtml(html, { allowSample: mode === 'sample' });
  let k = 0;
  const conv = (n: Node): ReactNode => {
    k += 1;
    if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? '';
    if (n.nodeType !== Node.ELEMENT_NODE) return null;
    const e = n as Element;
    if (e.tagName === 'DIV' && e.getAttribute('data-asset') === 'tenant.logo') {
      return letterhead != null ? <Letterhead key={k} info={letterhead} variant="rendered" testId="dt-doc-letterhead" /> : null;
    }
    const field = e.getAttribute('data-field');
    if (field != null) {
      const label = map.labelByToken[field];
      if (mode === 'sample') return <span key={k} className="dt-missing">[{label ?? field} missing]</span>;
      if (label == null) return <span key={k} className="dt-chip dt-chip--bad">{field} · unknown field</span>;
      return (
        <span key={k} className={`dt-chip${field === JOB_DESCRIPTION_KEY ? ' dt-chip--block' : ''}`}>
          <SourceIcon source={sourceOf(field)} size={12} />{field === JOB_DESCRIPTION_KEY ? 'Job description' : label}
        </span>
      );
    }
    const sample = e.getAttribute('data-sample');
    if (sample != null) {
      return (
        <span key={k} className={sample === JOB_DESCRIPTION_KEY ? 'dt-sample dt-sample--block' : 'dt-sample'} data-sample={sample}>
          {e.textContent ?? ''}
        </span>
      );
    }
    const tag = PASS[e.tagName];
    if (tag == null) return Array.from(e.childNodes).map(conv);
    if (tag === 'br') return <br key={k} />;
    return createElement(tag, { key: k }, ...Array.from(e.childNodes).map(conv));
  };
  return <div className="dt-doc" data-testid={testId}>{Array.from(parseFragment(clean).childNodes).map(conv)}</div>;
}
