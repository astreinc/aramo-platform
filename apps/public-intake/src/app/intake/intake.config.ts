// Intake runtime configuration — all env-driven, all with safe defaults so the
// service boots in any environment. No secrets here; AWS credentials come from
// the SDK default chain (never read or logged by this app).

export interface IntakeConfig {
  sesRegion: string;
  fromAddress: string;
  toAddress: string;
  baseUrl: string;
  ratePerHour: number;
}

export function loadIntakeConfig(): IntakeConfig {
  const ratePerHour = Number(
    process.env['INTAKE_RATE_LIMIT_PER_HOUR'] ?? '5',
  );
  return {
    sesRegion:
      process.env['INTAKE_SES_REGION'] ??
      process.env['AWS_REGION'] ??
      'us-east-1',
    fromAddress: process.env['INTAKE_FROM_ADDRESS'] ?? 'no-reply@aramo.ai',
    toAddress: process.env['INTAKE_TO_ADDRESS'] ?? 'hello@aramo.ai',
    baseUrl: process.env['PUBLIC_SITE_BASE_URL'] ?? 'https://aramo.ai',
    ratePerHour:
      Number.isFinite(ratePerHour) && ratePerHour > 0 ? ratePerHour : 5,
  };
}
