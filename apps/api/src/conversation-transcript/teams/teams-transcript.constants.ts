// TIP-E2E INC-3 A1-5 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Part D, CI-B5M) — the
// Microsoft Teams post-meeting transcript provider path. Same canonical B3/B4
// contract as Zoom; no downstream CI provider special case.
export const MICROSOFT_TEAMS_PROVIDER_KEY = 'microsoft_teams';
// One provider-neutral source-format token for the Teams transcript content:
// speaker-attributed WEBVTT, or the unattributed
// `application/vnd.microsoft.graph.transcript+text` fallback.
export const MICROSOFT_TEAMS_TRANSCRIPT_FORMAT = 'microsoft_teams_transcript';
