// TR-2b B2a (Directive ruling 3) — the DormantLink status closed vocabulary.
// Mirrors the DB CHECK constraint in the init migration; nothing else is valid.
//   PENDING_NOTICE — detected, awaiting the P4 notice delivery (the mint state).
//   NOTICED        — a notice was delivered (requires notice_version +
//                    notice_delivered_at non-null; a second DB CHECK enforces it).
//   EXPIRED        — the notice window elapsed (P4 sets expires_at at NOTICED+12mo).
export const DORMANT_LINK_STATUSES = [
  'PENDING_NOTICE',
  'NOTICED',
  'EXPIRED',
] as const;

export type DormantLinkStatus = (typeof DORMANT_LINK_STATUSES)[number];
