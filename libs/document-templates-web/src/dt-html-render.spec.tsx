import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SafeDoc } from './dt-html-render';
import { emptyBindingMap } from './dt-ui';

// TEMPLATE-STUDIO-1 S-3 — the `.dt-doc` collision. The library stylesheet used to carry a
// second, orphaned `.dt-doc` rule (a list-row flex layout) that also matched SafeDoc's root,
// so tenant previews rendered as narrow flex columns. The vitest config runs with
// `css: false`, so this spec injects the real stylesheet and asserts the computed layout of
// SafeDoc's root is a normal block flow.

const CSS_PATH = resolve(fileURLToPath(import.meta.url), '..', 'document-templates.css');

describe('SafeDoc root layout (TEMPLATE-STUDIO-1 S-3)', () => {
  let style: HTMLStyleElement;

  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = readFileSync(CSS_PATH, 'utf8');
    document.head.appendChild(style);
  });

  afterEach(() => {
    cleanup();
    style.remove();
  });

  it('renders the document root as block flow, not a flex row', () => {
    render(
      <SafeDoc
        html="<h2>Heading</h2><p>First paragraph.</p><p>Second paragraph.</p>"
        map={emptyBindingMap()}
        mode="content"
        letterhead={null}
        testId="safe-doc"
      />,
    );
    const root = screen.getByTestId('safe-doc');
    expect(root).toHaveClass('dt-doc');
    expect(getComputedStyle(root).display).not.toBe('flex');
    expect(root.querySelectorAll('p')).toHaveLength(2);
  });

  it('declares no flex layout on any bare `.dt-doc` rule in the stylesheet', () => {
    const css = readFileSync(CSS_PATH, 'utf8');
    const bare = [...css.matchAll(/^\s*\.dt-doc\s*\{([^}]*)\}/gm)].map((m) => m[1] ?? '');
    expect(bare.length).toBeGreaterThan(0);
    for (const body of bare) expect(body).not.toMatch(/display\s*:\s*flex/);
  });
});
