import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Tabs, type TabItem } from './Tabs';

function makeItems(): TabItem[] {
  return [
    { id: 'one', label: 'One', content: <p>One body</p> },
    { id: 'two', label: 'Two', content: <p>Two body</p> },
    { id: 'three', label: 'Three', content: <p>Three body</p> },
  ];
}

describe('Tabs', () => {
  it('renders the tablist with ARIA roles and the first tab selected', () => {
    render(<Tabs items={makeItems()} ariaLabel="Test tabs" />);
    const tablist = screen.getByRole('tablist', { name: /test tabs/i });
    expect(tablist).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[2]).toHaveAttribute('aria-selected', 'false');
  });

  it('shows only the selected panel content; switches on click', () => {
    render(<Tabs items={makeItems()} ariaLabel="Test tabs" />);
    expect(screen.getByText('One body')).toBeInTheDocument();
    expect(screen.queryByText('Two body')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Two' }));
    expect(screen.getByText('Two body')).toBeInTheDocument();
    expect(screen.queryByText('One body')).not.toBeInTheDocument();
  });

  it('moves selection with ArrowRight / ArrowLeft (wrapping)', () => {
    render(<Tabs items={makeItems()} ariaLabel="Test tabs" />);
    const tabOne = screen.getByRole('tab', { name: 'One' });
    tabOne.focus();
    fireEvent.keyDown(tabOne, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Two' }), {
      key: 'ArrowRight',
    });
    expect(screen.getByRole('tab', { name: 'Three' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Wraps from end to start.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Three' }), {
      key: 'ArrowRight',
    });
    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Wraps from start to end with ArrowLeft.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'One' }), {
      key: 'ArrowLeft',
    });
    expect(screen.getByRole('tab', { name: 'Three' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('Home jumps to the first tab; End jumps to the last', () => {
    render(<Tabs items={makeItems()} ariaLabel="Test tabs" initialId="two" />);
    const tabTwo = screen.getByRole('tab', { name: 'Two' });
    tabTwo.focus();
    fireEvent.keyDown(tabTwo, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Three' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Three' }), {
      key: 'Home',
    });
    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('uses roving tabindex: selected tab has tabindex 0, others -1', () => {
    render(<Tabs items={makeItems()} ariaLabel="Test tabs" />);
    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });

  it('honors initialId when present', () => {
    render(<Tabs items={makeItems()} ariaLabel="Test tabs" initialId="three" />);
    expect(screen.getByRole('tab', { name: 'Three' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('silently falls back to the first tab when initialId is unknown', () => {
    render(<Tabs items={makeItems()} ariaLabel="Test tabs" initialId="bogus" />);
    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('renders nothing when items is empty (parent handles gating)', () => {
    const { container } = render(<Tabs items={[]} ariaLabel="Empty" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('links each tab to its panel via aria-controls / aria-labelledby', () => {
    render(<Tabs items={makeItems()} ariaLabel="Test tabs" />);
    const tab = screen.getByRole('tab', { name: 'One' });
    const controlsId = tab.getAttribute('aria-controls');
    expect(controlsId).not.toBeNull();
    const panel = document.getElementById(controlsId ?? '');
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('aria-labelledby', tab.id);
  });
});
