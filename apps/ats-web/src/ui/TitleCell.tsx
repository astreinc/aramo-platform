import type { ReactNode } from 'react';
import { IconFlame } from '@aramo/fe-foundation';

interface TitleCellProps {
  readonly name: string;
  readonly subtitle?: ReactNode;
  readonly hot?: boolean;
}

// Avatar-less title cell for NON-person rows (requisitions / jobs): bold title
// + muted subtitle (company · code) + optional hot flame. People rows use
// EntityCell (with an avatar); entities like requisitions do not — matching
// the mockup grammar.
export function TitleCell({ name, subtitle, hot = false }: TitleCellProps) {
  return (
    <div className="rc-jt">
      <div className="rc-jt__name">
        {name}
        {hot ? <IconFlame aria-label="Hot" /> : null}
      </div>
      {subtitle != null && subtitle !== '' ? (
        <div className="rc-jt__co">{subtitle}</div>
      ) : null}
    </div>
  );
}
