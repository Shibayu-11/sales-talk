export interface SessionPayload {
  userId: string;
  tenantId: string;
  organizationId: string;
  membershipId: string;
  sessionVersion: number;
  iat: number;
  exp: number;
  nonce: string;
}

export interface PasswordCredential {
  passwordHash: string;
  salt: string;
  iterations: number;
  algorithm: 'PBKDF2-SHA256';
}

const SESSION_TTL_SECONDS = 60 * 60 * 12;
const PASSWORD_ITERATIONS = 100_000;
const BYTE_ARRAY_CHUNK_SIZE = 32_768;

export async function createPasswordCredential(password: string): Promise<PasswordCredential> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePasswordHash(password, salt, PASSWORD_ITERATIONS);
  return {
    passwordHash: base64UrlEncode(hash),
    salt: base64UrlEncode(salt),
    iterations: PASSWORD_ITERATIONS,
    algorithm: 'PBKDF2-SHA256',
  };
}

export async function verifyPassword(
  password: string,
  credential: PasswordCredential,
): Promise<boolean> {
  if (credential.algorithm !== 'PBKDF2-SHA256') {
    return false;
  }
  const salt = base64UrlDecode(credential.salt);
  const expectedHash = base64UrlDecode(credential.passwordHash);
  const actualHash = await derivePasswordHash(password, salt, credential.iterations);
  return constantTimeBytesEqual(actualHash, expectedHash);
}

export async function createSessionToken(
  input: Omit<SessionPayload, 'iat' | 'exp' | 'nonce'>,
  signingKey: string,
  now = new Date(),
): Promise<{ token: string; expiresAt: string }> {
  const issuedAtSeconds = Math.floor(now.getTime() / 1_000);
  const payload: SessionPayload = {
    ...input,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + SESSION_TTL_SECONDS,
    nonce: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
  };
  const payloadPart = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await signBytes(payloadPart, signingKey);
  return {
    token: `${payloadPart}.${base64UrlEncode(signature)}`,
    expiresAt: new Date(payload.exp * 1_000).toISOString(),
  };
}

export async function verifySessionToken(
  token: string,
  signingKey: string,
  now = new Date(),
): Promise<SessionPayload | null> {
  const parts = token.split('.');
  const payloadPart = parts[0];
  const signaturePart = parts[1];
  if (!payloadPart || !signaturePart || parts.length !== 2) {
    return null;
  }
  const signature = base64UrlDecode(signaturePart);
  if (!(await verifySignature(payloadPart, signature, signingKey))) {
    return null;
  }
  const payload = parseSessionPayload(new TextDecoder().decode(base64UrlDecode(payloadPart)));
  if (!payload || payload.exp <= Math.floor(now.getTime() / 1_000)) {
    return null;
  }
  return payload;
}

async function derivePasswordHash(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: toArrayBuffer(salt), iterations },
    passwordKey,
    256,
  );
  return new Uint8Array(bits);
}

async function signBytes(value: string, signingKey: string): Promise<Uint8Array> {
  const key = await importSigningKey(signingKey);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return new Uint8Array(signature);
}

async function verifySignature(
  value: string,
  signature: Uint8Array,
  signingKey: string,
): Promise<boolean> {
  const key = await importSigningKey(signingKey);
  return crypto.subtle.verify('HMAC', key, toArrayBuffer(signature), new TextEncoder().encode(value));
}

async function importSigningKey(signingKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function parseSessionPayload(value: string): SessionPayload | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    if (
      typeof parsed.userId !== 'string' ||
      typeof parsed.tenantId !== 'string' ||
      typeof parsed.organizationId !== 'string' ||
      typeof parsed.membershipId !== 'string' ||
      typeof parsed.sessionVersion !== 'number' ||
      typeof parsed.iat !== 'number' ||
      typeof parsed.exp !== 'number' ||
      typeof parsed.nonce !== 'string'
    ) {
      return null;
    }
    return {
      userId: parsed.userId,
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      membershipId: parsed.membershipId,
      sessionVersion: parsed.sessionVersion,
      iat: parsed.iat,
      exp: parsed.exp,
      nonce: parsed.nonce,
    };
  } catch {
    return null;
  }
}

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += BYTE_ARRAY_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.slice(index, index + BYTE_ARRAY_CHUNK_SIZE));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
