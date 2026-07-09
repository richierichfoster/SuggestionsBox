import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  const attempted = scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  if (attempted.length !== stored.length) return false;
  return timingSafeEqual(attempted, stored);
}

export function createToken() {
  return randomBytes(32).toString('hex');
}
