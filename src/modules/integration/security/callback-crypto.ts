import { createCipheriv, createDecipheriv, createHash, randomBytes as secureRandomBytes, timingSafeEqual } from "node:crypto";

export class ConnectorSecurityError extends Error {
  constructor(readonly code: "SIGNATURE_INVALID" | "TIMESTAMP_STALE" | "REPLAY_DETECTED" | "PAYLOAD_INVALID" | "RECEIVER_MISMATCH") {
    super(code);
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function sha1SortedSignature(parts: string[]): string {
  return createHash("sha1").update([...parts].sort().join("")).digest("hex");
}

export function verifySha1Signature(parts: string[], signature: string): void {
  if (!safeEqual(sha1SortedSignature(parts), signature.toLowerCase())) throw new ConnectorSecurityError("SIGNATURE_INVALID");
}

export function verifyFeishuSignature(input: {
  timestamp: string;
  nonce: string;
  encryptKey: string;
  rawBody: string;
  signature: string;
}): void {
  const expected = createHash("sha256")
    .update(`${input.timestamp}${input.nonce}${input.encryptKey}${input.rawBody}`)
    .digest("hex");
  if (!safeEqual(expected, input.signature.toLowerCase())) throw new ConnectorSecurityError("SIGNATURE_INVALID");
}

export function assertFreshTimestamp(timestamp: string, now = Date.now(), toleranceSeconds = 300): void {
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric)) throw new ConnectorSecurityError("TIMESTAMP_STALE");
  const timestampMs = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  if (Math.abs(now - timestampMs) > toleranceSeconds * 1000) throw new ConnectorSecurityError("TIMESTAMP_STALE");
}

function decodeAesKey(encodingAesKey: string): Buffer {
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32) throw new ConnectorSecurityError("PAYLOAD_INVALID");
  return key;
}

function removePkcs7(buffer: Buffer): Buffer {
  const padding = buffer.at(-1) ?? 0;
  if (padding < 1 || padding > 32 || padding > buffer.length) throw new ConnectorSecurityError("PAYLOAD_INVALID");
  for (let index = buffer.length - padding; index < buffer.length; index += 1) {
    if (buffer[index] !== padding) throw new ConnectorSecurityError("PAYLOAD_INVALID");
  }
  return buffer.subarray(0, buffer.length - padding);
}

function addPkcs7(buffer: Buffer): Buffer {
  const padding = 32 - (buffer.length % 32 || 32) || 32;
  return Buffer.concat([buffer, Buffer.alloc(padding, padding)]);
}

export function decryptEnterpriseCallback(input: {
  ciphertext: string;
  encodingAesKey: string;
  expectedReceiveId: string;
}): string {
  const key = decodeAesKey(input.encodingAesKey);
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  let decrypted: Buffer;
  try {
    decrypted = removePkcs7(Buffer.concat([decipher.update(input.ciphertext, "base64"), decipher.final()]));
  } catch (error) {
    if (error instanceof ConnectorSecurityError) throw error;
    throw new ConnectorSecurityError("PAYLOAD_INVALID");
  }
  if (decrypted.length < 20) throw new ConnectorSecurityError("PAYLOAD_INVALID");
  const messageLength = decrypted.readUInt32BE(16);
  const messageEnd = 20 + messageLength;
  if (messageEnd > decrypted.length) throw new ConnectorSecurityError("PAYLOAD_INVALID");
  const receiveId = decrypted.subarray(messageEnd).toString("utf8");
  if (!safeEqual(receiveId, input.expectedReceiveId)) throw new ConnectorSecurityError("RECEIVER_MISMATCH");
  return decrypted.subarray(20, messageEnd).toString("utf8");
}

function encryptEnterpriseCallbackWithRandom(input: {
  plaintext: string;
  encodingAesKey: string;
  receiveId: string;
  randomBytes: Buffer;
}): string {
  const key = decodeAesKey(input.encodingAesKey);
  const random = input.randomBytes;
  if (random.length !== 16) throw new ConnectorSecurityError("PAYLOAD_INVALID");
  const message = Buffer.from(input.plaintext, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.length);
  const padded = addPkcs7(Buffer.concat([random, length, message, Buffer.from(input.receiveId, "utf8")]));
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

export function encryptEnterpriseCallback(input: { plaintext: string; encodingAesKey: string; receiveId: string }): string {
  return encryptEnterpriseCallbackWithRandom({ ...input, randomBytes: secureRandomBytes(16) });
}

export function encryptEnterpriseCallbackFixture(input: { plaintext: string; encodingAesKey: string; receiveId: string; randomBytes?: Buffer }): string {
  return encryptEnterpriseCallbackWithRandom({ ...input, randomBytes: input.randomBytes ?? Buffer.alloc(16, 7) });
}

export function decryptFeishuPayload(ciphertext: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const encrypted = Buffer.from(ciphertext, "base64");
  if (encrypted.length <= 16) throw new ConnectorSecurityError("PAYLOAD_INVALID");
  const decipher = createDecipheriv("aes-256-cbc", key, encrypted.subarray(0, 16));
  try {
    return Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()]).toString("utf8");
  } catch {
    throw new ConnectorSecurityError("PAYLOAD_INVALID");
  }
}

export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs = 10 * 60 * 1000, private readonly now: () => number = () => Date.now()) {}

  claim(key: string): void {
    const current = this.now();
    for (const [existing, expiresAt] of this.seen) if (expiresAt <= current) this.seen.delete(existing);
    if (this.seen.has(key)) throw new ConnectorSecurityError("REPLAY_DETECTED");
    this.seen.set(key, current + this.ttlMs);
  }
}
