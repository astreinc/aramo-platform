// COMM PART C (Architect channel/provider correction) — the platform provider
// registry, mirrored truthfully for the FE. Channels are INDEPENDENT Tenant
// choices; each channel lists its eligible providers with a `ready` flag = the
// platform actually has the backend/config capability to use it TODAY. A provider
// that is declared but not executable (e.g. Zoom Meetings, Zoom SMS) is `ready:false`
// and is NEVER selectable/configurable — it is shown only as a "future" option.
//
// This registry is authoritative for what the UI may offer; it does NOT infer a
// provider from another channel's selection (Email=Microsoft 365 does not imply
// Meeting=Teams). Meeting reuses the Microsoft credential SUBSTRATE but is an
// independent channel selection. Repo recon (see project memory) proves: Voice→
// zoom_phone adapter, Email/Meeting→Microsoft (Teams create-link-only), and NO
// Zoom-meeting / executable-SMS adapter exists — so those stay ready:false.

export type ChannelKey = 'Voice' | 'Email' | 'Meeting' | 'SMS';

export interface RegistryProvider {
  readonly name: string;
  readonly initials: string;
  readonly note: string;
  /** Executable/configurable on the platform today. false = declared/future only. */
  readonly ready: boolean;
}

export interface ChannelDef {
  readonly channel: ChannelKey;
  readonly purpose: string;
  readonly icon: string;
  readonly providers: readonly RegistryProvider[];
  /**
   * The provider_key of the backing communications provider config (for Voice),
   * or 'microsoft' when the channel's configuration is the Microsoft connection
   * (Email + Meeting share the Microsoft substrate). null = no configurable
   * backend yet (SMS).
   */
  readonly backend: 'zoom_phone' | 'microsoft' | null;
}

const IC_VOICE = 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z';
const IC_MAIL = 'M3 5h18v14H3zM3 6l9 7 9-7';
const IC_MEETING = 'M4 5h16v13H4zM8 3v4M16 3v4M4 11h16';
const IC_SMS = 'M4 4h16v12H8l-4 4z';

export const COMMUNICATION_REGISTRY: readonly ChannelDef[] = [
  {
    channel: 'Voice',
    purpose: 'Logged calls · per-recruiter mappings',
    icon: IC_VOICE,
    backend: 'zoom_phone',
    providers: [{ name: 'Zoom Phone', initials: 'ZP', note: 'Per-recruiter mappings · call logging', ready: true }],
  },
  {
    channel: 'Email',
    purpose: 'Sent-email evidence · tenant-level connection',
    icon: IC_MAIL,
    backend: 'microsoft',
    providers: [{ name: 'Microsoft 365', initials: 'M365', note: 'Tenant-level OAuth connection', ready: true }],
  },
  {
    channel: 'Meeting',
    purpose: 'Interview and meeting scheduling',
    icon: IC_MEETING,
    backend: 'microsoft',
    providers: [
      { name: 'Microsoft Teams', initials: 'MT', note: 'Meeting links and scheduling · own connection', ready: true },
      // Repo recon: NO Zoom meeting adapter/endpoint exists — future only, never selectable.
      { name: 'Zoom Meetings', initials: 'ZM', note: 'Future — connector not shipped yet', ready: false },
    ],
  },
  {
    channel: 'SMS',
    purpose: 'Text engagement evidence',
    icon: IC_SMS,
    backend: null,
    // No executable SMS provider exists yet (declared-only by the Zoom connector).
    providers: [{ name: 'Zoom SMS', initials: 'ZS', note: 'Declared by the connector — execution not implemented yet', ready: false }],
  },
];

/** The single ready (selectable) provider for a channel, or null if none is ready. */
export function readyProvider(def: ChannelDef): RegistryProvider | null {
  return def.providers.find((p) => p.ready) ?? null;
}
