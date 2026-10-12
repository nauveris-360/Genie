import argon2 from 'argon2';

/** argon2id with library defaults (maintained, memory-hard; no custom tuning that could weaken it). */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // argon2.verify throws on a malformed/foreign hash rather than returning false.
    return false;
  }
}
