import type { ReactNode } from 'react';

import { Icons, type PillTone } from '../ui';

import type {
  TaskOwnerType,
  TaskPriority,
  TaskStatus,
  TaskType,
} from './types';

// Tasks workspace — presentation maps (labels / icons / tones) for the closed
// vocab. The vocab ARRAYS live in ./types (hand-mirrored from the BE +
// drift-guarded); this file is FE-only display polish, no domain logic.

export const TYPE_LABELS: Record<TaskType, string> = {
  call: 'Call',
  email: 'Email',
  follow_up: 'Follow-up',
  interview: 'Interview',
  screen: 'Screen',
  consent: 'Consent',
  admin: 'Admin',
};

export const STATUS_LABELS: Record<TaskStatus, string> = {
  open: 'To do',
  in_progress: 'In progress',
  waiting: 'Waiting',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  high: 'High',
  med: 'Medium',
  low: 'Low',
};

export const PRIORITY_TONE: Record<TaskPriority, PillTone> = {
  high: 'hot',
  med: 'warn',
  low: 'info',
};

// Deterministic priority order for the "Suggested order" sort (high first).
export const PRIORITY_RANK: Record<TaskPriority, number> = {
  high: 0,
  med: 1,
  low: 2,
};

export const STATUS_TONE: Record<TaskStatus, PillTone> = {
  open: 'info',
  in_progress: 'brand',
  waiting: 'neutral',
  done: 'ok',
  cancelled: 'neutral',
};

// Type → icon (the ats-web Icons set has no phone/calendar glyph; the
// closest semantic match is used — purely decorative).
export function typeIcon(type: TaskType): ReactNode {
  switch (type) {
    case 'call':
      return <Icons.IconMessage />;
    case 'email':
      return <Icons.IconMail />;
    case 'follow_up':
      return <Icons.IconReply />;
    case 'interview':
      return <Icons.IconUser />;
    case 'screen':
      return <Icons.IconEye />;
    case 'consent':
      return <Icons.IconShield />;
    case 'admin':
      return <Icons.IconFile />;
  }
}

// Owner-link entity label + tone (the four polymorphic targets).
export const OWNER_LABELS: Record<TaskOwnerType, string> = {
  talent_record: 'Talent',
  requisition: 'Requisition',
  company: 'Company',
  contact: 'Contact',
};

export function ownerIcon(owner: TaskOwnerType): ReactNode {
  switch (owner) {
    case 'talent_record':
      return <Icons.IconTalent />;
    case 'requisition':
      return <Icons.IconRequisitions />;
    case 'company':
      return <Icons.IconCompanies />;
    case 'contact':
      return <Icons.IconContacts />;
  }
}

// The owner-link detail route (deep-link from a task to its entity).
export function ownerHref(ownerType: TaskOwnerType, ownerId: string): string | null {
  switch (ownerType) {
    case 'talent_record':
      return `/talent/${ownerId}`;
    case 'requisition':
      return `/requisitions/${ownerId}`;
    case 'company':
      return `/companies/${ownerId}`;
    case 'contact':
      // Contacts have no standalone detail route in the recruiter console; the
      // chip renders un-linked.
      return null;
  }
}
