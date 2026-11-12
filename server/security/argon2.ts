import { hash, verify } from '@node-rs/argon2';

/**
 * Hash password using Argon2id with OWASP-recommended parameters
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  return hash(plainPassword, {
    memoryCost: 19456, // 19 MiB
    timeCost: 2,       // 2 iterations
    outputLen: 32,
    parallelism: 1
  });
}

/**
 * Verify a plain password against an Argon2id hash
 */
export async function verifyPassword(hashedPassword: string, candidatePassword: string): Promise<boolean> {
  try {
    return await verify(hashedPassword, candidatePassword);
  } catch (err) {
    return false;
  }
}
