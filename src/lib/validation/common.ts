import { z } from "zod";

// Building blocks shared by the per-area schemas.

export const uuid = z.uuid();

// ISO 8601 timestamp; an explicit offset ("Z" or "+02:00") is required so the day boundary is unambiguous.
export const isoDateTime = z.iso.datetime({ offset: true });

// Calendar date, YYYY-MM-DD.
export const isoDate = z.iso.date();

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// IANA zone such as "America/Los_Angeles". Validated against the runtime's tz database.
export const timezone = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { message: "Unknown time zone" });

// Finite, non-negative number with a sanity cap so absurd values never reach the database.
export function amount(max: number) {
  return z.number().finite().nonnegative().max(max);
}

// Trimmed, non-empty string.
export function text(max: number) {
  return z.string().trim().min(1).max(max);
}

// Query-string limit: ?limit=30 → 30, missing → fallback.
export function limitParam(fallback: number, max: number) {
  return z.coerce.number().int().min(1).max(max).default(fallback);
}
