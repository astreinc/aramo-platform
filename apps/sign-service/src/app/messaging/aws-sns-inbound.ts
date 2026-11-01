import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

// Aramo-Sign-Remaining-Work-Consolidated-Directive-v1_0-LOCKED §3 B5 — inbound SMS replies
// (STOP / START) for the AWS End User Messaging SMS adapter. AWS delivers two-way SMS to the
// Amazon SNS topic set as the number's two-way channel; the topic has an HTTPS subscription to
// POST v1/sign/messaging/sms/inbound/aws. Authenticity is the SNS message signature
// (SignatureVersion 1 = SHA1withRSA, 2 = SHA256withRSA) over the canonical string of the
// message, checked with the certificate at SigningCertURL, which must be an https URL on an
// Amazon SNS host. The topic must be the configured SIGN_SMS_AWS_INBOUND_TOPIC_ARN.
//
//   SIGN_SMS_AWS_INBOUND_TOPIC_ARN   the SNS topic ARN of the two-way channel (unset ⇒ the route
//                                    answers 404; it is also 404 unless SIGN_SMS_PROVIDER
//                                    includes aws and sign.sms_delivery is AVAILABLE)

export const SIGN_SMS_AWS_INBOUND_TOPIC_ARN_ENV = 'SIGN_SMS_AWS_INBOUND_TOPIC_ARN';

/** A message older than this is refused (SNS's default HTTP delivery retries end well within it). */
export const SNS_MAX_MESSAGE_AGE_MS = 24 * 60 * 60 * 1000;
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
const TOPIC_ARN = /^arn:aws(-[a-z]+)*:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/;
const MAX_CERT_BYTES = 16 * 1024;

export type SnsMessageType = 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';

export interface SnsMessage {
  Type: SnsMessageType;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: '1' | '2';
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

export type SnsRejection = 'MALFORMED' | 'WRONG_TOPIC' | 'UNTRUSTED_CERT_URL' | 'CERT_UNAVAILABLE' | 'BAD_SIGNATURE' | 'STALE';

export class SnsInboundRejectedError extends Error {
  constructor(readonly reason: SnsRejection) {
    super(`sns message rejected: ${reason}`);
    this.name = 'SnsInboundRejectedError';
  }
}

export function snsTopicArnFromEnv(env: NodeJS.ProcessEnv): string | null {
  const v = env[SIGN_SMS_AWS_INBOUND_TOPIC_ARN_ENV]?.trim();
  if (!v) return null;
  return TOPIC_ARN.test(v) ? v : null;
}

const str = (o: Record<string, unknown>, k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);

/** Parse the SNS HTTP body (JSON, sent as text/plain). Throws MALFORMED on anything else. */
export function parseSnsMessage(raw: Buffer): SnsMessage {
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    o = parsed as Record<string, unknown>;
  } catch {
    throw new SnsInboundRejectedError('MALFORMED');
  }
  const Type = str(o, 'Type');
  const SignatureVersion = str(o, 'SignatureVersion');
  const m = {
    MessageId: str(o, 'MessageId'),
    TopicArn: str(o, 'TopicArn'),
    Message: str(o, 'Message'),
    Timestamp: str(o, 'Timestamp'),
    Signature: str(o, 'Signature'),
    SigningCertURL: str(o, 'SigningCertURL'),
  };
  if (Type !== 'Notification' && Type !== 'SubscriptionConfirmation' && Type !== 'UnsubscribeConfirmation') throw new SnsInboundRejectedError('MALFORMED');
  if (SignatureVersion !== '1' && SignatureVersion !== '2') throw new SnsInboundRejectedError('MALFORMED');
  if (Object.values(m).some((v) => v === undefined)) throw new SnsInboundRejectedError('MALFORMED');
  const out: SnsMessage = { Type, SignatureVersion, ...(m as Omit<SnsMessage, 'Type' | 'SignatureVersion'>) };
  const Subject = str(o, 'Subject');
  const SubscribeURL = str(o, 'SubscribeURL');
  const Token = str(o, 'Token');
  if (Subject !== undefined) out.Subject = Subject;
  if (SubscribeURL !== undefined) out.SubscribeURL = SubscribeURL;
  if (Token !== undefined) out.Token = Token;
  if (Type !== 'Notification' && (SubscribeURL === undefined || Token === undefined)) throw new SnsInboundRejectedError('MALFORMED');
  return out;
}

/** The canonical string SNS signs (AWS SNS developer guide, "Verifying message signatures"). */
export function snsStringToSign(m: SnsMessage): string {
  const keys: Array<keyof SnsMessage> =
    m.Type === 'Notification'
      ? ['Message', 'MessageId', ...(m.Subject !== undefined ? (['Subject'] as const) : []), 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.map((k) => `${k}\n${m[k] ?? ''}\n`).join('');
}

/** An https URL on an Amazon SNS host (the signing certificate and the subscribe link). */
export function isSnsHostUrl(raw: string, pathSuffix?: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return false;
  if (!SNS_HOST.test(u.hostname)) return false;
  return pathSuffix === undefined || u.pathname.endsWith(pathSuffix);
}

export type SnsHttpGet = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const defaultGet: SnsHttpGet = (url) => fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5_000) });

/**
 * Verifies SNS messages for one topic. The signing certificates are fetched once per URL and
 * kept in memory (they rotate rarely; a new URL is fetched when SNS starts using it).
 */
export class SnsMessageVerifier {
  private readonly keys = new Map<string, KeyObject>();

  constructor(
    private readonly topicArn: string,
    private readonly httpGet: SnsHttpGet = defaultGet,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async verify(m: SnsMessage): Promise<void> {
    if (m.TopicArn !== this.topicArn) throw new SnsInboundRejectedError('WRONG_TOPIC');
    if (!isSnsHostUrl(m.SigningCertURL, '.pem')) throw new SnsInboundRejectedError('UNTRUSTED_CERT_URL');
    const sent = Date.parse(m.Timestamp);
    if (!Number.isFinite(sent) || this.now().getTime() - sent > SNS_MAX_MESSAGE_AGE_MS) throw new SnsInboundRejectedError('STALE');
    const key = await this.keyFor(m.SigningCertURL);
    let ok = false;
    try {
      ok = cryptoVerify(m.SignatureVersion === '1' ? 'sha1' : 'sha256', Buffer.from(snsStringToSign(m), 'utf8'), key, Buffer.from(m.Signature, 'base64'));
    } catch {
      ok = false;
    }
    if (!ok) throw new SnsInboundRejectedError('BAD_SIGNATURE');
  }

  private async keyFor(url: string): Promise<KeyObject> {
    const cached = this.keys.get(url);
    if (cached !== undefined) return cached;
    let pem: string;
    try {
      const res = await this.httpGet(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      pem = await res.text();
    } catch {
      throw new SnsInboundRejectedError('CERT_UNAVAILABLE');
    }
    if (pem.length > MAX_CERT_BYTES) throw new SnsInboundRejectedError('CERT_UNAVAILABLE');
    let key: KeyObject;
    try {
      key = createPublicKey(pem);
    } catch {
      throw new SnsInboundRejectedError('CERT_UNAVAILABLE');
    }
    this.keys.set(url, key);
    return key;
  }

  /** Confirms the topic subscription by visiting SubscribeURL (an Amazon SNS https URL only). */
  async confirmSubscription(m: SnsMessage): Promise<boolean> {
    if (m.SubscribeURL === undefined || !isSnsHostUrl(m.SubscribeURL)) return false;
    try {
      return (await this.httpGet(m.SubscribeURL)).ok;
    } catch {
      return false;
    }
  }
}

/** The AWS End User Messaging two-way SMS payload inside an SNS Notification's Message. */
export interface AwsInboundSms {
  originationNumber: string;
  messageBody: string;
}

export function parseAwsInboundSms(message: string): AwsInboundSms | null {
  try {
    const o = JSON.parse(message) as Record<string, unknown>;
    if (typeof o['originationNumber'] !== 'string' || typeof o['messageBody'] !== 'string') return null;
    return { originationNumber: o['originationNumber'], messageBody: o['messageBody'] };
  } catch {
    return null;
  }
}
