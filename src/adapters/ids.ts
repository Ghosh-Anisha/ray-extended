import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// Razorpay-style ids: a prefix and 14 random characters, e.g. pay_Kx3...
export function newId(prefix: string): string {
  const bytes = randomBytes(14);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}
