import type { ReactNode } from 'react';

import './platform-components.css';

// PLATFORM-UX-1 F-1 — the view-only note (handoff §3.6). Shown wherever the
// operator can read a surface but not change it, so buttons are never hidden
// silently (handoff §2). Local to platform-web: InlineAlert is frozen.

export interface ViewOnlyNoteProps {
  /** The plain permission label the change needs ("Manage tenant lifecycle"). */
  readonly permission: string;
  /**
   * What the operator can view, as a noun phrase completing "You can view …".
   * Default: "this".
   */
  readonly subject?: string;
  /**
   * The phrase before "the {permission} permission", verb included
   * ("Lifecycle and domain changes need"). Default: "Changing it needs".
   */
  readonly needs?: ReactNode;
}

export function ViewOnlyNote({ permission, subject = 'this', needs = 'Changing it needs' }: ViewOnlyNoteProps) {
  return (
    <div className="pw-viewonly" role="note">
      <b className="pw-viewonly__lead">View only.</b>
      <span>
        {/* One text node before the permission, as in the design: split text
            nodes shape (and so rasterise) differently from one run. */}
        {typeof needs === 'string' ? (
          `You can view ${subject}. ${needs} the `
        ) : (
          <>
            You can view {subject}. {needs} the{' '}
          </>
        )}
        <b>{permission}</b> permission.
      </span>
    </div>
  );
}
