import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;

function loadKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 of a 256-bit key).');
  }
  return key;
}

/**
 * Encrypts plaintext with AES-256-GCM using the deployment's external
 * credential encryption key. Output layout: iv (12 bytes) || authTag (16
 * bytes) || ciphertext, as a single Buffer suitable for a BYTEA column.
 * The key never comes from this repo or Git - it is an external deployment
 * secret supplied via CREDENTIAL_ENCRYPTION_KEY at runtime.
 */
export function encryptSecret(plaintext: string, base64Key: string): Buffer {
  const key = loadKey(base64Key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function decryptSecret(encrypted: Buffer, base64Key: string): string {
  const key = loadKey(base64Key);
  const iv = encrypted.subarray(0, IV_LENGTH);
  const authTag = encrypted.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = encrypted.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
