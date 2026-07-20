import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

// Per directive §8.1 step 2 + §3 PKCE state cookie. RFC 7636 mandates a
// 43-128-char verifier (base64url-encoded high-entropy). Cognito S256
// challenge = base64url(SHA-256(verifier)).
//
// State-cookie encryption: AES-256-GCM with a 12-byte IV. Output is
// base64url(iv || ciphertext || tag). 32-byte AUTH_PKCE_STATE_KEY,
// supplied as base64url-encoded string.

export interface PkcePair {
  verifier: string;
  challenge: string;
  state: string;
}

export interface PkceStatePayload {
  verifier: string;
  state: string;
  consumer: string;
  issued_at: number;
}

const VERIFIER_BYTES = 64; // 64 random bytes → ~86-char base64url verifier (within 43-128 range)
const STATE_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromBase64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

@Injectable()
export class PkceService {
  generate(): PkcePair {
    const verifier = base64url(randomBytes(VERIFIER_BYTES));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(STATE_BYTES));
    return { verifier, challenge, state };
  }

  encryptState(payload: PkceStatePayload): string {
    const key = this.loadKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const json = JSON.stringify(payload);
    const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return base64url(Buffer.concat([iv, ct, tag]));
  }

  decryptState(cipherText: string): PkceStatePayload {
    const key = this.loadKey();
    const raw = fromBase64url(cipherText);
    if (raw.length < IV_BYTES + TAG_BYTES) {
      throw new Error('pkce_state_decrypt_failed');
    }
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const ct = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let plain: Buffer;
    try {
      plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      throw new Error('pkce_state_decrypt_failed');
    }
    return JSON.parse(plain.toString('utf8')) as PkceStatePayload;
  }

  private loadKey(): Buffer {
    const v = process.env['AUTH_PKCE_STATE_KEY'];
    if (v === undefined || v.length === 0) {
      throw new Error('AUTH_PKCE_STATE_KEY is not configured');
    }
    const buf = fromBase64url(v);
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `AUTH_PKCE_STATE_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length})`,
      );
    }
    return buf;
  }
}
