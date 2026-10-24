import type { ReactNode } from 'react';

import { PERMISSION_LABEL, PLATFORM_PERMISSIONS as P } from '../components';
import './skills.css';

// PLATFORM-UX-1 F-7 — the Skills page head and view-only note, with the
// design's exact copy and geometry (Platform Admin.dc.html). The note reuses
// the platform `.pw-viewonly` box; its sentence is the design's Skills wording
// ("Changing skills needs the Manage skills permission."), which the generic
// ViewOnlyNote's "You can view …" sentence doesn't produce.

export const MANAGE_SKILLS_LABEL = PERMISSION_LABEL[P.skillManage];

export function SkillsPageHead({
  title,
  lede,
  action,
}: {
  readonly title: string;
  readonly lede: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className={action === undefined ? 'pw-sk-head pw-sk-head--plain' : 'pw-sk-head'}>
      <div>
        <h1 className="pw-sk-title">{title}</h1>
        <p className="pw-sk-lede">{lede}</p>
      </div>
      {action}
    </div>
  );
}

/** "View only. {what} needs the Manage skills permission." */
export function SkillsViewOnly({
  what = 'Changing skills',
  className,
}: {
  readonly what?: string;
  readonly className?: string;
}) {
  return (
    <div className={`pw-viewonly${className ? ` ${className}` : ''}`} role="note">
      <b className="pw-viewonly__lead">View only.</b>{' '}
      <span>
        {what} needs the <b>{MANAGE_SKILLS_LABEL}</b> permission.
      </span>
    </div>
  );
}
