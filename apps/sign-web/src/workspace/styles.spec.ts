// UAT DEL-09 / PRF-01 retest — elements drawn outside the `.sg` shell (the fe-foundation
// dialog portal and the workspace toast) must get the Sign tokens, or their colours resolve
// to nothing (invisible primary buttons; an invisible "Profile saved" toast).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf8');

/** The selector list of the first rule that defines `--ink`. */
function tokenSelectors(): string[] {
  const at = css.indexOf('--ink:');
  const open = css.lastIndexOf('{', at);
  const prevClose = css.lastIndexOf('}', open);
  const header = css.slice(prevClose + 1, open).replace(/\/\*[\s\S]*?\*\//g, '');
  return header.split(',').map((s) => s.trim()).filter(Boolean);
}

describe('Sign tokens reach elements outside the shell', () => {
  it('the token rule covers .sg, the dialog portal and the toast', () => {
    expect(tokenSelectors()).toEqual(expect.arrayContaining(['.sg', '.tc-dialog__content', '.sg-toast']));
  });

  it('the toast keeps its own dark background and white text', () => {
    const rule = css.slice(css.lastIndexOf('.sg-toast {'));
    expect(rule).toMatch(/background:\s*var\(--ink\)/);
    expect(rule).toMatch(/color:\s*#fff/);
  });
});
