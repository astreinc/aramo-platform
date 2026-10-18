// The ONE place a Secrets Manager client gets its configuration (connector /
// e-signature provider tokens, Microsoft delegated tokens, tenant LLM keys).
//
// LOCAL ONLY: AWS_SECRETS_MANAGER_ENDPOINT points the client at LocalStack so a
// developer box never reads or writes the real AWS account. It is refused when
// NODE_ENV=production and allowed only with ARAMO_ENV=local|test; with it set the
// client uses dummy credentials (real AWS credentials are never sent to it).
// CI's env:passthrough-check also forbids the variable in docker-compose.prod.yml.

export interface SecretsManagerClientConfig {
  readonly region: string;
  readonly endpoint?: string;
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
}

export function secretsManagerClientConfig(env: NodeJS.ProcessEnv = process.env): SecretsManagerClientConfig {
  const region = env['AWS_REGION'] ?? 'us-east-1';
  const endpoint = env['AWS_SECRETS_MANAGER_ENDPOINT'];
  if (endpoint === undefined || endpoint.length === 0) return { region };
  if ((env['NODE_ENV'] ?? '').toLowerCase() === 'production') {
    throw new Error('AWS_SECRETS_MANAGER_ENDPOINT is local-only and is refused when NODE_ENV=production');
  }
  const aramoEnv = (env['ARAMO_ENV'] ?? '').toLowerCase();
  if (aramoEnv !== 'local' && aramoEnv !== 'test') {
    throw new Error('AWS_SECRETS_MANAGER_ENDPOINT needs ARAMO_ENV=local or ARAMO_ENV=test');
  }
  return { region, endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };
}
