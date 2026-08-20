import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type EncryptedEnvelope = { encryptedPayload:string; initializationVector:string; authenticationTag:string };

export function encryptSensitiveJson(value: unknown, key: Buffer, additionalData: string): EncryptedEnvelope {
  if (key.length!==32) throw new Error("DATA_ENCRYPTION_KEY_INVALID");
  const iv=randomBytes(12); const cipher=createCipheriv("aes-256-gcm",key,iv); cipher.setAAD(Buffer.from(additionalData));
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),"utf8"),cipher.final()]);
  return {encryptedPayload:encrypted.toString("base64"),initializationVector:iv.toString("base64"),authenticationTag:cipher.getAuthTag().toString("base64")};
}

export function decryptSensitiveJson<T>(envelope: EncryptedEnvelope, key: Buffer, additionalData: string): T {
  if (key.length!==32) throw new Error("DATA_ENCRYPTION_KEY_INVALID");
  try { const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(envelope.initializationVector,"base64")); decipher.setAAD(Buffer.from(additionalData)); decipher.setAuthTag(Buffer.from(envelope.authenticationTag,"base64")); return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.encryptedPayload,"base64")),decipher.final()]).toString("utf8")) as T; } catch { throw new Error("ENCRYPTED_ENVELOPE_INVALID"); }
}

export function sensitiveValueDigest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
