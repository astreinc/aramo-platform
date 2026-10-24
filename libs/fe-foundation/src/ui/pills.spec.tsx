import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatusPill, type PillTone } from './pills';

// PLATFORM-UX-1 U-0 (directive R-4): the muted tone is additive; the seven
// existing tones keep their exact rendered markup and CSS.
const EXISTING: readonly PillTone[] = ['neutral', 'brand', 'info', 'ok', 'warn', 'danger', 'hot'];

const css = readFileSync(join(__dirname, 'ui.css'), 'utf8');

function ruleFor(tone: string): string | null {
  const m = css.match(new RegExp(`\\.rc-pill--${tone}\\s*\\{([^}]*)\\}`));
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

describe('StatusPill tones', () => {
  it.each(EXISTING)('renders the %s tone with an unchanged class list', (tone) => {
    const { container } = render(<StatusPill tone={tone}>Label</StatusPill>);
    const pill = container.firstChild as HTMLElement;
    expect(pill.tagName).toBe('SPAN');
    expect(pill.className).toBe(`rc-pill rc-pill--${tone}`);
    expect(pill.textContent).toBe('Label');
  });

  it.each(EXISTING)('keeps the dot modifier on the %s tone', (tone) => {
    const { container } = render(
      <StatusPill tone={tone} dot>
        Label
      </StatusPill>,
    );
    expect((container.firstChild as HTMLElement).className).toBe(
      `rc-pill rc-pill--${tone} rc-pill__dot`,
    );
  });

  it('renders the muted tone', () => {
    const { container } = render(
      <StatusPill tone="muted" dot>
        Closed
      </StatusPill>,
    );
    const pill = container.firstChild as HTMLElement;
    expect(pill.className).toBe('rc-pill rc-pill--muted rc-pill__dot');
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });

  it('renders the icon before the label', () => {
    const { container } = render(
      <StatusPill tone="muted" icon={<svg data-testid="ic" />}>
        Released
      </StatusPill>,
    );
    const pill = container.firstChild as HTMLElement;
    expect(pill.firstChild).toBe(screen.getByTestId('ic'));
  });
});

describe('StatusPill tone CSS', () => {
  it('keeps the existing tone rules byte-identical', () => {
    expect({
      neutral: ruleFor('neutral'),
      brand: ruleFor('brand'),
      info: ruleFor('info'),
      ok: ruleFor('ok'),
      warn: ruleFor('warn'),
      danger: ruleFor('danger'),
      hot: ruleFor('hot'),
    }).toEqual({
      neutral: 'background: #eef0f2; color: #54605b;',
      brand: 'background: var(--brand-tint); color: var(--brand-strong);',
      info: 'background: var(--info-tint); color: var(--info);',
      ok: 'background: var(--ok-tint); color: var(--ok);',
      warn: 'background: var(--warn-tint); color: var(--warn);',
      danger: 'background: var(--danger-tint); color: var(--danger);',
      hot: 'background: var(--hot-tint); color: var(--hot);',
    });
  });

  it('defines the muted tone with the design values (#66717B on #F0F2F4)', () => {
    expect(ruleFor('muted')).toBe('background: #f0f2f4; color: #66717b;');
  });
});
